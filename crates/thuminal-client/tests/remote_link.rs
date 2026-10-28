//! 원격 호스트 연결: 웹소켓 전송 위의 Client 가 유닉스 소켓과 똑같이 말하는지, 틀린 토큰과 판 다름을 가르는지,
//! 끊겼다가 다시 붙는지 본다.
#![cfg(unix)] // /tmp · /bin/sh · 유닉스 셸을 쓰는 시험이다. Windows 는 windows.rs

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use thuminal_client::link::{Link, LinkState, LinkStatus};
use thuminal_client::{Client, ClientError};
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{
    ClientMessage, CreateSession, ErrorBody, ErrorCode, Event, Frame, PROTOCOL_MAJOR, PROTOCOL_MINOR, Request, Response, ResponseResult,
    ServerMessage, SnapshotFormat,
};
use thuminal_pty_portable::PortablePty;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

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

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// 원격 접속을 켠 시험 데몬. (데몬 유닉스 소켓 연결, 웹 주소, 토큰)
async fn remote_daemon(dir: &std::path::Path) -> (Client, String, String) {
    let daemon = Daemon::bind(config(dir)).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir), "test").await.unwrap();
    let port = free_port();
    c.request(Request::SetRemote { enabled: Some(true), port: Some(port), lan: None }).await.unwrap();
    c.request(Request::PairRemote { name: "다른 맥".into() }).await.unwrap();
    let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("remote.json")).unwrap()).unwrap();
    let token = stored["token"].as_str().unwrap().to_string();
    (c, format!("http://127.0.0.1:{port}"), token)
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_client_speaks_like_unix_client() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let (_local, base, token) = remote_daemon(dir.path()).await;

    // 틀린 토큰은 Unauthorized 로 가른다
    assert!(matches!(Client::connect_ws(&base, "nope", "test").await, Err(ClientError::Unauthorized)));

    let c = Client::connect_ws(&base, &token, "desktop").await.unwrap();
    let (_, major, minor) = c.hello().unwrap();
    assert_eq!((major, minor), (PROTOCOL_MAJOR, PROTOCOL_MINOR));
    assert!(c.version_warning.is_none());

    let mut events = c.events();
    let s = c.create(CreateSession { command: vec!["/bin/cat".into()], cols: 40, rows: 5, ..Default::default() }).await.unwrap();
    // 이벤트도 웹소켓으로 온다
    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(Event::SessionCreated { session }) = events.recv().await {
                return session.id;
            }
        }
    })
    .await
    .expect("session_created 이벤트가 오지 않았다");
    assert_eq!(got, s.id);

    let mut at = c.attach(s.id, SnapshotFormat::Vt).await.unwrap();
    c.input(s.id, b"ping-over-ws\n".to_vec()).await.unwrap();
    let mut out = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !out.contains("ping-over-ws") && tokio::time::Instant::now() < deadline {
        if let Ok(Some(chunk)) = tokio::time::timeout(Duration::from_secs(1), at.output.recv()).await {
            out.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    assert!(out.contains("ping-over-ws"), "{out:?}");
    assert_eq!(c.list().await.unwrap().len(), 1);
    c.remove(s.id).await.unwrap();
}

async fn wait_state(rx: &mut watch::Receiver<LinkStatus>, want: LinkState, min_generation: u64) -> LinkStatus {
    let r = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|s| s.state == want && s.generation >= min_generation)).await;
    r.unwrap_or_else(|_| panic!("{want:?} 가 되지 않았다")).unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn link_reconnects_and_stops_on_bad_token() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let (local, base, token) = remote_daemon(dir.path()).await;

    let (b, t) = (base.clone(), token.clone());
    let link = Link::spawn(move || {
        let (b, t) = (b.clone(), t.clone());
        async move { Client::connect_ws(&b, &t, "desktop").await }
    });
    let mut st = link.status();
    let s = wait_state(&mut st, LinkState::Connected, 1).await;
    assert_eq!(s.protocol, Some((PROTOCOL_MAJOR, PROTOCOL_MINOR)));
    assert!(link.client().unwrap().list().await.is_ok());

    // 원격 접속을 껐다 켜면 끊겼다가 다시 붙는다
    local.request(Request::SetRemote { enabled: Some(false), port: None, lan: None }).await.unwrap();
    wait_state(&mut st, LinkState::Disconnected, 1).await;
    assert!(link.client().is_none());
    local.request(Request::SetRemote { enabled: Some(true), port: None, lan: None }).await.unwrap();
    let s = wait_state(&mut st, LinkState::Connected, 2).await;
    assert_eq!(s.generation, 2);
    assert!(link.client().unwrap().list().await.is_ok());

    // 토큰을 바꾸면 끊기고, 토큰이 틀려 멈춘다
    local.request(Request::RotateRemoteToken).await.unwrap();
    wait_state(&mut st, LinkState::Unauthorized, 2).await;
    assert!(link.client().is_none());
}

/// hello 에 정해 둔 답을 하는 가짜 원격 데몬
async fn fake_daemon(answer: ResponseResult) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        while let Some(Ok(m)) = ws.next().await {
            let Message::Binary(b) = m else { continue };
            let Frame::Json(j) = Frame::decode(&b).unwrap() else { continue };
            let ClientMessage::Request { id, .. } = serde_json::from_slice(&j).unwrap();
            let reply = Frame::json(&ServerMessage::Response { id, result: answer.clone() }).encode();
            ws.send(Message::Binary(reply[4..].to_vec().into())).await.unwrap();
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn hello(major: u32, minor: u32) -> ResponseResult {
    ResponseResult::Ok(Response::Hello { daemon_version: "9.9.9".into(), protocol_major: major, protocol_minor: minor, pid: 1, engine: "x".into() })
}

#[tokio::test]
async fn version_mismatch_is_refused_and_minor_is_warned() {
    let c = Client::connect_ws(&fake_daemon(hello(PROTOCOL_MAJOR, PROTOCOL_MINOR + 1)).await, "t", "test").await.unwrap();
    assert!(c.version_warning.as_deref().unwrap().contains("이 앱을 업데이트"), "{:?}", c.version_warning);

    if PROTOCOL_MINOR > 0 {
        let c = Client::connect_ws(&fake_daemon(hello(PROTOCOL_MAJOR, PROTOCOL_MINOR - 1)).await, "t", "test").await.unwrap();
        assert!(c.version_warning.as_deref().unwrap().contains("이전 버전"), "{:?}", c.version_warning);
    }

    let r = Client::connect_ws(&fake_daemon(hello(PROTOCOL_MAJOR + 1, 0)).await, "t", "test").await;
    assert!(matches!(r, Err(ClientError::VersionMismatch(_))), "{:?}", r.err());

    // 진짜 데몬은 주 판이 다르면 오류로 답한다
    let refuse = ResponseResult::Err(ErrorBody { code: ErrorCode::VersionMismatch, message: "데몬은 프로토콜 2".into() });
    let r = Client::connect_ws(&fake_daemon(refuse).await, "t", "test").await;
    assert!(matches!(r, Err(ClientError::VersionMismatch(_))), "{:?}", r.err());
}

#[tokio::test]
async fn unreachable_host_fails() {
    let port = free_port();
    let r = Client::connect_ws(&format!("http://127.0.0.1:{port}"), "t", "test").await;
    assert!(matches!(r, Err(ClientError::ConnectRemote { .. })), "{:?}", r.err());
}
