//! 밖에서 바꾼 워크트리: `git worktree add` · `remove` 를 데몬 밖에서 해도 목록이 바뀌었다고 알리고,
//! 지운 워크트리에 열려 있던 탭은 "워크트리 밖"으로 옮긴다 (세션은 끝내지 않는다).
#![cfg(unix)] // /tmp · 유닉스 셸을 쓰는 시험이다

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, Event, OTHER_WORKSPACE, PaneNode, SessionId, SessionState, WORKTREE_LABEL, WorkspaceLayout};
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

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
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

/// workspace_changed 를 기다린다 (데몬은 10초마다 견준다)
async fn workspace_changed(rx: &mut tokio::sync::broadcast::Receiver<Event>) {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if let Ok(Event::WorkspaceChanged) = rx.recv().await {
                return;
            }
        }
    })
    .await
    .expect("workspace_changed 가 오지 않았다");
}

#[tokio::test(flavor = "multi_thread")]
async fn notices_worktrees_changed_outside() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    let daemon = Daemon::bind(config(&dir.path().join("data"))).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir.path().join("data")), "test").await.unwrap();
    c.add_repo(root.to_string_lossy()).await.unwrap();
    let mut rx = c.events();
    // 저장소를 등록하며 보낸 알림은 버린다 (아래에서 받는 알림이 밖에서 바꾼 것을 알아챈 것이어야 한다)
    tokio::time::sleep(Duration::from_millis(500)).await;
    while rx.try_recv().is_ok() {}

    // 데몬 밖에서 워크트리를 만들면 목록이 바뀌었다고 알린다
    let wt = dir.path().canonicalize().unwrap().join("repo-wt");
    let wt_s = wt.to_string_lossy().into_owned();
    git(&root, &["worktree", "add", "-q", "-b", "side", &wt_s]);
    workspace_changed(&mut rx).await;
    assert!(c.worktrees(None).await.unwrap().iter().any(|w| w.path == wt_s));

    // 그 워크트리에 터미널을 연다
    let labels = BTreeMap::from([(WORKTREE_LABEL.to_string(), wt_s.clone())]);
    let s = c.create(CreateSession { command: vec!["/bin/cat".into()], cwd: Some(wt_s.clone()), labels, ..Default::default() }).await.unwrap();
    assert_eq!(c.layouts(Some(wt_s.clone())).await.unwrap()[0].tabs.len(), 1);

    // 데몬 밖에서 지우면 탭은 "워크트리 밖"으로 옮기고, 세션은 그대로 돈다
    git(&root, &["worktree", "remove", "--force", &wt_s]);
    workspace_changed(&mut rx).await;
    assert!(!c.worktrees(None).await.unwrap().iter().any(|w| w.path == wt_s));
    assert!(c.layouts(None).await.unwrap().iter().all(|l| l.workspace != wt_s), "지운 워크트리 배치가 남았다");
    let other = c.layouts(Some(OTHER_WORKSPACE.into())).await.unwrap();
    assert!(other.iter().any(|l| sessions_in(l).contains(&s.id)), "탭이 워크트리 밖으로 옮겨지지 않았다: {other:?}");
    let info = c.list().await.unwrap().into_iter().find(|x| x.id == s.id).expect("세션이 없어졌다");
    assert_eq!(info.state, SessionState::Running);
    assert!(!info.labels.get(WORKTREE_LABEL).is_some_and(|w| *w == wt_s), "세션 꼬리표가 옛 워크트리 그대로다");
}
