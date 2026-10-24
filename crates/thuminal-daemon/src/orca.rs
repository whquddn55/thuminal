//! Orca 에서 가져오기: Orca 에 등록한 저장소, 워크트리 이름·메모, 탭에 붙은 claude 세션을 읽는다.
//!
//! Orca 는 프로필마다 `~/Library/Application Support/orca/profiles/<프로필>/profile-state.db`(sqlite)에
//! 문서(`domain` → JSON `payload`)를 둔다. 옛 판은 같은 폴더의 `orca-data.json` 한 파일이다.
//! sqlite 는 macOS 에 들어 있는 `sqlite3` 를 읽기 전용으로 부른다 (Orca 가 떠 있어도 건드리지 않는다).
//! 읽기만 하고 바꾸지 않는다. 고른 것을 등록하고 탭을 여는 일은 앱이 한다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use thuminal_protocol::{OrcaRepo, OrcaScan, OrcaSession, OrcaWorktree};
use tracing::info;

/// Orca 떠 있는 터미널 워크트리 id
const FLOATING: &str = "global-floating-terminal";

fn orca_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/orca"))
}

/// 지금 고른 프로필 폴더
fn profile_dir(home: &Path) -> PathBuf {
    let id = std::fs::read(home.join("orca-profile-index.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("activeProfileId").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "local-default".into());
    home.join("profiles").join(id)
}

/// 문서 몇 개를 읽는다: sqlite 가 있으면 거기서, 없으면 orca-data.json 에서
fn documents(profile: &Path, domains: &[&str]) -> Result<BTreeMap<String, Value>, String> {
    let db = profile.join("profile-state.db");
    if db.is_file() {
        let list = domains.iter().map(|d| format!("'{d}'")).collect::<Vec<_>>().join(",");
        let out = std::process::Command::new("sqlite3")
            .args(["-readonly", "-json"])
            .arg(&db)
            .arg(format!("select domain, payload from profile_state_documents where domain in ({list})"))
            .output()
            .map_err(|e| format!("sqlite3 을 실행하지 못했다: {e}"))?;
        if !out.status.success() {
            return Err(format!("Orca 상태 파일을 읽지 못했다: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let rows: Vec<Value> = if out.stdout.iter().all(u8::is_ascii_whitespace) { Vec::new() } else { serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())? };
        return Ok(rows
            .into_iter()
            .filter_map(|r| {
                let domain = r.get("domain")?.as_str()?.to_string();
                let payload = serde_json::from_str(r.get("payload")?.as_str()?).ok()?;
                Some((domain, payload))
            })
            .collect());
    }
    let json = profile.join("orca-data.json");
    let all: Value = serde_json::from_slice(&std::fs::read(&json).map_err(|e| format!("Orca 데이터가 없다: {} ({e})", json.display()))?).map_err(|e| e.to_string())?;
    Ok(domains.iter().filter_map(|d| all.get(*d).map(|v| (d.to_string(), v.clone()))).collect())
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `✳ 제목` · `◐ 제목` 처럼 claude 가 앞에 붙이는 상태 글자를 뗀다
fn clean_title(t: &str) -> String {
    t.trim_start_matches(|c: char| !c.is_alphanumeric() && !('가'..='힣').contains(&c)).trim().to_string()
}

/// claude 세션 기록 파일과 그 세션을 띄운 폴더, 마지막으로 쓴 때(ms)
fn transcript(session: &str, hint: Option<&str>) -> Option<(String, u64)> {
    let path = hint.map(PathBuf::from).filter(|p| p.is_file()).or_else(|| {
        let projects = PathBuf::from(std::env::var_os("HOME")?).join(".claude/projects");
        std::fs::read_dir(projects).ok()?.flatten().map(|d| d.path().join(format!("{session}.jsonl"))).find(|p| p.is_file())
    })?;
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    let at = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    let text = std::fs::read_to_string(&path).ok()?;
    let cwd = text.lines().take(200).find_map(|l| serde_json::from_str::<Value>(l).ok().and_then(|v| str_of(&v, "cwd").map(str::to_string)))?;
    Some((cwd, at))
}

/// 지금 떠 있는 claude 의 세션 id. claude 는 `~/.claude/sessions/<pid>.json` 에 pid 와 세션 id 를 적는다
fn running_sessions() -> std::collections::BTreeSet<String> {
    let Some(dir) = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude/sessions")) else { return Default::default() };
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
        .filter(|v| {
            // 끝난 프로세스의 파일이 남아 있을 수 있다. 살아 있는지 본다
            let pid = v.get("pid").and_then(Value::as_i64).unwrap_or(0) as i32;
            pid > 0 && unsafe { libc::kill(pid, 0) } == 0
        })
        .filter_map(|v| str_of(&v, "sessionId").map(str::to_string))
        .collect()
}

/// Orca 워크트리 id(`<저장소 id>::<경로>`)에서 경로
fn worktree_path(id: &str) -> Option<String> {
    id.split_once("::").map(|(_, p)| p.to_string())
}

pub fn scan(registered: &[String]) -> Result<OrcaScan, String> {
    let home = orca_home().filter(|h| h.is_dir()).ok_or("Orca 데이터 폴더가 없다 (~/Library/Application Support/orca)")?;
    let profile = profile_dir(&home);
    let docs = documents(&profile, &["repos", "worktreeMeta", "workspaceSession"])?;

    let repos: Vec<OrcaRepo> = docs
        .get("repos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|r| str_of(r, "kind").is_none_or(|k| k == "git"))
        .filter_map(|r| {
            let path = str_of(r, "path")?.to_string();
            let name = str_of(r, "displayName").map(str::to_string).unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_string());
            let exists = Path::new(&path).is_dir();
            let registered = registered.iter().any(|p| p == &path);
            Some(OrcaRepo { path, name, exists, registered })
        })
        .collect();

    let worktrees: Vec<OrcaWorktree> = docs
        .get("worktreeMeta")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, m)| {
            let path = worktree_path(id)?;
            let name = str_of(m, "displayName").map(str::to_string);
            let comment = str_of(m, "comment").map(str::to_string);
            (name.is_some() || comment.is_some()).then_some(OrcaWorktree { path, name, comment })
        })
        .collect();

    // 탭 제목에 붙은 claude 세션과, 잠재운 에이전트 기록에 남은 claude 세션을 모은다
    let mut found: BTreeMap<String, (Option<String>, String, Option<String>, bool)> = BTreeMap::new();
    let ws = docs.get("workspaceSession").cloned().unwrap_or(Value::Null);
    for (wt, tabs) in ws.get("tabsByWorktree").and_then(Value::as_object).into_iter().flatten() {
        for tab in tabs.as_array().into_iter().flatten() {
            let Some(ai) = tab.get("aiVaultTitle").filter(|a| str_of(a, "agent") == Some("claude")) else { continue };
            let Some(id) = str_of(ai, "sessionId") else { continue };
            let title = str_of(ai, "title").map(str::to_string).or_else(|| str_of(tab, "title").map(clean_title)).unwrap_or_default();
            let teams = str_of(tab, "launchAgent") == Some("claude-agent-teams");
            let worktree = if wt == FLOATING { None } else { worktree_path(wt) };
            found.entry(id.to_string()).or_insert((worktree, title, None, teams));
        }
    }
    for s in ws.get("sleepingAgentSessionsByPaneKey").and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
        if str_of(s, "agent") != Some("claude") {
            continue;
        }
        let Some(p) = s.get("providerSession") else { continue };
        let Some(id) = str_of(p, "id") else { continue };
        let worktree = str_of(s, "worktreeId").filter(|w| *w != FLOATING).and_then(worktree_path);
        let title = str_of(s, "terminalTitle").map(clean_title).unwrap_or_default();
        let hint = str_of(p, "transcriptPath").map(str::to_string);
        let e = found.entry(id.to_string()).or_insert((worktree, title, None, false));
        e.2 = hint;
    }

    let running = running_sessions();
    let mut sessions: Vec<OrcaSession> = found
        .into_iter()
        .filter_map(|(id, (worktree, title, hint, teams))| {
            // 기록 파일이 없으면 이어 붙일 수 없다
            let (cwd, updated_at) = transcript(&id, hint.as_deref())?;
            let floating = worktree.is_none();
            let running = running.contains(&id);
            Some(OrcaSession { session_id: id, title, worktree, cwd, updated_at, floating, teams, running })
        })
        .collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    info!(event = "orca_scanned", repos = repos.len(), worktrees = worktrees.len(), sessions = sessions.len());
    Ok(OrcaScan { repos, worktrees, sessions })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_claude_status_glyphs() {
        assert_eq!(clean_title("✳ 공항라운지 이용 조건"), "공항라운지 이용 조건");
        assert_eq!(clean_title("◐ Plugin scratch"), "Plugin scratch");
        assert_eq!(clean_title("python3"), "python3");
    }
}
