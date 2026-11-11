//! `wait_daemon_exit` 는 데몬이 잠금을 놓을 때까지 기다린다 (앱이 옛 버전 데몬을 내리고 새 데몬을 띄울 때 쓴다).
#![cfg(unix)] // 유닉스 소켓 경로 길이 때문에 /tmp 에 띄운다. Windows 는 windows.rs

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::{Client, wait_daemon_exit};
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_pty_portable::PortablePty;

#[tokio::test(flavor = "multi_thread")]
async fn waits_until_restarted_daemon_releases_lock() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let paths = Paths::new(dir.path());
    // 데몬이 아직 뜬 적 없으면 바로 놓인 것이다
    assert!(wait_daemon_exit(&paths, Duration::ZERO).await);

    let config = DaemonConfig {
        paths: paths.clone(),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin: None,
        web_root: None,
    };
    let run = tokio::spawn(Daemon::bind(config).unwrap().run());
    let c = Client::connect(&paths, "test").await.unwrap();
    assert!(!wait_daemon_exit(&paths, Duration::from_millis(200)).await, "떠 있는 데몬의 잠금은 잡히지 않는다");

    c.restart_daemon().await.unwrap();
    assert!(wait_daemon_exit(&paths, Duration::from_secs(10)).await);
    tokio::time::timeout(Duration::from_secs(5), run).await.unwrap().unwrap();
    // 잠금이 놓였으니 새 데몬이 뜬다
    let _again = Daemon::bind(DaemonConfig {
        paths: paths.clone(),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin: None,
        web_root: None,
    })
    .unwrap();
}
