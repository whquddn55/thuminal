//! claude 에이전트 팀: claude 가 팀원 칸을 tmux 로 나누려 하면 그 명령을 받아 팀원 세션을 띄운다.
//!
//! claude 실행기(`shell.rs`)가 `TMUX`·`TMUX_PANE` 을 넣고 가짜 `tmux`(→ `thuminal tmux`)를 PATH 앞에 둔다.
//! claude 는 자기가 tmux 안에 있다고 믿고 팀원마다 다음을 부른다 (claude 2.1 실행 파일에서 확인했다):
//!
//! 1. `display-message -p '#{window_id}'`, `list-panes -F '#{pane_id}'` 로 지금 창의 칸을 센다
//! 2. `split-window -d -t %리더 -h -l 70% -P -F '#{pane_id}' -- cat` 으로 빈 칸을 만든다
//! 3. `set-option -p -t %N window-style 'bg=default,fg=<색>'`, `select-pane -t %N -T <이름>`
//! 4. `set-option -p remain-on-exit failed` 뒤 `respawn-pane -k -t %N -- <팀원 claude 명령>`
//! 5. 끝나면 `kill-pane -t %N`
//!
//! 팀원은 배치 트리(분할)에 넣지 않는다. 꼬리표 `layout=none` + `team.*` 를 단 세션으로 만들고, 화면이 리더 칸에 딸려 그린다.
//! 상태는 세션 꼬리표에만 둔다: 리더 = 꼬리표 `team.leader`, claude 가 아는 칸 번호 = `team.pane`.
//! 리더 칸 번호는 `%<리더 세션 번호>`, 팀원 칸 번호는 처음 만든 세션 번호다 (다시 띄워도 그대로).

use std::collections::BTreeMap;
use std::sync::Arc;

use thuminal_protocol::{
    CreateSession, ErrorBody, Event, LAYOUT_LABEL, ScreenFormat, SessionId, SessionInfo, SessionState, TEAM_COLOR_LABEL,
    TEAM_LEADER_LABEL, TEAM_NAME_LABEL, TEAM_PANE_LABEL, WORKTREE_LABEL,
};
use tracing::{info, warn};

use crate::manager::Manager;

/// 팀원 세션을 처음 띄우는 크기. 화면이 붙으면 패널 크기로 맞춘다
const COLS: u16 = 100;
const ROWS: u16 = 30;

/// tmux 명령 하나의 결과
#[derive(Debug, Default, PartialEq)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

fn ok(stdout: impl Into<String>) -> Result<String, String> {
    Ok(stdout.into())
}

/// 부른 쪽 정보
pub struct Call {
    pub session: SessionId,
    pub pane: Option<String>,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// 칸 하나 (리더 또는 팀원)
#[derive(Debug, Clone)]
struct Member {
    /// `%12`
    pane: String,
    session: SessionInfo,
}

struct Team {
    leader: SessionInfo,
    /// 리더가 맨 앞
    members: Vec<Member>,
}

impl Team {
    fn find(&self, target: &str) -> Result<&Member, String> {
        self.members.iter().find(|m| m.pane == target).ok_or_else(|| format!("can't find pane: {target}"))
    }
}

fn leader_pane(id: SessionId) -> String {
    format!("%{}", id.0)
}

/// tmux 인자: 값 있는 깃발, 값 없는 깃발, 나머지
struct Args {
    flags: Vec<char>,
    values: BTreeMap<char, Vec<String>>,
    rest: Vec<String>,
}

impl Args {
    fn parse(args: &[String], with_value: &str) -> Self {
        let mut out = Args { flags: Vec::new(), values: BTreeMap::new(), rest: Vec::new() };
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            if a == "--" {
                out.rest.extend(args[i + 1..].iter().cloned());
                break;
            }
            if !out.rest.is_empty() || !a.starts_with('-') || a == "-" {
                out.rest.push(a.clone());
                i += 1;
                continue;
            }
            let chars: Vec<char> = a[1..].chars().collect();
            let mut j = 0;
            while j < chars.len() {
                let c = chars[j];
                if with_value.contains(c) {
                    let tail: String = chars[j + 1..].iter().collect();
                    let v = if tail.is_empty() {
                        i += 1;
                        args.get(i).cloned().unwrap_or_default()
                    } else {
                        tail
                    };
                    out.values.entry(c).or_default().push(v);
                    break;
                }
                out.flags.push(c);
                j += 1;
            }
            i += 1;
        }
        out
    }

    fn has(&self, c: char) -> bool {
        self.flags.contains(&c)
    }

    fn value(&self, c: char) -> Option<&str> {
        self.values.get(&c).and_then(|v| v.last()).map(String::as_str)
    }
}

/// `#{pane_id}` 같은 자리를 채운다. 모르는 자리는 비운다
fn render(format: &str, vars: &BTreeMap<&str, String>) -> String {
    let mut out = String::new();
    let mut rest = format;
    while let Some(start) = rest.find("#{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                if let Some(v) = vars.get(&after[..end]) {
                    out.push_str(v);
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// tmux `send-keys` 의 키 이름을 글자로 바꾼다. `-l` 이면 그대로 잇는다
fn keys_text(keys: &[String], literal: bool) -> String {
    if literal {
        return keys.join(" ");
    }
    keys.iter()
        .map(|k| match k.to_ascii_lowercase().as_str() {
            "enter" | "c-m" | "kpenter" => "\r".to_string(),
            "tab" | "c-i" => "\t".into(),
            "space" => " ".into(),
            "bspace" | "backspace" => "\x7f".into(),
            "escape" | "esc" | "c-[" => "\x1b".into(),
            "c-c" => "\x03".into(),
            "c-d" => "\x04".into(),
            "c-z" => "\x1a".into(),
            "c-l" => "\x0c".into(),
            "c-u" => "\x15".into(),
            _ => k.clone(),
        })
        .collect()
}

/// `bg=default,fg=red` 에서 fg 색을 꺼낸다
fn fg_color(style: &str) -> Option<String> {
    style.split(',').find_map(|p| p.trim().strip_prefix("fg=")).filter(|c| !c.is_empty() && *c != "default").map(str::to_string)
}

pub struct Teams {
    manager: Arc<Manager>,
}

impl Teams {
    pub fn new(manager: Arc<Manager>) -> Arc<Self> {
        Arc::new(Self { manager })
    }

    /// 리더 세션이 지워지면 팀원도 지우고, 팀원이 탈 없이 끝나면 지운다 (tmux 도 칸을 닫는다)
    pub async fn watch(self: Arc<Self>) {
        let mut events = self.manager.events.subscribe();
        loop {
            match events.recv().await {
                Ok(Event::SessionRemoved { session }) => {
                    for m in self.manager.list().into_iter().filter(|s| leader_of(s) == Some(session)) {
                        info!(event = "teammate_removed_with_leader", leader = session.0, session = m.id.0);
                        let _ = self.manager.remove(m.id);
                    }
                }
                Ok(Event::SessionExited { session, code: Some(0) }) => {
                    if self.manager.info(session).is_ok_and(|s| leader_of(&s).is_some()) {
                        let _ = self.manager.remove(session);
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return,
            }
        }
    }

    fn team(&self, caller: SessionId) -> Result<Team, String> {
        let all = self.manager.list();
        let me = all.iter().find(|s| s.id == caller).ok_or_else(|| format!("no session {caller}"))?;
        let leader_id = leader_of(me).unwrap_or(caller);
        let leader = all.iter().find(|s| s.id == leader_id).cloned().ok_or("leader session is gone")?;
        let mut members = vec![Member { pane: leader_pane(leader_id), session: leader.clone() }];
        let mut mates: Vec<Member> = all
            .iter()
            .filter(|s| leader_of(s) == Some(leader_id))
            .map(|s| Member { pane: s.labels.get(TEAM_PANE_LABEL).cloned().unwrap_or_else(|| leader_pane(s.id)), session: s.clone() })
            .collect();
        mates.sort_by_key(|m| m.pane.trim_start_matches('%').parse::<u64>().unwrap_or(u64::MAX));
        members.extend(mates);
        Ok(Team { leader, members })
    }

    pub async fn call(&self, call: Call) -> Output {
        let line = call.argv.join(" ");
        match self.dispatch(&call).await {
            Ok(stdout) => {
                info!(event = "tmux_call", session = call.session.0, argv = %line);
                Output { stdout, stderr: String::new(), code: 0 }
            }
            Err(e) => {
                warn!(event = "tmux_call_failed", session = call.session.0, argv = %line, error = %e);
                Output { stdout: String::new(), stderr: format!("{e}\n"), code: 1 }
            }
        }
    }

    async fn dispatch(&self, call: &Call) -> Result<String, String> {
        // 앞쪽 전역 깃발(-S 소켓, -L 이름, -f 설정)을 건너뛴다
        let mut i = 0;
        while i < call.argv.len() {
            match call.argv[i].as_str() {
                "-S" | "-L" | "-f" => i += 2,
                "-V" | "-v" => return ok("tmux 3.4\n"),
                a if a.starts_with('-') && a.len() > 1 && !a.starts_with("--") => i += 1,
                _ => break,
            }
        }
        let Some(command) = call.argv.get(i) else { return Err("no command".into()) };
        let args = &call.argv[i + 1..];
        let team = self.team(call.session)?;
        let me = call.pane.clone().filter(|p| team.members.iter().any(|m| &m.pane == p)).unwrap_or_else(|| {
            team.members.iter().find(|m| m.session.id == call.session).map(|m| m.pane.clone()).unwrap_or_else(|| leader_pane(call.session))
        });
        // `-t` 가 칸이 아니라 창·세션(`@1`, `thuminal:0`)이면 부른 칸으로 친다
        let target = |a: &Args| -> String {
            match a.value('t') {
                Some(t) if t.starts_with('%') => t.to_string(),
                _ => me.clone(),
            }
        };
        match command.as_str() {
            "display-message" | "display" => {
                let a = Args::parse(args, "Fct");
                let m = team.find(&target(&a))?;
                let format = if a.rest.is_empty() { a.value('F').unwrap_or("").to_string() } else { a.rest.join(" ") };
                ok(format!("{}\n", render(&format, &self.vars(&team, m))))
            }
            "list-panes" | "lsp" => {
                let a = Args::parse(args, "Fft");
                let format = a.value('F').unwrap_or("#{pane_id}");
                ok(team.members.iter().map(|m| format!("{}\n", render(format, &self.vars(&team, m)))).collect::<String>())
            }
            "list-windows" | "lsw" => {
                let a = Args::parse(args, "Fft");
                let format = a.value('F').unwrap_or("#{window_name}");
                ok(format!("{}\n", render(format, &self.vars(&team, &team.members[0]))))
            }
            "split-window" | "splitw" | "new-window" | "neww" => {
                let a = Args::parse(args, "cClFtnte");
                let from = team.find(&target(&a)).map(|m| m.session.clone()).unwrap_or_else(|_| team.leader.clone());
                let pane = self.spawn_mate(&team, None, &from, &a, call)?;
                if !a.has('P') {
                    return ok("");
                }
                let made = self.team(call.session)?;
                let m = made.find(&pane)?;
                ok(format!("{}\n", render(a.value('F').unwrap_or("#{pane_id}"), &self.vars(&made, m))))
            }
            "respawn-pane" | "respawnp" => {
                let a = Args::parse(args, "cet");
                let t = target(&a);
                let m = team.find(&t)?;
                if m.session.id == team.leader.id {
                    return Err("refusing to respawn the leader pane".into());
                }
                if a.rest.is_empty() {
                    return ok("");
                }
                let old = m.session.clone();
                self.spawn_mate(&team, Some(&old), &old, &a, call)?;
                let _ = self.manager.remove(old.id);
                ok("")
            }
            "kill-pane" | "killp" => {
                let a = Args::parse(args, "t");
                let m = team.find(&target(&a))?;
                if m.session.id == team.leader.id {
                    return Err("refusing to kill the leader pane".into());
                }
                info!(event = "teammate_killed", leader = team.leader.id.0, session = m.session.id.0);
                self.manager.remove(m.session.id).map_err(|e| e.message)?;
                ok("")
            }
            "select-pane" | "selectp" => {
                let a = Args::parse(args, "PTt");
                if let Some(title) = a.value('T')
                    && let m = team.find(&target(&a))?
                    && m.session.id != team.leader.id
                {
                    self.label(m.session.id, TEAM_NAME_LABEL, title)?;
                }
                ok("")
            }
            "set-option" | "set" | "set-window-option" | "setw" => {
                let a = Args::parse(args, "t");
                if let [name, value, ..] = a.rest.as_slice()
                    && matches!(name.as_str(), "window-style" | "pane-border-style")
                    && let (Some(color), Ok(m)) = (fg_color(value), team.find(&target(&a)))
                    && m.session.id != team.leader.id
                {
                    self.label(m.session.id, TEAM_COLOR_LABEL, &color)?;
                }
                ok("")
            }
            "send-keys" | "send" => {
                let a = Args::parse(args, "Nt");
                let m = team.find(&target(&a))?;
                let text = keys_text(&a.rest, a.has('l'));
                if !text.is_empty() {
                    self.manager.input(m.session.id, text.into_bytes()).map_err(|e| e.message)?;
                }
                ok("")
            }
            "capture-pane" | "capturep" => {
                let a = Args::parse(args, "ESbt");
                let m = team.find(&target(&a))?;
                let text = self.manager.read_screen(m.session.id, ScreenFormat::Plain, false).await.map_err(|e| e.message)?;
                ok(if a.has('p') { format!("{text}\n") } else { String::new() })
            }
            "show-options" | "show-option" | "show" | "show-window-options" | "showw" => {
                let a = Args::parse(args, "t");
                match a.rest.last().map(String::as_str) {
                    Some("extended-keys") => ok(if a.has('v') { "on\n" } else { "extended-keys on\n" }),
                    Some("prefix") => ok(if a.has('v') { "C-b\n" } else { "prefix C-b\n" }),
                    // claude 는 꺼져 있으면 "add 'set -g focus-events on'" 을 띄운다. thuminal 터미널은 포커스 신호를 보낸다
                    Some("focus-events") => ok(if a.has('v') { "on\n" } else { "focus-events on\n" }),
                    _ => ok(""),
                }
            }
            "has-session" | "has" | "new-session" | "new" | "kill-session" | "resize-pane" | "resizep" | "select-layout" | "selectl"
            | "set-hook" | "refresh-client" | "attach-session" | "attach" | "detach-client" | "switch-client" | "source-file"
            | "wait-for" | "last-pane" | "rename-window" | "set-environment" => ok(""),
            other => Err(format!("thuminal tmux: unsupported command {other}")),
        }
    }

    fn vars(&self, team: &Team, m: &Member) -> BTreeMap<&'static str, String> {
        let index = team.members.iter().position(|x| x.pane == m.pane).unwrap_or(0);
        let window = format!("@{}", team.leader.id.0);
        let title = m.session.labels.get(TEAM_NAME_LABEL).cloned().unwrap_or_else(|| m.session.title.clone());
        [
            ("session_name", "thuminal".to_string()),
            ("session_id", "$0".into()),
            ("window_id", window),
            ("window_index", "0".into()),
            ("window_name", "thuminal".into()),
            ("window_active", "1".into()),
            ("window_width", team.leader.cols.to_string()),
            ("window_height", team.leader.rows.to_string()),
            ("pane_id", m.pane.clone()),
            ("pane_index", index.to_string()),
            ("pane_active", if index == 0 { "1" } else { "0" }.into()),
            ("pane_title", title),
            ("pane_width", m.session.cols.to_string()),
            ("pane_height", m.session.rows.to_string()),
            ("pane_pid", m.session.pid.map(|p| p.to_string()).unwrap_or_default()),
            ("pane_current_path", m.session.cwd.clone()),
            ("pane_dead", if matches!(m.session.state, SessionState::Exited { .. }) { "1" } else { "0" }.into()),
        ]
        .into()
    }

    fn label(&self, session: SessionId, key: &str, value: &str) -> Result<(), String> {
        self.manager.set_labels(session, [(key.to_string(), value.to_string())].into()).map(|_| ()).map_err(|e| e.message)
    }

    /// 팀원 세션을 띄우고 claude 가 아는 칸 번호를 돌려준다. `replace` 가 있으면 그 칸 번호·이름·색을 이어받는다
    fn spawn_mate(&self, team: &Team, replace: Option<&SessionInfo>, near: &SessionInfo, a: &Args, call: &Call) -> Result<String, String> {
        let command = a.rest.join(" ");
        let mut env: BTreeMap<String, String> =
            call.env.iter().filter(|(k, _)| matches!(k.as_str(), "PATH" | "TMUX" | "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")).map(|(k, v)| (k.clone(), v.clone())).collect();
        for kv in a.values.get(&'e').into_iter().flatten() {
            if let Some((k, v)) = kv.split_once('=') {
                env.insert(k.into(), v.into());
            }
        }
        let mut labels: BTreeMap<String, String> = [
            (LAYOUT_LABEL.to_string(), "none".to_string()),
            (TEAM_LEADER_LABEL.to_string(), team.leader.id.0.to_string()),
        ]
        .into();
        if let Some(w) = team.leader.labels.get(WORKTREE_LABEL) {
            labels.insert(WORKTREE_LABEL.into(), w.clone());
        }
        if let Some(old) = replace {
            for k in [TEAM_PANE_LABEL, TEAM_NAME_LABEL, TEAM_COLOR_LABEL] {
                if let Some(v) = old.labels.get(k) {
                    labels.insert(k.into(), v.clone());
                }
            }
        }
        let cwd = a.value('c').map(str::to_string).or_else(|| call.cwd.clone()).or_else(|| Some(near.cwd.clone()));
        let req = CreateSession {
            command: if command.is_empty() { Vec::new() } else { vec!["/bin/sh".into(), "-c".into(), command] },
            cwd,
            env,
            cols: COLS,
            rows: ROWS,
            labels,
        };
        // 칸 번호(`team.pane`)가 없으면 데몬이 새 세션 번호로 달고 `TMUX_PANE` 에 넣는다 (`Manager::create_with`)
        let info = self.manager.create(req).map_err(|e: ErrorBody| e.message)?;
        let pane = info.labels.get(TEAM_PANE_LABEL).cloned().unwrap_or_else(|| leader_pane(info.id));
        info!(event = "teammate_spawned", leader = team.leader.id.0, session = info.id.0, pane, respawn = replace.is_some());
        Ok(pane)
    }
}

/// 팀원 세션이면 리더 세션 번호
pub fn leader_of(s: &SessionInfo) -> Option<SessionId> {
    s.labels.get(TEAM_LEADER_LABEL).and_then(|v| v.parse().ok()).map(SessionId)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_claude_split() {
        let a = Args::parse(&v(&["-d", "-t", "%3", "-h", "-l", "70%", "-P", "-F", "#{pane_id}", "--", "cat"]), "cClFtnte");
        assert!(a.has('d') && a.has('h') && a.has('P'));
        assert_eq!(a.value('t'), Some("%3"));
        assert_eq!(a.value('l'), Some("70%"));
        assert_eq!(a.value('F'), Some("#{pane_id}"));
        assert_eq!(a.rest, v(&["cat"]));
        let b = Args::parse(&v(&["-p", "-t", "%9", "window-style", "bg=default,fg=colour208"]), "t");
        assert_eq!(b.rest, v(&["window-style", "bg=default,fg=colour208"]));
        assert_eq!(fg_color(&b.rest[1]).as_deref(), Some("colour208"));
    }

    #[test]
    fn renders_formats_and_keys() {
        let vars: BTreeMap<&str, String> = [("pane_id", "%4".to_string()), ("window_id", "@1".into())].into();
        assert_eq!(render("#{pane_id}", &vars), "%4");
        assert_eq!(render("#{window_id}:#{pane_id} #{nope}!", &vars), "@1:%4 !");
        assert_eq!(keys_text(&v(&["echo hi", "Enter"]), false), "echo hi\r");
        assert_eq!(keys_text(&v(&["a", "b"]), true), "a b");
    }
}
