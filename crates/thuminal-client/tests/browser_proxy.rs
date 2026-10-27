//! 원격 기기용 브라우저 칸 대리: 토큰을 쿠키로 바꿔 다시 보내고, Host 를 원래 주소로 바꿔 넘기고, 웹소켓 업그레이드를 잇는다.
#![cfg(unix)] // /tmp · /bin/sh · 유닉스 셸을 쓰는 시험이다. Windows 는 windows.rs

use std::sync::Arc;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{Request, Response};
use thuminal_pty_portable::PortablePty;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// 가짜 개발 서버: 받은 Host · 경로 · Origin · 쿠키를 글로 돌려주고, Upgrade 요청이면 101 뒤 받은 것을 되돌려 준다
async fn fake_dev_server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let line = head.lines().next().unwrap_or("").to_string();
                let get = |name: &str| {
                    head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string())).unwrap_or_default()
                };
                if !get("upgrade").is_empty() {
                    s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
                    let mut b = [0u8; 64];
                    while let Ok(n) = s.read(&mut b).await {
                        if n == 0 || s.write_all(&b[..n]).await.is_err() {
                            break;
                        }
                    }
                    return;
                }
                let body = format!("{line}|host={}|origin={}|cookie={}", get("host"), get("origin"), get("cookie"));
                let res = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nX-Frame-Options: DENY\r\nSet-Cookie: s=1; Domain=localhost; Path=/\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(res.as_bytes()).await;
            });
        }
    });
    port
}

/// 머리와 몸을 나눠 돌려준다 (Connection: close)
async fn http(port: u16, path: &str, extra: &str) -> (String, String) {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    (String::from_utf8_lossy(&buf[..split]).to_string(), String::from_utf8_lossy(&buf[split + 4..]).to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn proxies_local_dev_server_for_paired_devices() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let daemon = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir.path()), "test").await.unwrap();
    let dev = fake_dev_server().await;

    // 원격 접속이 꺼져 있으면 대리하지 않는다
    let ask = |url: String| Request::BrowserProxy { url };
    let Response::BrowserProxy { port } = c.request(ask(format!("http://localhost:{dev}/"))).await.unwrap() else { panic!() };
    assert_eq!(port, None);

    let remote_port = free_port();
    c.request(Request::SetRemote { enabled: Some(true), port: Some(remote_port), lan: None }).await.unwrap();
    c.request(Request::PairRemote { name: "시험".into() }).await.unwrap();
    let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join("remote.json")).unwrap()).unwrap();
    let token = stored["devices"][0]["token"].as_str().unwrap().to_string();

    let Response::BrowserProxy { port } = c.request(ask(format!("http://localhost:{dev}/app?x=1"))).await.unwrap() else { panic!() };
    let p = port.expect("대리 포트");
    assert!(p > remote_port, "원격 접속 포트 다음부터 쓴다");
    // 같은 대상은 같은 포트, 공개 주소는 대리하지 않는다
    let Response::BrowserProxy { port: again } = c.request(ask(format!("http://localhost:{dev}/other"))).await.unwrap() else { panic!() };
    assert_eq!(again, Some(p));
    let Response::BrowserProxy { port: public } = c.request(ask("https://example.com/".into())).await.unwrap() else { panic!() };
    assert_eq!(public, None);

    // 토큰 없이 오면 막는다
    let (head, _) = http(p, "/app", "").await;
    assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    // 틀린 토큰도
    let (head, _) = http(p, "/app?thuminal_proxy=nope", "").await;
    assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    // 맞는 토큰은 쿠키로 바꿔 토큰 없는 주소로 다시 보낸다
    let (head, _) = http(p, &format!("/app?x=1&thuminal_proxy={token}"), "").await;
    assert!(head.starts_with("HTTP/1.1 302"), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("location: /app?x=1"), "{head}");
    assert!(lower.contains(&format!("set-cookie: thuminal_proxy={token}")), "{head}");

    // 쿠키가 있으면 넘긴다: Host · Origin 은 원래 주소로, 우리 쿠키는 빼고 다른 쿠키는 남긴다
    let cookie = format!("Cookie: a=1; thuminal_proxy={token}\r\nOrigin: http://127.0.0.1:{p}\r\n");
    let (head, body) = http(p, "/app?x=1", &cookie).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}\n{body}");
    assert!(body.starts_with("GET /app?x=1 HTTP/1.1"), "{body}");
    assert!(body.contains(&format!("host=localhost:{dev}")), "{body}");
    assert!(body.contains(&format!("origin=http://localhost:{dev}")), "{body}");
    assert!(body.contains("cookie=a=1") && !body.contains("thuminal_proxy"), "{body}");
    // 칸 안에 띄우게 X-Frame-Options 를 빼고, 쿠키 Domain 도 뺀다
    let lower = head.to_ascii_lowercase();
    assert!(!lower.contains("x-frame-options"), "{head}");
    assert!(lower.contains("set-cookie: s=1; path=/") && !lower.contains("domain="), "{head}");

    // 웹소켓 업그레이드: 101 뒤로 바이트를 그대로 잇는다
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", p)).await.unwrap();
    s.write_all(format!("GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: thuminal_proxy={token}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buf = Vec::new();
    let mut b = [0u8; 256];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut b).await.unwrap();
        assert!(n > 0, "101 전에 끊겼다");
        buf.extend_from_slice(&b[..n]);
    }
    assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 101"), "{}", String::from_utf8_lossy(&buf));
    s.write_all(b"ping-hmr").await.unwrap();
    let mut echo = [0u8; 8];
    tokio::time::timeout(std::time::Duration::from_secs(3), s.read_exact(&mut echo)).await.unwrap().unwrap();
    assert_eq!(&echo, b"ping-hmr");

    // 개발 서버가 없으면 502
    let gone = free_port();
    let Response::BrowserProxy { port: Some(gp) } = c.request(ask(format!("http://localhost:{gone}/"))).await.unwrap() else { panic!() };
    let (head, body) = http(gp, "/", &format!("Cookie: thuminal_proxy={token}\r\n")).await;
    assert!(head.starts_with("HTTP/1.1 502") && body.contains(&format!("localhost:{gone}")), "{head}\n{body}");
}
