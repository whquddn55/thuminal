//! JSON 메시지.
//!
//! 클라이언트는 [`ClientMessage::Request`] 를 보내고 같은 `id` 의
//! [`ServerMessage::Response`] 를 받는다. 데몬은 요청과 상관없이
//! [`ServerMessage::Event`] 를 보낼 수 있다.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::frame::FrameError;
use crate::layout::{LayoutOp, PaneId, TerminalColors, WorkspaceLayout};

/// 데몬 안에서 세션을 가리키는 번호. 데몬이 뜰 때마다 1 부터 센다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub u64);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 붙을 때 받을 화면 저장본 형식.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum SnapshotFormat {
    /// 데몬 엔진 고유 형식. 클라이언트가 같은 엔진을 쓸 때만 쓴다.
    Native = 0,
    /// 화면과 스크롤백을 다시 그리는 제어 코드. 어떤 엔진이든 먹는다.
    Vt = 1,
}

impl TryFrom<u8> for SnapshotFormat {
    type Error = FrameError;
    fn try_from(v: u8) -> Result<Self, FrameError> {
        match v {
            0 => Ok(Self::Native),
            1 => Ok(Self::Vt),
            other => Err(FrameError::UnknownSnapshotFormat(other)),
        }
    }
}

/// 화면 읽기 형식.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScreenFormat {
    /// 글자만
    #[default]
    Plain,
    /// 색과 모양을 담은 제어 코드
    Vt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum SessionState {
    Running,
    Exited { code: Option<i32> },
}

/// 세션 정보. `labels` 는 데몬이 뜻을 모르는 꼬리표다.
/// 앱은 여기에 워크트리, 탭 같은 자기 정보를 넣어 두고 다시 붙을 때 찾는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    /// 셸이 OSC 0/2 로 정한 제목. 없으면 명령 이름.
    pub title: String,
    /// 셸이 OSC 7 로 알린 작업 폴더. 없으면 시작 폴더.
    pub cwd: String,
    pub command: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    pub state: SessionState,
    /// 유닉스 시간 ms
    pub created_at: u64,
    /// 마지막으로 출력이 온 때 (유닉스 시간 ms). `wait --idle` 이 쓴다.
    pub last_output_at: u64,
    /// 지금 붙어 있는 클라이언트 수
    pub attached: u32,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    /// 이 세션 안에서 도는 에이전트 (claude 등). 훅이 알려 준다
    #[serde(default)]
    pub agent: Option<AgentInfo>,
    /// 재부팅 등으로 데몬이 다시 뜰 때 되살린 세션이면, 이전 데몬에서의 번호
    #[serde(default)]
    pub restored_from: Option<SessionId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    /// 사용자 입력을 기다린다 (막 시작했거나 응답을 마쳤다)
    Idle,
    /// 일하는 중
    Working,
    /// 권한 확인 등 사용자를 부르고 있다
    NeedsAttention,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentInfo {
    /// 에이전트 종류 (예: claude)
    pub kind: String,
    /// 에이전트 자기 세션 id. 재부팅 뒤 `claude --resume <id>` 에 쓴다
    pub session_id: Option<String>,
    pub transcript: Option<String>,
    pub state: AgentState,
    /// 유닉스 시간 ms
    pub updated_at: u64,
}

/// 등록한 git 저장소
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoInfo {
    /// 경로에서 만든 짧은 id
    pub id: String,
    pub name: String,
    /// 메인 워크트리 경로
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub repo: String,
    pub path: String,
    /// 브랜치 이름 (detached 면 None)
    pub branch: Option<String>,
    pub head: String,
    /// 저장소를 처음 만든 메인 워크트리인지
    pub is_main: bool,
    /// 사용자가 붙인 이름 (없으면 브랜치 이름으로 보인다)
    #[serde(default)]
    pub name: Option<String>,
    /// 프로젝트 맨 위에 고정
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

/// 바뀐 파일 하나. `staged` 는 스테이지된 변경, `unstaged` 는 작업 폴더의 변경
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    /// 워크트리 기준 상대 경로
    pub path: String,
    /// 이름이 바뀌었으면 이전 경로
    pub orig_path: Option<String>,
    pub staged: Option<ChangeKind>,
    pub unstaged: Option<ChangeKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct BranchList {
    pub local: Vec<String>,
    /// `origin/main` 꼴
    pub remote: Vec<String>,
    pub current: Option<String>,
    /// 원격의 기본 브랜치 (`origin/HEAD` 가 가리키는 것)
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    /// git 이 무시하는 파일 (.gitignore)
    #[serde(default)]
    pub ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileContent {
    /// 글자 파일이면 내용 (너무 크면 앞부분만)
    pub text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
}

/// 세션 꼬리표 중 워크트리 경로를 담는 키. 데몬이 세션을 만들 때 시작 폴더로 채운다
pub const WORKTREE_LABEL: &str = "worktree";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CreateSession {
    /// 비우면 사용자 로그인 셸
    #[serde(default)]
    pub command: Vec<String>,
    /// 비우면 사용자 홈
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum Request {
    /// 붙자마자 처음 보낸다. 주 버전이 다르면 데몬이 오류로 답하고 끊는다.
    Hello { protocol_major: u32, protocol_minor: u32, client: String },
    Status,
    CreateSession(CreateSession),
    ListSessions,
    /// 저장본(Snapshot 프레임) → `Attached` 응답 → 출력(Output 프레임) 순서로 온다.
    Attach { session: SessionId, snapshot: SnapshotFormat },
    Detach { session: SessionId },
    Resize { session: SessionId, cols: u16, rows: u16 },
    /// 글자로 입력을 보낸다 (CLI 용). 바이트는 Input 프레임으로 보낸다.
    SendText { session: SessionId, text: String },
    ReadScreen {
        session: SessionId,
        #[serde(default)]
        format: ScreenFormat,
        /// 스크롤백까지 포함할지
        #[serde(default)]
        scrollback: bool,
    },
    SetLabels { session: SessionId, labels: BTreeMap<String, String> },
    /// 에이전트 훅이 보내는 알림. `event` 는 훅 이름 (SessionStart, UserPromptSubmit, Stop, Notification, SessionEnd)
    ReportAgent {
        session: SessionId,
        kind: String,
        event: String,
        #[serde(default)]
        agent_session_id: Option<String>,
        #[serde(default)]
        transcript: Option<String>,
    },
    Kill { session: SessionId },
    /// 끝난 세션을 목록에서 지운다
    Remove { session: SessionId },
    /// 모든 세션을 끝내고 데몬을 내린다
    Shutdown,
    ListRepos,
    /// 경로가 든 git 저장소를 등록한다 (워크트리 안의 경로여도 메인 저장소를 찾는다)
    AddRepo { path: String },
    RemoveRepo { repo: String },
    /// 폴더가 git 저장소가 아니면 바로 아래 폴더들에서 저장소를 찾아 모두 등록한다
    AddRepos { path: String },
    /// `repo` 를 비우면 모든 저장소
    ListWorktrees {
        #[serde(default)]
        repo: Option<String>,
    },
    /// 새 브랜치로 저장소 옆 폴더에 워크트리를 만든다. `base` 를 비우면 지금 HEAD
    CreateWorktree {
        repo: String,
        branch: String,
        #[serde(default)]
        base: Option<String>,
        /// 사용자가 붙인 이름
        #[serde(default)]
        name: Option<String>,
    },
    /// 워크트리 이름이나 고정을 바꾼다 (None 이면 그대로 둔다. 이름을 빈 글로 주면 지운다)
    UpdateWorktree {
        path: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        pinned: Option<bool>,
    },
    GitStatus { worktree: String },
    /// 파일 하나의 diff. `staged` 면 스테이지된 변경, 아니면 작업 폴더 변경 (새 파일 포함)
    GitDiff {
        worktree: String,
        file: String,
        #[serde(default)]
        staged: bool,
    },
    GitStage { worktree: String, files: Vec<String> },
    GitUnstage { worktree: String, files: Vec<String> },
    /// 작업 폴더 변경을 버린다 (새 파일은 지운다)
    GitDiscard { worktree: String, files: Vec<String> },
    GitCommit {
        worktree: String,
        message: String,
        /// 스테이지된 것이 없으면 바뀐 파일을 모두 담는다
        #[serde(default)]
        all: bool,
    },
    GitPush { worktree: String },
    ListBranches { repo: String },
    /// 워크트리 안 폴더 목록. `dir` 은 워크트리 기준 상대 경로 (빈 글이면 맨 위)
    ListDir {
        worktree: String,
        #[serde(default)]
        dir: String,
    },
    ReadFile { worktree: String, file: String },
    RemoveWorktree {
        repo: String,
        path: String,
        #[serde(default)]
        force: bool,
        #[serde(default)]
        delete_branch: bool,
    },
    /// workspace 를 비우면 모든 workspace 배치
    GetLayout {
        #[serde(default)]
        workspace: Option<String>,
    },
    /// 배치를 바꾸는 요청 하나. 결과는 바뀐 workspace 배치(들)와 새로 만든 칸 id
    Layout { op: LayoutOp },
    /// 여러 op 를 순서대로. 하나라도 실패하면 그 앞까지는 반영되고 오류를 돌려준다 (오류 메시지에 몇 번째인지)
    LayoutBatch { ops: Vec<LayoutOp> },
    /// 모든 세션 엔진과 앞으로 만들 엔진의 기본색을 바꾼다
    SetTerminalColors { colors: TerminalColors },
    GetTerminalColors,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum Response {
    Hello { daemon_version: String, protocol_major: u32, protocol_minor: u32, pid: u32, engine: String },
    Status { daemon_version: String, pid: u32, started_at: u64, sessions: usize, engine: String },
    Session { session: SessionInfo },
    Sessions { sessions: Vec<SessionInfo> },
    Attached { session: SessionInfo },
    Screen { text: String },
    Repos { repos: Vec<RepoInfo> },
    Repo { repo: RepoInfo },
    Text { text: String },
    GitStatus { status: GitStatus },
    Branches { branches: BranchList },
    Dir { entries: Vec<DirEntry> },
    File { file: FileContent },
    Worktrees { worktrees: Vec<WorktreeInfo> },
    Worktree { worktree: WorktreeInfo },
    Layouts { layouts: Vec<WorkspaceLayout> },
    LayoutResult { layouts: Vec<WorkspaceLayout>, created: Vec<PaneId> },
    TerminalColors { colors: Option<TerminalColors> },
    Ok,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum Event {
    SessionCreated { session: SessionInfo },
    /// 제목, 작업 폴더, 크기, 꼬리표가 바뀌었다
    SessionUpdated { session: SessionInfo },
    SessionExited { session: SessionId, code: Option<i32> },
    SessionRemoved { session: SessionId },
    /// 저장소나 워크트리 목록이 바뀌었다. 다시 읽는다
    WorkspaceChanged,
    /// 이 워크트리의 git 상태가 바뀌었다 (스테이지, 커밋, 푸시 등)
    GitChanged { worktree: String },
    /// 이 workspace 배치가 바뀌었다 (전체를 보낸다. 앱은 통째로 바꿔 끼운다)
    LayoutChanged { layout: WorkspaceLayout },
    /// workspace 배치가 없어졌다
    LayoutRemoved { workspace: String },
    TerminalColorsChanged { colors: TerminalColors },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    VersionMismatch,
    NotFound,
    InvalidRequest,
    SpawnFailed,
    Vcs,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ClientMessage {
    Request { id: u64, request: Request },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ServerMessage {
    Response {
        id: u64,
        #[serde(flatten)]
        result: ResponseResult,
    },
    Event { event: Event },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseResult {
    Ok(Response),
    Err(ErrorBody),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shape_is_stable() {
        let m = ClientMessage::Request { id: 3, request: Request::Attach { session: SessionId(2), snapshot: SnapshotFormat::Vt } };
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"kind":"request","id":3,"request":{"type":"attach","session":2,"snapshot":"vt"}}"#
        );
        let r = ServerMessage::Response { id: 3, result: ResponseResult::Err(ErrorBody { code: ErrorCode::NotFound, message: "x".into() }) };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(s, r#"{"kind":"response","id":3,"err":{"code":"not_found","message":"x"}}"#);
        assert_eq!(serde_json::from_str::<ServerMessage>(&s).unwrap(), r);
    }
}
