//! `thuminal` 명령.
//!
//! 데몬이 없으면 같은 폴더의 `thuminald` 를 떼어 띄운다. 세션 자리에는 `12`, `s12`, 칸 `p7`(그 칸의 세션),
//! `.`(지금 셸이 들어 있는 세션, `THUMINAL_SESSION_ID`)을 쓸 수 있다. 칸·탭 명령에서 `.` 은 이 셸이 든 칸과 탭이다.

mod attach;
mod layout;
mod workspace;

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::{Args, Parser, Subcommand};
use thuminal_client::{Client, default_daemon_bin};
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{AgentState, CreateSession, Event, ScreenFormat, SessionId, SessionInfo, SessionState};

#[derive(Parser)]
#[command(name = "thuminal", version, about = "thuminal 터미널 관리 명령")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 데몬 상태 보기, 내리기
    #[command(subcommand)]
    Daemon(DaemonCmd),
    /// 터미널 세션 다루기
    #[command(subcommand, alias = "t")]
    Term(TermCmd),
    /// 칸 나누기, 옮기기, 크기, 포커스 (p7 = 칸, `.` = 이 셸이 든 칸)
    Pane(layout::PaneArgs),
    /// 탭 만들기, 고르기, 옮기기 (t3 = 탭)
    Tab(layout::TabArgs),
    /// 탭 배치를 한 줄로 보고 적용하기 (예: 'row(claude, col(zsh, "npm run dev"):40%)')
    Layout(layout::LayoutArgs),
    /// 앱 안 브라우저 탭 (예: thuminal browser open localhost:3000)
    Browser(layout::BrowserArgs),
    /// 저장소 등록
    #[command(subcommand)]
    Repo(workspace::RepoCmd),
    /// 워크트리 만들기, 지우기, 보기
    #[command(subcommand, alias = "worktree")]
    Wt(workspace::WtCmd),
    /// 원격 접속 (폰·다른 컴퓨터 브라우저가 Tailscale 로 붙는다)
    #[command(subcommand)]
    Remote(RemoteCmd),
    /// 에이전트 훅이 부르는 명령
    #[command(subcommand)]
    Agent(AgentCmd),
    /// claude 에이전트 팀이 부르는 가짜 tmux (`shell/teams-bin/tmux` 가 넘긴다)
    #[command(hide = true, disable_help_flag = true, disable_version_flag = true)]
    Tmux {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        argv: Vec<String>,
    },
}

#[derive(Subcommand)]
enum AgentCmd {
    /// 훅 알림을 데몬에 전한다. 훅 JSON 을 표준 입력으로 받는다.
    /// thuminal 세션 밖이거나 데몬이 없으면 아무것도 하지 않고 0 으로 끝난다 (에이전트를 막지 않는다)
    Report {
        #[arg(long, default_value = "claude")]
        kind: String,
        /// 훅 이름 (표준 입력 JSON 의 hook_event_name 이 있으면 그것을 쓴다)
        #[arg(long)]
        event: Option<String>,
    },
}

#[derive(Subcommand)]
enum RemoteCmd {
    /// 켜져 있는지, 받는 주소, 등록한 기기
    Status,
    /// 켠다 (Tailscale 주소와 127.0.0.1 에서 받는다)
    On {
        #[arg(long)]
        port: Option<u16>,
        /// 같은 Wi‑Fi 의 모든 주소에서도 받는다 (내용이 암호화되지 않는다)
        #[arg(long)]
        lan: bool,
    },
    /// 끈다 (붙어 있던 기기는 끊긴다)
    Off,
    /// 기기를 등록하고 그 기기가 열 주소를 찍는다
    Pair {
        #[arg(default_value = "기기")]
        name: String,
    },
    /// 등록한 기기를 지운다
    Rm { id: String },
}

#[derive(Subcommand)]
enum DaemonCmd {
    /// 데몬이 떠 있는지, 세션이 몇 개인지
    Status {
        #[arg(long)]
        json: bool,
    },
    /// 모든 세션을 끝내고 데몬을 내린다
    Stop,
}

#[derive(Subcommand)]
enum TermCmd {
    /// 새 세션을 띄우고 번호를 찍는다. `--` 뒤에 명령을 주면 셸 대신 그것을 띄운다
    New {
        #[arg(long)]
        cwd: Option<String>,
        /// 이 워크트리(경로나 브랜치)에서 띄운다
        #[arg(long, conflicts_with = "cwd")]
        worktree: Option<String>,
        /// 열x줄 (예: 120x40)
        #[arg(long, default_value = "120x40")]
        size: String,
        /// 꼬리표 key=value (여러 번)
        #[arg(long = "label", value_name = "KEY=VALUE")]
        labels: Vec<String>,
        #[arg(long)]
        json: bool,
        #[arg(last = true)]
        command: Vec<String>,
    },
    /// 세션 목록
    #[command(alias = "list")]
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// 글을 입력한다 (세션: 12, s12, 칸 p7, `.`)
    Send {
        id: String,
        text: String,
        /// 끝에 Enter 를 친다
        #[arg(long)]
        enter: bool,
    },
    /// 화면 글자를 읽는다
    Read {
        id: String,
        /// 스크롤백까지
        #[arg(long)]
        scrollback: bool,
        /// 색과 모양을 담은 제어 코드로
        #[arg(long)]
        vt: bool,
        /// 빈 줄을 뺀 마지막 N 줄만
        #[arg(long, value_name = "N")]
        tail: Option<usize>,
        /// {"session":12,"lines":[…]} 로
        #[arg(long)]
        json: bool,
    },
    /// 조건이 될 때까지 기다린다. 시간이 넘으면 종료 코드 124
    Wait(WaitArgs),
    /// 지금 터미널에서 세션에 붙는다. Ctrl-\ 로 떨어진다
    Attach { id: String },
    /// 세션 프로그램을 끝낸다
    Kill { id: String },
    /// 세션을 목록에서 지운다 (돌고 있으면 끝낸다)
    Rm { id: String },
}

#[derive(Args)]
struct WaitArgs {
    id: String,
    /// 프로그램이 끝날 때까지
    #[arg(long)]
    exit: bool,
    /// 출력이 이만큼(ms) 없을 때까지
    #[arg(long, value_name = "MS")]
    idle: Option<u64>,
    /// 화면에 이 글이 나올 때까지
    #[arg(long = "match", value_name = "TEXT")]
    pattern: Option<String>,
    /// 에이전트(claude)가 이 상태가 될 때까지. idle 은 이미 idle 이면 막 보낸 입력이 훅에 닿을 틈(1.5초)을
    /// 지켜본 뒤 끝낸다 (그 사이 일을 시작하면 턴이 끝날 때까지 기다린다). idle 은 오류로 끝난 턴(failed)도 받고 `failed` 를 찍는다
    #[arg(long, value_name = "STATE", value_parser = ["idle", "working", "attention", "failed"])]
    agent: Option<String>,
    /// 최대 기다림(초)
    #[arg(long, default_value_t = 600)]
    timeout: u64,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("thuminal: {e}");
            ExitCode::from(1)
        }
    }
}

type Res<T> = Result<T, Box<dyn std::error::Error>>;

async fn connect() -> Res<Client> {
    Ok(Client::connect_or_spawn(&Paths::default_home(), "cli", &default_daemon_bin()).await?)
}

/// 세션 자리의 글: `12`, `s12`, `.`(이 셸), `p7`(그 칸의 세션. 배치를 한 번 읽는다)
async fn session_id(c: &Client, s: &str) -> Res<SessionId> {
    if let Some(n) = s.strip_prefix('p').and_then(|n| n.parse().ok()) {
        return layout::session_of_pane(c, thuminal_protocol::PaneId(n)).await;
    }
    let raw = if s == "." { std::env::var("THUMINAL_SESSION_ID").map_err(|_| "`.` 은 thuminal 세션 안에서만 쓸 수 있다")? } else { s.to_string() };
    let num = raw.strip_prefix('s').unwrap_or(&raw);
    Ok(SessionId(num.parse().map_err(|_| format!("세션은 12, s12, 칸 p7, . 으로 쓴다: {s}"))?))
}

/// 빈 줄을 뺀 마지막 `n` 줄
fn tail_lines(text: &str, n: usize) -> Vec<&str> {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
}

fn print_sessions(sessions: &[SessionInfo]) {
    println!("{:>4}  {:<8}  {:>9}  {:<24}  CWD", "ID", "STATE", "SIZE", "TITLE");
    for s in sessions {
        let state = match &s.state {
            SessionState::Running => "running".to_string(),
            SessionState::Exited { code } => format!("exit {}", code.map_or("?".into(), |c| c.to_string())),
        };
        println!("{:>4}  {:<8}  {:>9}  {:<24}  {}", s.id, state, format!("{}x{}", s.cols, s.rows), s.title, s.cwd);
    }
}

/// transcript 끝에서 읽을 최대 바이트 (Stop 훅에 `last_assistant_message` 가 없는 옛 claude 용)
const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// claude transcript(JSON 줄) 끝에서 마지막 assistant 글을 찾는다. 끝 [`TRANSCRIPT_TAIL_BYTES`] 만 읽는다
fn last_assistant_from_transcript(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TRANSCRIPT_TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.take(TRANSCRIPT_TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines().rev().find_map(|line| {
        let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        if v.get("type")?.as_str()? != "assistant" {
            return None;
        }
        let content = v.get("message")?.get("content")?;
        let joined = match content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return None,
        };
        (!joined.trim().is_empty()).then_some(joined)
    })
}

/// Notification 종류. `notification_type` 이 없는 옛 claude 는 글로 가린다
fn notification_type(payload: &serde_json::Value) -> Option<String> {
    let field = |k: &str| payload.get(k).and_then(|v| v.as_str());
    if let Some(t) = field("notification_type") {
        return Some(t.to_string());
    }
    let msg = field("message")?.to_ascii_lowercase();
    if msg.contains("permission") {
        Some("permission_prompt".into())
    } else if msg.contains("waiting for your input") {
        Some("idle_prompt".into())
    } else {
        None
    }
}

/// 훅 JSON 을 데몬 요청으로. 긴 글은 여기서 먼저 자른다
fn agent_request(session: SessionId, kind: String, event: Option<String>, payload: &serde_json::Value) -> Option<thuminal_protocol::Request> {
    use thuminal_protocol::{AGENT_TEXT_MAX, clip_text};
    let field = |k: &str| payload.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let clipped = |k: &str| payload.get(k).and_then(|v| v.as_str()).and_then(|v| clip_text(v, AGENT_TEXT_MAX));
    let event = field("hook_event_name").or(event)?;
    let transcript = field("transcript_path");
    let last_assistant_message = match event.as_str() {
        "Stop" | "StopFailure" => clipped("last_assistant_message")
            .or_else(|| transcript.as_deref().and_then(last_assistant_from_transcript).and_then(|m| clip_text(&m, AGENT_TEXT_MAX))),
        _ => None,
    };
    Some(thuminal_protocol::Request::ReportAgent {
        session,
        kind,
        agent_session_id: field("session_id"),
        transcript,
        prompt: (event == "UserPromptSubmit").then(|| clipped("prompt")).flatten(),
        last_assistant_message,
        tool_name: field("tool_name"),
        notification_type: (event == "Notification").then(|| notification_type(payload)).flatten(),
        source: field("source"),
        model: field("model"),
        event,
    })
}

/// 훅 알림. 어떤 경우에도 에이전트를 막지 않게 1초 안에 끝내고 오류를 내지 않는다
async fn agent_report(kind: String, event: Option<String>) -> ExitCode {
    let Ok(sid) = std::env::var("THUMINAL_SESSION_ID") else { return ExitCode::SUCCESS };
    let Ok(session) = sid.parse::<u64>() else { return ExitCode::SUCCESS };
    let mut input = String::new();
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
    }
    let payload: serde_json::Value = serde_json::from_str(&input).unwrap_or_default();
    let Some(request) = agent_request(SessionId(session), kind, event, &payload) else { return ExitCode::SUCCESS };
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        if let Ok(c) = Client::connect(&Paths::default_home(), "agent-hook").await {
            let _ = c.request(request).await;
        }
    })
    .await;
    ExitCode::SUCCESS
}

/// 가짜 tmux: 명령 하나를 데몬에 넘기고 tmux 처럼 출력·종료 코드를 낸다
async fn tmux(argv: Vec<String>) -> ExitCode {
    let Some(session) = std::env::var("THUMINAL_SESSION_ID").ok().and_then(|s| s.parse::<u64>().ok()) else {
        eprintln!("thuminal tmux: thuminal 세션 밖이다");
        return ExitCode::from(1);
    };
    let env = ["PATH", "TMUX", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    let request = thuminal_protocol::Request::Tmux {
        session: SessionId(session),
        pane: std::env::var("TMUX_PANE").ok(),
        argv,
        cwd: std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()),
        env,
    };
    let reply = async { Client::connect(&Paths::default_home(), "tmux").await?.request(request).await };
    match reply.await {
        Ok(thuminal_protocol::Response::Tmux { stdout, stderr, code }) => {
            print!("{stdout}");
            eprint!("{stderr}");
            ExitCode::from(code.clamp(0, 255) as u8)
        }
        Ok(other) => {
            eprintln!("thuminal tmux: 뜻밖의 응답 {other:?}");
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("thuminal tmux: {e}");
            ExitCode::from(1)
        }
    }
}

async fn run(cli: Cli) -> Res<ExitCode> {
    match cli.command {
        Command::Tmux { argv } => return Ok(tmux(argv).await),
        Command::Agent(AgentCmd::Report { kind, event }) => return Ok(agent_report(kind, event).await),
        Command::Daemon(DaemonCmd::Status { json }) => {
            match Client::connect(&Paths::default_home(), "cli").await {
                Ok(c) => {
                    let status = c.request(thuminal_protocol::Request::Status).await?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&status)?);
                    } else {
                        println!("{status:?}");
                    }
                }
                Err(_) => {
                    println!("데몬이 떠 있지 않다");
                    return Ok(ExitCode::from(3));
                }
            }
        }
        Command::Daemon(DaemonCmd::Stop) => match Client::connect(&Paths::default_home(), "cli").await {
            Ok(c) => {
                c.shutdown().await?;
                println!("데몬을 내렸다");
            }
            Err(_) => println!("데몬이 떠 있지 않다"),
        },
        Command::Remote(cmd) => remote(&connect().await?, cmd).await?,
        Command::Term(cmd) => return term(cmd).await,
        Command::Repo(cmd) => workspace::repo(&connect().await?, cmd).await?,
        Command::Wt(cmd) => workspace::wt(&connect().await?, cmd).await?,
        Command::Pane(args) => layout::pane(&connect().await?, args).await?,
        Command::Tab(args) => layout::tab(&connect().await?, args).await?,
        Command::Layout(args) => layout::layout(&connect().await?, args).await?,
        Command::Browser(args) => layout::browser(&connect().await?, args).await?,
    }
    Ok(ExitCode::SUCCESS)
}

async fn remote(c: &Client, cmd: RemoteCmd) -> Res<()> {
    use thuminal_protocol::{Request, Response};
    let req = match cmd {
        RemoteCmd::Status => Request::GetRemote,
        RemoteCmd::On { port, lan } => Request::SetRemote { enabled: Some(true), port, lan: Some(lan) },
        RemoteCmd::Off => Request::SetRemote { enabled: Some(false), port: None, lan: None },
        RemoteCmd::Pair { name } => Request::PairRemote { name },
        RemoteCmd::Rm { id } => Request::RemoveRemoteDevice { id },
    };
    match c.request(req).await? {
        Response::Remote { remote: r } => {
            println!("원격 접속: {} · 포트 {}{}", if r.enabled { "켜짐" } else { "꺼짐" }, r.port, if r.lan { " · LAN 허용" } else { "" });
            for a in &r.listening {
                println!("  받는 주소 {a}");
            }
            if r.tailnet.is_empty() {
                println!("  Tailscale 주소를 찾지 못했다");
            }
            if let Some(e) = &r.error {
                println!("  오류: {e}");
            }
            if !r.web {
                println!("  웹 화면 파일이 없다 (pnpm -C apps/web build)");
            }
            for d in &r.devices {
                println!("  기기 {} {} · 연결 {}", d.id, d.name, d.connected);
            }
        }
        Response::RemotePaired { device, urls } => {
            println!("기기 {} ({}) 를 등록했다. 폰에서 이 주소를 연다:", device.name, device.id);
            for u in urls {
                println!("  {u}");
            }
        }
        other => println!("{other:?}"),
    }
    Ok(())
}

async fn term(cmd: TermCmd) -> Res<ExitCode> {
    let c = connect().await?;
    match cmd {
        TermCmd::New { cwd, worktree, size, labels, json, command } => {
            let cwd = match worktree {
                Some(w) => Some(workspace::find_worktree(&c, &w, false).await?.path),
                None => cwd,
            };
            let (cols, rows) = size.split_once('x').ok_or("--size 는 120x40 처럼 쓴다")?;
            let labels: BTreeMap<String, String> = labels
                .iter()
                .map(|l| l.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).ok_or(format!("꼬리표는 key=value: {l}")))
                .collect::<Result<_, _>>()?;
            let cwd = cwd.or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()));
            let s = c.create(CreateSession { command, cwd, cols: cols.parse()?, rows: rows.parse()?, labels, ..Default::default() }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&s)?);
            } else {
                println!("{}", s.id);
            }
        }
        TermCmd::Ls { json } => {
            let sessions = c.list().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&sessions)?);
            } else {
                print_sessions(&sessions);
            }
        }
        TermCmd::Send { id, text, enter } => {
            let mut text = text;
            if enter {
                text.push('\r');
            }
            c.send_text(session_id(&c, &id).await?, text).await?;
        }
        TermCmd::Read { id, scrollback, vt, tail, json } => {
            let id = session_id(&c, &id).await?;
            let format = if vt { ScreenFormat::Vt } else { ScreenFormat::Plain };
            let text = c.read_screen(id, format, scrollback).await?;
            let lines: Vec<&str> = match tail {
                Some(n) => tail_lines(&text, n),
                None => text.lines().collect(),
            };
            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "session": id, "lines": lines }))?);
            } else if tail.is_some() {
                lines.iter().for_each(|l| println!("{l}"));
            } else {
                print!("{text}");
                println!();
            }
        }
        TermCmd::Wait(w) => return wait(&c, w).await,
        TermCmd::Attach { id } => attach::run(&c, session_id(&c, &id).await?).await?,
        TermCmd::Kill { id } => c.kill(session_id(&c, &id).await?).await?,
        TermCmd::Rm { id } => c.remove(session_id(&c, &id).await?).await?,
    }
    Ok(ExitCode::SUCCESS)
}

/// `--agent idle` 이 이미 idle 인 에이전트를 받아들이기 전에 지켜보는 틈 (막 보낸 프롬프트의 훅이 닿을 시간)
const AGENT_IDLE_GRACE: Duration = Duration::from_millis(1500);

fn agent_state(name: &str) -> AgentState {
    match name {
        "working" => AgentState::Working,
        "attention" => AgentState::NeedsAttention,
        "failed" => AgentState::Failed,
        _ => AgentState::Idle,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

async fn wait(c: &Client, w: WaitArgs) -> Res<ExitCode> {
    let id = session_id(c, &w.id).await?;
    if !w.exit && w.idle.is_none() && w.pattern.is_none() && w.agent.is_none() {
        return Err("--exit, --idle, --match, --agent 가운데 하나를 준다".into());
    }
    let started = Instant::now();
    let started_ms = now_ms();
    let deadline = started + Duration::from_secs(w.timeout);
    let want_agent = w.agent.as_deref().map(agent_state);
    let mut events = c.events();
    loop {
        let info = c.list().await?.into_iter().find(|s| s.id == id).ok_or(format!("세션 {id} 이 없다"))?;
        if w.exit
            && let SessionState::Exited { code } = info.state
        {
            println!("exit {}", code.map_or("?".into(), |c| c.to_string()));
            return Ok(ExitCode::SUCCESS);
        }
        if let Some(ms) = w.idle
            && now_ms().saturating_sub(info.last_output_at) >= ms
        {
            return Ok(ExitCode::SUCCESS);
        }
        if let Some(p) = &w.pattern
            && c.read_screen(id, ScreenFormat::Plain, false).await?.contains(p.as_str())
        {
            return Ok(ExitCode::SUCCESS);
        }
        if let Some(want) = want_agent {
            // idle 을 기다리면 오류로 끝난 턴(failed)도 턴이 끝난 것으로 받는다
            let matches = |s: AgentState| s == want || (want == AgentState::Idle && s == AgentState::Failed);
            if let Some(a) = info.agent.as_ref().filter(|a| matches(a.state)) {
                // idle 은 기다리기 시작한 뒤에 idle 이 되었거나, 틈 동안 그대로였을 때만
                let fresh = want != AgentState::Idle || a.updated_at >= started_ms || started.elapsed() >= AGENT_IDLE_GRACE;
                if fresh {
                    println!("{}", if a.state == AgentState::Failed { "failed" } else { w.agent.as_deref().unwrap_or_default() });
                    return Ok(ExitCode::SUCCESS);
                }
            }
            if !w.exit && matches!(info.state, SessionState::Exited { .. }) {
                eprintln!("thuminal: 세션 {id} 이 끝났다");
                return Ok(ExitCode::from(1));
            }
        }
        if Instant::now() >= deadline {
            eprintln!("thuminal: 기다리다 시간이 넘었다");
            return Ok(ExitCode::from(124));
        }
        // 끝남, 에이전트 상태 바뀜은 이벤트로 바로 깨고, 나머지는 짧게 다시 본다
        let _ = tokio::time::timeout(Duration::from_millis(150), async {
            while let Ok(e) = events.recv().await {
                match e {
                    Event::SessionExited { session, .. } if session == id => break,
                    Event::SessionUpdated { session } if session.id == id && want_agent.is_some() => break,
                    _ => {}
                }
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_skips_blank_lines() {
        assert_eq!(tail_lines("a\n\n b \n\nc\n  \n", 2), vec![" b ", "c"]);
        assert_eq!(tail_lines("a\nb", 5), vec!["a", "b"]);
    }

    #[test]
    fn builds_report_from_hook_json() {
        let req = |v: serde_json::Value| agent_request(SessionId(4), "claude".into(), None, &v).unwrap();
        let r = req(serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"x","prompt":"a".repeat(300)}));
        let thuminal_protocol::Request::ReportAgent { event, prompt, agent_session_id, .. } = r else { panic!() };
        assert_eq!((event.as_str(), agent_session_id.as_deref()), ("UserPromptSubmit", Some("x")));
        assert_eq!(prompt.unwrap().chars().count(), thuminal_protocol::AGENT_TEXT_MAX + 1);

        let r = req(serde_json::json!({"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}));
        assert!(matches!(r, thuminal_protocol::Request::ReportAgent { notification_type: Some(t), .. } if t == "permission_prompt"));
        let r = req(serde_json::json!({"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude needs your permission"}));
        assert!(matches!(r, thuminal_protocol::Request::ReportAgent { notification_type: Some(t), .. } if t == "idle_prompt"));
        // 프롬프트는 UserPromptSubmit 에서만 받는다
        let r = req(serde_json::json!({"hook_event_name":"PreToolUse","tool_name":"Bash","prompt":"x"}));
        assert!(matches!(r, thuminal_protocol::Request::ReportAgent { prompt: None, tool_name: Some(t), .. } if t == "Bash"));
        assert!(agent_request(SessionId(1), "claude".into(), None, &serde_json::json!({})).is_none());
    }

    #[test]
    fn reads_last_assistant_text_from_transcript_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let lines = [
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"old"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"},{"type":"tool_use","name":"Bash"},{"type":"text","text":"second"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}]}}"#,
            "not json",
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(last_assistant_from_transcript(path.to_str().unwrap()).as_deref(), Some("first\nsecond"));
        let r = agent_request(
            SessionId(1),
            "claude".into(),
            None,
            &serde_json::json!({"hook_event_name":"Stop","transcript_path": path.to_str().unwrap()}),
        )
        .unwrap();
        assert!(matches!(r, thuminal_protocol::Request::ReportAgent { last_assistant_message: Some(m), .. } if m == "first\nsecond"));
        assert!(last_assistant_from_transcript("/없는/파일").is_none());
    }
}
