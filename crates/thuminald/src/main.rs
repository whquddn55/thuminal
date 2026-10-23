//! thuminal 데몬 실행 파일.
//!
//! 엔진, PTY, 버전 관리 어댑터를 고르는 유일한 곳이다. 다른 구현으로 바꾸려면
//! 여기서 끼우는 것만 바꾼다.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use thuminal_daemon::{Daemon, DaemonConfig, DaemonError};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_pty_portable::PortablePty;
use thuminal_vcs_git::GitCli;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "thuminald", about = "thuminal 데몬. 보통은 앱이나 CLI 가 알아서 띄운다.")]
struct Args {
    /// 데이터 폴더 (기본: THUMINAL_HOME 또는 ~/Library/Application Support/thuminal)
    #[arg(long)]
    home: Option<PathBuf>,
}

/// thuminal claude 플러그인 폴더를 찾는다.
/// 1. `THUMINAL_CLAUDE_PLUGIN` 2. 앱 번들 `Contents/Resources/claude-plugin` 3. 개발 중 저장소의 `plugins/claude-code/thuminal`
fn claude_plugin_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("THUMINAL_CLAUDE_PLUGIN").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.join("../Resources/claude-plugin");
    if bundled.join(".claude-plugin/plugin.json").is_file() {
        return std::fs::canonicalize(bundled).ok();
    }
    dir.ancestors().map(|a| a.join("plugins/claude-code/thuminal")).find(|p| p.join(".claude-plugin/plugin.json").is_file())
}

fn main() {
    let args = Args::parse();
    let paths = args.home.map(Paths::new).unwrap_or_else(Paths::default_home);

    // JSON 한 줄 로그. `event` 필드로 기능 사용을 셀 수 있다
    let _ = std::fs::create_dir_all(paths.logs());
    let appender = tracing_appender::rolling::never(paths.logs(), "daemon.log");
    let (writer, _guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_env("THUMINAL_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(writer)
        .with_current_span(false)
        .init();

    let config = DaemonConfig {
        paths,
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(GitCli),
        claude_plugin: claude_plugin_dir(),
    };
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio 런타임");
    // 소켓은 tokio 런타임 안에서 연다
    let _enter = rt.enter();
    let daemon = match Daemon::bind(config) {
        Ok(d) => d,
        Err(DaemonError::AlreadyRunning(pid)) => {
            eprintln!("이미 데몬이 떠 있다 (pid {pid:?})");
            return;
        }
        Err(e) => {
            eprintln!("데몬을 띄우지 못했다: {e}");
            std::process::exit(1);
        }
    };

    rt.block_on(async move {
        let shutdown = daemon.server.shutdown.clone();
        tokio::spawn(async move {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
            let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).expect("SIGINT");
            tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
            tracing::info!(event = "signal_shutdown");
            shutdown.notify_waiters();
        });
        daemon.run().await;
    });
}
