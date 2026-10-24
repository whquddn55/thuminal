//! thuminal 데몬 로직.
//!
//! 엔진과 PTY 는 [`DaemonConfig`] 로 받는다. 어떤 어댑터를 끼울지는 실행 파일
//! (`thuminald`) 이 정한다.

pub mod layout;
pub mod lock;
pub mod manager;
pub mod persist;
pub mod server;
pub mod session;
pub mod shell;
pub mod teams;

use std::sync::Arc;

use thuminal_engine::EngineFactory;
use thuminal_protocol::paths::Paths;
use thuminal_pty::PtySystem;
use thuminal_workspace::{Vcs, Workspace};
use tokio::net::UnixListener;
use tracing::info;

pub use server::read_frame;

pub struct DaemonConfig {
    pub paths: Paths,
    pub engine: Arc<dyn EngineFactory>,
    pub pty: Arc<dyn PtySystem>,
    pub vcs: Arc<dyn Vcs>,
    /// thuminal claude 플러그인 폴더 (셸 통합이 `claude --plugin-dir` 로 붙인다). 없으면 붙이지 않는다
    pub claude_plugin: Option<std::path::PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("이미 데몬이 떠 있다 (pid {0:?})")]
    AlreadyRunning(Option<u32>),
    #[error("입출력 오류: {0}")]
    Io(#[from] std::io::Error),
}

/// 데몬 하나가 뜬 상태. `run` 이 끝나면 소켓을 지운다.
pub struct Daemon {
    pub server: Arc<server::Server>,
    listener: UnixListener,
    paths: Paths,
    _lock: lock::InstanceLock,
}

impl Daemon {
    /// 잠금을 잡고 소켓을 연다. 여기까지 되면 클라이언트가 붙을 수 있다.
    pub fn bind(config: DaemonConfig) -> Result<Self, DaemonError> {
        let paths = config.paths;
        std::fs::create_dir_all(&paths.home)?;
        set_private(&paths.home);
        let lock = lock::InstanceLock::acquire(&paths.lock())?;
        let socket = paths.socket();
        // 잠금을 잡았으니 남아 있는 소켓은 죽은 데몬이 남긴 것이다
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket)?;
        let shell = shell::ShellIntegration::new(&paths.home, config.claude_plugin);
        shell.install();
        let manager = Arc::new(manager::Manager::new(config.engine, config.pty, socket.clone(), shell, &paths.home));
        let workspace = Arc::new(Workspace::open(config.vcs, &paths.home));
        let layouts = Arc::new(layout::Layouts::load(&paths.home));
        info!(event = "daemon_started", pid = std::process::id(), socket = %socket.display(), engine = manager.engine_name());
        let teams = teams::Teams::new(manager.clone());
        Ok(Self { server: server::Server::new(manager, workspace, layouts, teams), listener, paths, _lock: lock })
    }

    pub async fn run(self) {
        let Daemon { server, listener, paths, _lock } = self;
        let persist = Arc::new(persist::Persist::new(&paths.home));
        // 지난번 데몬이 종료 신호나 사고로 내려갔으면 그때 세션을 되살린다
        server.manager.restore(persist.take_previous());
        // 배치의 옛 세션 번호를 새 번호로 바꾸고, 칸에 없는 세션을 넣는다
        server.layouts.restore(&server.manager);
        let teams = tokio::spawn(server.teams.clone().watch());
        let saver = tokio::spawn(save_loop(server.manager.clone(), server.layouts.clone(), persist.clone()));

        server.clone().serve(listener).await;
        saver.abort();
        teams.abort();
        // 저장 작업이 다른 스레드에서 쓰는 중일 수 있다. 끝난 뒤에 지우거나 남긴다
        let _ = saver.await;
        let mode = *server.stop_mode.lock().unwrap();
        match mode {
            server::StopMode::Clear => {
                persist.clear();
                server.layouts.clear();
            }
            server::StopMode::Keep => {
                save_all(&server.manager, &persist).await;
                server.layouts.save();
            }
        }
        let _ = std::fs::remove_file(paths.socket());
        info!(event = "daemon_stopped", pid = std::process::id(), ?mode);
    }
}

/// 세션 목록이나 배치가 바뀌면 1초 안에 기록을 쓰고, 30초마다 출력이 있었던 세션의 화면 저장본을 쓴다
async fn save_loop(manager: Arc<manager::Manager>, layouts: Arc<layout::Layouts>, persist: Arc<persist::Persist>) {
    let mut events = manager.events.subscribe();
    let mut dirty = true;
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut last_snap = 0u64;
    let mut n = 0u64;
    loop {
        tokio::select! {
            e = events.recv() => match e {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => dirty = true,
                Err(_) => return,
            },
            _ = tick.tick() => {
                n += 1;
                layouts.save_if_dirty();
                if dirty {
                    persist.save_records(&manager.list());
                    dirty = false;
                }
                if n % 30 == 0 {
                    let now = session::now_ms();
                    for s in manager.list() {
                        if s.last_output_at >= last_snap {
                            if let Ok(bytes) = manager.snapshot(s.id, thuminal_protocol::SnapshotFormat::Vt).await {
                                persist.save_snapshot(s.id.0, &bytes);
                            }
                        }
                    }
                    last_snap = now;
                }
            }
        }
    }
}

/// 내려가기 전에 모든 세션의 기록과 화면 저장본을 남긴다
async fn save_all(manager: &manager::Manager, persist: &persist::Persist) {
    let list = manager.list();
    for s in &list {
        if let Ok(bytes) = manager.snapshot(s.id, thuminal_protocol::SnapshotFormat::Vt).await {
            persist.save_snapshot(s.id.0, &bytes);
        }
    }
    persist.save_records(&list);
    info!(event = "sessions_saved", count = list.len());
}

fn set_private(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700));
}
