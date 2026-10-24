//! 배치: 데몬이 세션을 칸에 넣고, op 로 칸을 만들고 닫고, 실패하면 되돌리는지 확인한다.

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::{Client, ClientError};
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{
    CreateSession, ErrorCode, Event, LayoutOp, LayoutSpec, PaneId, PaneNode, PaneRef, Request, ScreenFormat, SessionId, Side, Spawn,
    TabRef, WorkspaceLayout,
};
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

async fn start() -> (tempfile::TempDir, Client) {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let daemon = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir.path()), "test").await.unwrap();
    (dir, c)
}

fn sh() -> Spawn {
    Spawn { command: vec!["/bin/sh".into()], ..Default::default() }
}

fn session_req(labels: &[(&str, &str)]) -> CreateSession {
    CreateSession {
        command: vec!["/bin/sh".into()],
        cwd: Some("/tmp".into()),
        cols: 60,
        rows: 10,
        labels: labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        ..Default::default()
    }
}

fn sessions_in(l: &WorkspaceLayout) -> Vec<SessionId> {
    fn walk(n: &PaneNode, out: &mut Vec<SessionId>) {
        match n {
            PaneNode::Pane { pane } => out.extend(pane.session()),
            PaneNode::Split { children, .. } => children.iter().for_each(|c| walk(c, out)),
        }
    }
    let mut out = Vec::new();
    l.tabs.iter().for_each(|t| walk(&t.root, &mut out));
    out
}

async fn wait_screen(c: &Client, s: SessionId, needle: &str) -> String {
    let mut last = String::new();
    for _ in 0..150 {
        last = c.read_screen(s, ScreenFormat::Plain, true).await.unwrap();
        if last.contains(needle) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    panic!("화면에 {needle:?} 이 나오지 않았다:\n{last}");
}

async fn next_layout_event(events: &mut tokio::sync::broadcast::Receiver<Event>) -> Event {
    loop {
        let e = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap().unwrap();
        if matches!(e, Event::LayoutChanged { .. } | Event::LayoutRemoved { .. }) {
            return e;
        }
    }
}

#[tokio::test]
async fn create_session_is_placed_by_labels_and_removed_with_its_pane() {
    let (_dir, c) = start().await;
    let mut events = c.events();
    let a = c.create(session_req(&[("worktree", "/tmp/wt-a")])).await.unwrap();
    let Event::LayoutChanged { layout } = next_layout_event(&mut events).await else { panic!("배치 이벤트가 아니다") };
    assert_eq!(layout.workspace, "/tmp/wt-a");
    assert_eq!(sessions_in(&layout), vec![a.id]);
    assert_eq!(layout.active_tab, Some(layout.tabs[0].id));

    let f = c.create(session_req(&[("floating", "1")])).await.unwrap();
    let hidden = c.create(session_req(&[("layout", "none")])).await.unwrap();
    let all = c.layouts(None).await.unwrap();
    assert_eq!(all.len(), 2, "{all:?}");
    assert_eq!(sessions_in(&c.layouts(Some("floating".into())).await.unwrap()[0]), vec![f.id]);
    assert!(all.iter().all(|l| !sessions_in(l).contains(&hidden.id)), "layout=none 은 칸에 넣지 않는다");

    // 세션을 지우면 칸이 빠지고, 마지막 칸이었으면 workspace 배치도 없어진다
    let mut events = c.events();
    c.remove(a.id).await.unwrap();
    assert!(matches!(next_layout_event(&mut events).await, Event::LayoutRemoved { workspace } if workspace == "/tmp/wt-a"));
    assert!(c.layouts(Some("/tmp/wt-a".into())).await.unwrap().is_empty());
}

#[tokio::test]
async fn split_spawns_shell_types_input_and_close_removes_session() {
    let (_dir, c) = start().await;
    let a = c.create(session_req(&[("worktree", "/tmp")])).await.unwrap();
    let (layouts, created) = c
        .layout(LayoutOp::Split {
            target: PaneRef::Session(a.id),
            side: Side::Down,
            size: Some(0.3),
            spawn: Spawn { input: Some("echo split-$((40+2))".into()), ..sh() },
            focus: true,
            doc: None,
        })
        .await
        .unwrap();
    assert_eq!(created.len(), 1);
    let tab = &layouts[0].tabs[0];
    assert_eq!(tab.focused, created[0]);
    let PaneNode::Split { sizes, .. } = &tab.root else { panic!("분할이 아니다") };
    assert!((sizes[1] - 0.3).abs() < 1e-4);
    let new = sessions_in(&layouts[0])[1];
    // 새 세션은 대상 칸 폴더에서 뜨고, 꼬리표는 workspace 를 따른다. input 은 셸이 뜬 뒤 입력된다
    let info = c.list().await.unwrap().into_iter().find(|s| s.id == new).unwrap();
    assert_eq!(info.cwd, "/tmp");
    assert_eq!(info.labels.get("worktree").map(String::as_str), Some("/tmp"));
    assert_eq!((info.cols, info.rows), (120, 40));
    wait_screen(&c, new, "split-42").await;

    // 다른 workspace 로 떼어 내면 세션 꼬리표도 따라간다 (다시 뜰 때 맞추기가 같은 곳에 넣게)
    c.layout(LayoutOp::BreakPane { pane: PaneRef::Id(created[0]), workspace: Some("floating".into()), index: None }).await.unwrap();
    let info = c.list().await.unwrap().into_iter().find(|s| s.id == new).unwrap();
    assert_eq!(info.labels.get("floating").map(String::as_str), Some("1"));
    assert!(!info.labels.contains_key("worktree"));

    // 칸을 닫으면 세션도 지운다
    c.layout(LayoutOp::ClosePane { target: PaneRef::Id(created[0]) }).await.unwrap();
    assert!(c.list().await.unwrap().iter().all(|s| s.id != new));
    // 없는 칸은 NotFound
    let err = c.layout(LayoutOp::Focus { target: PaneRef::Id(PaneId(99)) }).await.unwrap_err();
    assert!(matches!(err, ClientError::Daemon(ErrorCode::NotFound, ref m) if m == "칸 p99 이 없다"), "{err:?}");
}

#[tokio::test]
async fn failed_op_removes_sessions_it_made_and_batch_stops_at_failure() {
    let (_dir, c) = start().await;
    let spec = LayoutSpec::Split {
        axis: thuminal_protocol::Axis::Row,
        children: vec![
            LayoutSpec::Spawn { spawn: sh() },
            LayoutSpec::Spawn { spawn: Spawn { command: vec!["/nonexistent/thuminal-test".into()], ..Default::default() } },
        ],
        sizes: None,
    };
    let err = c.layout(LayoutOp::Apply { workspace: "/tmp".into(), tab: None, spec, focus: true }).await.unwrap_err();
    assert!(matches!(err, ClientError::Daemon(ErrorCode::SpawnFailed, _)), "{err:?}");
    assert!(c.list().await.unwrap().is_empty(), "실패한 op 가 만든 세션은 지운다");
    assert!(c.layouts(None).await.unwrap().is_empty());

    let ok = LayoutOp::NewTab { workspace: "other".into(), spawn: sh(), index: None, focus: true, title: None, doc: None };
    let bad = LayoutOp::SelectTab { tab: TabRef::Id(thuminal_protocol::TabId(77)) };
    let err = c.request(Request::LayoutBatch { ops: vec![ok.clone(), bad] }).await.unwrap_err();
    assert!(matches!(&err, ClientError::Daemon(ErrorCode::NotFound, m) if m.starts_with("2번째 op")), "{err:?}");
    assert_eq!(c.layouts(Some("other".into())).await.unwrap()[0].tabs.len(), 1, "앞의 op 는 남는다");
    let (layouts, created) = c.layout_batch(vec![ok.clone(), ok]).await.unwrap();
    assert_eq!(created.len(), 2);
    assert_eq!(layouts[0].tabs.len(), 3);
}

#[tokio::test]
async fn removing_worktree_drops_its_layout() {
    let (dir, c) = start().await;
    let git = |cwd: &std::path::Path, args: &[&str]| {
        let st = std::process::Command::new("git").current_dir(cwd).args(args).output().unwrap();
        assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
    };
    let root = dir.path().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    let repo = c.add_repo(root.to_string_lossy()).await.unwrap();
    let wt = c.create_worktree(repo.id.clone(), "feature/x".into(), None).await.unwrap();
    let mut events = c.events();
    c.layout(LayoutOp::NewTab { workspace: wt.path.clone(), spawn: sh(), index: None, focus: true, title: None, doc: None }).await.unwrap();
    assert!(matches!(next_layout_event(&mut events).await, Event::LayoutChanged { .. }));
    c.remove_worktree(repo.id, wt.path.clone(), true, true, true).await.unwrap();
    assert!(matches!(next_layout_event(&mut events).await, Event::LayoutRemoved { workspace } if workspace == wt.path));
    assert!(c.layouts(Some(wt.path)).await.unwrap().is_empty());
}
