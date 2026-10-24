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

/// 훅 알림 하나 (`Request::ReportAgent` 의 필드)
#[derive(Debug, Clone, Default)]
pub struct AgentReport {
    pub kind: String,
    pub event: String,
    pub agent_session_id: Option<String>,
    pub transcript: Option<String>,
    pub prompt: Option<String>,
    pub last_assistant_message: Option<String>,
    pub tool_name: Option<String>,
    pub notification_type: Option<String>,
    pub source: Option<String>,
    pub model: Option<String>,
}

/// 묻는 도구: 이 도구의 PreToolUse 는 사용자 답을 기다리는 것이다 (Orca `isAskUserQuestionTool` 과 같다)
fn is_question_tool(name: &str) -> bool {
    let n: String = name.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
    n == "askuserquestion" || n == "requestuserinput"
}

/// 훅 알림 하나로 에이전트 정보를 바꾼다. 상태 규칙은 Orca 의 claude 훅 처리를 따른다
/// (`src/shared/agent-hook-listener/providers/claude-events.ts`, `compatible-lifecycle-events.ts`):
/// - UserPromptSubmit, PostToolUse, PostToolUseFailure, PreToolUse → 일하는 중 (묻는 도구의 PreToolUse 는 부름)
/// - PermissionRequest → 부름
/// - Notification: `permission_prompt`/`elicitation_dialog` 면 부름, `idle_prompt` 면 기다림, 그 밖은 그대로
/// - Stop, StopFailure → 기다림 + 턴 끝난 때. SessionStart(compact 말고) → 기다림, 지난 턴 글을 비운다
/// - SessionEnd → 에이전트 없음. 모르는 훅 → 상태는 그대로 두고 세션 id 만 받는다
pub fn next_agent(prev: Option<AgentInfo>, r: AgentReport, now: u64) -> Option<AgentInfo> {
    use thuminal_protocol::{AGENT_TEXT_MAX, clip_text};
    if r.event == "SessionEnd" {
        return None;
    }
    let mut a = prev.unwrap_or(AgentInfo {
        kind: r.kind.clone(),
        session_id: None,
        transcript: None,
        state: AgentState::Idle,
        updated_at: now,
        prompt: None,
        last_assistant_message: None,
        tool_name: None,
        model: None,
        turn_ended_at: None,
    });
    a.kind = r.kind;
    if r.agent_session_id.is_some() {
        a.session_id = r.agent_session_id;
    }
    if r.transcript.is_some() {
        a.transcript = r.transcript;
    }
    let tool = r.tool_name.filter(|t| !t.is_empty());
    let state = match r.event.as_str() {
        "SessionStart" if r.source.as_deref() == Some("compact") => None,
        "SessionStart" => {
            a.prompt = None;
            a.last_assistant_message = None;
            a.tool_name = None;
            a.turn_ended_at = None;
            if r.model.is_some() {
                a.model = r.model;
            }
            Some(AgentState::Idle)
        }
        "UserPromptSubmit" => {
            if let Some(p) = r.prompt.as_deref().and_then(|p| clip_text(p, AGENT_TEXT_MAX)) {
                a.prompt = Some(p);
            }
            a.last_assistant_message = None;
            a.tool_name = None;
            a.turn_ended_at = None;
            Some(AgentState::Working)
        }
        "PreToolUse" => {
            let asks = tool.as_deref().is_some_and(is_question_tool);
            a.tool_name = tool.or(a.tool_name.take());
            Some(if asks { AgentState::NeedsAttention } else { AgentState::Working })
        }
        "PostToolUse" | "PostToolUseFailure" => {
            a.tool_name = tool.or(a.tool_name.take());
            Some(AgentState::Working)
        }
        "PermissionRequest" => {
            a.tool_name = tool.or(a.tool_name.take());
            Some(AgentState::NeedsAttention)
        }
        "Notification" => match r.notification_type.as_deref() {
            Some("permission_prompt" | "elicitation_dialog") => Some(AgentState::NeedsAttention),
            Some("idle_prompt") => Some(AgentState::Idle),
            _ => None,
        },
        "Stop" | "StopFailure" => {
            if let Some(m) = r.last_assistant_message.as_deref().and_then(|m| clip_text(m, AGENT_TEXT_MAX)) {
                a.last_assistant_message = Some(m);
            }
            a.tool_name = None;
            a.turn_ended_at = Some(now);
            Some(AgentState::Idle)
        }
        _ => None,
    };
    if let Some(s) = state
        && s != a.state
    {
        a.state = s;
        a.updated_at = now;
    }
    Some(a)
}

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
            bell_at: 0,
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

    /// 에이전트 훅 알림으로 세션의 에이전트 상태를 바꾼다. 바뀐 것이 있을 때만 알린다
    pub fn report_agent(&self, id: SessionId, report: AgentReport) -> Result<SessionInfo, ErrorBody> {
        let hook = report.event.clone();
        let (info, changed) = {
            let h = self.handle(id)?;
            let mut i = h.info.lock().unwrap();
            let next = next_agent(i.agent.clone(), report, now_ms());
            let changed = next != i.agent;
            i.agent = next;
            (i.clone(), changed)
        };
        info!(event = "agent_report", session = id.0, hook, agent = ?info.agent.as_ref().map(|a| a.state), changed);
        if changed {
            let _ = self.events.send(Event::SessionUpdated { session: info.clone() });
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn report(event: &str) -> AgentReport {
        AgentReport { kind: "claude".into(), event: event.into(), ..Default::default() }
    }

    fn step(prev: Option<AgentInfo>, r: AgentReport, now: u64) -> AgentInfo {
        next_agent(prev, r, now).expect("에이전트가 있어야 한다")
    }

    #[test]
    fn permission_granted_goes_back_to_working() {
        let a = step(None, AgentReport { agent_session_id: Some("s1".into()), model: Some("opus".into()), source: Some("startup".into()), ..report("SessionStart") }, 1);
        assert_eq!((a.state, a.turn_ended_at, a.model.as_deref()), (AgentState::Idle, None, Some("opus")));
        let a = step(Some(a), AgentReport { prompt: Some("  고쳐 줘 ".into()), ..report("UserPromptSubmit") }, 2);
        assert_eq!((a.state, a.prompt.as_deref(), a.updated_at), (AgentState::Working, Some("고쳐 줘"), 2));
        let a = step(Some(a), AgentReport { tool_name: Some("Bash".into()), ..report("PreToolUse") }, 3);
        assert_eq!((a.state, a.tool_name.as_deref(), a.updated_at), (AgentState::Working, Some("Bash"), 2), "상태가 그대로면 updated_at 도 그대로");
        let a = step(Some(a), AgentReport { tool_name: Some("Bash".into()), ..report("PermissionRequest") }, 4);
        assert_eq!(a.state, AgentState::NeedsAttention);
        let a = step(Some(a), AgentReport { notification_type: Some("permission_prompt".into()), ..report("Notification") }, 5);
        assert_eq!((a.state, a.updated_at), (AgentState::NeedsAttention, 4));
        // 승인하면 PostToolUse 가 온다 → 다시 일하는 중
        let a = step(Some(a), AgentReport { tool_name: Some("Bash".into()), ..report("PostToolUse") }, 6);
        assert_eq!(a.state, AgentState::Working);
        let a = step(Some(a), AgentReport { last_assistant_message: Some("다 했다".into()), ..report("Stop") }, 7);
        assert_eq!((a.state, a.turn_ended_at, a.tool_name.as_deref()), (AgentState::Idle, Some(7), None));
        assert_eq!((a.last_assistant_message.as_deref(), a.prompt.as_deref(), a.session_id.as_deref()), (Some("다 했다"), Some("고쳐 줘"), Some("s1")));
        // 쉬고 있다는 알림은 부름이 아니다
        let b = step(Some(a.clone()), AgentReport { notification_type: Some("idle_prompt".into()), ..report("Notification") }, 8);
        assert_eq!((b.state, b.turn_ended_at, b.updated_at), (AgentState::Idle, Some(7), 7));
        // 새 프롬프트면 지난 답과 끝난 때를 비운다
        let c = step(Some(a.clone()), report("UserPromptSubmit"), 9);
        assert_eq!((c.last_assistant_message, c.turn_ended_at, c.prompt.as_deref()), (None, None, Some("고쳐 줘")));
        assert!(next_agent(Some(a), report("SessionEnd"), 10).is_none());
    }

    #[test]
    fn notification_kinds_and_unknown_hooks() {
        let working = step(None, report("UserPromptSubmit"), 1);
        for (kind, want) in [
            (Some("permission_prompt"), AgentState::NeedsAttention),
            (Some("elicitation_dialog"), AgentState::NeedsAttention),
            (Some("idle_prompt"), AgentState::Idle),
            (Some("auth_success"), AgentState::Working),
            (None, AgentState::Working),
        ] {
            let a = step(Some(working.clone()), AgentReport { notification_type: kind.map(Into::into), ..report("Notification") }, 2);
            assert_eq!(a.state, want, "{kind:?}");
        }
        // 묻는 도구의 PreToolUse 는 부름
        let a = step(Some(working.clone()), AgentReport { tool_name: Some("AskUserQuestion".into()), ..report("PreToolUse") }, 2);
        assert_eq!(a.state, AgentState::NeedsAttention);
        // 모르는 훅, 턴 중간의 compact SessionStart 는 상태를 바꾸지 않는다
        assert_eq!(step(Some(working.clone()), report("SubagentStop"), 3).state, AgentState::Working);
        let a = step(Some(working.clone()), AgentReport { source: Some("compact".into()), ..report("SessionStart") }, 3);
        assert_eq!((a.state, a.prompt), (AgentState::Working, working.prompt));
        // 긴 글은 자른다
        let long = "가".repeat(500);
        let a = step(None, AgentReport { prompt: Some(long), ..report("UserPromptSubmit") }, 1);
        assert_eq!(a.prompt.unwrap().chars().count(), thuminal_protocol::AGENT_TEXT_MAX + 1);
    }
}
