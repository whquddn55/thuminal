//! `thuminal pane …`, `thuminal tab …`, `thuminal layout …`: 칸과 탭, 배치 한 줄.
//!
//! 바꾸는 명령은 대상을 데몬이 풀도록 [`PaneRef`]/[`TabRef`] 로 보내고 요청 하나(`Layout`)로 끝낸다.
//! `--in` 의 브랜치 이름이나 `.`(이 셸의 workspace)을 풀 때만 읽기 요청을 하나 더 한다.
//! 대상을 생략하거나 `.` 을 쓰면 이 셸이 든 칸(`THUMINAL_SESSION_ID`)이다.

use clap::{Args, Subcommand};
use thuminal_client::Client;
use thuminal_layout::dsl;
use thuminal_protocol::{
    Axis, FLOATING_WORKSPACE, LayoutOp, LayoutSpec, OTHER_WORKSPACE, Pane, PaneContent, PaneId, PaneNode, PaneRef, SessionId,
    SessionInfo, Side, Spawn, Tab, TabId, TabRef, WorkspaceLayout,
};

use crate::workspace::find_worktree;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Args)]
pub struct PaneArgs {
    /// 결과를 JSON 으로
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: PaneCmd,
}

#[derive(Args)]
pub struct TabArgs {
    /// 결과를 JSON 으로
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: TabCmd,
}

#[derive(Args)]
pub struct BrowserArgs {
    /// 결과를 JSON 으로
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: BrowserCmd,
}

#[derive(Subcommand)]
enum BrowserCmd {
    /// 앱 안 브라우저로 주소를 연다 (기본: 새 탭). 새 칸을 찍는다 (`p9`)
    Open {
        /// 주소. 스킴이 없으면 http:// 를 붙인다 (localhost:3000 처럼)
        url: String,
        /// 이 워크스페이스에 연다 (경로, 브랜치, floating, other, `.`)
        #[arg(long = "in", value_name = "W")]
        workspace: Option<String>,
        /// 새 탭 대신 이 칸 옆을 나눠 연다 (p7, `.` 은 이 셸이 든 칸)
        #[arg(long, value_name = "칸")]
        beside: Option<String>,
        #[command(flatten)]
        dir: Dir,
        #[arg(long)]
        no_focus: bool,
    },
}

/// 주소에 스킴이 없으면 붙인다
fn browser_url(url: &str) -> String {
    let u = url.trim();
    if u.contains("://") || u.starts_with("about:") { u.to_string() } else { format!("http://{u}") }
}

fn browser_doc(url: &str) -> std::collections::BTreeMap<String, String> {
    [("kind".to_string(), "browser".to_string()), ("url".to_string(), browser_url(url))].into()
}

pub async fn browser(c: &Client, args: BrowserArgs) -> Res<()> {
    let json = args.json;
    match args.cmd {
        BrowserCmd::Open { url, workspace: w, beside, dir, no_focus } => {
            let op = match beside.or_else(|| dir.side().map(|_| ".".to_string())) {
                Some(target) => LayoutOp::Split {
                    target: pane_ref(Some(&target))?,
                    side: dir.side().unwrap_or(Side::Right),
                    size: None,
                    spawn: Spawn::default(),
                    focus: !no_focus,
                    doc: Some(browser_doc(&url)),
                },
                None => LayoutOp::NewTab {
                    workspace: workspace(c, w.as_deref()).await?,
                    spawn: Spawn::default(),
                    index: None,
                    focus: !no_focus,
                    title: None,
                    doc: Some(browser_doc(&url)),
                },
            };
            let (_, created) = send(c, json, op).await?;
            if !json {
                created.iter().for_each(|p| println!("{p}"));
            }
        }
    }
    Ok(())
}

#[derive(Args)]
pub struct LayoutArgs {
    /// 결과를 JSON 으로
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: LayoutCmd,
}

/// 방향 (하나만)
#[derive(Args, Default)]
#[group(multiple = false)]
struct Dir {
    #[arg(long)]
    left: bool,
    #[arg(long)]
    right: bool,
    #[arg(long)]
    up: bool,
    #[arg(long)]
    down: bool,
}

impl Dir {
    fn side(&self) -> Option<Side> {
        [(self.left, Side::Left), (self.right, Side::Right), (self.up, Side::Up), (self.down, Side::Down)].into_iter().find(|(on, _)| *on).map(|(_, s)| s)
    }
}

#[derive(Subcommand)]
enum PaneCmd {
    /// 칸을 나눠 새 터미널을 띄우고 새 칸과 세션 번호를 찍는다 (`p8 s13`). `--` 뒤 명령은 새 셸에 입력한다 (기본 --right)
    Split {
        /// 나눌 칸 (p7, 생략하면 이 셸이 든 칸)
        target: Option<String>,
        #[command(flatten)]
        dir: Dir,
        /// 새 칸 크기 (40% 나 0.4, 기본 50%)
        #[arg(long)]
        size: Option<String>,
        /// 새 칸으로 포커스를 옮기지 않는다
        #[arg(long)]
        no_focus: bool,
        /// 새 셸의 작업 폴더 (기본: 대상 칸의 지금 폴더)
        #[arg(long)]
        cwd: Option<String>,
        #[arg(last = true)]
        command: Vec<String>,
    },
    /// 칸 크기를 바꾼다 (칸이 든 분할에서 이 칸 몫)
    Resize {
        target: Option<String>,
        /// 이 크기로 (30% 나 0.3)
        #[arg(long, group = "how")]
        size: Option<String>,
        /// 이만큼 늘린다
        #[arg(long, group = "how")]
        grow: Option<String>,
        /// 이만큼 줄인다
        #[arg(long, group = "how")]
        shrink: Option<String>,
        /// 이 축의 분할에서 고친다 (row = 가로 폭, column = 세로 높이)
        #[arg(long, value_parser = ["row", "column", "col"])]
        axis: Option<String>,
    },
    /// 칸에 포커스. 방향을 주면 화면에서 그쪽 옆 칸, --next/--prev 는 탭 안 순서대로. 포커스된 칸을 찍는다
    Focus {
        target: Option<String>,
        #[command(flatten)]
        dir: Dir,
        #[arg(long, conflicts_with_all = ["prev", "left", "right", "up", "down"])]
        next: bool,
        #[arg(long, conflicts_with_all = ["left", "right", "up", "down"])]
        prev: bool,
    },
    /// 칸을 다른 칸 옆으로 옮긴다 (다른 탭, 다른 워크트리도 된다. 기본 --right)
    Move {
        pane: String,
        /// 이 칸 옆으로
        #[arg(long)]
        to: String,
        #[command(flatten)]
        dir: Dir,
    },
    /// 두 칸 자리를 맞바꾼다
    Swap { a: String, b: String },
    /// 칸을 탭 전체로 펼치거나 되돌린다 (생략하면 뒤집는다)
    Zoom {
        target: Option<String>,
        #[arg(long, conflicts_with = "off")]
        on: bool,
        #[arg(long)]
        off: bool,
    },
    /// 칸이 든 탭의 분할을 모두 똑같이 나눈다
    Equalize { target: Option<String> },
    /// 칸을 떼어 새 탭으로. 탭 번호를 찍는다
    Break {
        target: Option<String>,
        /// 이 워크스페이스로 (워크트리 경로나 브랜치, floating, other. 기본: 같은 곳)
        #[arg(long = "in")]
        workspace: Option<String>,
        /// 탭 줄 자리 (0 부터. 기본: 끝)
        #[arg(long)]
        index: Option<usize>,
    },
    /// 칸을 닫는다 (터미널이면 세션을 끝내고 지운다)
    Close { target: Option<String> },
    /// 칸 목록: 칸 탭 세션 제목 폴더 (* 는 포커스된 칸, 활성 탭)
    #[command(alias = "list")]
    Ls {
        /// 이 워크스페이스만 (기본: 이 셸의 워크스페이스)
        #[arg(long = "in", conflicts_with = "all")]
        workspace: Option<String>,
        /// 모든 워크스페이스
        #[arg(long)]
        all: bool,
    },
}

#[derive(Subcommand)]
enum TabCmd {
    /// 새 탭을 띄우고 탭, 칸, 세션 번호를 찍는다 (`t3 p7 s12`). `--` 뒤 명령은 새 셸에 입력한다
    New {
        /// 탭 이름
        #[arg(long)]
        title: Option<String>,
        /// 이 워크스페이스에 (워크트리 경로나 브랜치, floating, other, `.`. 기본: 이 셸의 워크스페이스)
        #[arg(long = "in")]
        workspace: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        /// 탭 줄 자리 (0 부터. 기본: 끝)
        #[arg(long)]
        index: Option<usize>,
        /// 활성 탭으로 만들지 않는다
        #[arg(long)]
        no_focus: bool,
        #[arg(last = true)]
        command: Vec<String>,
    },
    /// 활성 탭으로 (t3, 칸 p7, `.`)
    Select { tab: Option<String> },
    /// 탭을 닫는다 (안의 터미널 세션을 모두 끝내고 지운다)
    Close { tab: Option<String> },
    /// 탭 이름을 붙인다. 이름을 빼면 지운다
    Rename { tab: String, title: Option<String> },
    /// 탭 순서를 바꾸거나 다른 워크스페이스로 옮긴다
    Move {
        tab: String,
        #[arg(long)]
        index: usize,
        #[arg(long = "in")]
        workspace: Option<String>,
    },
    /// 탭 전체를 다른 칸 옆으로 합친다 (기본 --right)
    Join {
        tab: String,
        #[arg(long)]
        to: String,
        #[command(flatten)]
        dir: Dir,
    },
    /// 탭 목록: 탭 제목 배치 (* 는 활성 탭)
    #[command(alias = "list")]
    Ls {
        #[arg(long = "in")]
        workspace: Option<String>,
    },
}

#[derive(Subcommand)]
enum LayoutCmd {
    /// 탭 배치를 한 줄로 찍는다. 그대로 `layout apply` 에 다시 넣을 수 있다
    Show {
        #[arg(long = "in")]
        workspace: Option<String>,
        /// 이 탭 (기본: 이 셸이 든 탭, 셸 밖이면 활성 탭)
        #[arg(long)]
        tab: Option<String>,
    },
    /// 한 줄 배치를 적용하고 탭의 칸마다 칸과 세션 번호를 한 줄씩 찍는다 (`p7 s12`, 문서 칸은 `p7 -`).
    /// 예: 'row(claude, col(zsh, "npm run dev"):40%)'.
    /// --tab 을 주면 그 탭을 바꾸고(빠진 옛 칸은 새 탭으로 뗀다), 아니면 새 탭을 만든다
    Apply {
        spec: String,
        #[arg(long = "in")]
        workspace: Option<String>,
        /// 바꿀 탭 (t3, `.` = 이 셸이 든 탭)
        #[arg(long)]
        tab: Option<String>,
        #[arg(long)]
        no_focus: bool,
    },
}

// ---- 대상 풀기 ----

fn this_session() -> Res<SessionId> {
    let raw = std::env::var("THUMINAL_SESSION_ID").map_err(|_| "대상을 생략하거나 `.` 을 쓰려면 thuminal 셸 안이어야 한다")?;
    Ok(SessionId(raw.parse().map_err(|_| format!("THUMINAL_SESSION_ID 가 숫자가 아니다: {raw}"))?))
}

fn numbered(s: &str, prefix: char) -> Option<u64> {
    s.strip_prefix(prefix).and_then(|n| n.parse().ok())
}

/// `p7`, `.`, 생략
fn pane_ref(s: Option<&str>) -> Res<PaneRef> {
    match s {
        None | Some(".") => Ok(PaneRef::Session(this_session()?)),
        Some(s) => numbered(s, 'p').map(|n| PaneRef::Id(PaneId(n))).ok_or_else(|| format!("칸은 p7 이나 . 으로 쓴다: {s}").into()),
    }
}

/// `t3`, `p7`(그 칸이 든 탭), `.`, 생략
fn tab_ref(s: Option<&str>) -> Res<TabRef> {
    match s.and_then(|s| numbered(s, 't')) {
        Some(n) => Ok(TabRef::Id(TabId(n))),
        None => pane_ref(s).map(TabRef::Pane).map_err(|_| format!("탭은 t3, 칸 p7, . 으로 쓴다: {}", s.unwrap_or(".")).into()),
    }
}

fn size(s: &str) -> Res<f32> {
    Ok(dsl::parse_size(s.trim())?)
}

/// `-- 명령…` 을 셸에 입력할 한 줄로. 낱말이 하나면 그대로, 여럿이면 필요한 것만 따옴표로 싼다
fn shell_line(args: &[String]) -> Option<String> {
    match args {
        [] => None,
        [one] => Some(one.clone()),
        many => Some(
            many.iter()
                .map(|a| {
                    if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
                        a.clone()
                    } else {
                        format!("'{}'", a.replace('\'', r"'\''"))
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
    }
}

fn spawn(cwd: Option<String>, command: &[String]) -> Res<Spawn> {
    let cwd = cwd.map(|d| dunce::canonicalize(&d).map(|p| p.to_string_lossy().into_owned()).map_err(|e| format!("{d}: {e}"))).transpose()?;
    Ok(Spawn { input: shell_line(command), cwd, ..Default::default() })
}

/// `--in` 을 workspace 이름으로: `floating`, `other`, 워크트리 경로나 브랜치, `.`/생략은 이 셸의 workspace
async fn workspace(c: &Client, w: Option<&str>) -> Res<String> {
    match w {
        Some(FLOATING_WORKSPACE) | Some(OTHER_WORKSPACE) => Ok(w.unwrap().to_string()),
        None | Some(".") => here(c).await,
        Some(target) => Ok(find_worktree(c, target, true).await?.path),
    }
}

/// 이 셸이 든 workspace. 셸 밖이면 지금 폴더의 워크트리, 그것도 아니면 `other`
async fn here(c: &Client) -> Res<String> {
    if let Ok(me) = this_session()
        && let Some(l) = c.layouts(None).await?.into_iter().find(|l| layout_has_session(l, me))
    {
        return Ok(l.workspace);
    }
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    Ok(find_worktree(c, &cwd, true).await.map(|w| w.path).unwrap_or_else(|_| OTHER_WORKSPACE.into()))
}

// ---- 결과 읽기 ----

fn panes(n: &PaneNode) -> Vec<&Pane> {
    match n {
        PaneNode::Pane { pane } => vec![pane],
        PaneNode::Split { children, .. } => children.iter().flat_map(panes).collect(),
    }
}

fn layout_has_session(l: &WorkspaceLayout, s: SessionId) -> bool {
    l.tabs.iter().any(|t| panes(&t.root).iter().any(|p| p.session() == Some(s)))
}

/// 결과 배치에서 이 칸이 든 탭
fn tab_with<'a>(layouts: &'a [WorkspaceLayout], r: &PaneRef) -> Option<(&'a WorkspaceLayout, &'a Tab)> {
    layouts.iter().find_map(|l| {
        l.tabs
            .iter()
            .find(|t| match r {
                PaneRef::Id(id) => panes(&t.root).iter().any(|p| p.id == *id),
                PaneRef::Session(s) => panes(&t.root).iter().any(|p| p.session() == Some(*s)),
                PaneRef::Focused(ws) => l.workspace == *ws && l.active_tab == Some(t.id),
            })
            .map(|t| (l, t))
    })
}

fn pane_title(p: &Pane, sessions: &[SessionInfo]) -> String {
    match &p.content {
        PaneContent::Terminal { session } => sessions.iter().find(|s| s.id == *session).map(|s| s.title.clone()).unwrap_or_default(),
        PaneContent::Doc { doc } => {
            let kind = doc.get("kind").map(String::as_str).unwrap_or("doc");
            doc.get("file").or_else(|| doc.get("path")).map(|f| format!("{kind} {f}")).unwrap_or_else(|| kind.to_string())
        }
    }
}

fn tilde(path: &str) -> String {
    match thuminal_protocol::paths::user_home().map(|h| h.to_string_lossy().into_owned()) {
        Some(h) if !h.is_empty() && path.starts_with(&h) => format!("~{}", &path[h.len()..]),
        _ => path.to_string(),
    }
}

fn print_json(v: &impl serde::Serialize) -> Res<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

/// 결과 배치에서 이 칸의 세션
fn session_in(layouts: &[WorkspaceLayout], id: PaneId) -> Option<SessionId> {
    layouts.iter().flat_map(|l| &l.tabs).flat_map(|t| panes(&t.root)).find(|p| p.id == id).and_then(Pane::session)
}

/// `p7 s12` (문서 칸은 `p7 -`)
fn pane_and_session(layouts: &[WorkspaceLayout], id: PaneId) -> String {
    format!("{id} {}", session_in(layouts, id).map_or("-".to_string(), |s| format!("s{s}")))
}

/// 칸이 든 세션 (term 명령의 `p7`). 배치를 한 번 읽는다
pub async fn session_of_pane(c: &Client, id: PaneId) -> Res<SessionId> {
    session_in(&c.layouts(None).await?, id).ok_or_else(|| format!("{id} 은 없거나 터미널 칸이 아니다").into())
}

/// `--json` 이면 결과를 찍는다: 바뀐 배치, 새로 만든 칸, 새 칸마다 {pane, tab, session}
async fn send(c: &Client, json: bool, op: LayoutOp) -> Res<(Vec<WorkspaceLayout>, Vec<PaneId>)> {
    let (layouts, created) = c.layout(op).await?;
    if json {
        let made: Vec<_> = created
            .iter()
            .map(|p| {
                let tab = tab_with(&layouts, &PaneRef::Id(*p)).map(|(_, t)| t.id);
                serde_json::json!({ "pane": p, "tab": tab, "session": session_in(&layouts, *p) })
            })
            .collect();
        print_json(&serde_json::json!({ "layouts": layouts, "created": created, "panes": made }))?;
    }
    Ok((layouts, created))
}

// ---- 명령 ----

pub async fn pane(c: &Client, args: PaneArgs) -> Res<()> {
    let json = args.json;
    match args.cmd {
        PaneCmd::Split { target, dir, size: sz, no_focus, cwd, command } => {
            let op = LayoutOp::Split {
                target: pane_ref(target.as_deref())?,
                side: dir.side().unwrap_or(Side::Right),
                size: sz.as_deref().map(size).transpose()?,
                spawn: spawn(cwd, &command)?,
                focus: !no_focus,
                doc: None,
            };
            let (layouts, created) = send(c, json, op).await?;
            if !json {
                created.iter().for_each(|p| println!("{}", pane_and_session(&layouts, *p)));
            }
        }
        PaneCmd::Resize { target, size: sz, grow, shrink, axis } => {
            let target = pane_ref(target.as_deref())?;
            let axis = axis.map(|a| if a == "row" { Axis::Row } else { Axis::Column });
            let op = match (sz, grow, shrink) {
                (Some(s), _, _) => LayoutOp::Resize { target, size: size(&s)?, axis },
                (_, Some(g), _) => LayoutOp::ResizeBy { target, delta: size(&g)?, axis },
                (_, _, Some(s)) => LayoutOp::ResizeBy { target, delta: -size(&s)?, axis },
                _ => return Err("--size, --grow, --shrink 가운데 하나를 준다".into()),
            };
            send(c, json, op).await?;
        }
        PaneCmd::Focus { target, dir, next, prev } => {
            let from = pane_ref(target.as_deref())?;
            let op = match (dir.side(), next, prev) {
                (Some(side), _, _) => LayoutOp::FocusDir { from: from.clone(), side },
                (_, true, _) => LayoutOp::FocusCycle { from: from.clone(), delta: 1 },
                (_, _, true) => LayoutOp::FocusCycle { from: from.clone(), delta: -1 },
                _ => LayoutOp::Focus { target: from.clone() },
            };
            let (layouts, _) = send(c, json, op).await?;
            if !json && let Some((_, t)) = tab_with(&layouts, &from) {
                println!("{}", t.focused);
            }
        }
        PaneCmd::Move { pane, to, dir } => {
            let op = LayoutOp::MovePane { pane: pane_ref(Some(&pane))?, to: pane_ref(Some(&to))?, side: dir.side().unwrap_or(Side::Right) };
            send(c, json, op).await?;
        }
        PaneCmd::Swap { a, b } => {
            send(c, json, LayoutOp::Swap { a: pane_ref(Some(&a))?, b: pane_ref(Some(&b))? }).await?;
        }
        PaneCmd::Zoom { target, on, off } => {
            let on = if on { Some(true) } else if off { Some(false) } else { None };
            send(c, json, LayoutOp::Zoom { target: pane_ref(target.as_deref())?, on }).await?;
        }
        PaneCmd::Equalize { target } => {
            send(c, json, LayoutOp::Equalize { tab: TabRef::Pane(pane_ref(target.as_deref())?) }).await?;
        }
        PaneCmd::Break { target, workspace: w, index } => {
            let pane = pane_ref(target.as_deref())?;
            let w = match w {
                Some(w) => Some(workspace(c, Some(&w)).await?),
                None => None,
            };
            let (layouts, _) = send(c, json, LayoutOp::BreakPane { pane: pane.clone(), workspace: w, index }).await?;
            if !json && let Some((_, t)) = tab_with(&layouts, &pane) {
                println!("{}", t.id);
            }
        }
        PaneCmd::Close { target } => {
            send(c, json, LayoutOp::ClosePane { target: pane_ref(target.as_deref())? }).await?;
        }
        PaneCmd::Ls { workspace: w, all } => {
            let mut layouts = if all { c.layouts(None).await? } else { c.layouts(Some(workspace(c, w.as_deref()).await?)).await? };
            if json {
                return print_json(&layouts);
            }
            let sessions = c.list().await?;
            layouts.sort_by(|a, b| a.workspace.cmp(&b.workspace));
            for l in &layouts {
                if all {
                    println!("{}", tilde(&l.workspace));
                }
                for t in &l.tabs {
                    for p in panes(&t.root) {
                        let mark = |on: bool| if on { "*" } else { "" };
                        let (sid, cwd) = match p.session().and_then(|s| sessions.iter().find(|x| x.id == s)) {
                            Some(s) => (s.id.to_string(), tilde(&s.cwd)),
                            None => ("-".to_string(), String::new()),
                        };
                        println!(
                            "{}{:<6} {:<5} {:>4}  {:<24}  {}",
                            if all { "  " } else { "" },
                            format!("{}{}", p.id, mark(t.focused == p.id)),
                            format!("{}{}", t.id, mark(l.active_tab == Some(t.id))),
                            sid,
                            pane_title(p, &sessions),
                            cwd
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn tab(c: &Client, args: TabArgs) -> Res<()> {
    let json = args.json;
    match args.cmd {
        TabCmd::New { title, workspace: w, cwd, index, no_focus, command } => {
            let ws = workspace(c, w.as_deref()).await?;
            let op = LayoutOp::NewTab { workspace: ws, spawn: spawn(cwd, &command)?, index, focus: !no_focus, title, doc: None };
            let (layouts, created) = send(c, json, op).await?;
            if !json && let Some(p) = created.first() {
                let tab = tab_with(&layouts, &PaneRef::Id(*p)).map(|(_, t)| t.id.to_string()).unwrap_or_default();
                println!("{tab} {}", pane_and_session(&layouts, *p));
            }
        }
        TabCmd::Select { tab } => {
            send(c, json, LayoutOp::SelectTab { tab: tab_ref(tab.as_deref())? }).await?;
        }
        TabCmd::Close { tab } => {
            send(c, json, LayoutOp::CloseTab { tab: tab_ref(tab.as_deref())? }).await?;
        }
        TabCmd::Rename { tab, title } => {
            send(c, json, LayoutOp::RenameTab { tab: tab_ref(Some(&tab))?, title }).await?;
        }
        TabCmd::Move { tab, index, workspace: w } => {
            let w = match w {
                Some(w) => Some(workspace(c, Some(&w)).await?),
                None => None,
            };
            send(c, json, LayoutOp::MoveTab { tab: tab_ref(Some(&tab))?, workspace: w, index }).await?;
        }
        TabCmd::Join { tab, to, dir } => {
            let op = LayoutOp::JoinTab { tab: tab_ref(Some(&tab))?, to: pane_ref(Some(&to))?, side: dir.side().unwrap_or(Side::Right) };
            send(c, json, op).await?;
        }
        TabCmd::Ls { workspace: w } => {
            let ws = workspace(c, w.as_deref()).await?;
            let layout = c.layouts(Some(ws)).await?.into_iter().next();
            if json {
                return print_json(&layout.map(|l| l.tabs).unwrap_or_default());
            }
            let Some(l) = layout else { return Ok(()) };
            let sessions = c.list().await?;
            for t in &l.tabs {
                let title = t.title.clone().unwrap_or_else(|| panes(&t.root).into_iter().find(|p| p.id == t.focused).map(|p| pane_title(p, &sessions)).unwrap_or_default());
                let id = format!("{}{}", t.id, if l.active_tab == Some(t.id) { "*" } else { "" });
                println!("{id:<6} {title:<24}  {}", dsl::print(&t.root, &|_| String::new()));
            }
        }
    }
    Ok(())
}

pub async fn layout(c: &Client, args: LayoutArgs) -> Res<()> {
    let json = args.json;
    match args.cmd {
        LayoutCmd::Show { workspace: w, tab } => {
            let layouts = c.layouts(None).await?;
            let found = match (&tab, &w) {
                (Some(t), _) => match tab_ref(Some(t))? {
                    TabRef::Id(id) => layouts.iter().flat_map(|l| &l.tabs).find(|x| x.id == id),
                    TabRef::Pane(p) => tab_with(&layouts, &p).map(|(_, t)| t),
                    TabRef::Active(_) => None,
                },
                (None, None) if this_session().is_ok() => tab_with(&layouts, &PaneRef::Session(this_session()?)).map(|(_, t)| t),
                _ => {
                    let ws = workspace(c, w.as_deref()).await?;
                    layouts.iter().find(|l| l.workspace == ws).and_then(|l| l.tabs.iter().find(|t| Some(t.id) == l.active_tab))
                }
            };
            let t = found.ok_or("보일 탭이 없다")?;
            if json {
                return print_json(t);
            }
            let sessions = c.list().await?;
            println!("{}", dsl::print(&t.root, &|p| pane_title(p, &sessions)));
        }
        LayoutCmd::Apply { spec, workspace: w, tab, no_focus } => {
            let parsed = dsl::parse(&spec)?;
            let ws = workspace(c, w.as_deref()).await?;
            let tab = tab.as_deref().map(|t| tab_ref(Some(t))).transpose()?;
            let first_ref = first_pane_ref(&parsed);
            let (layouts, created) = send(c, json, LayoutOp::Apply { workspace: ws, tab, spec: parsed, focus: !no_focus }).await?;
            if !json {
                let key = created.first().map(|p| PaneRef::Id(*p)).or(first_ref);
                if let Some((_, t)) = key.and_then(|k| tab_with(&layouts, &k)) {
                    panes(&t.root).iter().for_each(|p| println!("{}", pane_and_session(&layouts, p.id)));
                }
            }
        }
    }
    Ok(())
}

fn first_pane_ref(s: &LayoutSpec) -> Option<PaneRef> {
    match s {
        LayoutSpec::Pane { pane } => Some(pane.clone()),
        LayoutSpec::Split { children, .. } => children.iter().find_map(first_pane_ref),
        LayoutSpec::Spawn { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_targets() {
        assert_eq!(pane_ref(Some("p7")).unwrap(), PaneRef::Id(PaneId(7)));
        assert!(pane_ref(Some("t7")).is_err());
        assert_eq!(tab_ref(Some("t3")).unwrap(), TabRef::Id(TabId(3)));
        assert_eq!(tab_ref(Some("p2")).unwrap(), TabRef::Pane(PaneRef::Id(PaneId(2))));
    }

    #[test]
    fn prints_pane_with_session() {
        let pane = |id, content| PaneNode::Pane { pane: Pane { id: PaneId(id), content } };
        let root = PaneNode::Split {
            axis: Axis::Row,
            children: vec![pane(7, PaneContent::Terminal { session: SessionId(12) }), pane(8, PaneContent::Doc { doc: Default::default() })],
            sizes: vec![0.5, 0.5],
        };
        let tab = Tab { id: TabId(3), title: None, root, focused: PaneId(7), zoomed: None };
        let layouts = [WorkspaceLayout { workspace: "other".into(), tabs: vec![tab], active_tab: Some(TabId(3)) }];
        assert_eq!(pane_and_session(&layouts, PaneId(7)), "p7 s12");
        assert_eq!(pane_and_session(&layouts, PaneId(8)), "p8 -");
        assert_eq!(session_in(&layouts, PaneId(9)), None);
    }

    #[test]
    fn joins_command_words_for_the_shell() {
        let words = |w: &[&str]| w.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(shell_line(&words(&["npm run dev"])).as_deref(), Some("npm run dev"));
        assert_eq!(shell_line(&words(&["echo", "a b", "it's"])).as_deref(), Some(r"echo 'a b' 'it'\''s'"));
        assert_eq!(shell_line(&[]), None);
    }
}
