//! 원격 접속: 기기를 등록하고 웹소켓으로 붙어 데몬 프로토콜(hello, 세션 만들기, 입력·출력)을 그대로 쓰는지 본다.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{ClientMessage, CreateSession, Frame, Request, Response, ServerMessage};
use thuminal_pty_portable::PortablePty;
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

/// 길이 머리를 뗀 프레임 (웹소켓 메시지 하나)
fn body(frame: Frame) -> Vec<u8> {
    frame.encode()[4..].to_vec()
}

fn request(id: u64, request: Request) -> Message {
    Message::Binary(body(Frame::json(&ClientMessage::Request { id, request })).into())
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_speaks_daemon_protocol() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let daemon = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir.path()), "test").await.unwrap();

    let port = free_port();
    let r = c.request(Request::SetRemote { enabled: Some(true), port: Some(port), lan: None }).await.unwrap();
    let Response::Remote { remote } = r else { panic!("{r:?}") };
    assert!(remote.listening.contains(&format!("127.0.0.1:{port}")), "{remote:?}");
    let Response::RemotePaired { device, urls } = c.request(Request::PairRemote { name: "시험".into() }).await.unwrap() else { panic!() };
    assert_eq!(device.name, "시험");
    // Tailscale 이 없는 기계에서는 주소가 비어 있을 수 있다. 토큰은 데몬 파일에서 읽는다
    let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join("remote.json")).unwrap()).unwrap();
    let token = stored["devices"][0]["token"].as_str().unwrap().to_string();
    for u in &urls {
        assert!(u.ends_with(&format!("#token={token}")), "{u}");
    }

    // 토큰이 틀리면 열지 않는다
    assert!(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws?token=nope")).await.is_err());

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws?token={token}")).await.unwrap();
    ws.send(request(1, Request::Hello { protocol_major: thuminal_protocol::PROTOCOL_MAJOR, protocol_minor: 0, client: "ws".into() })).await.unwrap();
    let hello = recv_response(&mut ws, 1).await;
    assert!(matches!(hello, Response::Hello { .. }), "{hello:?}");

    // 원격 연결은 원격 설정을 바꾸지 못한다
    ws.send(request(2, Request::PairRemote { name: "x".into() })).await.unwrap();
    assert!(recv_error(&mut ws, 2).await.contains("원격"));

    let req = CreateSession { command: vec!["/bin/cat".into()], cols: 40, rows: 5, ..Default::default() };
    ws.send(request(3, Request::CreateSession(req))).await.unwrap();
    let Response::Session { session } = recv_response(&mut ws, 3).await else { panic!() };
    ws.send(request(4, Request::Attach { session: session.id, snapshot: thuminal_protocol::SnapshotFormat::Vt })).await.unwrap();
    recv_response(&mut ws, 4).await;
    ws.send(Message::Binary(body(Frame::Input { session: session.id, data: b"ping-remote\n".to_vec() }).into())).await.unwrap();
    let mut out = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !out.contains("ping-remote") && tokio::time::Instant::now() < deadline {
        if let Some(Frame::Output { session: s, data }) = recv_frame(&mut ws).await {
            assert_eq!(s, session.id);
            out.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(out.contains("ping-remote"), "{out:?}");

    // 기기를 지우면 붙어 있던 연결이 끊긴다
    c.request(Request::RemoveRemoteDevice { id: device.id }).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                _ => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "기기를 지워도 연결이 남았다");
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn recv_frame(ws: &mut Ws) -> Option<Frame> {
    match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.ok()?? {
        Ok(Message::Binary(b)) => Some(Frame::decode(&b).unwrap()),
        _ => None,
    }
}

async fn recv_server(ws: &mut Ws, id: u64) -> thuminal_protocol::ResponseResult {
    loop {
        if let Some(Frame::Json(b)) = recv_frame(ws).await {
            if let Ok(ServerMessage::Response { id: got, result }) = serde_json::from_slice(&b) {
                if got == id {
                    return result;
                }
            }
        }
    }
}

async fn recv_response(ws: &mut Ws, id: u64) -> Response {
    match recv_server(ws, id).await {
        thuminal_protocol::ResponseResult::Ok(r) => r,
        thuminal_protocol::ResponseResult::Err(e) => panic!("{e:?}"),
    }
}

async fn recv_error(ws: &mut Ws, id: u64) -> String {
    match recv_server(ws, id).await {
        thuminal_protocol::ResponseResult::Err(e) => e.message,
        r => panic!("{r:?}"),
    }
}
