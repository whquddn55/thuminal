//! 세션 하나: PTY 하나 + 엔진 하나.
//!
//! 엔진은 세션 전용 스레드(actor)가 혼자 들고 있다. PTY 출력, 붙기, 화면 읽기가
//! 모두 이 스레드의 명령 줄로 들어오므로, 저장본을 만든 시점과 그 뒤 출력 사이에
//! 빠지거나 겹치는 바이트가 없다.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use thuminal_engine::{EngineConfig, EngineEvent, EngineFactory, TerminalEngine, color_scheme_report};
use thuminal_protocol::{
    AgentState, Event, Frame, Response, ResponseResult, ScreenFormat, ServerMessage, SessionId, SessionInfo, SessionState,
    SnapshotFormat, TerminalColors,
};
use thuminal_pty::{PtyControl, PtyKiller, Spawned};
use tokio::sync::{broadcast, oneshot};
use tracing::{info, warn};

/// 연결 하나로 나가는 프레임 줄
pub type Outbox = tokio::sync::mpsc::UnboundedSender<Frame>;
pub type ConnId = u64;

pub enum Cmd {
    Output(Vec<u8>),
    Exited(Option<i32>),
    Attach { conn: ConnId, tx: Outbox, format: SnapshotFormat, req_id: u64 },
    Detach { conn: ConnId },
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16, reply: oneshot::Sender<Result<(), String>> },
    ReadScreen { format: ScreenFormat, scrollback: bool, reply: oneshot::Sender<Result<String, String>> },
    Snapshot { format: SnapshotFormat, reply: oneshot::Sender<Result<Vec<u8>, String>> },
    /// 엔진 기본색을 바꾼다
    SetColors(TerminalColors),
    Kill,
    Stop,
}

/// 매니저가 들고 있는 세션 손잡이
#[derive(Clone)]
pub struct SessionHandle {
    pub info: Arc<Mutex<SessionInfo>>,
    pub cmd: mpsc::Sender<Cmd>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 되살린 세션에 미리 넣을 것
#[derive(Default)]
pub struct Restore {
    /// 엔진에 먼저 넣어 이전 화면을 보이게 할 바이트 (VT 저장본)
    pub replay: Option<Vec<u8>>,
    /// 셸이 첫 출력을 낸 뒤 입력할 글 (예: `claude --resume <id>\r`)
    pub input: Option<Vec<u8>>,
}

/// 셸이 첫 출력을 내고 이만큼 지난 뒤 되살리기 입력을 넣는다 (셸이 설정을 다 읽기 전에 넣으면 사라질 수 있다)
const RESTORE_INPUT_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// 켜 두면 색 밝기가 바뀔 때 `CSI ?997;1n`/`;2n` 을 받겠다는 DEC 모드
const COLOR_SCHEME_REPORT_MODE: u16 = 2031;

/// 세션 스레드들을 띄운다: actor, PTY 읽기, PTY 쓰기, 끝 기다리기.
pub fn start(
    id: SessionId,
    info: SessionInfo,
    spawned: Spawned,
    engine: Arc<dyn EngineFactory>,
    events: broadcast::Sender<Event>,
    restore: Restore,
    colors: Option<TerminalColors>,
) -> SessionHandle {
    let info = Arc::new(Mutex::new(info));
    let (tx, rx) = mpsc::channel::<Cmd>();
    let Spawned { mut reader, mut writer, control, mut child, killer } = spawned;

    // PTY 읽기
    let out_tx = tx.clone();
    thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out_tx.send(Cmd::Output(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .expect("pty 읽기 스레드");

    // PTY 쓰기 (쓰기가 막혀도 actor 가 멈추지 않게 따로 둔다)
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name(format!("pty-write-{id}"))
        .spawn(move || {
            for data in in_rx {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        })
        .expect("pty 쓰기 스레드");

    // 끝 기다리기
    let exit_tx = tx.clone();
    thread::Builder::new()
        .name(format!("pty-wait-{id}"))
        .spawn(move || {
            let code = child.wait().ok().flatten();
            let _ = exit_tx.send(Cmd::Exited(code));
        })
        .expect("pty 기다리기 스레드");

    // actor: 엔진은 이 스레드 안에서만 만든다 (엔진은 Send 가 아니어도 된다)
    let actor_info = info.clone();
    thread::Builder::new()
        .name(format!("session-{id}"))
        .spawn(move || {
            let (cols, rows) = {
                let i = actor_info.lock().unwrap();
                (i.cols, i.rows)
            };
            let mut engine = match engine.create(EngineConfig { cols, rows, ..Default::default() }) {
                Ok(e) => e,
                Err(e) => {
                    warn!(event = "engine_create_failed", session = id.0, error = %e);
                    return;
                }
            };
            if let Some(c) = &colors
                && let Err(e) = engine.set_default_colors(c)
            {
                warn!(event = "terminal_colors_failed", session = id.0, error = %e);
            }
            if let Some(replay) = restore.replay {
                engine.feed(&replay);
                engine.feed("\r\n\x1b[2m── thuminal: 이전 화면을 되살렸다 ──\x1b[0m\r\n".as_bytes());
                // 저장본 안의 질의(커서 위치 등)에 대한 답은 새 셸에 보내지 않는다. 벨·알림도 옛것이다
                engine.take_replies();
                engine.take_events();
            }
            Actor {
                id,
                info: actor_info,
                engine,
                control,
                killer,
                input: in_tx,
                subscribers: Vec::new(),
                events,
                pending_input: restore.input,
                last_bell: 0,
                last_notification: 0,
                esc_watch: None,
            }
            .run(rx);
        })
        .expect("세션 스레드");

    SessionHandle { info, cmd: tx }
}

struct Actor {
    id: SessionId,
    info: Arc<Mutex<SessionInfo>>,
    engine: Box<dyn TerminalEngine>,
    control: Box<dyn PtyControl>,
    killer: Box<dyn PtyKiller>,
    input: mpsc::Sender<Vec<u8>>,
    subscribers: Vec<(ConnId, Outbox)>,
    events: broadcast::Sender<Event>,
    pending_input: Option<Vec<u8>>,
    /// 마지막으로 알린 벨, 데스크톱 알림 (ms). 이벤트를 1초에 하나까지만 낸다
    last_bell: u64,
    last_notification: u64,
    /// 일하던 claude 에 Esc · ⌃C 를 보냈다. 화면에서 "esc to interrupt" 가 사라지는지 본다
    esc_watch: Option<crate::interrupt::EscWatch>,
}

/// 같은 세션의 벨·알림 이벤트 사이 최소 간격
const ENGINE_EVENT_INTERVAL_MS: u64 = 1000;
/// 데스크톱 알림 제목, 본문 글자 수 한도
const NOTIFICATION_TITLE_MAX: usize = 200;
const NOTIFICATION_BODY_MAX: usize = 1000;

impl Actor {
    fn run(mut self, rx: mpsc::Receiver<Cmd>) {
        loop {
            // Esc 를 지켜보는 동안에는 출력이 멎어도 다시 본다 (claude 가 멈춘 화면을 그리고 조용해진다)
            let cmd = if self.esc_watch.is_some() {
                match rx.recv_timeout(crate::interrupt::ESC_RECHECK) {
                    Ok(cmd) => cmd,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        self.check_esc_watch();
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match rx.recv() {
                    Ok(cmd) => cmd,
                    Err(_) => break,
                }
            };
            match cmd {
                Cmd::Output(data) => self.output(data),
                Cmd::Exited(code) => {
                    info!(event = "session_exited", session = self.id.0, code);
                    self.info.lock().unwrap().state = SessionState::Exited { code };
                    let _ = self.events.send(Event::SessionExited { session: self.id, code });
                }
                Cmd::Attach { conn, tx, format, req_id } => self.attach(conn, tx, format, req_id),
                Cmd::Detach { conn } => {
                    self.subscribers.retain(|(c, _)| *c != conn);
                    self.sync_attached();
                }
                Cmd::Input(data) => {
                    if let Some(key) = crate::interrupt::interrupt_key(&data) {
                        self.start_esc_watch(key);
                    }
                    let _ = self.input.send(data);
                }
                Cmd::Resize { cols, rows, reply } => {
                    let r = self
                        .control
                        .resize(cols, rows)
                        .map_err(|e| e.to_string())
                        .and_then(|_| self.engine.resize(cols, rows).map_err(|e| e.to_string()));
                    if r.is_ok() {
                        let mut i = self.info.lock().unwrap();
                        i.cols = cols;
                        i.rows = rows;
                    }
                    let _ = reply.send(r);
                }
                Cmd::ReadScreen { format, scrollback, reply } => {
                    let _ = reply.send(self.engine.read_screen(format, scrollback).map_err(|e| e.to_string()));
                }
                Cmd::Snapshot { format, reply } => {
                    let _ = reply.send(self.engine.snapshot(format).map_err(|e| e.to_string()));
                }
                Cmd::SetColors(colors) => self.set_colors(&colors),
                Cmd::Kill => {
                    if let Err(e) = self.killer.kill() {
                        warn!(event = "session_kill_failed", session = self.id.0, error = %e);
                    }
                }
                Cmd::Stop => break,
            }
        }
    }

    fn output(&mut self, data: Vec<u8>) {
        if let Some(input) = self.pending_input.take() {
            let tx = self.input.clone();
            let id = self.id;
            thread::spawn(move || {
                thread::sleep(RESTORE_INPUT_DELAY);
                info!(event = "restore_input_sent", session = id.0);
                let _ = tx.send(input);
            });
        }
        // 붙은 화면에 먼저 보낸다. 데몬 엔진이 처리하는 시간만큼 화면이 늦지 않게 한다
        self.subscribers.retain(|(_, tx)| tx.send(Frame::Output { session: self.id, data: data.clone() }).is_ok());
        self.engine.feed(&data);
        // 터미널 질의(커서 위치 등)는 데몬 엔진이 답한다. 앱 엔진은 답하지 않는다
        let replies = self.engine.take_replies();
        if !replies.is_empty() {
            let _ = self.input.send(replies);
        }

        let now = now_ms();
        let mut bell = false;
        for e in self.engine.take_events() {
            match e {
                EngineEvent::Bell => {
                    if now.saturating_sub(self.last_bell) >= ENGINE_EVENT_INTERVAL_MS {
                        self.last_bell = now;
                        bell = true;
                    }
                }
                EngineEvent::Notification { title, body } => {
                    if now.saturating_sub(self.last_notification) >= ENGINE_EVENT_INTERVAL_MS {
                        self.last_notification = now;
                        let clip = |s: &str, max| thuminal_protocol::clip_text(s, max).unwrap_or_default();
                        let (title, body) = (clip(&title, NOTIFICATION_TITLE_MAX), clip(&body, NOTIFICATION_BODY_MAX));
                        info!(event = "session_notification", session = self.id.0);
                        let _ = self.events.send(Event::SessionNotification { session: self.id, title, body });
                    }
                }
            }
        }

        let (title, pwd) = (self.engine.title(), self.engine.pwd());
        let changed = {
            let mut i = self.info.lock().unwrap();
            i.last_output_at = now;
            let mut changed = false;
            if bell {
                i.bell_at = now;
                changed = true;
            }
            if !title.is_empty() && i.title != title {
                i.title = title;
                changed = true;
            }
            let pwd = pwd.strip_prefix("file://").map(|p| p.find('/').map_or(p, |s| &p[s..])).unwrap_or(&pwd);
            if !pwd.is_empty() && i.cwd != pwd {
                i.cwd = pwd.to_string();
                changed = true;
            }
            changed.then(|| i.clone())
        };
        if let Some(session) = changed {
            let _ = self.events.send(Event::SessionUpdated { session });
        }
        if self.esc_watch.is_some() {
            self.check_esc_watch();
        }
    }

    /// 에이전트에 멈춤 키가 왔다. 판정 규칙은 `interrupt.rs` 머리 주석
    fn start_esc_watch(&mut self, key: crate::interrupt::Key) {
        use crate::interrupt::{Key, WatchKind};
        let Some((state, updated_at, asking)) = self.info.lock().unwrap().agent.as_ref().map(|a| {
            (a.state, a.updated_at, a.tool_name.as_deref().is_some_and(crate::manager::is_question_tool))
        }) else {
            return;
        };
        let kind = match (state, key) {
            (AgentState::Working, Key::CtrlC) => WatchKind::CtrlC,
            (AgentState::Working, Key::Esc) => WatchKind::Esc,
            (AgentState::NeedsAttention, Key::Esc) if asking => WatchKind::Question,
            _ => return,
        };
        let working = kind != WatchKind::Esc || self.working_now();
        info!(event = "esc_watch", session = self.id.0, kind = ?kind, working);
        // Esc 는 일하는 모습이 보일 때만 지켜본다 (쉬는 화면의 Esc 는 메뉴 · 입력 지우기다)
        if working {
            self.esc_watch = Some(crate::interrupt::EscWatch::new(kind, updated_at, now_ms()));
        }
    }

    fn working_now(&mut self) -> bool {
        let screen = self.engine.read_screen(ScreenFormat::Plain, false).unwrap_or_default();
        crate::interrupt::shows_working(&screen, &self.engine.title())
    }

    fn check_esc_watch(&mut self) {
        use crate::interrupt::{Verdict, WatchKind};
        let Some(kind) = self.esc_watch.as_ref().map(|w| w.kind) else { return };
        let working = kind == WatchKind::Esc && self.working_now();
        let now = now_ms();
        let Some(watch) = self.esc_watch.as_mut() else { return };
        let verdict = watch.observe(working, now);
        let baseline = watch.updated_at;
        let session = match verdict {
            Verdict::Wait => return,
            Verdict::GiveUp => {
                info!(event = "esc_watch_still_working", session = self.id.0);
                None
            }
            Verdict::Interrupted | Verdict::Dismissed => {
                let mut i = self.info.lock().unwrap();
                // 그사이 훅이 새 상태를 알렸으면 그것을 믿는다
                match i.agent.as_mut() {
                    Some(a) if a.updated_at == baseline && verdict == Verdict::Interrupted && a.state == AgentState::Working => {
                        a.state = AgentState::Idle;
                        a.tool_name = None;
                        a.turn_ended_at = Some(now);
                        a.updated_at = now;
                        a.interrupted = true;
                        Some(i.clone())
                    }
                    Some(a) if a.updated_at == baseline && verdict == Verdict::Dismissed && a.state == AgentState::NeedsAttention => {
                        a.state = AgentState::Working;
                        a.tool_name = None;
                        a.updated_at = now;
                        Some(i.clone())
                    }
                    _ => None,
                }
            }
        };
        if let Some(session) = session {
            info!(event = "agent_interrupted", session = self.id.0, kind = ?kind);
            let _ = self.events.send(Event::SessionUpdated { session });
        }
        self.esc_watch = None;
    }

    fn attach(&mut self, conn: ConnId, tx: Outbox, format: SnapshotFormat, req_id: u64) {
        let reply = |result| Frame::json(&ServerMessage::Response { id: req_id, result });
        match self.engine.snapshot(format) {
            Ok(data) => {
                let _ = tx.send(Frame::Snapshot { session: self.id, format, data });
                self.subscribers.retain(|(c, _)| *c != conn);
                self.subscribers.push((conn, tx.clone()));
                let session = self.sync_attached();
                let _ = tx.send(reply(ResponseResult::Ok(Response::Attached { session })));
                info!(event = "session_attached", session = self.id.0, conn, ?format);
            }
            Err(e) => {
                let _ = tx.send(reply(ResponseResult::Err(thuminal_protocol::ErrorBody {
                    code: thuminal_protocol::ErrorCode::InvalidRequest,
                    message: e.to_string(),
                })));
            }
        }
    }

    /// 기본색을 바꾸고, 밝기(dark/light)가 바뀌었으면 mode 2031 을 켠 프로그램에만 알린다
    fn set_colors(&mut self, colors: &TerminalColors) {
        let before = self.engine.color_scheme();
        if let Err(e) = self.engine.set_default_colors(colors) {
            warn!(event = "terminal_colors_failed", session = self.id.0, error = %e);
            return;
        }
        let after = self.engine.color_scheme();
        if before != after && self.engine.dec_mode(COLOR_SCHEME_REPORT_MODE) {
            info!(event = "color_scheme_reported", session = self.id.0, scheme = ?after);
            let _ = self.input.send(color_scheme_report(after).to_vec());
        }
    }

    fn sync_attached(&self) -> SessionInfo {
        let mut i = self.info.lock().unwrap();
        i.attached = self.subscribers.len() as u32;
        i.clone()
    }
}
