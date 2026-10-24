//! 세션 목록을 들고, 요청을 세션 actor 에 나눠 준다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use thuminal_engine::EngineFactory;
use thuminal_protocol::{
    AgentInfo, AgentState, CreateSession, ErrorBody, ErrorCode, Event, ScreenFormat, SessionId, SessionInfo, SessionState,
    SnapshotFormat, TerminalColors,
};
use thuminal_pty::{PtySystem, SpawnSpec};
use tokio::sync::{broadcast, oneshot};
use tracing::{info, warn};

use crate::session::{self, Cmd, ConnId, Outbox, Restore, SessionHandle, now_ms};
use crate::shell::ShellIntegration;

/// 데몬 환경에서 셸로 물려주지 않을 변수 앞머리.
/// 데몬을 띄운 터미널(예: Orca 안의 셸)의 정보가 새 세션에 새지 않게 한다.
const SCRUBBED_ENV_PREFIXES: &[&str] = &["ORCA_", "THUMINAL_", "CLAUDE_CODE_", "CLAUDECODE"];

pub struct Manager {
    sessions: Mutex<BTreeMap<SessionId, SessionHandle>>,
    next_id: AtomicU64,
    engine: Arc<dyn EngineFactory>,
    pty: Arc<dyn PtySystem>,
    pub events: broadcast::Sender<Event>,
    socket: PathBuf,
    shell: ShellIntegration,
    /// 모든 세션 엔진의 기본색 (`terminal-colors.json`)
    colors: Mutex<Option<TerminalColors>>,
    colors_file: PathBuf,
}

fn not_found(id: SessionId) -> ErrorBody {
    ErrorBody { code: ErrorCode::NotFound, message: format!("세션 {id} 이 없다") }
}

fn internal(msg: impl ToString) -> ErrorBody {
    ErrorBody { code: ErrorCode::Internal, message: msg.to_string() }
}

impl Manager {
    pub fn new(engine: Arc<dyn EngineFactory>, pty: Arc<dyn PtySystem>, socket: PathBuf, shell: ShellIntegration, home: &Path) -> Self {
        let colors_file = home.join("terminal-colors.json");
        let colors = std::fs::read(&colors_file).ok().and_then(|b| serde_json::from_slice(&b).ok());
        Self {
            sessions: Mutex::new(BTreeMap::new()),
            next_id: AtomicU64::new(1),
            engine,
            pty,
            events: broadcast::channel(1024).0,
            socket,
            shell,
            colors: Mutex::new(colors),
            colors_file,
        }
    }

    pub fn engine_name(&self) -> &'static str {
        self.engine.name()
    }

    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    fn handle(&self, id: SessionId) -> Result<SessionHandle, ErrorBody> {
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| not_found(id))
    }

    fn send(&self, id: SessionId, cmd: Cmd) -> Result<(), ErrorBody> {
        self.handle(id)?.cmd.send(cmd).map_err(|_| internal("세션 스레드가 끝났다"))
    }

    pub fn create(&self, req: CreateSession) -> Result<SessionInfo, ErrorBody> {
        self.create_with(req, Restore::default(), None)
    }

    /// 세션을 띄우고, `input` 이 있으면 셸이 첫 출력을 낸 뒤 입력하고 Enter 를 친다 (되살리기 입력과 같은 방식)
    pub fn create_with_input(&self, req: CreateSession, input: Option<String>) -> Result<SessionInfo, ErrorBody> {
        let input = input.filter(|i| !i.is_empty()).map(|i| format!("{i}\r").into_bytes());
        self.create_with(req, Restore { replay: None, input }, None)
    }

    fn create_with(&self, req: CreateSession, restore: Restore, restored_from: Option<SessionId>) -> Result<SessionInfo, ErrorBody> {
        let id = SessionId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let env_remove = std::env::vars_os()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .filter(|k| SCRUBBED_ENV_PREFIXES.iter().any(|p| k.starts_with(p)))
            .collect();
        let mut env = BTreeMap::new();
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("TERM_PROGRAM".into(), "thuminal".into());
        env.insert("THUMINAL_SESSION_ID".into(), id.to_string());
        env.insert("THUMINAL_SOCKET".into(), self.socket.to_string_lossy().into_owned());
        // 에이전트 훅이 부를 CLI (데몬 실행 파일 옆에 있다)
        if let Some(cli) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("thuminal"))).filter(|p| p.exists()) {
            env.insert("THUMINAL_CLI".into(), cli.to_string_lossy().into_owned());
        }
        let mut command = req.command.clone();
        self.shell.apply(&mut command, &mut env);
        env.extend(req.env.clone());

        let cols = req.cols.max(2);
        let rows = req.rows.max(2);
        let spec = SpawnSpec { command, cwd: req.cwd.clone().map(PathBuf::from), env, env_remove, cols, rows };
        let spawned = self.pty.spawn(&spec).map_err(|e| ErrorBody { code: ErrorCode::SpawnFailed, message: e.to_string() })?;
        let pid = spawned.child.pid();
        let cwd = spec
            .cwd
            .clone()
            .or_else(|| std::env::var_os("HOME").map(Into::into))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let title = req.command.first().map(|c| c.rsplit('/').next().unwrap_or(c).to_string()).unwrap_or_else(|| {
            std::env::var("SHELL").ok().and_then(|s| s.rsplit('/').next().map(str::to_string)).unwrap_or_else(|| "shell".into())
        });
        let now = now_ms();
        let info = SessionInfo {
            id,
            title,
            cwd,
            command: req.command,
            cols,
            rows,
            pid,
            state: SessionState::Running,
            created_at: now,
            last_output_at: now,
            attached: 0,
            labels: req.labels,
            agent: None,
            restored_from,
        };
        let colors = self.colors.lock().unwrap().clone();
        let handle = session::start(id, info.clone(), spawned, self.engine.clone(), self.events.clone(), restore, colors);
        self.sessions.lock().unwrap().insert(id, handle);
        info!(event = "session_created", session = id.0, pid, cols, rows, command = ?info.command);
        let _ = self.events.send(Event::SessionCreated { session: info.clone() });
        Ok(info)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions.lock().unwrap().values().map(|h| h.info.lock().unwrap().clone()).collect()
    }

    pub fn info(&self, id: SessionId) -> Result<SessionInfo, ErrorBody> {
        Ok(self.handle(id)?.info.lock().unwrap().clone())
    }

    pub fn attach(&self, id: SessionId, conn: ConnId, tx: Outbox, format: SnapshotFormat, req_id: u64) -> Result<(), ErrorBody> {
        if format == SnapshotFormat::Native && !self.engine.supports_native_snapshot() {
            return Err(ErrorBody { code: ErrorCode::InvalidRequest, message: "이 데몬 엔진은 고유 저장본을 만들지 못한다. vt 를 쓴다".into() });
        }
        self.send(id, Cmd::Attach { conn, tx, format, req_id })
    }

    pub fn detach(&self, id: SessionId, conn: ConnId) -> Result<(), ErrorBody> {
        self.send(id, Cmd::Detach { conn })
    }

    /// 연결이 끊기면 모든 세션에서 뗀다
    pub fn detach_all(&self, conn: ConnId) {
        for h in self.sessions.lock().unwrap().values() {
            let _ = h.cmd.send(Cmd::Detach { conn });
        }
    }

    pub fn input(&self, id: SessionId, data: Vec<u8>) -> Result<(), ErrorBody> {
        self.send(id, Cmd::Input(data))
    }

    pub async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<SessionInfo, ErrorBody> {
        let (reply, rx) = oneshot::channel();
        self.send(id, Cmd::Resize { cols: cols.max(2), rows: rows.max(2), reply })?;
        rx.await.map_err(internal)?.map_err(internal)?;
        let info = self.info(id)?;
        let _ = self.events.send(Event::SessionUpdated { session: info.clone() });
        Ok(info)
    }

    pub async fn read_screen(&self, id: SessionId, format: ScreenFormat, scrollback: bool) -> Result<String, ErrorBody> {
        let (reply, rx) = oneshot::channel();
        self.send(id, Cmd::ReadScreen { format, scrollback, reply })?;
        rx.await.map_err(internal)?.map_err(internal)
    }

    pub fn set_labels(&self, id: SessionId, labels: BTreeMap<String, String>) -> Result<SessionInfo, ErrorBody> {
        let info = {
            let h = self.handle(id)?;
            let mut i = h.info.lock().unwrap();
            for (k, v) in labels {
                if v.is_empty() {
                    i.labels.remove(&k);
                } else {
                    i.labels.insert(k, v);
                }
            }
            i.clone()
        };
        let _ = self.events.send(Event::SessionUpdated { session: info.clone() });
        Ok(info)
    }

    /// 에이전트 훅 알림으로 세션의 에이전트 상태를 바꾼다
    pub fn report_agent(
        &self,
        id: SessionId,
        kind: String,
        event: &str,
        agent_session_id: Option<String>,
        transcript: Option<String>,
    ) -> Result<SessionInfo, ErrorBody> {
        let info = {
            let h = self.handle(id)?;
            let mut i = h.info.lock().unwrap();
            if event == "SessionEnd" {
                i.agent = None;
            } else {
                let prev = i.agent.take();
                let state = match event {
                    "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => AgentState::Working,
                    "Notification" | "PermissionRequest" => AgentState::NeedsAttention,
                    _ => AgentState::Idle, // SessionStart, Stop, SubagentStop
                };
                i.agent = Some(AgentInfo {
                    kind,
                    session_id: agent_session_id.or_else(|| prev.as_ref().and_then(|p| p.session_id.clone())),
                    transcript: transcript.or_else(|| prev.as_ref().and_then(|p| p.transcript.clone())),
                    state,
                    updated_at: now_ms(),
                });
            }
            i.clone()
        };
        info!(event = "agent_report", session = id.0, hook = event, agent = ?info.agent.as_ref().map(|a| a.state));
        let _ = self.events.send(Event::SessionUpdated { session: info.clone() });
        Ok(info)
    }

    pub fn kill(&self, id: SessionId) -> Result<(), ErrorBody> {
        info!(event = "session_kill", session = id.0);
        self.send(id, Cmd::Kill)
    }

    pub fn remove(&self, id: SessionId) -> Result<(), ErrorBody> {
        let h = self.sessions.lock().unwrap().remove(&id).ok_or_else(|| not_found(id))?;
        let _ = h.cmd.send(Cmd::Kill);
        let _ = h.cmd.send(Cmd::Stop);
        info!(event = "session_removed", session = id.0);
        let _ = self.events.send(Event::SessionRemoved { session: id });
        Ok(())
    }

    pub async fn snapshot(&self, id: SessionId, format: SnapshotFormat) -> Result<Vec<u8>, ErrorBody> {
        let (reply, rx) = oneshot::channel();
        self.send(id, Cmd::Snapshot { format, reply })?;
        rx.await.map_err(internal)?.map_err(internal)
    }

    /// 지난번 데몬이 남긴 세션을 되살린다. 로그인 셸을 같은 폴더에서 띄우고,
    /// 이전 화면을 먼저 그리고, claude 세션이 있었으면 `claude --resume` 을 입력한다.
    pub fn restore(&self, previous: Vec<(SessionInfo, Option<Vec<u8>>)>) {
        for (old, replay) in previous {
            let input = old
                .agent
                .as_ref()
                .filter(|a| a.kind == "claude")
                .and_then(|a| a.session_id.as_ref())
                .filter(|sid| sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                .map(|sid| format!("claude --resume {sid}\r").into_bytes());
            let req = CreateSession {
                command: Vec::new(),
                cwd: Some(old.cwd.clone()),
                env: BTreeMap::new(),
                cols: old.cols,
                rows: old.rows,
                labels: old.labels.clone(),
            };
            let resumes = input.is_some();
            match self.create_with(req, Restore { replay, input }, Some(old.id)) {
                Ok(new) => info!(event = "session_restored", from = old.id.0, session = new.id.0, resumes_agent = resumes),
                Err(e) => tracing::warn!(event = "session_restore_failed", from = old.id.0, error = %e.message),
            }
        }
    }

    pub fn colors(&self) -> Option<TerminalColors> {
        self.colors.lock().unwrap().clone()
    }

    /// 기본색을 바꾼다: 저장하고, 모든 세션 엔진에 넣고, 알린다
    pub fn set_colors(&self, colors: TerminalColors) -> Result<(), ErrorBody> {
        if colors.palette.len() > 256 {
            return Err(ErrorBody { code: ErrorCode::InvalidRequest, message: "palette 는 256개까지다".into() });
        }
        *self.colors.lock().unwrap() = Some(colors.clone());
        let tmp = self.colors_file.with_extension("json.tmp");
        let r = std::fs::write(&tmp, serde_json::to_vec_pretty(&colors).unwrap()).and_then(|_| std::fs::rename(&tmp, &self.colors_file));
        if let Err(e) = r {
            warn!(event = "terminal_colors_save_failed", error = %e);
        }
        for h in self.sessions.lock().unwrap().values() {
            let _ = h.cmd.send(Cmd::SetColors(colors.clone()));
        }
        info!(event = "terminal_colors_set", scheme = ?colors.scheme, palette = colors.palette.len());
        let _ = self.events.send(Event::TerminalColorsChanged { colors });
        Ok(())
    }

    pub fn kill_all(&self) {
        for h in self.sessions.lock().unwrap().values() {
            let _ = h.cmd.send(Cmd::Kill);
        }
    }
}
