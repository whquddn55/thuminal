//! 데몬이 다시 뜨면 배치를 되살리고 세션 번호를 바꿔 끼우는지, `daemon stop` 뒤에는 지우는지 확인한다.
//! 되살리기가 로그인 셸을 띄우므로 SHELL 을 바꾼다. 그래서 이 파일에는 시험을 하나만 둔다.

use std::sync::Arc;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, LayoutOp, PaneNode, PaneRef, Side, Spawn};
use thuminal_pty_portable::PortablePty;

fn config(home: &std::path::Path) -> DaemonConfig {
    DaemonConfig {
        paths: Paths::new(home),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin: None,
    }
}

fn panes(n: &PaneNode) -> Vec<(u64, Option<u64>)> {
    match n {
        PaneNode::Pane { pane } => vec![(pane.id.0, pane.session().map(|s| s.0))],
        PaneNode::Split { children, .. } => children.iter().flat_map(panes).collect(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn layout_survives_signal_restart_and_is_cleared_by_user_stop() {
    unsafe {
        std::env::set_var("SHELL", "/bin/sh");
        std::env::set_var("PATH", "/usr/bin:/bin");
    }
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let paths = Paths::new(dir.path());

    // 1. 첫 데몬: 세션 둘을 한 탭에 나눠 둔다. 세션 번호가 바뀌는 것이 보이게 첫 세션은 지운다
    let d1 = Daemon::bind(config(dir.path())).unwrap();
    let server1 = d1.server.clone();
    let run1 = tokio::spawn(d1.run());
    let before = {
        let c = Client::connect(&paths, "test").await.unwrap();
        let gone = c.create(CreateSession { cols: 40, rows: 10, labels: [("layout".into(), "none".into())].into(), ..Default::default() }).await.unwrap();
        c.remove(gone.id).await.unwrap();
        let a = c.create(CreateSession { cwd: Some("/tmp".into()), cols: 40, rows: 10, labels: [("worktree".into(), "/tmp".into())].into(), ..Default::default() }).await.unwrap();
        c.layout(LayoutOp::Split { target: PaneRef::Session(a.id), side: Side::Right, size: None, spawn: Spawn::default(), focus: true }).await.unwrap();
        c.layouts(Some("/tmp".into())).await.unwrap().remove(0)
    };
    let old = panes(&before.tabs[0].root);
    assert_eq!(old.len(), 2);
    server1.shutdown.notify_waiters();
    run1.await.unwrap();
    assert!(dir.path().join("layout-v1.json").is_file());

    // 2. 두 번째 데몬: 같은 칸, 같은 탭, 새 세션 번호
    let d2 = Daemon::bind(config(dir.path())).unwrap();
    let run2 = tokio::spawn(d2.run());
    let c = Client::connect(&paths, "test").await.unwrap();
    let sessions = c.list().await.unwrap();
    assert_eq!(sessions.len(), 2);
    let after = c.layouts(Some("/tmp".into())).await.unwrap().remove(0);
    assert_eq!(after.tabs[0].id, before.tabs[0].id);
    assert_eq!(after.tabs[0].focused, before.tabs[0].focused);
    let new = panes(&after.tabs[0].root);
    for ((old_pane, old_session), (new_pane, new_session)) in old.iter().zip(&new) {
        assert_eq!(old_pane, new_pane);
        let s = sessions.iter().find(|s| Some(s.id.0) == *new_session).expect("새 세션");
        assert_eq!(s.restored_from.map(|x| x.0), *old_session, "옛 번호 → 새 번호");
    }
    assert_ne!(old.iter().map(|p| p.1).collect::<Vec<_>>(), new.iter().map(|p| p.1).collect::<Vec<_>>());
    // 칸 번호는 이어서 센다
    let (_, created) = c.layout(LayoutOp::NewTab { workspace: "/tmp".into(), spawn: Spawn::default(), index: None, focus: true }).await.unwrap();
    assert_eq!(created[0].0, old.iter().map(|p| p.0).max().unwrap() + 1);

    // 3. daemon stop 이면 배치를 지운다
    c.shutdown().await.unwrap();
    run2.await.unwrap();
    assert!(!dir.path().join("layout-v1.json").exists());
    tokio::spawn(Daemon::bind(config(dir.path())).unwrap().run());
    let c = Client::connect(&paths, "test").await.unwrap();
    assert!(c.layouts(None).await.unwrap().is_empty());
}
