//! 세션 셸 밑에서 도는 프로세스 찾기. 탭을 닫기 전에 claude 같은 에이전트가 떠 있는지 본다
//! (에이전트 훅이 알려 오지 않은 경우: 플러그인 없이 띄운 claude, 훅이 아직 오지 않은 claude).

use std::collections::HashMap;
use std::process::Command;

use thuminal_protocol::{RunningAgent, SessionId};

/// `roots`(세션, 셸 pid) 의 자손 프로세스 중 이름이 `names` 에 든 것. 세션마다 처음 찾은 하나만 낸다
pub fn running_agents(roots: &[(SessionId, u32)], names: &[String]) -> Vec<RunningAgent> {
    let Ok(out) = Command::new("ps").args(["-A", "-o", "pid=,ppid=,args="]).output() else { return Vec::new() };
    let table = parse_ps(&String::from_utf8_lossy(&out.stdout));
    find(&table, roots, names)
}

struct Proc {
    pid: u32,
    ppid: u32,
    args: String,
}

fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.trim_start().splitn(2, char::is_whitespace);
            let pid = it.next()?.parse().ok()?;
            let rest = it.next()?.trim_start();
            let mut it = rest.splitn(2, char::is_whitespace);
            let ppid = it.next()?.parse().ok()?;
            Some(Proc { pid, ppid, args: it.next().unwrap_or("").trim().to_string() })
        })
        .collect()
}

/// 실행 파일 이름. node · bun · deno 로 도는 스크립트면 스크립트 이름도 본다 (예전 npm 판 claude 는 `node …/bin/claude`)
fn program_names(args: &str) -> Vec<String> {
    let base = |t: &str| {
        let b = t.rsplit('/').next().unwrap_or(t);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_agent_under_session_shell() {
        let ps = "    1     0 /sbin/launchd\n  100     1 -zsh\n  101   100 /bin/sh /x/shell/claude-launch\n  102   101 /Users/a/.local/bin/claude --resume x\n  200     1 -zsh\n  201   200 node /opt/homebrew/bin/codex\n  300     1 -zsh\n  301   300 vim claude.md\n";
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
    }
}
