//! 데몬이 종료 신호로 내려간 뒤 다시 뜨면 세션을 되살리는지 확인한다.
//! 환경 변수를 바꾸므로 이 파일에는 시험을 하나만 둔다.
#![cfg(unix)] // /tmp · /bin/sh · 유닉스 셸을 쓰는 시험이다. Windows 는 windows.rs

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, Request, ScreenFormat, SessionId};
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

#[tokio::test(flavor = "multi_thread")]
async fn restores_sessions_after_signal_stop_but_not_after_user_stop() {
    // 되살리기는 로그인 셸을 띄우고 `claude --resume` 을 입력한다. 시험에서 진짜 claude 가 뜨지 않게 셸과 PATH 를 좁힌다
    unsafe {
        std::env::set_var("SHELL", "/bin/sh");
        std::env::set_var("PATH", "/usr/bin:/bin");
    }
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let paths = Paths::new(dir.path());
    // claude 는 셸 폴더(/tmp)가 아닌 곳에서 돈다 (`cd 프로젝트 && claude` 로 띄우면 셸이 바뀐 폴더를 알리기 전에 claude 가 뜬다)
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let project = project.to_string_lossy().into_owned();

    // 1. 첫 데몬: 세션을 만들고 화면에 글을 남기고, claude 훅 알림을 보낸다
    let d1 = Daemon::bind(config(dir.path())).unwrap();
    let server1 = d1.server.clone();
    let run1 = tokio::spawn(d1.run());
    let old_id = {
        let c = Client::connect(&paths, "test").await.unwrap();
        let s = c
            .create(CreateSession { cwd: Some("/tmp".into()), cols: 70, rows: 12, labels: [("worktree".into(), "/tmp".into())].into(), ..Default::default() })
            .await
            .unwrap();
        c.send_text(s.id, "echo before-reboot\n").await.unwrap();
        wait_screen(&c, s.id, "before-reboot\n").await;
        c.request(Request::ReportAgent {
            session: s.id,
            kind: "claude".into(),
            event: "SessionStart".into(),
            agent_session_id: Some("abc-123".into()),
            transcript: None,
            prompt: None,
            last_assistant_message: None,
            tool_name: None,
            notification_type: None,
            source: Some("startup".into()),
            model: None,
            cwd: Some(project.clone()),
        })
        .await
        .unwrap();
        s.id
    };
    // 2. 종료 신호처럼 내린다 (기록을 남긴다)
    server1.shutdown.notify_waiters();
    run1.await.unwrap();

    // 3. 두 번째 데몬: 지난 세션을 되살린다
    let d2 = Daemon::bind(config(dir.path())).unwrap();
    let server2 = d2.server.clone();
    let run2 = tokio::spawn(d2.run());
    let c = Client::connect(&paths, "test").await.unwrap();
    let sessions = c.list().await.unwrap();
    assert_eq!(sessions.len(), 1, "되살린 세션이 하나여야 한다");
    let s = &sessions[0];
    assert_eq!(s.restored_from, Some(old_id));
    assert_eq!(s.cwd, project, "claude 가 돌던 폴더에서 되살려야 한다");
    assert_eq!(s.labels.get("worktree").map(String::as_str), Some("/tmp"));
    assert_eq!((s.cols, s.rows), (70, 12));
    let screen = wait_screen(&c, s.id, "claude --resume abc-123").await;
    assert!(screen.contains("before-reboot"), "이전 화면이 없다:\n{screen}");
    assert!(screen.contains("이전 화면을 되살렸어요"));

    // 4. 사용자가 daemon stop 으로 내리면 다음에 되살리지 않는다
    c.shutdown().await.unwrap();
    run2.await.unwrap();
    drop(server2);
    let d3 = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(d3.run());
    let c = Client::connect(&paths, "test").await.unwrap();
    assert!(c.list().await.unwrap().is_empty(), "daemon stop 뒤에는 되살리지 않는다");
}
