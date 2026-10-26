//! thuminal 데몬 클라이언트.
//!
//! 연결 하나에 읽기 작업 하나가 붙어, 들어온 프레임을 나눠 준다.
//! - 응답은 요청 id 로 기다리는 쪽에
//! - 이벤트는 [`Client::events`] 구독자에게
//! - 세션 출력은 [`Client::attach`] 가 돌려준 줄에
//!
//! 전송은 둘이다. 같은 컴퓨터 데몬은 유닉스 소켓([`Client::connect`]), 다른 컴퓨터 데몬은 원격 접속 웹소켓
//! ([`Client::connect_ws`], [`ws`]). 웹소켓은 길이 머리를 뗀 프레임이라 안에서 바이트 줄로 바꿔 같은 읽기 작업을 탄다.
//! 끊기면 다시 붙는 일은 [`link::Link`] 가 맡는다.

pub mod link;
pub mod ws;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thuminal_protocol::paths::Paths;
use thuminal_protocol::{
    ClientMessage, CreateSession, ErrorBody, Event, Frame, LayoutOp, PROTOCOL_MAJOR, PROTOCOL_MINOR, PaneId, RepoGroup, RepoInfo, Request,
    Response, ResponseResult, ScreenFormat, ServerMessage, SessionId, SessionInfo, SnapshotFormat, TerminalColors,
    WorkspaceLayout, WorktreeInfo,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("데몬에 붙지 못했다 ({path}): {source}")]
    Connect { path: PathBuf, source: std::io::Error },
    #[error("원격 데몬에 붙지 못했다 ({url}): {reason}")]
    ConnectRemote { url: String, reason: String },
    #[error("원격 데몬이 토큰을 받지 않았다. 원격 컴퓨터에서 기기를 다시 등록한다")]
    Unauthorized,
    #[error("프로토콜 주 판이 다르다: {0}")]
    VersionMismatch(String),
    #[error("데몬을 띄우지 못했다: {0}")]
    Spawn(String),
    #[error("데몬이 오류로 답했다: {0:?} {1}")]
    Daemon(thuminal_protocol::ErrorCode, String),
    #[error("데몬과 연결이 끊겼다")]
    Disconnected,
    #[error("예상하지 못한 응답: {0:?}")]
    Unexpected(Box<Response>),
    #[error("입출력 오류: {0}")]
    Io(#[from] std::io::Error),
}

impl From<ErrorBody> for ClientError {
    fn from(e: ErrorBody) -> Self {
        ClientError::Daemon(e.code, e.message)
    }
}

pub type Result<T> = std::result::Result<T, ClientError>;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<ResponseResult>>>>;
type Outputs = Arc<Mutex<HashMap<SessionId, mpsc::UnboundedSender<Vec<u8>>>>>;
type Snapshots = Arc<Mutex<HashMap<SessionId, Vec<u8>>>>;

/// 붙은 세션: 저장본 + 그 뒤로 이어지는 출력
pub struct Attachment {
    pub session: SessionInfo,
    pub format: SnapshotFormat,
    pub snapshot: Vec<u8>,
    pub output: mpsc::UnboundedReceiver<Vec<u8>>,
}

type Writer = Box<dyn AsyncWrite + Send + Unpin>;

pub struct Client {
    writer: tokio::sync::Mutex<Writer>,
    next_id: AtomicU64,
    pending: Pending,
    outputs: Outputs,
    snapshots: Snapshots,
    events: broadcast::Sender<Event>,
    /// 연결이 끊기면 true
    closed: Arc<watch::Sender<bool>>,
    /// `hello` 응답
    pub daemon: Response,
    /// 데몬 프로토콜 부 판이 이 클라이언트와 다를 때 알릴 글 (주 판이 다르면 붙지 않는다)
    pub version_warning: Option<String>,
}

impl Client {
    /// 이미 떠 있는 데몬에 붙는다.
    pub async fn connect(paths: &Paths, client_name: &str) -> Result<Client> {
        let path = paths.socket();
        let stream = UnixStream::connect(&path).await.map_err(|source| ClientError::Connect { path, source })?;
        let (rd, wr) = stream.into_split();
        Client::from_stream(rd, wr, client_name).await
    }

    /// 프레임(`[길이 u32][종류 u8][내용]`)이 오가는 아무 바이트 줄 위에서 붙는다. hello 로 판을 맞춘다
    pub async fn from_stream<R, W>(mut rd: R, wr: W, client_name: &str) -> Result<Client>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let pending: Pending = Default::default();
        let outputs: Outputs = Default::default();
        let snapshots: Snapshots = Default::default();
        let events = broadcast::channel(1024).0;

        let closed = Arc::new(watch::channel(false).0);
        let (p, o, s, e, done) = (pending.clone(), outputs.clone(), snapshots.clone(), events.clone(), closed.clone());
        tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut rd).await {
                match frame {
                    Frame::Json(bytes) => match serde_json::from_slice::<ServerMessage>(&bytes) {
                        Ok(ServerMessage::Response { id, result }) => {
                            if let Some(tx) = p.lock().unwrap().remove(&id) {
                                let _ = tx.send(result);
                            }
                        }
                        Ok(ServerMessage::Event { event }) => {
                            let _ = e.send(event);
                        }
                        Err(err) => tracing::warn!(error = %err, "데몬 메시지를 읽지 못했다"),
                    },
                    Frame::Output { session, data } => {
                        let mut outs = o.lock().unwrap();
                        if let Some(tx) = outs.get(&session) {
                            if tx.send(data).is_err() {
                                outs.remove(&session);
                            }
                        }
                    }
                    Frame::Snapshot { session, data, .. } => {
                        s.lock().unwrap().insert(session, data);
                    }
                    Frame::Input { .. } => {}
                }
            }
            // 연결이 끊기면 기다리던 요청을 모두 깨운다
            done.send_replace(true);
            p.lock().unwrap().clear();
            o.lock().unwrap().clear();
        });

        let mut client = Client {
            writer: tokio::sync::Mutex::new(Box::new(wr)),
            next_id: AtomicU64::new(1),
            pending,
            outputs,
            snapshots,
            events,
            closed,
            daemon: Response::Ok,
            version_warning: None,
        };
        let hello = client
            .request(Request::Hello { protocol_major: PROTOCOL_MAJOR, protocol_minor: PROTOCOL_MINOR, client: client_name.into() })
            .await
            .map_err(|e| match e {
                ClientError::Daemon(thuminal_protocol::ErrorCode::VersionMismatch, m) => ClientError::VersionMismatch(m),
                e => e,
            })?;
        client.version_warning = check_hello(&hello)?;
        if let Some(w) = &client.version_warning {
            tracing::warn!(warning = %w, "데몬 프로토콜 부 판이 다르다");
        }
        client.daemon = hello;
        Ok(client)
    }

    /// 다른 컴퓨터 데몬의 원격 접속에 웹소켓으로 붙는다. `base` 는 `http://100.x.y.z:6780` (끝 / 없이)
    pub async fn connect_ws(base: &str, token: &str, client_name: &str) -> Result<Client> {
        let (rd, wr) = ws::connect(base, token).await?;
        Client::from_stream(rd, wr, client_name).await
    }

    /// 데몬에 붙고, 없으면 `daemon_bin` 을 떼어 띄운 뒤 붙는다.
    pub async fn connect_or_spawn(paths: &Paths, client_name: &str, daemon_bin: &Path) -> Result<Client> {
        if let Ok(c) = Client::connect(paths, client_name).await {
            return Ok(c);
        }
        spawn_daemon(paths, daemon_bin)?;
        let mut last = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            match Client::connect(paths, client_name).await {
                Ok(c) => return Ok(c),
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or(ClientError::Disconnected))
    }

    /// 데몬과 연결이 끊겼는지 (데몬이 내려갔거나 다시 떴다)
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// 연결이 끊길 때까지 기다린다
    pub async fn closed(&self) {
        let mut rx = self.closed.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    /// `hello` 응답의 데몬 판 (데몬 판, 프로토콜 주 판, 부 판)
    pub fn hello(&self) -> Option<(&str, u32, u32)> {
        match &self.daemon {
            Response::Hello { daemon_version, protocol_major, protocol_minor, .. } => Some((daemon_version.as_str(), *protocol_major, *protocol_minor)),
            _ => None,
        }
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    async fn write(&self, frame: Frame) -> Result<()> {
        self.writer.lock().await.write_all(&frame.encode()).await.map_err(|_| ClientError::Disconnected)
    }

    pub async fn request(&self, request: Request) -> Result<Response> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.write(Frame::json(&ClientMessage::Request { id, request })).await?;
        match rx.await.map_err(|_| ClientError::Disconnected)? {
            ResponseResult::Ok(r) => Ok(r),
            ResponseResult::Err(e) => Err(e.into()),
        }
    }

    pub async fn create(&self, req: CreateSession) -> Result<SessionInfo> {
        match self.request(Request::CreateSession(req)).await? {
            Response::Session { session } => Ok(session),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn list(&self) -> Result<Vec<SessionInfo>> {
        match self.request(Request::ListSessions).await? {
            Response::Sessions { sessions } => Ok(sessions),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn attach(&self, session: SessionId, format: SnapshotFormat) -> Result<Attachment> {
        // 출력 줄을 먼저 걸어 둔다. 데몬은 저장본 → 응답 → 출력 순서로 보낸다
        let (tx, output) = mpsc::unbounded_channel();
        self.outputs.lock().unwrap().insert(session, tx);
        let info = match self.request(Request::Attach { session, snapshot: format }).await {
            Ok(Response::Attached { session }) => session,
            Ok(other) => return Err(ClientError::Unexpected(Box::new(other))),
            Err(e) => {
                self.outputs.lock().unwrap().remove(&session);
                return Err(e);
            }
        };
        let snapshot = self.snapshots.lock().unwrap().remove(&session).unwrap_or_default();
        Ok(Attachment { session: info, format, snapshot, output })
    }

    pub async fn detach(&self, session: SessionId) -> Result<()> {
        self.outputs.lock().unwrap().remove(&session);
        self.request(Request::Detach { session }).await.map(|_| ())
    }

    pub async fn input(&self, session: SessionId, data: impl Into<Vec<u8>>) -> Result<()> {
        self.write(Frame::Input { session, data: data.into() }).await
    }

    pub async fn send_text(&self, session: SessionId, text: impl Into<String>) -> Result<()> {
        self.request(Request::SendText { session, text: text.into() }).await.map(|_| ())
    }

    pub async fn resize(&self, session: SessionId, cols: u16, rows: u16) -> Result<SessionInfo> {
        match self.request(Request::Resize { session, cols, rows }).await? {
            Response::Session { session } => Ok(session),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn read_screen(&self, session: SessionId, format: ScreenFormat, scrollback: bool) -> Result<String> {
        match self.request(Request::ReadScreen { session, format, scrollback }).await? {
            Response::Screen { text } => Ok(text),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn kill(&self, session: SessionId) -> Result<()> {
        self.request(Request::Kill { session }).await.map(|_| ())
    }

    pub async fn remove(&self, session: SessionId) -> Result<()> {
        self.request(Request::Remove { session }).await.map(|_| ())
    }

    pub async fn repos(&self) -> Result<Vec<RepoInfo>> {
        match self.request(Request::ListRepos).await? {
            Response::Repos { repos } => Ok(repos),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    /// 사이드바 워크스페이스 (프로젝트 묶음)
    pub async fn groups(&self) -> Result<Vec<RepoGroup>> {
        match self.request(Request::ListGroups).await? {
            Response::Groups { groups } => Ok(groups),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    /// 워크스페이스 목록을 통째로 바꾸고 데몬이 맞춘 목록을 돌려받는다
    pub async fn set_groups(&self, groups: Vec<RepoGroup>) -> Result<Vec<RepoGroup>> {
        match self.request(Request::SetGroups { groups }).await? {
            Response::Groups { groups } => Ok(groups),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn add_repo(&self, path: impl Into<String>) -> Result<RepoInfo> {
        match self.request(Request::AddRepo { path: path.into() }).await? {
            Response::Repo { repo } => Ok(repo),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn worktrees(&self, repo: Option<String>) -> Result<Vec<WorktreeInfo>> {
        match self.request(Request::ListWorktrees { repo }).await? {
            Response::Worktrees { worktrees } => Ok(worktrees),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn create_worktree(&self, repo: String, branch: String, base: Option<String>, parent: Option<String>) -> Result<WorktreeInfo> {
        match self.request(Request::CreateWorktree { repo, branch, base, name: None, parent }).await? {
            Response::Worktree { worktree } => Ok(worktree),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    /// 워크트리를 지운다. `force` 는 워크트리에만, `force_branch` 는 브랜치에만 쓴다.
    /// 알릴 것(예: 합치지 않은 브랜치를 남겼다)이 있으면 그 글, 없으면 빈 글을 돌려준다
    pub async fn remove_worktree(&self, repo: String, path: String, force: bool, delete_branch: bool, force_branch: bool) -> Result<String> {
        match self.request(Request::RemoveWorktree { repo, path, force, delete_branch, force_branch }).await? {
            Response::Text { text } => Ok(text),
            Response::Ok => Ok(String::new()),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    /// `workspace` 를 비우면 모든 workspace
    pub async fn layouts(&self, workspace: Option<String>) -> Result<Vec<WorkspaceLayout>> {
        match self.request(Request::GetLayout { workspace }).await? {
            Response::Layouts { layouts } => Ok(layouts),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    /// 배치 op 하나. 바뀐 배치와 새로 만든 칸
    pub async fn layout(&self, op: LayoutOp) -> Result<(Vec<WorkspaceLayout>, Vec<PaneId>)> {
        match self.request(Request::Layout { op }).await? {
            Response::LayoutResult { layouts, created } => Ok((layouts, created)),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn layout_batch(&self, ops: Vec<LayoutOp>) -> Result<(Vec<WorkspaceLayout>, Vec<PaneId>)> {
        match self.request(Request::LayoutBatch { ops }).await? {
            Response::LayoutResult { layouts, created } => Ok((layouts, created)),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn terminal_colors(&self) -> Result<Option<TerminalColors>> {
        match self.request(Request::GetTerminalColors).await? {
            Response::TerminalColors { colors } => Ok(colors),
            other => Err(ClientError::Unexpected(Box::new(other))),
        }
    }

    pub async fn set_terminal_colors(&self, colors: TerminalColors) -> Result<()> {
        self.request(Request::SetTerminalColors { colors }).await.map(|_| ())
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.request(Request::Shutdown).await.map(|_| ())
    }
}

/// hello 응답을 본다. 주 판이 다르면 거절하고, 부 판이 다르면 알릴 글을 돌려준다
pub fn check_hello(hello: &Response) -> Result<Option<String>> {
    let Response::Hello { protocol_major, protocol_minor, daemon_version, .. } = hello else {
        return Err(ClientError::Unexpected(Box::new(hello.clone())));
    };
    if *protocol_major != PROTOCOL_MAJOR {
        return Err(ClientError::VersionMismatch(format!("데몬은 프로토콜 {protocol_major}, 클라이언트는 {PROTOCOL_MAJOR}")));
    }
    Ok(match protocol_minor.cmp(&PROTOCOL_MINOR) {
        std::cmp::Ordering::Equal => None,
        std::cmp::Ordering::Less => Some(format!(
            "데몬({daemon_version})이 옛 판이다 (프로토콜 {protocol_major}.{protocol_minor}, 앱은 {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}). 새 기능 일부가 안 될 수 있다. 그 컴퓨터의 thuminal 을 업데이트한다"
        )),
        std::cmp::Ordering::Greater => Some(format!(
            "데몬({daemon_version})이 더 새 판이다 (프로토콜 {protocol_major}.{protocol_minor}, 앱은 {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}). 이 앱을 업데이트한다"
        )),
    })
}

async fn read_frame<R: AsyncReadExt + Unpin>(rd: &mut R) -> std::io::Result<Option<Frame>> {
    let mut header = [0u8; 4];
    match rd.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = Frame::body_len(header).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut body = vec![0u8; n];
    rd.read_exact(&mut body).await?;
    Frame::decode(&body).map(Some).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// 데몬을 새 세션(`setsid`)으로 떼어 띄운다. 띄운 쪽(CLI, 앱)이 끝나도 데몬은 산다.
pub fn spawn_daemon(paths: &Paths, daemon_bin: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    std::fs::create_dir_all(paths.logs()).map_err(|e| ClientError::Spawn(e.to_string()))?;
    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.logs().join("daemon.stderr.log"))
        .map_err(|e| ClientError::Spawn(e.to_string()))?;
    let mut cmd = Command::new(daemon_bin);
    cmd.arg("--home").arg(&paths.home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(stderr);
    // SAFETY: fork 뒤 exec 전에 setsid 만 부른다 (async-signal-safe)
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| ClientError::Spawn(format!("{}: {e}", daemon_bin.display())))?;
    Ok(())
}

/// 데몬 실행 파일 위치: `THUMINAL_DAEMON_BIN`, 아니면 지금 실행 파일 옆의 `thuminald`.
pub fn default_daemon_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("THUMINAL_DAEMON_BIN") {
        return PathBuf::from(p);
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("thuminald")))
        .unwrap_or_else(|| PathBuf::from("thuminald"))
}
