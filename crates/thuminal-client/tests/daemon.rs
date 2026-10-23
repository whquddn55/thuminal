//! 데몬을 임시 폴더에 띄우고 클라이언트로 핵심 약속을 확인한다.

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig, DaemonError};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, Event, ScreenFormat, SessionId, SnapshotFormat};
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

/// 유닉스 소켓 경로 길이 제한(104바이트) 때문에 짧은 임시 폴더를 쓴다
fn short_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap()
}

async fn start() -> (tempfile::TempDir, Paths) {
    let dir = short_tempdir();
    let daemon = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(daemon.run());
    let paths = Paths::new(dir.path());
    (dir, paths)
}

fn cmd(args: &[&str]) -> CreateSession {
    CreateSession { command: args.iter().map(|s| s.to_string()).collect(), cols: 60, rows: 10, ..Default::default() }
}

async fn wait_screen(c: &Client, s: SessionId, needle: &str) -> String {
    for _ in 0..100 {
        let text = c.read_screen(s, ScreenFormat::Plain, true).await.unwrap();
        if text.contains(needle) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("화면에 {needle:?} 이 나오지 않았다");
}

#[tokio::test]
async fn creates_session_and_reads_screen() {
    let (_dir, paths) = start().await;
    let c = Client::connect(&paths, "test").await.unwrap();
    let s = c.create(cmd(&["/bin/sh", "-c", "printf 'hello from pty'; sleep 30"])).await.unwrap();
    wait_screen(&c, s.id, "hello from pty").await;
    assert_eq!(c.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn reattach_after_client_disconnect_keeps_screen_and_io() {
    let (_dir, paths) = start().await;
    let id = {
        let a = Client::connect(&paths, "a").await.unwrap();
        let s = a.create(cmd(&["/bin/cat"])).await.unwrap();
        a.send_text(s.id, "before\n").await.unwrap();
        wait_screen(&a, s.id, "before").await;
        s.id
        // a 가 여기서 끊긴다
    };

    let b = Client::connect(&paths, "b").await.unwrap();
    let mut at = b.attach(id, SnapshotFormat::Vt).await.unwrap();
    assert!(String::from_utf8_lossy(&at.snapshot).contains("before"), "저장본에 이전 화면이 없다");
    assert_eq!(at.session.attached, 1);

    b.input(id, b"after\n".to_vec()).await.unwrap();
    let mut got = String::new();
    while !got.contains("after") {
        let chunk = tokio::time::timeout(Duration::from_secs(3), at.output.recv()).await.unwrap().unwrap();
        got.push_str(&String::from_utf8_lossy(&chunk));
    }

    let native = b.attach(id, SnapshotFormat::Native).await.unwrap();
    assert!(!native.snapshot.is_empty());
}

#[tokio::test]
async fn reports_exit_code_as_event() {
    let (_dir, paths) = start().await;
    let c = Client::connect(&paths, "test").await.unwrap();
    let mut events = c.events();
    let s = c.create(cmd(&["/bin/sh", "-c", "exit 7"])).await.unwrap();
    loop {
        let e = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap().unwrap();
        if let Event::SessionExited { session, code } = e {
            assert_eq!(session, s.id);
            assert_eq!(code, Some(7));
            break;
        }
    }
}

#[tokio::test]
async fn rejects_other_protocol_major() {
    use thuminal_protocol::{ClientMessage, Frame, Request, ResponseResult, ServerMessage};
    use tokio::io::AsyncWriteExt;
    let (_dir, paths) = start().await;
    let mut stream = tokio::net::UnixStream::connect(paths.socket()).await.unwrap();
    let hello = ClientMessage::Request { id: 1, request: Request::Hello { protocol_major: 99, protocol_minor: 0, client: "old".into() } };
    stream.write_all(&Frame::json(&hello).encode()).await.unwrap();
    let frame = thuminal_daemon::read_frame(&mut stream).await.unwrap().unwrap();
    let Frame::Json(bytes) = frame else { panic!("JSON 응답이 아니다") };
    let msg: ServerMessage = serde_json::from_slice(&bytes).unwrap();
    assert!(matches!(msg, ServerMessage::Response { result: ResponseResult::Err(_), .. }), "{msg:?}");
}

#[tokio::test]
async fn second_daemon_does_not_start() {
    let (dir, _paths) = start().await;
    assert!(matches!(Daemon::bind(config(dir.path())), Err(DaemonError::AlreadyRunning(Some(_)))));
}
