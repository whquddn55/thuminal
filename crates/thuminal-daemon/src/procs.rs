//! 세션 셸 밑에서 도는 프로세스 찾기.
//!
//! - 탭을 닫기 전에 claude 같은 에이전트가 떠 있는지 본다 (에이전트 훅이 알려 오지 않은 경우: 플러그인 없이 띄운 claude,
//!   훅이 아직 오지 않은 claude).
//! - 리소스 관리자: 세션마다 셸과 자손의 CPU · 메모리, 이 컴퓨터에서 LISTEN 중인 TCP 포트와 그 포트를 붙인 곳.
//!   macOS 는 Orca 처럼 `ps` 한 번으로 부모 표를 만들고, 포트는 `lsof` 로 읽는다. 그 밖(Linux · Windows)에서는
//!   `sysinfo` 로 프로세스 표를, `listeners` 로 포트를 읽는다 (Linux 에는 `lsof` 가 없는 일이 많고 Windows 에는 둘 다 없다). 포트는 연 프로세스가 세션 셸의 자손이면
//!   그 세션에, 아니면 작업 폴더 · 명령줄에 워크트리 경로가 든 워크트리(가장 긴 경로)에, 둘 다 아니면 밖(external)에 붙인다.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use thuminal_protocol::{
    ListenPort, MAX_PORTS, MAX_SESSION_PROCESSES, PortVia, ProcessInfo, ProcessReport, RunningAgent, SessionId, SessionProcesses,
};

/// `roots`(세션, 셸 pid) 의 자손 프로세스 중 이름이 `names` 에 든 것. 세션마다 처음 찾은 하나만 낸다
pub fn running_agents(roots: &[(SessionId, u32)], names: &[String]) -> Vec<RunningAgent> {
    find(&read_procs(), roots, names)
}

/// 바깥 명령 하나의 시간 제한 (Orca 와 같다)
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CMD_TIMEOUT: Duration = Duration::from_secs(4);
/// 포트 읽기가 시간을 넘기면 이만큼 쉬었다가 다시 읽는다
const PORTS_BACKOFF: Duration = Duration::from_secs(15);
/// 이 안에 다시 물으면 앞서 읽은 것을 쓴다 (여러 화면이 2초마다 물어도 ps · lsof 는 한 번)
const SNAPSHOT_REUSE: Duration = Duration::from_millis(900);
/// 명령줄을 이 글자 수까지 남긴다
const COMMAND_MAX: usize = 400;

#[cfg(target_os = "macos")]
fn read_procs() -> Vec<Proc> {
    run(&mut ps_command(), CMD_TIMEOUT).map(|t| parse_ps(&t)).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn read_procs() -> Vec<Proc> {
    native::procs()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ps_command() -> Command {
    let mut c = Command::new("ps");
    // LC_ALL=C: %CPU 를 소수점(.)으로 찍게 한다
    c.env("LC_ALL", "C").args(["-A", "-o", "pid=,ppid=,pcpu=,rss=,args="]);
    c
}

/// 명령을 돌려 표준 출력을 받는다. 시간을 넘기면 죽이고 None
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn run(cmd: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(timeout) {
        Ok(buf) => {
            let _ = child.wait();
            Some(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

#[derive(Debug, Clone)]
struct Proc {
    pid: u32,
    ppid: u32,
    cpu: f32,
    /// KB
    rss: u64,
    args: String,
}

/// `ps -o pid=,ppid=,pcpu=,rss=,args=` 출력
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|l| {
            let mut rest = l.trim_start();
            let mut field = || {
                let (head, tail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                rest = tail.trim_start();
                head
            };
            let pid = field().parse().ok()?;
            let ppid = field().parse().ok()?;
            let cpu = field().replace(',', ".").parse().ok()?;
            let rss = field().parse().ok()?;
            Some(Proc { pid, ppid, cpu, rss, args: rest.trim().to_string() })
        })
        .collect()
}

/// 실행 파일 이름. node · bun · deno 로 도는 스크립트면 스크립트 이름도 본다 (예전 npm 판 claude 는 `node …/bin/claude`)
fn program_names(args: &str) -> Vec<String> {
    let base = |t: &str| {
        let b = t.rsplit(['/', '\\']).next().unwrap_or(t);
        let b = b.strip_suffix(".exe").unwrap_or(b);
        b.trim_end_matches(".js").trim_end_matches(".mjs").trim_end_matches(".cjs").trim_start_matches('-').to_string()
    };
    let mut tokens = args.split_whitespace();
    let Some(first) = tokens.next() else { return Vec::new() };
    let first = base(first);
    if matches!(first.as_str(), "node" | "bun" | "deno")
        && let Some(script) = tokens.find(|t| !t.starts_with('-'))
    {
        return vec![first, base(script)];
    }
    vec![first]
}

fn find(table: &[Proc], roots: &[(SessionId, u32)], names: &[String]) -> Vec<RunningAgent> {
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    let mut by_pid: HashMap<u32, &Proc> = HashMap::new();
    for p in table {
        children.entry(p.ppid).or_default().push(p);
        by_pid.insert(p.pid, p);
    }
    let mut found = Vec::new();
    for &(session, root) in roots {
        let mut stack: Vec<&Proc> = by_pid.get(&root).copied().into_iter().collect();
        let mut seen = 0;
        while let Some(p) = stack.pop() {
            seen += 1;
            if seen > 10_000 {
                break;
            }
            if let Some(name) = program_names(&p.args).into_iter().find(|n| names.contains(n)) {
                found.push(RunningAgent { session, name });
                break;
            }
            if let Some(kids) = children.get(&p.pid) {
                stack.extend(kids.iter().copied());
            }
        }
    }
    found
}

// ---- 리소스 관리자 ----

/// lsof 가 찍은 LISTEN 소켓 하나
#[derive(Debug, Clone, PartialEq)]
struct RawPort {
    pid: u32,
    process: String,
    address: String,
    port: u16,
}

/// `lsof -nP -iTCP -sTCP:LISTEN -F pcn` 출력. `p` 로 프로세스가 바뀌고 `n` 마다 소켓 하나다.
/// 같은 프로세스가 같은 포트를 IPv4 · IPv6 로 두 번 열면 하나로 친다
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof_listen(text: &str) -> Vec<RawPort> {
    let mut out: Vec<RawPort> = Vec::new();
    let mut seen = HashSet::new();
    let (mut pid, mut process) = (0u32, String::new());
    for line in text.lines() {
        let Some(tag) = line.chars().next() else { continue };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = value.parse().unwrap_or(0);
                process.clear();
            }
            'c' => process = value.to_string(),
            'n' if pid != 0 => {
                // `*:3000`, `127.0.0.1:3000`, `[::1]:3000`. 연결된 소켓(`->`)은 LISTEN 이 아니다
                if value.contains("->") {
                    continue;
                }
                let Some((address, port)) = value.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                if seen.insert((pid, port)) {
                    out.push(RawPort { pid, process: process.clone(), address: address.to_string(), port });
                }
            }
            _ => {}
        }
    }
    out
}

/// `lsof -a -p … -d cwd -Fn` 출력 → pid 마다 작업 폴더
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof_cwd(text: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let mut pid = 0u32;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix('p') {
            pid = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix('n')
            && pid != 0
        {
            out.entry(pid).or_insert_with(|| v.to_string());
        }
    }
    out
}

/// 한 번 읽은 프로세스 표와 포트
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    procs: Vec<Proc>,
    ports: Vec<RawPort>,
    cwds: HashMap<u32, String>,
    ports_error: Option<String>,
}

struct Cache {
    /// 마지막으로 읽은 때와 그것
    last: Option<(Instant, Snapshot)>,
    /// 포트 읽기가 시간을 넘긴 때. [`PORTS_BACKOFF`] 동안은 포트를 다시 읽지 않는다
    ports_failed_at: Option<Instant>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { last: None, ports_failed_at: None });

/// ps · lsof 를 읽는다. `fresh` 가 아니면 [`SNAPSHOT_REUSE`] 안에 읽은 것을 다시 쓴다
pub fn snapshot(fresh: bool) -> Snapshot {
    let mut cache = CACHE.lock().unwrap();
    if !fresh
        && let Some((at, snap)) = &cache.last
        && at.elapsed() < SNAPSHOT_REUSE
    {
        return snap.clone();
    }
    let procs = read_procs();
    let (mut ports, mut cwds, mut ports_error) = (Vec::new(), HashMap::new(), None);
    if cache.ports_failed_at.is_some_and(|t| t.elapsed() < PORTS_BACKOFF) {
        ports_error = Some("포트 읽기가 시간을 넘겨 잠시 쉬어요".to_string());
    } else {
        match read_ports() {
            Ok((p, c)) => {
                cache.ports_failed_at = None;
                (ports, cwds) = (p, c);
            }
            Err(e) => {
                cache.ports_failed_at = Some(Instant::now());
                ports_error = Some(e);
            }
        }
    }
    let snap = Snapshot { procs, ports, cwds, ports_error };
    cache.last = Some((Instant::now(), snap.clone()));
    snap
}

/// LISTEN 중인 TCP 포트와 그 프로세스들의 작업 폴더
#[cfg(target_os = "macos")]
fn read_ports() -> Result<(Vec<RawPort>, HashMap<u32, String>), String> {
    let mut lsof = Command::new("lsof");
    lsof.env("LC_ALL", "C").args(["-b", "-w", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
    let text = run(&mut lsof, CMD_TIMEOUT).ok_or("포트를 읽지 못했어요. lsof 가 없거나 시간을 넘겼어요")?;
    let ports = parse_lsof_listen(&text);
    let mut pids: Vec<u32> = ports.iter().map(|p| p.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    let mut cwds = HashMap::new();
    if !pids.is_empty() {
        let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let mut c = Command::new("lsof");
        c.env("LC_ALL", "C").args(["-b", "-w", "-a", "-p", &list, "-d", "cwd", "-Fn"]);
        cwds = run(&mut c, CMD_TIMEOUT).map(|t| parse_lsof_cwd(&t)).unwrap_or_default();
    }
    Ok((ports, cwds))
}

#[cfg(not(target_os = "macos"))]
fn read_ports() -> Result<(Vec<RawPort>, HashMap<u32, String>), String> {
    native::ports()
}

/// macOS 밖에서 프로세스 표 · 포트를 읽는다
#[cfg(not(target_os = "macos"))]
mod native {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    use super::{Proc, RawPort};

    /// CPU 몫은 앞서 읽은 때와의 차이로 세므로 표를 들고 있는다 (처음 읽은 것은 0 이다)
    static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

    fn with_system<T>(f: impl FnOnce(&mut System) -> T) -> T {
        let mut guard = SYSTEM.lock().unwrap();
        f(guard.get_or_insert_with(System::new))
    }

    pub fn procs() -> Vec<Proc> {
        with_system(|sys| {
            let kind = ProcessRefreshKind::nothing().with_cpu().with_memory().with_cmd(UpdateKind::OnlyIfNotSet);
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
            sys.processes()
                .values()
                .map(|p| {
                    let args = p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ");
                    Proc {
                        pid: p.pid().as_u32(),
                        ppid: p.parent().map_or(0, Pid::as_u32),
                        cpu: p.cpu_usage(),
                        rss: p.memory() / 1024,
                        args: if args.is_empty() { p.name().to_string_lossy().into_owned() } else { args },
                    }
                })
                .collect()
        })
    }

    pub fn ports() -> Result<(Vec<RawPort>, HashMap<u32, String>), String> {
        let all = listeners::get_all().map_err(|e| format!("포트를 읽지 못했어요: {e}"))?;
        let mut seen = HashSet::new();
        let mut ports: Vec<RawPort> = all
            .into_iter()
            .filter(|l| l.protocol == listeners::Protocol::TCP && l.state == listeners::SocketState::Listen)
            .filter(|l| seen.insert((l.process.pid, l.socket.port())))
            .map(|l| {
                let ip = l.socket.ip();
                let address = if ip.is_unspecified() {
                    "*".to_string()
                } else if ip.is_ipv6() {
                    format!("[{ip}]")
                } else {
                    ip.to_string()
                };
                RawPort { pid: l.process.pid, process: l.process.name, address, port: l.socket.port() }
            })
            .collect();
        ports.sort_by_key(|p| (p.pid, p.port));
        let pids: Vec<Pid> = ports.iter().map(|p| Pid::from_u32(p.pid)).collect::<HashSet<_>>().into_iter().collect();
        let cwds = with_system(|sys| {
            sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), false, ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always));
            pids.iter()
                .filter_map(|pid| Some((pid.as_u32(), sys.process(*pid)?.cwd()?.to_string_lossy().into_owned())))
                .collect()
        });
        Ok((ports, cwds))
    }
}

/// 리소스를 셀 세션: 번호, 셸 pid, `worktree` 꼬리표
pub struct SessionRoot {
    pub session: SessionId,
    pub pid: u32,
    pub worktree: Option<String>,
}

fn clip(s: &str) -> String {
    match s.char_indices().nth(COMMAND_MAX) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// `path` 가 `root` 그 자체이거나 그 안인지
fn under(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

/// 명령줄에 `root` 경로가 낱말로 들어 있는지 (`/a/b` 가 `/a/bc` 에 걸리지 않게 뒤 글자를 본다)
fn mentions(command: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return false;
    }
    command.match_indices(root).any(|(i, _)| {
        let before = command[..i].chars().next_back();
        let after = command[i + root.len()..].chars().next();
        let edge_before = before.is_none_or(|c| c.is_whitespace() || matches!(c, '=' | '"' | '\'' | ':'));
        let edge_after = after.is_none_or(|c| c.is_whitespace() || matches!(c, '/' | '"' | '\'' | ':'));
        edge_before && edge_after
    })
}

/// 가장 긴(가장 안쪽) 워크트리
fn longest(worktrees: &[String], hit: impl Fn(&str) -> bool) -> Option<&String> {
    worktrees.iter().filter(|w| hit(w)).max_by_key(|w| w.len())
}

/// 읽은 것을 세션 · 워크트리에 붙여 보고서를 만든다. `me` 는 데몬 pid
pub fn report(snap: &Snapshot, roots: &[SessionRoot], worktrees: &[String], me: u32) -> ProcessReport {
    let by_pid: HashMap<u32, &Proc> = snap.procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in &snap.procs {
        if p.pid != p.ppid {
            children.entry(p.ppid).or_default().push(p);
        }
    }
    for kids in children.values_mut() {
        kids.sort_by_key(|p| p.pid);
    }
    let root_of: HashMap<u32, usize> = roots.iter().enumerate().map(|(i, r)| (r.pid, i)).collect();
    // 프로세스마다 가장 가까운 조상 세션 (자기가 셸이면 자기)
    let owner = |pid: u32| -> Option<usize> {
        let mut cur = pid;
        for _ in 0..512 {
            if let Some(&i) = root_of.get(&cur) {
                return Some(i);
            }
            let p = by_pid.get(&cur)?;
            if p.ppid == cur || p.ppid == 0 {
                return None;
            }
            cur = p.ppid;
        }
        None
    };
    let mut ports_by_pid: HashMap<u32, Vec<u16>> = HashMap::new();
    for p in &snap.ports {
        ports_by_pid.entry(p.pid).or_default().push(p.port);
    }
    for v in ports_by_pid.values_mut() {
        v.sort_unstable();
    }
    let info = |p: &Proc, depth: u32| ProcessInfo {
        pid: p.pid,
        ppid: p.ppid,
        depth,
        cpu: p.cpu,
        rss: p.rss * 1024,
        command: clip(&p.args),
        ports: ports_by_pid.get(&p.pid).cloned().unwrap_or_default(),
    };

    let mut sessions = Vec::new();
    for r in roots {
        let mut s = SessionProcesses { session: r.session, pid: r.pid, cpu: 0.0, rss: 0, processes: Vec::new(), truncated: false };
        let mut stack: Vec<(&Proc, u32)> = by_pid.get(&r.pid).map(|p| (*p, 0)).into_iter().collect();
        let mut counted = HashSet::new();
        while let Some((p, depth)) = stack.pop() {
            // 다른 세션 셸 밑(세션 안에서 띄운 다른 데몬의 세션 등)은 그 세션이 센다. 이미 센 pid 는 다시 세지 않는다
            if (depth > 0 && root_of.contains_key(&p.pid)) || !counted.insert(p.pid) {
                continue;
            }
            s.cpu += p.cpu;
            s.rss += p.rss * 1024;
            if s.processes.len() < MAX_SESSION_PROCESSES {
                s.processes.push(info(p, depth));
            } else {
                s.truncated = true;
            }
            if let Some(kids) = children.get(&p.pid) {
                stack.extend(kids.iter().rev().map(|k| (*k, depth + 1)));
            }
        }
        sessions.push(s);
    }

    let mut ports: Vec<ListenPort> = snap
        .ports
        .iter()
        .map(|raw| {
            let command = by_pid.get(&raw.pid).map(|p| clip(&p.args)).unwrap_or_default();
            let cwd = snap.cwds.get(&raw.pid).cloned();
            let mut port = ListenPort {
                port: raw.port,
                address: raw.address.clone(),
                pid: raw.pid,
                process: raw.process.clone(),
                command,
                cwd,
                session: None,
                worktree: None,
                via: PortVia::External,
            };
            if raw.pid == me {
                // 데몬 자신(원격 접속 포트)은 세션 밖이다
            } else if let Some(i) = owner(raw.pid) {
                port.session = Some(roots[i].session);
                port.worktree = roots[i].worktree.clone();
                port.via = PortVia::Tree;
            } else if let Some(w) = port.cwd.as_deref().and_then(|cwd| longest(worktrees, |w| under(cwd, w))) {
                port.worktree = Some(w.clone());
                port.via = PortVia::Cwd;
            } else if let Some(w) = longest(worktrees, |w| mentions(&port.command, w)) {
                port.worktree = Some(w.clone());
                port.via = PortVia::Command;
            }
            port
        })
        .collect();
    ports.sort_by_key(|p| (p.via == PortVia::External, p.port, p.pid));
    let ports_truncated = ports.len() > MAX_PORTS;
    ports.truncate(MAX_PORTS);

    let daemon = by_pid.get(&me).map(|p| info(p, 0)).unwrap_or(ProcessInfo { pid: me, ..Default::default() });
    ProcessReport { daemon, sessions, ports, ports_truncated, ports_error: snap.ports_error.clone() }
}

/// 포트를 연 프로세스를 멈춘다 (SIGTERM). 다시 읽어 그 pid 가 아직 그 포트에서 LISTEN 이고 세션 · 워크트리 것일 때만
pub fn stop_port_process(pid: u32, port: u16, roots: &[SessionRoot], worktrees: &[String]) -> Result<(), String> {
    let me = std::process::id();
    if pid == me {
        return Err("thuminal 데몬 자신은 멈출 수 없어요".into());
    }
    let r = report(&snapshot(true), roots, worktrees, me);
    if let Some(e) = r.ports_error {
        return Err(e);
    }
    let Some(p) = r.ports.iter().find(|p| p.pid == pid && p.port == port) else {
        return Err(format!("pid {pid} 는 이제 포트 {port} 를 열고 있지 않아요"));
    };
    if p.via == PortVia::External {
        return Err(format!("포트 {port} 는 세션이나 워크트리 밖 프로세스라 멈출 수 없어요"));
    }
    // 다른 thuminal 데몬(개발 데몬 등)은 그 밑 터미널이 모두 끝나므로 멈추지 않는다
    if program_names(&p.command).iter().any(|n| n == "thuminald") || p.process == "thuminald" {
        return Err("thuminal 데몬은 멈출 수 없어요".into());
    }
    if pid <= 1 {
        return Err("pid 가 올바르지 않아요".into());
    }
    crate::sys::terminate(pid).map_err(|e| format!("pid {pid} 를 멈추지 못했어요: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_agent_under_session_shell() {
        let ps = "    1     0   0.0  100 /sbin/launchd\n  100     1   0.0  100 -zsh\n  101   100   0.0  100 /bin/sh /x/shell/claude-launch\n  102   101   3.5  100 /Users/a/.local/bin/claude --resume x\n  200     1   0.0  100 -zsh\n  201   200   0.0  100 node /opt/homebrew/bin/codex\n  300     1   0.0  100 -zsh\n  301   300   0.0  100 vim claude.md\n";
        let t = parse_ps(ps);
        let names = vec!["claude".to_string(), "codex".to_string()];
        let found = find(&t, &[(SessionId(1), 100), (SessionId(2), 200), (SessionId(3), 300), (SessionId(4), 999)], &names);
        assert_eq!(
            found,
            vec![RunningAgent { session: SessionId(1), name: "claude".into() }, RunningAgent { session: SessionId(2), name: "codex".into() }]
        );
    }

    #[test]
    fn reads_real_ps() {
        let me = std::process::id();
        let found = running_agents(&[(SessionId(1), me)], &["thuminal_daemon-unused".into()]);
        assert!(found.is_empty());
        let snap = snapshot(true);
        assert!(snap.procs.iter().any(|p| p.pid == me), "ps 에 이 시험 프로세스가 있어야 한다");
        let r = report(&snap, &[], &[], me);
        assert_eq!(r.daemon.pid, me);
        assert!(r.daemon.rss > 0);
    }

    #[test]
    fn parses_ps_columns() {
        let t = parse_ps("  10     1  12.5  2048 /usr/bin/python3 -m http.server 8765\n  11    10   0,3    16 sleep 1\nbad line\n");
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].pid, t[0].ppid, t[0].cpu, t[0].rss), (10, 1, 12.5, 2048));
        assert_eq!(t[0].args, "/usr/bin/python3 -m http.server 8765");
        assert_eq!(t[1].cpu, 0.3);
    }

    #[test]
    fn parses_lsof_listen() {
        let text = "p711\ncrapportd\nf11\nn*:51463\nf15\nn*:51463\np900\ncnode\nf20\nn127.0.0.1:3000\nf21\nn[::1]:3000\nf22\nn127.0.0.1:3000->127.0.0.1:5000\np901\ncPython\nf3\nn*:8765\n";
        let ports = parse_lsof_listen(text);
        assert_eq!(
            ports,
            vec![
                RawPort { pid: 711, process: "rapportd".into(), address: "*".into(), port: 51463 },
                RawPort { pid: 900, process: "node".into(), address: "127.0.0.1".into(), port: 3000 },
                RawPort { pid: 901, process: "Python".into(), address: "*".into(), port: 8765 },
            ]
        );
        let cwds = parse_lsof_cwd("p900\nfcwd\nn/w/app\np901\nfcwd\nn/\n");
        assert_eq!(cwds.get(&900).map(String::as_str), Some("/w/app"));
        assert_eq!(cwds.get(&901).map(String::as_str), Some("/"));
    }

    fn snap() -> Snapshot {
        // 1: launchd, 50: 데몬, 100 · 200: 세션 셸, 300: 세션 안에서 띄운 다른 셸(세션 3)
        let ps = "\
    1     0   0.0  1000 /sbin/launchd
   50     1   1.0  4000 thuminald --home /h
  100    50   0.5  2000 -zsh
  101   100  10.0  8000 python3 -m http.server 8765
  102   100   0.0  1000 npm run dev
  103   102  20.0 16000 node /w/app/node_modules/.bin/vite
  200    50   0.0  2000 -zsh
  201   200   0.0  1000 sleep 100
  300   201   0.0  2000 -zsh
  301   300   5.0  3000 python3 -m http.server 9000
  400     1   2.0  5000 node /w/app-feature/server.js --port 4000
  500     1   0.0  1000 /usr/bin/ruby -run -e httpd /w/app-feature -p 5000
  600     1   0.0  1000 ControlCenter
";
        let lsof = "p50\ncthuminald\nn*:6780\np101\ncPython\nn*:8765\np103\ncnode\nn[::1]:5173\nn127.0.0.1:5173\np301\ncPython\nn*:9000\np400\ncnode\nn*:4000\np500\ncruby\nn*:5000\np600\ncControlCenter\nn*:7000\n";
        let cwds = "p101\nn/w/app\np103\nn/w/app\np400\nn/w/app-feature/sub\np500\nn/\np600\nn/\n";
        Snapshot { procs: parse_ps(ps), ports: parse_lsof_listen(lsof), cwds: parse_lsof_cwd(cwds), ports_error: None }
    }

    fn roots() -> Vec<SessionRoot> {
        vec![
            SessionRoot { session: SessionId(1), pid: 100, worktree: Some("/w/app".into()) },
            SessionRoot { session: SessionId(2), pid: 200, worktree: None },
            SessionRoot { session: SessionId(3), pid: 300, worktree: Some("/w/app".into()) },
        ]
    }

    #[test]
    fn sums_session_trees() {
        let r = report(&snap(), &roots(), &["/w/app".into(), "/w/app-feature".into()], 50);
        let s1 = &r.sessions[0];
        assert_eq!(s1.processes.iter().map(|p| (p.pid, p.depth)).collect::<Vec<_>>(), vec![(100, 0), (101, 1), (102, 1), (103, 2)]);
        assert!((s1.cpu - 30.5).abs() < 0.01);
        assert_eq!(s1.rss, (2000 + 8000 + 1000 + 16000) * 1024);
        assert_eq!(s1.processes[1].ports, vec![8765]);
        assert_eq!(s1.processes[3].ports, vec![5173]);
        // 세션 2 밑에서 띄운 세션 3 셸은 세션 3 이 센다
        assert_eq!(r.sessions[1].processes.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![200, 201]);
        assert_eq!(r.sessions[2].processes.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![300, 301]);
        assert_eq!((r.daemon.pid, r.daemon.rss), (50, 4000 * 1024));
    }

    #[test]
    fn attaches_ports_by_tree_then_cwd_then_command() {
        let r = report(&snap(), &roots(), &["/w/app".into(), "/w/app-feature".into()], 50);
        let got: Vec<_> = r.ports.iter().map(|p| (p.port, p.session.map(|s| s.0), p.worktree.as_deref(), p.via)).collect();
        assert_eq!(
            got,
            vec![
                (4000, None, Some("/w/app-feature"), PortVia::Cwd),
                (5000, None, Some("/w/app-feature"), PortVia::Command),
                (5173, Some(1), Some("/w/app"), PortVia::Tree),
                (8765, Some(1), Some("/w/app"), PortVia::Tree),
                (9000, Some(3), Some("/w/app"), PortVia::Tree),
                (6780, None, None, PortVia::External),
                (7000, None, None, PortVia::External),
            ]
        );
        // IPv6 · IPv4 로 두 번 연 5173 은 하나다
        assert_eq!(r.ports.iter().filter(|p| p.port == 5173).count(), 1);
    }

    #[test]
    fn matches_worktree_paths_by_whole_segment() {
        assert!(under("/w/app", "/w/app"));
        assert!(under("/w/app/src", "/w/app/"));
        assert!(!under("/w/app-feature", "/w/app"));
        assert!(mentions("node /w/app/server.js", "/w/app"));
        assert!(mentions("ruby --dir=/w/app", "/w/app"));
        assert!(!mentions("node /w/app-feature/server.js", "/w/app"));
        assert!(!mentions("node /x/w/app/server.js", "/w/app"));
    }

    #[test]
    fn refuses_to_stop_daemon() {
        assert!(stop_port_process(std::process::id(), 1, &[], &[]).is_err());
    }
}
