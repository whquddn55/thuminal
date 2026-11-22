//! thuminal 데몬 실행 파일.
//!
//! 엔진, PTY, 버전 관리 어댑터를 고르는 유일한 곳이다. 다른 구현으로 바꾸려면
//! 여기서 끼우는 것만 바꾼다.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use thuminal_daemon::{Daemon, DaemonConfig, DaemonError};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::{Paths, RUNTIME_READY};
use thuminal_pty_portable::PortablePty;
use thuminal_vcs_git::GitCli;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "thuminald", about = "thuminal 데몬. 보통은 앱이나 CLI 가 알아서 띄운다.")]
struct Args {
    /// 데이터 폴더 (기본: THUMINAL_HOME, 없으면 macOS 는 ~/Library/Application Support/thuminal, Linux 는 ~/.local/share/thuminal)
    #[arg(long)]
    home: Option<PathBuf>,
}

/// 설치된 앱의 리소스 폴더 안 `name`. Tauri 가 리소스를 두는 곳은 OS 마다 다르다:
/// macOS 는 `Contents/MacOS/../Resources`, Linux(deb · rpm · AppImage)는 `usr/bin/../lib/thuminal`, Windows 는 실행 파일 옆이다
fn bundled_resource(exe_dir: &std::path::Path, name: &str, marker: &str) -> Option<PathBuf> {
    ["../Resources", "../lib/thuminal", "."]
        .iter()
        .map(|base| exe_dir.join(base).join(name))
        .find(|p| p.join(marker).is_file())
        .and_then(|p| dunce::canonicalize(p).ok())
}

/// thuminal claude 플러그인 폴더를 찾는다.
/// 1. `THUMINAL_CLAUDE_PLUGIN` 2. 설치된 앱의 리소스 `claude-plugin` 3. 개발 중 저장소의 `plugins/claude-code/thuminal`
fn claude_plugin_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("THUMINAL_CLAUDE_PLUGIN").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if let Some(p) = bundled_resource(dir, "claude-plugin", ".claude-plugin/plugin.json") {
        return Some(p);
    }
    dir.ancestors().map(|a| a.join("plugins/claude-code/thuminal")).find(|p| p.join(".claude-plugin/plugin.json").is_file())
}

/// 원격 접속 웹 화면 파일 폴더를 찾는다.
/// 1. `THUMINAL_WEB_ROOT` 2. 앱이 데이터 폴더에 맞춰 둔 `runtime/web` (앱을 업데이트하면 데몬이 그대로여도 바뀐다)
/// 3. 설치된 앱의 리소스 `web` 4. 개발 중 저장소의 `apps/web/dist`
fn web_root(paths: &Paths) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("THUMINAL_WEB_ROOT").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(p);
    }
    let staged = paths.runtime().join("web");
    if staged.join("index.html").is_file() {
        return Some(staged);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if let Some(p) = bundled_resource(dir, "web", "index.html") {
        return Some(p);
    }
    // 개발 중에는 아직 빌드하지 않았어도 폴더 자리를 준다 (나중에 빌드하면 바로 보인다)
    dir.ancestors().find(|a| a.join("apps/web/package.json").is_file()).map(|a| a.join("apps/web/dist"))
}

fn main() {
    let args = Args::parse();
    // 새 터미널은 $SHELL 을 띄운다. 계정의 로그인 셸(passwd)로 맞춘다. 아직 스레드가 없을 때 바꾼다
    #[cfg(unix)]
    if let Some(shell) = thuminal_daemon::sys::login_shell() {
        // SAFETY: 런타임 · 로그 스레드를 만들기 전이라 환경을 읽는 다른 스레드가 없다
        unsafe { std::env::set_var("SHELL", shell) };
    }
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

    let web_root = web_root(&paths);
    let config = DaemonConfig {
        paths,
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(GitCli),
        claude_plugin: claude_plugin_dir(),
        web_root,
    };
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio 런타임");
    // 소켓은 tokio 런타임 안에서 연다
    let _enter = rt.enter();
    let runtime_paths = config.paths.clone();
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

    // 잠금을 쥐었으니 이 데이터 폴더의 데몬은 이것뿐이다. 쓰지 않는 옛 빌드 폴더를 지운다
    if let Ok(exe) = std::env::current_exe() {
        prune_runtime(&runtime_paths, &exe);
    }

    rt.block_on(async move {
        let shutdown = daemon.server.shutdown.clone();
        tokio::spawn(async move {
            shutdown_signal().await;
            tracing::info!(event = "signal_shutdown");
            shutdown.notify_waiters();
        });
        daemon.run().await;
    });
}

/// 이 데몬(`exe`)이 `runtime/<빌드 id>/` 복사본으로 돌면, 쓰지 않는 다른 빌드 폴더와 남은 임시 폴더를 지운다 (`runtime/web` 은 둔다).
/// 설치본 · 개발 빌드에서 바로 돈 데몬은 아무것도 지우지 않는다. 지우지 못한 것(Windows 에서 쓰는 중인 CLI 사본 등)은 다음에 다시 지운다
fn prune_runtime(paths: &Paths, exe: &std::path::Path) {
    let root = paths.runtime();
    let Some(own) = exe.parent().filter(|d| d.parent() == Some(root.as_path())) else { return };
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p == own || e.file_name() == "web" || !p.is_dir() {
            continue;
        }
        // 표시를 먼저 지워 반쯤 지운 폴더를 다시 쓰지 않게 한다
        let _ = std::fs::remove_file(p.join(RUNTIME_READY));
        match std::fs::remove_dir_all(&p) {
            Ok(()) => tracing::info!(event = "runtime_pruned", dir = %p.display()),
            Err(e) => tracing::info!(event = "runtime_prune_skipped", dir = %p.display(), error = %e),
        }
    }
}

/// 내려가라는 신호. 유닉스는 SIGTERM · SIGINT, Windows 는 Ctrl+C · 콘솔 닫기 · 로그오프 · 시스템 종료
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT");
        tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let mut c = windows::ctrl_c().expect("Ctrl+C");
        let mut close = windows::ctrl_close().expect("CTRL_CLOSE");
        let mut logoff = windows::ctrl_logoff().expect("CTRL_LOGOFF");
        let mut shut = windows::ctrl_shutdown().expect("CTRL_SHUTDOWN");
        tokio::select! { _ = c.recv() => {}, _ = close.recv() => {}, _ = logoff.recv() => {}, _ = shut.recv() => {} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_own_build_and_web() {
        let home = std::env::temp_dir().join(format!("thuminal-prune-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let paths = Paths::new(&home);
        let root = paths.runtime();
        for d in ["aaa", "bbb", "web", ".tmp-ccc-1"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
            std::fs::write(root.join(d).join(RUNTIME_READY), "x").unwrap();
        }
        prune_runtime(&paths, &root.join("aaa").join("thuminald"));
        let left: std::collections::BTreeSet<String> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["aaa", "web"].into_iter().map(String::from).collect());
        // 빌드 폴더 밖에서 도는 데몬(설치본 · 개발 빌드)은 아무것도 지우지 않는다
        std::fs::create_dir_all(root.join("ddd")).unwrap();
        prune_runtime(&paths, &home.join("thuminald"));
        assert!(root.join("ddd").is_dir());
        let _ = std::fs::remove_dir_all(&home);
    }
}
