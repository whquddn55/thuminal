//! 파일 칸: 글자 파일 고쳐 쓰기(바뀐 때로 덮어쓰기 막기), 바이트 조각 읽기, 웹 화면의 `/api/file` (Range).
#![cfg(unix)] // /tmp · /bin/sh · 유닉스 셸을 쓰는 시험이다. Windows 는 windows.rs

use std::sync::Arc;

use base64::Engine;
use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{ErrorCode, Request, Response};
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

/// 데몬을 띄우고 git 저장소 하나를 등록한다. (폴더, 연결, 워크트리 경로)
async fn start() -> (tempfile::TempDir, Client, String) {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let daemon = Daemon::bind(config(dir.path())).unwrap();
    tokio::spawn(daemon.run());
    let c = Client::connect(&Paths::new(dir.path()), "test").await.unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let st = std::process::Command::new("git").current_dir(&root).args(["init", "-q", "-b", "main"]).output().unwrap();
    assert!(st.status.success());
    c.add_repo(root.to_string_lossy()).await.unwrap();
    (dir, c, root.to_string_lossy().into_owned())
}

async fn read(c: &Client, w: &str, file: &str) -> thuminal_protocol::FileContent {
    match c.request(Request::ReadFile { worktree: w.into(), file: file.into() }).await.unwrap() {
        Response::File { file } => file,
        r => panic!("{r:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn write_file_refuses_when_changed_elsewhere() {
    let (_dir, c, w) = start().await;
    std::fs::write(format!("{w}/README.md"), "# 제목\n").unwrap();
    let first = read(&c, &w, "README.md").await;
    let at = first.modified.expect("바뀐 때를 준다");

    let write = |text: &str, expect: Option<u64>| Request::WriteFile { worktree: w.clone(), file: "README.md".into(), text: text.into(), expect_modified: expect };
    let Response::File { file: saved } = c.request(write("# 고친 제목\n", Some(at))).await.unwrap() else { panic!() };
    assert_eq!(std::fs::read_to_string(format!("{w}/README.md")).unwrap(), "# 고친 제목\n");
    assert_eq!(read(&c, &w, "README.md").await.modified, saved.modified);

    // claude 가 그사이 고쳤다
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(format!("{w}/README.md"), "# claude 가 고침\n").unwrap();
    match c.request(write("# 덮어쓰기\n", saved.modified)).await {
        Err(thuminal_client::ClientError::Daemon(ErrorCode::Conflict, _)) => {}
        r => panic!("그사이 바뀌었으면 거절해야 한다: {r:?}"),
    }
    assert_eq!(std::fs::read_to_string(format!("{w}/README.md")).unwrap(), "# claude 가 고침\n");
    // 덮어쓰기를 고르면 바뀐 때 없이 보낸다
    c.request(write("# 덮어쓰기\n", None)).await.unwrap();
    assert_eq!(std::fs::read_to_string(format!("{w}/README.md")).unwrap(), "# 덮어쓰기\n");

    let outside = Request::WriteFile { worktree: w.clone(), file: "../x.md".into(), text: "x".into(), expect_modified: None };
    assert!(matches!(c.request(outside).await, Err(thuminal_client::ClientError::Daemon(ErrorCode::InvalidRequest, _))));
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_bytes_and_serves_ranges() {
    let (dir, c, w) = start().await;
    let data: Vec<u8> = (0..6_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(format!("{w}/clip.mp4"), &data).unwrap();

    let piece = |offset: u64, len: u64| Request::ReadFileBytes { worktree: w.clone(), file: "clip.mp4".into(), offset, len };
    let Response::FileBytes { bytes } = c.request(piece(1000, 64)).await.unwrap() else { panic!() };
    let got = base64::engine::general_purpose::STANDARD.decode(&bytes.data).unwrap();
    assert_eq!((got.as_slice(), bytes.size, bytes.offset), (&data[1000..1064], 6_000_000, 1000));
    let Response::FileBytes { bytes } = c.request(piece(0, u64::MAX)).await.unwrap() else { panic!() };
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(&bytes.data).unwrap().len(), 4 * 1024 * 1024, "한 번에 4MB 까지");

    // 웹 화면: 토큰이 맞아야 하고, Range 를 받으면 206
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    c.request(Request::SetRemote { enabled: Some(true), port: Some(port), lan: None }).await.unwrap();
    c.request(Request::PairRemote { name: "시험".into() }).await.unwrap();
    let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join("remote.json")).unwrap()).unwrap();
    let token = stored["devices"][0]["token"].as_str().unwrap().to_string();
    let get = |q: String, range: Option<&str>| {
        let range = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(format!("GET /api/file?{q} HTTP/1.1\r\nHost: 127.0.0.1\r\n{range}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
            let mut buf = Vec::new();
            s.read_to_end(&mut buf).await.unwrap();
            let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            (String::from_utf8_lossy(&buf[..split]).to_string(), buf[split + 4..].to_vec())
        }
    };
    let enc = |s: &str| s.replace('/', "%2F");
    let q = |token: &str| format!("token={token}&worktree={}&file=clip.mp4", enc(&w));
    let (head, _) = get(q("nope"), None).await;
    assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    let (head, body) = get(q(&token), Some("bytes=0-1")).await;
    assert!(head.starts_with("HTTP/1.1 206"), "{head}");
    assert!(head.to_ascii_lowercase().contains("content-range: bytes 0-1/6000000"), "{head}");
    assert!(head.contains("video/mp4"), "{head}");
    assert_eq!(body, &data[..2]);
    // 끝이 열린 구간은 4MB 씩 끊어 낸다 (플레이어가 다음 구간을 다시 달라고 한다)
    let (head, body) = get(q(&token), Some("bytes=5000000-")).await;
    assert!(head.to_ascii_lowercase().contains("content-range: bytes 5000000-5999999/6000000"), "{head}");
    assert_eq!(body, &data[5_000_000..]);
    let (head, _) = get(q(&token), Some("bytes=7000000-")).await;
    assert!(head.starts_with("HTTP/1.1 416"), "{head}");
    // 워크트리 밖은 내지 않는다
    let (head, _) = get(format!("token={token}&worktree={}&file=..%2Fx", enc(&w)), None).await;
    assert!(head.starts_with("HTTP/1.1 404"), "{head}");
}
