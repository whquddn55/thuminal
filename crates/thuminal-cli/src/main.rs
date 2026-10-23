//! `thuminal` 명령.
//!
//! 데몬이 없으면 같은 폴더의 `thuminald` 를 떼어 띄운다. 세션 번호 자리에 `.` 을 쓰면
//! 지금 셸이 들어 있는 세션(`THUMINAL_SESSION_ID`)을 가리킨다.

mod attach;
mod workspace;

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::{Args, Parser, Subcommand};
use thuminal_client::{Client, default_daemon_bin};
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, Event, ScreenFormat, SessionId, SessionInfo, SessionState};

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
    /// 저장소 등록
    #[command(subcommand)]
    Repo(workspace::RepoCmd),
    /// 워크트리 만들기, 지우기, 보기
    #[command(subcommand, alias = "worktree")]
    Wt(workspace::WtCmd),
    /// 에이전트 훅이 부르는 명령
    #[command(subcommand)]
    Agent(AgentCmd),
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
    /// 글을 입력한다
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

fn session_id(s: &str) -> Res<SessionId> {
    let raw = if s == "." { std::env::var("THUMINAL_SESSION_ID").map_err(|_| "`.` 은 thuminal 세션 안에서만 쓸 수 있다")? } else { s.to_string() };
    Ok(SessionId(raw.parse().map_err(|_| format!("세션 번호가 아니다: {s}"))?))
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

/// 훅 알림. 어떤 경우에도 에이전트를 막지 않게 1초 안에 끝내고 오류를 내지 않는다
async fn agent_report(kind: String, event: Option<String>) -> ExitCode {
    let Ok(sid) = std::env::var("THUMINAL_SESSION_ID") else { return ExitCode::SUCCESS };
    let Ok(session) = sid.parse::<u64>() else { return ExitCode::SUCCESS };
    let mut input = String::new();
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
    }
    let payload: serde_json::Value = serde_json::from_str(&input).unwrap_or_default();
    let field = |k: &str| payload.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let Some(event) = field("hook_event_name").or(event) else { return ExitCode::SUCCESS };
    let request = thuminal_protocol::Request::ReportAgent {
        session: SessionId(session),
        kind,
        event,
        agent_session_id: field("session_id"),
        transcript: field("transcript_path"),
    };
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        if let Ok(c) = Client::connect(&Paths::default_home(), "agent-hook").await {
            let _ = c.request(request).await;
        }
    })
    .await;
    ExitCode::SUCCESS
}

async fn run(cli: Cli) -> Res<ExitCode> {
    match cli.command {
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
        Command::Term(cmd) => return term(cmd).await,
        Command::Repo(cmd) => workspace::repo(&connect().await?, cmd).await?,
        Command::Wt(cmd) => workspace::wt(&connect().await?, cmd).await?,
    }
    Ok(ExitCode::SUCCESS)
}

async fn term(cmd: TermCmd) -> Res<ExitCode> {
    let c = connect().await?;
    match cmd {
        TermCmd::New { cwd, worktree, size, labels, json, command } => {
            let cwd = match worktree {
                Some(w) => {
                    let all = c.worktrees(None).await?;
                    let abs = std::fs::canonicalize(&w).ok().map(|p| p.to_string_lossy().into_owned());
                    let found = all
                        .iter()
                        .find(|x| Some(&x.path) == abs.as_ref() || x.path == w || x.branch.as_deref() == Some(w.as_str()))
                        .ok_or(format!("워크트리를 찾지 못했다: {w}"))?;
                    Some(found.path.clone())
                }
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
            c.send_text(session_id(&id)?, text).await?;
        }
        TermCmd::Read { id, scrollback, vt } => {
            let format = if vt { ScreenFormat::Vt } else { ScreenFormat::Plain };
            print!("{}", c.read_screen(session_id(&id)?, format, scrollback).await?);
            println!();
        }
        TermCmd::Wait(w) => return wait(&c, w).await,
        TermCmd::Attach { id } => attach::run(&c, session_id(&id)?).await?,
        TermCmd::Kill { id } => c.kill(session_id(&id)?).await?,
        TermCmd::Rm { id } => c.remove(session_id(&id)?).await?,
    }
    Ok(ExitCode::SUCCESS)
}

async fn wait(c: &Client, w: WaitArgs) -> Res<ExitCode> {
    let id = session_id(&w.id)?;
    if !w.exit && w.idle.is_none() && w.pattern.is_none() {
        return Err("--exit, --idle, --match 가운데 하나를 준다".into());
    }
    let deadline = Instant::now() + Duration::from_secs(w.timeout);
    let mut events = c.events();
    loop {
        let info = c.list().await?.into_iter().find(|s| s.id == id).ok_or(format!("세션 {id} 이 없다"))?;
        if w.exit {
            if let SessionState::Exited { code } = info.state {
                println!("exit {}", code.map_or("?".into(), |c| c.to_string()));
                return Ok(ExitCode::SUCCESS);
            }
        }
        if let Some(ms) = w.idle {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
            if now.saturating_sub(info.last_output_at) >= ms {
                return Ok(ExitCode::SUCCESS);
            }
        }
        if let Some(p) = &w.pattern {
            if c.read_screen(id, ScreenFormat::Plain, false).await?.contains(p.as_str()) {
                return Ok(ExitCode::SUCCESS);
            }
        }
        if Instant::now() >= deadline {
            eprintln!("thuminal: 기다리다 시간이 넘었다");
            return Ok(ExitCode::from(124));
        }
        // 끝남은 이벤트로 바로 깨고, 나머지는 짧게 다시 본다
        let _ = tokio::time::timeout(Duration::from_millis(150), async {
            while let Ok(e) = events.recv().await {
                if matches!(e, Event::SessionExited { session, .. } if session == id) {
                    break;
                }
            }
        })
        .await;
    }
}
