//! Orca 에서 가져오기: Orca 에 등록한 저장소, 워크트리 이름·메모, 탭에 붙은 claude 세션을 읽는다.
//!
//! Orca 는 프로필마다 `~/Library/Application Support/orca/profiles/<프로필>/profile-state.db`(sqlite)에
//! 문서(`domain` → JSON `payload`)를 둔다. 옛 판은 같은 폴더의 `orca-data.json` 한 파일이다.
//! sqlite 는 함께 빌드한 sqlite(rusqlite)로 읽기 전용으로 연다 (Orca 가 떠 있어도 건드리지 않는다. Windows 에는 sqlite3 명령이 없다).
//! 읽기만 하고 바꾸지 않는다. 고른 것을 등록하고 탭을 여는 일은 앱이 한다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use thuminal_protocol::{OrcaRepo, OrcaScan, OrcaSession, OrcaWorktree};
use tracing::info;

/// Orca 떠 있는 터미널 워크트리 id
const FLOATING: &str = "global-floating-terminal";

/// Orca(Electron) 의 앱 데이터 폴더. macOS 는 `~/Library/Application Support/orca`, Linux 는 `$XDG_CONFIG_HOME/orca`
/// (없으면 `~/.config/orca`), Windows 는 `%APPDATA%\\orca`
fn orca_home() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = thuminal_protocol::paths::user_home;
    if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library/Application Support/orca"))
    } else if cfg!(windows) {
        env("APPDATA").map(|a| a.join("orca"))
    } else {
        env("XDG_CONFIG_HOME").or_else(|| home().map(|h| h.join(".config"))).map(|c| c.join("orca"))
    }
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
        return read_db(&db, domains).map_err(|e| format!("Orca 상태 파일을 읽지 못했어요: {e}"));
    }
    let json = profile.join("orca-data.json");
    let all: Value = serde_json::from_slice(&std::fs::read(&json).map_err(|e| format!("Orca 데이터를 찾지 못했어요: {} ({e})", json.display()))?).map_err(|e| e.to_string())?;
    Ok(domains.iter().filter_map(|d| all.get(*d).map(|v| (d.to_string(), v.clone()))).collect())
}

fn read_db(db: &Path, domains: &[&str]) -> rusqlite::Result<BTreeMap<String, Value>> {
    use rusqlite::{OpenFlags, params_from_iter};
    // Orca 는 WAL 모드로 쓴다. Orca 가 꺼져 있으면 `-wal` · `-shm` 이 없어 읽기 전용으로는 열지 못한다 (sqlite3 -readonly 도 같다).
    // 그때는 WAL 에 남은 것이 없으므로 immutable 로 연다 (잠그지도, 파일을 만들지도 않는다)
    let wal = std::fs::metadata(format!("{}-wal", db.display())).map_or(0, |m| m.len());
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    let conn = if wal == 0 {
        rusqlite::Connection::open_with_flags(file_uri(db) + "?immutable=1", flags)?
    } else {
        rusqlite::Connection::open_with_flags(db, flags)?
    };
    let marks = vec!["?"; domains.len()].join(",");
    let mut stmt = conn.prepare(&format!("select domain, payload from profile_state_documents where domain in ({marks})"))?;
    let rows = stmt.query_map(params_from_iter(domains), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (domain, payload) = row?;
        if let Ok(v) = serde_json::from_str(&payload) {
            out.insert(domain, v);
        }
    }
    Ok(out)
}

/// sqlite URI (`file:/a/b%20c.db`). Windows 경로는 `file:/C:/a/b.db` 로 쓴다
fn file_uri(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if p.starts_with('/') { "file:" } else { "file:/" });
    for b in p.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
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
        let projects = thuminal_protocol::paths::user_home()?.join(".claude/projects");
        std::fs::read_dir(projects).ok()?.flatten().map(|d| d.path().join(format!("{session}.jsonl"))).find(|p| p.is_file())
    })?;
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    let at = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    let text = std::fs::read_to_string(&path).ok()?;
    let cwd = text.lines().take(200).find_map(|l| serde_json::from_str::<Value>(l).ok().and_then(|v| str_of(&v, "cwd").map(str::to_string)))?;
    Some((cwd, at))
}

fn alive(pid: i32) -> bool {
    u32::try_from(pid).is_ok_and(crate::sys::alive)
}

/// 지금 떠 있는 claude: 세션 id → pid. claude 는 `~/.claude/sessions/<pid>.json` 에 pid 와 세션 id 를 적는다
fn running_sessions() -> BTreeMap<String, i32> {
    let Some(dir) = thuminal_protocol::paths::user_home().map(|h| h.join(".claude/sessions")) else { return Default::default() };
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
        .filter_map(|v| {
            // 끝난 프로세스의 파일이 남아 있을 수 있다. 살아 있는지 본다
            let pid = v.get("pid").and_then(Value::as_i64).unwrap_or(0) as i32;
            alive(pid).then(|| str_of(&v, "sessionId").map(|s| (s.to_string(), pid)))?
        })
        .collect()
}

/// 이 세션으로 떠 있는 claude 를 끝낸다. claude 는 SIGTERM 을 받으면 기록을 남기고 0.2초쯤에 끝난다
pub fn stop_session(session_id: &str) -> Result<(), String> {
    let Some(&pid) = running_sessions().get(session_id) else { return Ok(()) };
    // 다른 프로세스를 잘못 끄지 않게 이름을 확인한다 (pid 는 다시 쓰일 수 있다)
    let comm = crate::sys::process_name(pid as u32).unwrap_or_default();
    if !comm.contains("claude") && !comm.trim().rsplit('/').next().is_some_and(|n| n.starts_with("2.")) {
        return Err(format!("claude 프로세스가 아니에요: pid {pid} ({})", comm.trim()));
    }
    info!(event = "claude_stop", session = session_id, pid);
    let _ = crate::sys::terminate(pid as u32);
    for _ in 0..50 {
        if !alive(pid) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(format!("claude(pid {pid})가 5초 안에 끝나지 않았어요"))
}

/// Orca 워크트리 id(`<저장소 id>::<경로>`)에서 경로
fn worktree_path(id: &str) -> Option<String> {
    id.split_once("::").map(|(_, p)| p.to_string())
}

pub fn scan(registered: &[String]) -> Result<OrcaScan, String> {
    let home = orca_home().filter(|h| h.is_dir()).ok_or_else(|| match orca_home() {
        Some(h) => format!("Orca 데이터 폴더가 없어요 ({})", h.display()),
        None => "Orca 데이터 폴더를 찾지 못했어요".to_string(),
    })?;
    let profile = profile_dir(&home);
    let docs = documents(&profile, &["repos", "worktreeMeta", "workspaceSession", "worktreeLineageById"])?;

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

    // 하위 워크트리: 자식 워크트리 id → 부모 워크트리 id
    let parents: BTreeMap<String, String> = docs
        .get("worktreeLineageById")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(_, l)| Some((worktree_path(str_of(l, "worktreeId")?)?, worktree_path(str_of(l, "parentWorktreeId")?)?)))
        .collect();
    let mut worktrees: Vec<OrcaWorktree> = docs
        .get("worktreeMeta")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, m)| {
            let path = worktree_path(id)?;
            let name = str_of(m, "displayName").map(str::to_string);
            let comment = str_of(m, "comment").map(str::to_string);
            let parent = parents.get(&path).cloned();
            (name.is_some() || comment.is_some() || parent.is_some()).then_some(OrcaWorktree { path, name, comment, parent })
        })
        .collect();
    // 이름·메모 없이 부모만 있는 워크트리
    for (child, parent) in &parents {
        if !worktrees.iter().any(|w| &w.path == child) {
            worktrees.push(OrcaWorktree { path: child.clone(), name: None, comment: None, parent: Some(parent.clone()) });
        }
    }

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
            let running = running.contains_key(&id);
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

    #[test]
    fn reads_documents_from_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("profile-state.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"create table profile_state_documents (domain text primary key, payload text);
               insert into profile_state_documents values ('repos', '[{"path":"/a"}]'), ('other', '{}'), ('broken', 'not json');"#,
        )
        .unwrap();
        drop(conn);
        let docs = documents(dir.path(), &["repos", "broken", "missing"]).unwrap();
        assert_eq!(docs.keys().collect::<Vec<_>>(), vec!["repos"]);
        assert_eq!(docs["repos"][0]["path"], "/a");
    }

    #[test]
    fn reads_wal_database_without_creating_files() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a b");
        std::fs::create_dir(&sub).unwrap();
        let db = sub.join("profile-state.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"pragma journal_mode=wal;
               create table profile_state_documents (domain text primary key, payload text);
               insert into profile_state_documents values ('repos', '[]');"#,
        )
        .unwrap();
        drop(conn);
        // 닫으면 -wal · -shm 이 지워진다. 꺼진 Orca 와 같은 모양이다
        let files = || std::fs::read_dir(&sub).unwrap().count();
        assert_eq!(files(), 1);
        assert!(documents(&sub, &["repos"]).unwrap().contains_key("repos"));
        assert_eq!(files(), 1, "읽기만 하고 파일을 만들지 않는다");
    }

    #[test]
    fn makes_sqlite_file_uris() {
        assert_eq!(file_uri(Path::new("/a b/c#d.db")), "file:/a%20b/c%23d.db");
        assert_eq!(file_uri(Path::new(r"C:\Users\x\a.db")), "file:/C:/Users/x/a.db");
    }

    /// 이 컴퓨터의 진짜 Orca 상태 파일을 읽는다 (Orca 가 깔린 컴퓨터에서 손으로 돌린다)
    #[test]
    #[ignore]
    fn reads_real_orca() {
        let profile = profile_dir(&orca_home().unwrap());
        let docs = documents(&profile, &["repos", "worktreeMeta", "tabs"]).unwrap();
        eprintln!("{:?}", docs.keys().collect::<Vec<_>>());
        assert!(!docs.is_empty());
    }
}
