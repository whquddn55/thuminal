//! 유닉스 소켓 서버: 연결마다 읽기 루프 + 쓰기 루프 + 이벤트 전달.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use thuminal_protocol::{
    ClientMessage, ErrorBody, ErrorCode, Frame, PROTOCOL_MAJOR, PROTOCOL_MINOR, Request, Response, ResponseResult,
    ServerMessage,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, mpsc};
use tracing::{debug, info, warn};

use thuminal_protocol::{Event, WORKTREE_LABEL};
use thuminal_workspace::{Workspace, WorkspaceError};

use crate::manager::Manager;
use crate::session::now_ms;

/// 데몬이 내려갈 때 세션 기록을 어떻게 할지
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    /// 종료 신호(재부팅, 로그아웃): 기록을 남겨 다음에 되살린다
    Keep,
    /// 사용자가 `daemon stop` 으로 내렸다: 기록을 지운다
    Clear,
}

pub struct Server {
    pub manager: Arc<Manager>,
    pub stop_mode: std::sync::Mutex<StopMode>,
    pub workspace: Arc<Workspace>,
    pub shutdown: Arc<Notify>,
    pub started_at: u64,
    next_conn: AtomicU64,
}

impl Server {
    pub fn new(manager: Arc<Manager>, workspace: Arc<Workspace>) -> Arc<Self> {
        Arc::new(Self { manager, workspace, stop_mode: std::sync::Mutex::new(StopMode::Keep), shutdown: Arc::new(Notify::new()), started_at: now_ms(), next_conn: AtomicU64::new(1) })
    }

    pub async fn serve(self: Arc<Self>, listener: UnixListener) {
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let me = self.clone();
                        tokio::spawn(async move { me.connection(stream).await });
                    }
                    Err(e) => warn!(event = "accept_failed", error = %e),
                },
                _ = self.shutdown.notified() => break,
            }
        }
    }

    async fn connection(self: Arc<Self>, stream: UnixStream) {
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (mut rd, mut wr) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();

        let writer = tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if wr.write_all(&frame.encode()).await.is_err() {
                    break;
                }
            }
        });

        let mut hello = false;
        let mut events: Option<tokio::task::JoinHandle<()>> = None;
        let mut client = String::new();
        loop {
            let frame = match read_frame(&mut rd).await {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(e) => {
                    debug!(event = "conn_read_error", conn, error = %e);
                    break;
                }
            };
            match frame {
                Frame::Json(bytes) => {
                    let msg: ClientMessage = match serde_json::from_slice(&bytes) {
                        Ok(m) => m,
                        Err(e) => {
                            warn!(event = "bad_message", conn, error = %e);
                            break;
                        }
                    };
                    let ClientMessage::Request { id, request } = msg;
                    if !hello {
                        match &request {
                            Request::Hello { protocol_major, client: name, .. } if *protocol_major == PROTOCOL_MAJOR => {
                                hello = true;
                                client = name.clone();
                                info!(event = "client_hello", conn, client = %client);
                                // 이벤트는 hello 뒤부터 보낸다
                                let mut sub = self.manager.events.subscribe();
                                let etx = tx.clone();
                                events = Some(tokio::spawn(async move {
                                    loop {
                                        match sub.recv().await {
                                            Ok(event) => {
                                                if etx.send(Frame::json(&ServerMessage::Event { event })).is_err() {
                                                    break;
                                                }
                                            }
                                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                                warn!(event = "events_lagged", conn, skipped = n);
                                            }
                                            Err(_) => break,
                                        }
                                    }
                                }));
                            }
                            Request::Hello { protocol_major, .. } => {
                                let _ = tx.send(err_frame(id, ErrorCode::VersionMismatch, format!("데몬은 프로토콜 {PROTOCOL_MAJOR}, 클라이언트는 {protocol_major}")));
                                break;
                            }
                            _ => {
                                let _ = tx.send(err_frame(id, ErrorCode::InvalidRequest, "hello 를 먼저 보내야 한다".into()));
                                break;
                            }
                        }
                    }
                    if let Some(frame) = self.handle(conn, &client, id, request, &tx).await {
                        let _ = tx.send(frame);
                    }
                }
                Frame::Input { session, data } => {
                    if hello {
                        let _ = self.manager.input(session, data);
                    }
                }
                other => warn!(event = "unexpected_frame", conn, kind = ?other.kind()),
            }
        }
        self.manager.detach_all(conn);
        if let Some(e) = events {
            e.abort();
        }
        drop(tx);
        let _ = writer.await;
        debug!(event = "conn_closed", conn);
    }

    /// 응답 프레임을 돌려준다. `Attach` 는 세션 스레드가 저장본과 응답을 순서대로 보내므로 None.
    async fn handle(&self, conn: u64, client: &str, id: u64, request: Request, tx: &mpsc::UnboundedSender<Frame>) -> Option<Frame> {
        let m = &self.manager;
        let kind = request_kind(&request);
        // 기능 사용을 나중에 셀 수 있게 요청 종류마다 한 줄 남긴다
        info!(event = "request", conn, client, kind);
        let result: Result<Response, ErrorBody> = match request {
            Request::Hello { .. } => Ok(Response::Hello {
                daemon_version: env!("CARGO_PKG_VERSION").into(),
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                pid: std::process::id(),
                engine: m.engine_name().into(),
            }),
            Request::Status => Ok(Response::Status {
                daemon_version: env!("CARGO_PKG_VERSION").into(),
                pid: std::process::id(),
                started_at: self.started_at,
                sessions: m.len(),
                engine: m.engine_name().into(),
            }),
            Request::CreateSession(mut req) => {
                // 시작 폴더가 git 워크트리 안이면 워크트리 꼬리표를 단다 (앱 사이드바가 이 꼬리표로 묶는다)
                if !req.labels.contains_key(WORKTREE_LABEL) {
                    if let Some(cwd) = req.cwd.clone() {
                        let ws = self.workspace.clone();
                        if let Ok(Some(root)) = tokio::task::spawn_blocking(move || ws.worktree_of(std::path::Path::new(&cwd))).await {
                            req.labels.insert(WORKTREE_LABEL.into(), root.to_string_lossy().into_owned());
                        }
                    }
                }
                m.create(req).map(|session| Response::Session { session })
            }
            Request::ListSessions => Ok(Response::Sessions { sessions: m.list() }),
            Request::Attach { session, snapshot } => match m.attach(session, conn, tx.clone(), snapshot, id) {
                Ok(()) => return None,
                Err(e) => Err(e),
            },
            Request::Detach { session } => m.detach(session, conn).map(|_| Response::Ok),
            Request::Resize { session, cols, rows } => m.resize(session, cols, rows).await.map(|session| Response::Session { session }),
            Request::SendText { session, text } => m.input(session, text.into_bytes()).map(|_| Response::Ok),
            Request::ReadScreen { session, format, scrollback } => {
                m.read_screen(session, format, scrollback).await.map(|text| Response::Screen { text })
            }
            Request::SetLabels { session, labels } => m.set_labels(session, labels).map(|session| Response::Session { session }),
            Request::ReportAgent { session, kind, event, agent_session_id, transcript } => {
                m.report_agent(session, kind, &event, agent_session_id, transcript).map(|session| Response::Session { session })
            }
            Request::Kill { session } => m.kill(session).map(|_| Response::Ok),
            Request::Remove { session } => m.remove(session).map(|_| Response::Ok),
            Request::ListRepos => Ok(Response::Repos { repos: self.workspace.repos() }),
            req @ (Request::AddRepo { .. }
            | Request::RemoveRepo { .. }
            | Request::ListWorktrees { .. }
            | Request::CreateWorktree { .. }
            | Request::RemoveWorktree { .. }) => self.workspace_request(req).await,
            Request::Shutdown => {
                info!(event = "shutdown_requested", conn);
                *self.stop_mode.lock().unwrap() = StopMode::Clear;
                m.kill_all();
                self.shutdown.notify_waiters();
                Ok(Response::Ok)
            }
        };
        Some(Frame::json(&ServerMessage::Response {
            id,
            result: match result {
                Ok(r) => ResponseResult::Ok(r),
                Err(e) => ResponseResult::Err(e),
            },
        }))
    }
}

impl Server {
    /// 저장소와 워크트리 요청. git 명령이 막을 수 있어 블로킹 스레드에서 돌린다
    async fn workspace_request(&self, req: Request) -> Result<Response, ErrorBody> {
        let ws = self.workspace.clone();
        let changes = !matches!(req, Request::ListWorktrees { .. });
        let result = tokio::task::spawn_blocking(move || -> Result<Response, WorkspaceError> {
            Ok(match req {
                Request::AddRepo { path } => Response::Repo { repo: ws.add_repo(std::path::Path::new(&path))? },
                Request::RemoveRepo { repo } => {
                    ws.remove_repo(&repo)?;
                    Response::Ok
                }
                Request::ListWorktrees { repo } => Response::Worktrees { worktrees: ws.worktrees(repo.as_deref())? },
                Request::CreateWorktree { repo, branch, base } => {
                    Response::Worktree { worktree: ws.create_worktree(&repo, &branch, base.as_deref())? }
                }
                Request::RemoveWorktree { repo, path, force, delete_branch } => {
                    ws.remove_worktree(&repo, std::path::Path::new(&path), force, delete_branch)?;
                    Response::Ok
                }
                _ => unreachable!("저장소 요청만 온다"),
            })
        })
        .await
        .map_err(|e| ErrorBody { code: ErrorCode::Internal, message: e.to_string() })?
        .map_err(|e| ErrorBody {
            code: match e {
                WorkspaceError::UnknownRepo(_) => ErrorCode::NotFound,
                WorkspaceError::Invalid(_) => ErrorCode::InvalidRequest,
                _ => ErrorCode::Vcs,
            },
            message: e.to_string(),
        })?;
        if changes {
            let _ = self.manager.events.send(Event::WorkspaceChanged);
        }
        Ok(result)
    }
}

fn request_kind(r: &Request) -> &'static str {
    match r {
        Request::Hello { .. } => "hello",
        Request::Status => "status",
        Request::CreateSession(_) => "create_session",
        Request::ListSessions => "list_sessions",
        Request::Attach { .. } => "attach",
        Request::Detach { .. } => "detach",
        Request::Resize { .. } => "resize",
        Request::SendText { .. } => "send_text",
        Request::ReadScreen { .. } => "read_screen",
        Request::SetLabels { .. } => "set_labels",
        Request::ReportAgent { .. } => "report_agent",
        Request::Kill { .. } => "kill",
        Request::Remove { .. } => "remove",
        Request::Shutdown => "shutdown",
        Request::ListRepos => "list_repos",
        Request::AddRepo { .. } => "add_repo",
        Request::RemoveRepo { .. } => "remove_repo",
        Request::ListWorktrees { .. } => "list_worktrees",
        Request::CreateWorktree { .. } => "create_worktree",
        Request::RemoveWorktree { .. } => "remove_worktree",
    }
}

fn err_frame(id: u64, code: ErrorCode, message: String) -> Frame {
    Frame::json(&ServerMessage::Response { id, result: ResponseResult::Err(ErrorBody { code, message }) })
}

/// 프레임 하나를 읽는다. 연결이 깨끗하게 끝나면 None.
pub async fn read_frame<R: AsyncReadExt + Unpin>(rd: &mut R) -> std::io::Result<Option<Frame>> {
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
