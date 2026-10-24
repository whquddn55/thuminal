//! 배치: workspace 마다 탭, 탭마다 칸 트리 (tmux 식). 터미널 색.
//!
//! 배치의 주인은 데몬이다. 앱과 CLI 는 [`LayoutOp`] 를 보내고 바뀐 배치를
//! `layout_changed` 이벤트로 받는다. 트리를 바꾸는 규칙은 `thuminal-layout` 크레이트에 있다.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::SessionId;

/// 칸 번호. 데몬 전체에서 하나씩 늘어나고, 데몬이 다시 떠도 이어 센다. CLI 는 `p7` 로 쓴다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PaneId(pub u64);

/// 탭 번호. CLI 는 `t3` 로 쓴다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TabId(pub u64);

impl std::fmt::Display for PaneId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "p{}", self.0)
    }
}

impl std::fmt::Display for TabId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "t{}", self.0)
    }
}

/// 플로팅 워크스페이스
pub const FLOATING_WORKSPACE: &str = "floating";
/// 워크트리 밖 세션
pub const OTHER_WORKSPACE: &str = "other";
/// 이 꼬리표가 있는 세션은 플로팅 워크스페이스에 들어간다
pub const FLOATING_LABEL: &str = "floating";
/// 꼬리표 `layout=none` 이 있으면 데몬이 칸에 넣지 않는다 (내부용 세션)
pub const LAYOUT_LABEL: &str = "layout";

/// `"row"` 는 좌우로 늘어놓고(세로 구분선), `"column"` 은 위아래로 늘어놓는다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    Row,
    Column,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Left,
    Right,
    Up,
    Down,
}

impl Side {
    /// 이 방향으로 붙이면 생기는 분할의 축
    pub fn axis(self) -> Axis {
        match self {
            Side::Left | Side::Right => Axis::Row,
            Side::Up | Side::Down => Axis::Column,
        }
    }

    /// 새 칸이 대상 칸 앞(왼쪽, 위)에 오는지
    pub fn before(self) -> bool {
        matches!(self, Side::Left | Side::Up)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PaneContent {
    Terminal { session: SessionId },
    /// 앱이 그리는 문서(diff, 파일 보기). 데몬은 뜻을 모른다
    Doc { doc: BTreeMap<String, String> },
}

/// JSON: `{"id":7,"type":"terminal","session":12}`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pane {
    pub id: PaneId,
    #[serde(flatten)]
    pub content: PaneContent,
}

impl Pane {
    pub fn session(&self) -> Option<SessionId> {
        match &self.content {
            PaneContent::Terminal { session } => Some(*session),
            PaneContent::Doc { .. } => None,
        }
    }
}

/// 분할은 n갈래(`children` 2개 이상)이고 `sizes` 는 children 과 같은 길이의 비율(합 1.0)이다
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PaneNode {
    Split { axis: Axis, children: Vec<PaneNode>, sizes: Vec<f32> },
    Pane { pane: Pane },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tab {
    pub id: TabId,
    /// 사용자가 붙인 이름 (없으면 앱이 포커스 칸 세션 제목을 보인다)
    pub title: Option<String>,
    pub root: PaneNode,
    /// 이 탭에서 포커스된 칸 (항상 이 탭 안의 칸)
    pub focused: PaneId,
    /// 펼친(zoom) 칸. 있으면 이 칸만 탭 전체에 보인다
    pub zoomed: Option<PaneId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceLayout {
    /// 워크트리 절대 경로, `"floating"`, `"other"`
    pub workspace: String,
    /// 탭 줄 순서
    pub tabs: Vec<Tab>,
    pub active_tab: Option<TabId>,
}

/// 새 터미널 세션 만들기
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Spawn {
    /// 비우면 로그인 셸. 셸 안에서 칠 명령은 `input` 으로 준다 (셸 함수 claude 가 훅과 함께 뜨게)
    #[serde(default)]
    pub command: Vec<String>,
    /// 셸이 뜬 뒤 입력할 글. 끝에 Enter(\r)를 데몬이 붙인다. 예: "claude", "npm run dev"
    #[serde(default)]
    pub input: Option<String>,
    /// 비우면: 대상 칸 세션의 지금 작업 폴더 → 없으면 workspace 경로(워크트리) → 홈
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "by", content = "value")]
pub enum PaneRef {
    /// `{"by":"id","value":7}`
    Id(PaneId),
    /// 그 세션이 든 칸 (CLI 의 `.`)
    Session(SessionId),
    /// workspace 의 활성 탭에서 포커스된 칸
    Focused(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "by", content = "value")]
pub enum TabRef {
    Id(TabId),
    /// 이 칸이 든 탭
    Pane(PaneRef),
    /// workspace 의 활성 탭
    Active(String),
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "op")]
pub enum LayoutOp {
    /// 새 탭(터미널 하나). index 를 비우면 끝. focus 면 활성 탭으로. title 을 주면 탭 이름
    NewTab {
        workspace: String,
        #[serde(default)]
        spawn: Spawn,
        #[serde(default)]
        index: Option<usize>,
        #[serde(default = "yes")]
        focus: bool,
        #[serde(default)]
        title: Option<String>,
    },
    /// 문서 칸을 새 탭으로 연다 (같은 doc 이 이미 있으면 그 칸으로 포커스만)
    OpenDoc { workspace: String, doc: BTreeMap<String, String> },
    /// 대상 칸 옆에 새 터미널 칸. size 는 새 칸이 차지할 비율(0.05~0.95, 기본 0.5)
    Split {
        target: PaneRef,
        side: Side,
        #[serde(default)]
        size: Option<f32>,
        #[serde(default)]
        spawn: Spawn,
        #[serde(default = "yes")]
        focus: bool,
    },
    /// 칸 크기: 칸이 든 분할에서 이 칸 몫을 정한다. 형제들은 원래 비율대로 나머지를 나눈다.
    /// axis 를 주면 그 축의 가장 가까운 조상 분할을 고른다 (없으면 가장 가까운 분할)
    Resize {
        target: PaneRef,
        size: f32,
        #[serde(default)]
        axis: Option<Axis>,
    },
    /// 상대 크기: delta(+0.1 = 10%p 늘림)
    ResizeBy {
        target: PaneRef,
        delta: f32,
        #[serde(default)]
        axis: Option<Axis>,
    },
    /// 앱 구분선 끌기: 탭의 분할 노드를 경로(루트부터 children 인덱스)로 가리켜 sizes 를 통째로 바꾼다
    SetSizes { tab: TabId, path: Vec<usize>, sizes: Vec<f32> },
    /// 탭의 모든 분할을 균등하게
    Equalize { tab: TabRef },
    Focus { target: PaneRef },
    /// 화면 위치 기준으로 옆 칸에 포커스 (from 칸의 가운데에서 그 방향으로 가장 가까운 칸)
    FocusDir { from: PaneRef, side: Side },
    /// 탭 안 칸 순서대로 다음/이전 (delta = +1 / -1, 끝에서 돈다)
    FocusCycle { from: PaneRef, delta: i32 },
    /// 펼치기 켜고 끄기. on 을 비우면 뒤집는다
    Zoom {
        target: PaneRef,
        #[serde(default)]
        on: Option<bool>,
    },
    /// 칸 하나를 다른 칸 옆으로 옮긴다 (다른 탭, 다른 workspace 도 된다). 원래 탭이 비면 지운다
    MovePane { pane: PaneRef, to: PaneRef, side: Side },
    /// 두 칸 자리를 맞바꾼다
    Swap { a: PaneRef, b: PaneRef },
    /// 칸을 떼어 새 탭으로 (탭 줄에 놓기). workspace 를 비우면 같은 workspace, index 를 비우면 끝
    BreakPane {
        pane: PaneRef,
        #[serde(default)]
        workspace: Option<String>,
        #[serde(default)]
        index: Option<usize>,
    },
    /// 탭 전체를 다른 칸 옆으로 합친다 (탭을 칸 가장자리로 끌어 놓기). 탭의 칸 트리가 통째로 들어간다
    JoinTab { tab: TabRef, to: PaneRef, side: Side },
    /// 탭 순서 바꾸기 / 다른 workspace 로 옮기기
    MoveTab {
        tab: TabRef,
        #[serde(default)]
        workspace: Option<String>,
        index: usize,
    },
    SelectTab { tab: TabRef },
    RenameTab {
        tab: TabRef,
        #[serde(default)]
        title: Option<String>,
    },
    /// 칸 닫기 (터미널이면 세션을 끝내고 지운다)
    ClosePane { target: PaneRef },
    CloseTab { tab: TabRef },
    /// 선언형 배치. tab 을 주면 그 탭의 칸 트리를 spec 으로 바꾸고, 비우면 새 탭을 만든다.
    /// spec 에 나오지 않은 그 탭의 옛 칸은 닫지 않고 각자 새 탭으로 떼어 낸다 (실수로 터미널을 잃지 않게)
    Apply {
        workspace: String,
        #[serde(default)]
        tab: Option<TabRef>,
        spec: LayoutSpec,
        #[serde(default = "yes")]
        focus: bool,
    },
}

impl LayoutOp {
    /// 로그에 남기는 op 이름
    pub fn kind(&self) -> &'static str {
        match self {
            LayoutOp::NewTab { .. } => "new_tab",
            LayoutOp::OpenDoc { .. } => "open_doc",
            LayoutOp::Split { .. } => "split",
            LayoutOp::Resize { .. } => "resize",
            LayoutOp::ResizeBy { .. } => "resize_by",
            LayoutOp::SetSizes { .. } => "set_sizes",
            LayoutOp::Equalize { .. } => "equalize",
            LayoutOp::Focus { .. } => "focus",
            LayoutOp::FocusDir { .. } => "focus_dir",
            LayoutOp::FocusCycle { .. } => "focus_cycle",
            LayoutOp::Zoom { .. } => "zoom",
            LayoutOp::MovePane { .. } => "move_pane",
            LayoutOp::Swap { .. } => "swap",
            LayoutOp::BreakPane { .. } => "break_pane",
            LayoutOp::JoinTab { .. } => "join_tab",
            LayoutOp::MoveTab { .. } => "move_tab",
            LayoutOp::SelectTab { .. } => "select_tab",
            LayoutOp::RenameTab { .. } => "rename_tab",
            LayoutOp::ClosePane { .. } => "close_pane",
            LayoutOp::CloseTab { .. } => "close_tab",
            LayoutOp::Apply { .. } => "apply",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum LayoutSpec {
    Split {
        axis: Axis,
        children: Vec<LayoutSpec>,
        #[serde(default)]
        sizes: Option<Vec<f32>>,
    },
    /// 이미 있는 칸을 이 자리로 옮긴다
    Pane { pane: PaneRef },
    /// 새 터미널
    Spawn {
        #[serde(default)]
        spawn: Spawn,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorScheme {
    Dark,
    Light,
}

/// 터미널 기본색. 데몬 엔진이 프로그램의 색 질의(OSC 4/10/11/12)에 이 색으로 답한다
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalColors {
    /// 0xRRGGBB
    pub foreground: u32,
    pub background: u32,
    pub cursor: Option<u32>,
    /// 0~15 (16개) 또는 0~255 (256개). 16개면 16~255 는 엔진 기본을 쓴다
    pub palette: Vec<u32>,
    pub scheme: ColorScheme,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shapes_match_contract() {
        let pane = Pane { id: PaneId(7), content: PaneContent::Terminal { session: SessionId(12) } };
        assert_eq!(serde_json::to_string(&pane).unwrap(), r#"{"id":7,"type":"terminal","session":12}"#);
        let doc = Pane { id: PaneId(8), content: PaneContent::Doc { doc: [("kind".to_string(), "diff".to_string())].into() } };
        let s = serde_json::to_string(&doc).unwrap();
        assert_eq!(s, r#"{"id":8,"type":"doc","doc":{"kind":"diff"}}"#);
        assert_eq!(serde_json::from_str::<Pane>(&s).unwrap(), doc);

        let node = PaneNode::Split { axis: Axis::Row, children: vec![PaneNode::Pane { pane }], sizes: vec![1.0] };
        assert_eq!(
            serde_json::to_string(&node).unwrap(),
            r#"{"type":"split","axis":"row","children":[{"type":"pane","pane":{"id":7,"type":"terminal","session":12}}],"sizes":[1.0]}"#
        );

        let r = TabRef::Pane(PaneRef::Session(SessionId(12)));
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"by":"pane","value":{"by":"session","value":12}}"#);
        assert_eq!(serde_json::to_string(&PaneRef::Focused("/w".into())).unwrap(), r#"{"by":"focused","value":"/w"}"#);

        // 빠진 필드는 기본값 (focus 는 true)
        let op: LayoutOp = serde_json::from_str(r#"{"op":"split","target":{"by":"id","value":1},"side":"down"}"#).unwrap();
        assert_eq!(
            op,
            LayoutOp::Split { target: PaneRef::Id(PaneId(1)), side: Side::Down, size: None, spawn: Spawn::default(), focus: true }
        );
        let spec: LayoutSpec = serde_json::from_str(r#"{"type":"split","axis":"column","children":[{"type":"spawn"}]}"#).unwrap();
        assert_eq!(spec, LayoutSpec::Split { axis: Axis::Column, children: vec![LayoutSpec::Spawn { spawn: Spawn::default() }], sizes: None });
    }
}
