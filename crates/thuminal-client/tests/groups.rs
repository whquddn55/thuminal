//! 사이드바 워크스페이스(프로젝트 묶음): 데몬이 목록을 맞춰 남기고, 바뀌면 `workspace_changed` 로 알리는지 확인한다.

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::{Client, ClientError};
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{DEFAULT_GROUP, ErrorCode, Event, RepoGroup};
use thuminal_pty_portable::PortablePty;

fn config(home: &std::path::Path) -> DaemonConfig {
    DaemonConfig {
        paths: Paths::new(home),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin: None,
        web_root: None,
    }
}

/// 데몬을 띄우고 저장소 둘(a, b)을 등록한다. (데이터 폴더, 연결, [a id, b id])
async fn start() -> (tempfile::TempDir, Client, [String; 2]) {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let daemon = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir.path()), "test").await.unwrap();
    let mut ids = Vec::new();
    for name in ["a", "b"] {
        let root = dir.path().join(name);
        std::fs::create_dir_all(&root).unwrap();
        let st = std::process::Command::new("git").current_dir(&root).args(["init", "-q", "-b", "main"]).output().unwrap();
        assert!(st.status.success());
        ids.push(c.add_repo(root.to_string_lossy()).await.unwrap().id);
    }
    (dir, c, ids.try_into().unwrap())
}

fn group(id: &str, name: &str, repos: &[&str]) -> RepoGroup {
    RepoGroup { id: id.into(), name: name.into(), repos: repos.iter().map(|r| r.to_string()).collect() }
}

async fn next_workspace_changed(events: &mut tokio::sync::broadcast::Receiver<Event>) {
    loop {
        let e = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap().unwrap();
        if matches!(e, Event::WorkspaceChanged) {
            return;
        }
    }
}

#[tokio::test]
async fn groups_start_with_default_holding_every_repo() {
    let (_dir, c, [a, b]) = start().await;
    assert_eq!(c.groups().await.unwrap(), [group(DEFAULT_GROUP, "기본", &[&a, &b])]);
}

#[tokio::test]
async fn set_groups_moves_repo_and_notifies() {
    let (dir, c, [a, b]) = start().await;
    let mut events = c.events();
    let got = c.set_groups(vec![group(DEFAULT_GROUP, "기본", &[&a]), group("", "일", &[&b])]).await.unwrap();
    next_workspace_changed(&mut events).await;
    let id = got[1].id.clone();
    assert!(!id.is_empty());
    assert_eq!(got, [group(DEFAULT_GROUP, "기본", &[&a]), group(&id, "일", &[&b])]);
    assert_eq!(c.groups().await.unwrap(), got);
    // 다른 연결(다른 화면)도 같은 것을 본다
    let other = Client::connect(&Paths::new(dir.path()), "test2").await.unwrap();
    assert_eq!(other.groups().await.unwrap(), got);

    // 프로젝트를 빼면 그 워크스페이스에서도 빠진다
    c.request(thuminal_protocol::Request::RemoveRepo { repo: b.clone() }).await.unwrap();
    assert_eq!(c.groups().await.unwrap(), [group(DEFAULT_GROUP, "기본", &[&a]), group(&id, "일", &[])]);
}

#[tokio::test]
async fn set_groups_rejects_empty_name() {
    let (_dir, c, _) = start().await;
    match c.set_groups(vec![group("x", "  ", &[])]).await {
        Err(ClientError::Daemon(code, _)) => assert_eq!(code, ErrorCode::InvalidRequest),
        other => panic!("거절해야 한다: {other:?}"),
    }
}
