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

/// 세션 밑에서 찾은 에이전트 프로세스
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningAgent {
    pub session: SessionId,
    pub name: String,
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
    /// 마지막으로 BEL(0x07)이 온 때 (유닉스 시간 ms, 없으면 0). 세션마다 1초에 한 번까지만 바뀐다
    #[serde(default)]
    pub bell_at: u64,
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
    /// 턴이 오류로 끝났다 (StopFailure). 다음 프롬프트까지 남는다
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentInfo {
    /// 에이전트 종류 (예: claude)
    pub kind: String,
    /// 에이전트 자기 세션 id. 재부팅 뒤 `claude --resume <id>` 에 쓴다
    pub session_id: Option<String>,
    pub transcript: Option<String>,
    pub state: AgentState,
    /// 상태가 마지막으로 바뀐 때 (유닉스 시간 ms)
    pub updated_at: u64,
    /// 마지막 사용자 프롬프트 (UserPromptSubmit 의 `prompt`, [`AGENT_TEXT_MAX`] 글자까지)
    #[serde(default)]
    pub prompt: Option<String>,
    /// 마지막 답 (Stop 의 `last_assistant_message`, 없으면 transcript 끝에서 읽은 것. [`AGENT_TEXT_MAX`] 글자까지)
    #[serde(default)]
    pub last_assistant_message: Option<String>,
    /// 지금 쓰는(또는 막 쓴) 도구 이름 (PreToolUse 등의 `tool_name`). 턴이 끝나면 비운다
    #[serde(default)]
    pub tool_name: Option<String>,
    /// 모델 (SessionStart 의 `model`)
    #[serde(default)]
    pub model: Option<String>,
    /// 일하던 턴이 Stop 으로 끝난 때 (유닉스 시간 ms). 새 프롬프트나 새 세션이면 비운다.
    /// 이것이 있고 state 가 idle 이면 "끝남", 없이 idle 이면 막 시작해 기다리는 중이다
    #[serde(default)]
    pub turn_ended_at: Option<u64>,
    /// 에이전트가 도는 폴더 (훅 JSON 의 `cwd`). 되살릴 때 이 폴더에서 `--resume` 한다
    #[serde(default)]
    pub cwd: Option<String>,
    /// 사용자가 Esc · ⌃C 로 턴을 멈췄다 (데몬이 추론한다. 훅은 멈춤을 알리지 않는다). 다음 프롬프트에서 지운다
    #[serde(default)]
    pub interrupted: bool,
    /// 이 대화 기록에서 사용자가 붙여 보낸 그림 수 (데몬이 기록을 읽어 센다. 기록이 바뀌면 0 부터)
    #[serde(default)]
    pub image_count: u32,
}

/// 에이전트 대화 기록에서 사용자가 붙여 보낸 그림 하나 (`AgentImages`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentImage {
    /// 기록 안 자리 (`<줄 바이트 위치>:<줄 안 차례>`). 그림을 받을 때 쓴다
    pub id: String,
    /// 대화에 `[Image #N]` 으로 남은 번호
    pub n: u32,
    /// `image/png`, `image/jpeg` …
    pub media_type: String,
    /// 원본 크기 (px). 머리를 읽지 못하면 0
    pub width: u32,
    pub height: u32,
    /// 원본 바이트 수
    pub bytes: u64,
    /// 보낸 때 (유닉스 시간 ms, 모르면 0)
    pub at: u64,
}

/// 에이전트 글 필드(프롬프트, 마지막 답)를 이 글자 수까지 남긴다
pub const AGENT_TEXT_MAX: usize = 200;

/// 앞뒤 공백을 지우고 `max` 글자까지 자른다 (자르면 끝에 `…`). 비면 None
pub fn clip_text(s: &str, max: usize) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    match s.char_indices().nth(max) {
        Some((i, _)) => Some(format!("{}…", s[..i].trim_end())),
        None => Some(s.to_string()),
    }
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

/// 기본 워크스페이스의 id. 지울 수 없고, 다른 워크스페이스에 넣지 않은 프로젝트가 여기 든다
pub const DEFAULT_GROUP: &str = "default";

/// 사이드바 워크스페이스: 프로젝트(저장소) 묶음. 목록 차례가 사이드바 차례다.
/// (코드의 `workspace` 는 워크트리 경로·floating·other 를 뜻하므로 묶음은 `group` 이라 부른다)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoGroup {
    /// 기본은 [`DEFAULT_GROUP`]. `set_groups` 에 빈 글로 주면 데몬이 새 id 를 붙인다
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// 든 프로젝트(저장소 id), 사이드바 차례
    #[serde(default)]
    pub repos: Vec<String>,
}

/// 저장소 안에서 찾은 아이콘 그림 (`RepoIcon` 요청). 사이드바 프로젝트 머리에 그린다
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoIcon {
    /// `image/png` 또는 `image/webp` (파일 머리 바이트로 가른다)
    pub mime: String,
    /// 파일 내용 base64
    pub data: String,
    /// 저장소 기준 상대 경로
    pub file: String,
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
    /// 부모 워크트리 경로 (하위 워크트리면). 사이드바가 부모 카드 밑에 들여 그린다
    #[serde(default)]
    pub parent: Option<String>,
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

/// 파일 내용 찾기 결과 한 줄
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    /// 워크트리 기준 상대 경로
    pub path: String,
    /// 1 부터
    pub line: u32,
    /// 그 줄 (너무 길면 자른다)
    pub text: String,
}

/// 파일 하나의 바뀐 줄 수 (`git diff --numstat`). 바이너리면 None
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineCount {
    pub path: String,
    /// 스테이지된 변경의 줄 수인지 (아니면 작업 폴더 변경)
    pub staged: bool,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileContent {
    /// 글자 파일이면 내용 (너무 크면 앞부분만)
    pub text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
    /// 마지막으로 바뀐 때 (유닉스 밀리초). 고쳐 쓸 때 그사이 바뀌었는지 보는 데 쓴다. 옛 데몬은 보내지 않는다
    #[serde(default)]
    pub modified: Option<u64>,
}

/// 파일 바이트 한 조각 (`ReadFileBytes`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileBytes {
    /// base64
    pub data: String,
    /// 이 조각이 시작하는 자리
    pub offset: u64,
    /// 파일 전체 크기
    pub size: u64,
    pub modified: Option<u64>,
}

/// 세션 꼬리표 중 워크트리 경로를 담는 키. 데몬이 세션을 만들 때 시작 폴더로 채운다
pub const WORKTREE_LABEL: &str = "worktree";

/// 에이전트 팀원 세션 꼬리표. 팀원은 칸에 넣지 않고(`layout=none`) 리더 세션에 딸려 그린다
pub const TEAM_LEADER_LABEL: &str = "team.leader";
/// 팀원 이름 (claude 가 `select-pane -T` 로 붙인다)
pub const TEAM_NAME_LABEL: &str = "team.name";
/// 팀원 색 이름 (claude 가 tmux 색으로 준다: red, blue, colour208 …)
pub const TEAM_COLOR_LABEL: &str = "team.color";
/// claude 가 아는 팀원 칸 번호 (`%12`). 팀원을 다시 띄워 세션이 바뀌어도 그대로다
pub const TEAM_PANE_LABEL: &str = "team.pane";

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
    /// 에이전트 훅이 보내는 알림. `event` 는 훅 이름 (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
    /// PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SessionEnd).
    /// 나머지 필드는 훅 JSON 에서 그대로 옮긴 것이고 없으면 비운다
    ReportAgent {
        session: SessionId,
        kind: String,
        event: String,
        #[serde(default)]
        agent_session_id: Option<String>,
        #[serde(default)]
        transcript: Option<String>,
        /// UserPromptSubmit 의 `prompt`
        #[serde(default)]
        prompt: Option<String>,
        /// Stop 의 `last_assistant_message` (없으면 CLI 가 transcript 끝에서 읽는다)
        #[serde(default)]
        last_assistant_message: Option<String>,
        /// PreToolUse, PostToolUse, PermissionRequest 의 `tool_name`
        #[serde(default)]
        tool_name: Option<String>,
        /// Notification 의 `notification_type` (permission_prompt, elicitation_dialog, idle_prompt, auth_success …)
        #[serde(default)]
        notification_type: Option<String>,
        /// SessionStart 의 `source` (startup, resume, clear, compact)
        #[serde(default)]
        source: Option<String>,
        /// SessionStart 의 `model`
        #[serde(default)]
        model: Option<String>,
        /// 에이전트가 도는 폴더 (훅 JSON 의 `cwd`). 셸이 알린 폴더와 다를 수 있다 (`cd x && claude`)
        #[serde(default)]
        cwd: Option<String>,
    },
    Kill { session: SessionId },
    /// 끝난 세션을 목록에서 지운다
    Remove { session: SessionId },
    /// 모든 세션을 끝내고 데몬을 내린다
    Shutdown,
    ListRepos,
    /// 사이드바 워크스페이스 목록. 기본 워크스페이스가 늘 들어 있고, 프로젝트마다 꼭 한 워크스페이스에 든다
    ListGroups,
    /// 워크스페이스 목록을 통째로 바꾼다 (만들기·이름·차례·지우기·프로젝트 옮기기). 데몬이 고른 뒤 `groups` 로 돌려준다.
    /// 빠진 기본 워크스페이스는 다시 넣고, 어디에도 없는 프로젝트는 기본으로 보낸다
    SetGroups { groups: Vec<RepoGroup> },
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
        /// 부모 워크트리 경로 (하위 워크트리로 만든다)
        #[serde(default)]
        parent: Option<String>,
    },
    /// 워크트리 이름·고정·부모를 바꾼다 (None 이면 그대로 둔다. 이름·부모를 빈 글로 주면 지운다)
    UpdateWorktree {
        path: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        pinned: Option<bool>,
        #[serde(default)]
        parent: Option<String>,
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
    /// 저장소(id) 안의 흔한 자리(favicon, logo, Tauri 아이콘 …)에서 아이콘 그림을 찾는다. 없으면 None
    RepoIcon { repo: String },
    /// 워크트리 안 폴더 목록. `dir` 은 워크트리 기준 상대 경로 (빈 글이면 맨 위)
    ListDir {
        worktree: String,
        #[serde(default)]
        dir: String,
    },
    ReadFile { worktree: String, file: String },
    /// 파일 바이트를 `offset` 부터 `len` 만큼 (그림 · 영상). `len` 은 데몬이 `MAX_READ_BYTES` 로 줄인다 (minor 5)
    ReadFileBytes { worktree: String, file: String, offset: u64, len: u64 },
    /// 글자 파일을 통째로 쓴다. 답은 `File` (글은 빼고 새 크기 · 바뀐 때). `expect_modified` 를 주면
    /// 파일이 그때 그대로일 때만 쓰고, 그사이 바뀌었으면 `Conflict` 로 거절한다 (minor 5)
    WriteFile {
        worktree: String,
        file: String,
        text: String,
        #[serde(default)]
        expect_modified: Option<u64>,
    },
    /// 워크트리 안 파일 내용에서 글을 찾는다 (git grep, 무시하는 파일은 뺀다). 결과가 많으면 앞부분만
    SearchText {
        worktree: String,
        query: String,
        #[serde(default)]
        case_sensitive: bool,
    },
    /// 워크트리 안 파일 경로 전부 (추적 + 무시하지 않는 새 파일). 이름 거르기·빠른 열기에 쓴다
    ListFiles { worktree: String },
    /// 바뀐 파일마다 더하고 지운 줄 수
    GitLineCounts { worktree: String },
    /// 워크트리를 지운다. 답은 `Text`: 알릴 것(예: 브랜치를 남긴 까닭)이 있으면 그 글, 없으면 빈 글
    RemoveWorktree {
        repo: String,
        path: String,
        /// 바뀐 파일이 있어도 워크트리를 지운다 (`git worktree remove --force`). 브랜치에는 쓰지 않는다
        #[serde(default)]
        force: bool,
        #[serde(default)]
        delete_branch: bool,
        /// 합치지 않은 커밋이 있어도 브랜치를 지운다 (`git branch -D`). 아니면 `-d` 로 지우고, git 이 거절하면 남긴다
        #[serde(default)]
        force_branch: bool,
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
    /// 사용자 로그인 셸의 PATH 에서 찾을 수 있는 명령만 돌려준다 (새 탭 메뉴가 설치된 에이전트를 보이려고 쓴다)
    FindCommands { names: Vec<String> },
    /// 터미널에서 찾은 경로가 정말 있는지 본다. `~` 를 풀고, 상대 경로는 `bases`(절대 경로) 앞에서부터 붙여 보아
    /// 처음 있는 것을 돌려준다 (터미널 링크를 열 때 쓴다)
    ResolvePath { path: String, bases: Vec<String> },
    /// 붙여넣은 그림을 임시 폴더에 파일로 쓴다. `data` 는 base64, `ext` 는 확장자(png, jpg …).
    /// 앱은 돌려받은 경로를 터미널에 붙여 넣는다 (claude 는 붙여 넣은 그림 경로를 그림으로 붙인다)
    SavePasteImage { data: String, ext: String },
    /// 세션 셸 밑에서 도는 프로세스 중 이름(실행 파일, node 스크립트)이 `names` 에 든 것을 찾는다.
    /// 에이전트 훅이 알려 오지 않은 claude 도 닫기 전에 묻게 한다
    RunningAgents { sessions: Vec<SessionId>, names: Vec<String> },
    /// Orca 에 등록한 저장소·워크트리 이름·claude 세션을 읽는다 (바꾸지 않는다)
    ScanOrca,
    /// 이 claude 세션으로 떠 있는 claude 프로세스를 끝낸다 (SIGTERM, 끝날 때까지 기다린다). 가져와 이어 붙이기 전에 쓴다
    StopClaudeSession { session_id: String },
    GetAgentSettings,
    /// 에이전트를 띄울 때 붙일 옵션을 바꾼다. 다음에 띄우는 에이전트부터 적용된다 (이미 뜬 셸에서 치는 `claude` 도)
    SetAgentSettings { settings: AgentSettings },
    /// 원격 접속(폰·다른 컴퓨터 브라우저) 상태. 원격 연결에서는 원격 설정 요청을 받지 않는다
    GetRemote,
    /// 원격 접속을 켜고 끄거나 포트·LAN 허용을 바꾼다. 준 것만 바꾼다
    SetRemote {
        #[serde(default)]
        enabled: Option<bool>,
        #[serde(default)]
        port: Option<u16>,
        #[serde(default)]
        lan: Option<bool>,
    },
    /// 새 기기를 등록하고 그 기기용 접속 주소(토큰이 든)를 만든다. 원격 접속이 꺼져 있으면 켠다
    PairRemote { name: String },
    /// 등록한 기기를 지운다. 붙어 있던 연결은 바로 끊는다
    RemoveRemoteDevice { id: String },
    /// 세션 에이전트 대화 기록에서 사용자가 붙여 보낸 그림 목록 (보낸 차례대로). 에이전트가 없으면 빈 목록
    AgentImages { session: SessionId },
    /// 그림 하나의 내용. `thumb` 이면 긴 변을 줄인 작은 그림이다
    AgentImage {
        session: SessionId,
        id: String,
        #[serde(default)]
        thumb: bool,
    },
    /// claude 에이전트 팀이 부르는 tmux 명령 하나 (`thuminal tmux …`). 데몬이 팀원 세션으로 흉내 낸다
    Tmux {
        /// 부른 프로세스가 든 세션 (`THUMINAL_SESSION_ID`)
        session: SessionId,
        /// `TMUX_PANE`
        #[serde(default)]
        pane: Option<String>,
        argv: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        /// 팀원에게 물려줄 부른 쪽 환경 (PATH, TMUX 등)
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
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
    Groups { groups: Vec<RepoGroup> },
    Text { text: String },
    GitStatus { status: GitStatus },
    Branches { branches: BranchList },
    RepoIcon { icon: Option<RepoIcon> },
    Dir { entries: Vec<DirEntry> },
    File { file: FileContent },
    FileBytes { bytes: FileBytes },
    SearchHits { hits: Vec<SearchHit>, truncated: bool },
    FileList { files: Vec<String>, truncated: bool },
    LineCounts { counts: Vec<LineCount> },
    Worktrees { worktrees: Vec<WorktreeInfo> },
    Worktree { worktree: WorktreeInfo },
    Layouts { layouts: Vec<WorkspaceLayout> },
    LayoutResult { layouts: Vec<WorkspaceLayout>, created: Vec<PaneId> },
    TerminalColors { colors: Option<TerminalColors> },
    Commands { found: Vec<String> },
    /// 있는 경로 (없으면 None)
    ResolvedPath { path: Option<String>, is_dir: bool },
    /// 데몬이 쓴 파일
    Saved { path: String },
    RunningAgents { found: Vec<RunningAgent> },
    AgentSettings {
        settings: AgentSettings,
        /// thuminal claude 플러그인에 든 스킬들 (설정에서 켜고 끈다). 옛 데몬은 보내지 않는다
        #[serde(default)]
        skills: Vec<PluginSkill>,
    },
    Tmux { stdout: String, stderr: String, code: i32 },
    AgentImages { images: Vec<AgentImage> },
    /// 그림 내용 (`data` 는 base64)
    AgentImageData { media_type: String, data: String },
    OrcaScan { scan: OrcaScan },
    Remote { remote: RemoteStatus },
    /// 새로 등록한 기기와 그 기기가 열 주소들 (주소마다 토큰이 들어 있다. 이 응답에서만 보인다)
    RemotePaired { device: RemoteDevice, urls: Vec<String> },
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
    /// 저장소나 워크트리, 워크스페이스 목록이 바뀌었다. 다시 읽는다
    WorkspaceChanged,
    /// 이 워크트리의 git 상태가 바뀌었다 (스테이지, 커밋, 푸시 등)
    GitChanged { worktree: String },
    /// 이 workspace 배치가 바뀌었다 (전체를 보낸다. 앱은 통째로 바꿔 끼운다)
    LayoutChanged { layout: WorkspaceLayout },
    /// workspace 배치가 없어졌다
    LayoutRemoved { workspace: String },
    TerminalColorsChanged { colors: TerminalColors },
    /// 세션 프로그램이 OSC 9 / OSC 777 로 데스크톱 알림을 청했다 (세션마다 1초에 한 번까지)
    SessionNotification { session: SessionId, title: String, body: String },
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
    /// 고쳐 쓰려는 파일이 그사이 바뀌었다
    Conflict,
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

/// Orca 에서 가져올 수 있는 것 (`ScanOrca`)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaScan {
    pub repos: Vec<OrcaRepo>,
    /// 표시 이름·메모·부모가 있는 워크트리
    pub worktrees: Vec<OrcaWorktree>,
    /// Orca 탭에 붙은 claude 세션 (최근에 쓴 것부터)
    pub sessions: Vec<OrcaSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaRepo {
    pub path: String,
    pub name: String,
    /// 폴더가 아직 있는지
    pub exists: bool,
    /// thuminal 에 이미 등록했는지
    pub registered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaWorktree {
    pub path: String,
    pub name: Option<String>,
    pub comment: Option<String>,
    /// Orca 에서 이 워크트리의 부모 워크트리 경로 (하위 워크트리)
    #[serde(default)]
    pub parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaSession {
    pub session_id: String,
    pub title: String,
    /// Orca 워크트리 경로. 떠 있는 터미널이면 None
    pub worktree: Option<String>,
    /// claude 를 띄운 폴더 (세션 기록에서 읽는다. `--resume` 은 이 폴더에서 해야 한다)
    pub cwd: String,
    /// 세션 기록을 마지막으로 쓴 때 (ms)
    pub updated_at: u64,
    /// Orca 떠 있는 터미널에서 쓰던 세션
    pub floating: bool,
    /// Orca 에서 에이전트 팀으로 띄웠다
    pub teams: bool,
    /// 지금 이 세션으로 떠 있는 claude 가 있다 (Orca 든 어디든). 또 띄우면 두 claude 가 한 세션을 같이 쓴다
    pub running: bool,
}

/// 원격 접속 상태 (`GetRemote`)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub port: u16,
    /// Tailscale 말고 같은 Wi‑Fi(모든 주소)에서도 받는다. 끄면 Tailscale 주소와 이 컴퓨터(127.0.0.1)에서만 받는다
    pub lan: bool,
    /// 지금 받고 있는 주소들 (`100.80.1.2:6780`)
    pub listening: Vec<String>,
    /// 찾은 Tailscale 주소들 (100.64.0.0/10, fd7a:115c:a1e0::/48)
    pub tailnet: Vec<String>,
    /// 받기를 시작하지 못한 까닭 (포트를 다른 프로그램이 쓴다 등)
    #[serde(default)]
    pub error: Option<String>,
    /// 웹 화면 파일을 찾았는지 (없으면 브라우저로 열어도 빈 화면이다)
    pub web: bool,
    /// 안드로이드 앱 파일을 내려받을 수 있는지 (`/download/thuminal.apk`)
    pub apk: bool,
    pub devices: Vec<RemoteDevice>,
}

/// 원격 접속을 허락한 기기
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    /// 마지막으로 붙은 때 (ms). 붙은 적이 없으면 0
    #[serde(default)]
    pub last_seen: u64,
    /// 지금 붙어 있는 연결 수
    #[serde(default)]
    pub connected: u32,
}

/// 데몬이 에이전트를 띄울 때 쓰는 설정 (`agent-settings.json`)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSettings {
    #[serde(default)]
    pub claude: ClaudeSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeSettings {
    /// `--dangerously-skip-permissions` 를 붙인다 (기본 켬)
    pub skip_permissions: bool,
    /// 에이전트 팀을 켜고, 팀원을 리더 칸에 딸린 thuminal 터미널로 연다 (기본 켬)
    pub teams: bool,
    /// thuminal claude 플러그인에서 끈 스킬 이름들. 없는 이름은 켜진 것이다 (새 스킬은 처음에 켜져 있다)
    pub disabled_skills: Vec<String>,
}

impl Default for ClaudeSettings {
    fn default() -> Self {
        Self { skip_permissions: true, teams: true, disabled_skills: Vec::new() }
    }
}

/// thuminal claude 플러그인의 스킬 하나 (`skills/<name>/SKILL.md`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginSkill {
    pub name: String,
    /// SKILL.md 머리의 description
    #[serde(default)]
    pub description: String,
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

    #[test]
    fn new_fields_default_when_missing() {
        // 예전 클라이언트가 보내는 모양도 그대로 받는다
        let r: Request = serde_json::from_str(r#"{"type":"report_agent","session":1,"kind":"claude","event":"Stop"}"#).unwrap();
        assert!(matches!(r, Request::ReportAgent { prompt: None, notification_type: None, .. }));
        let r: Request = serde_json::from_str(r#"{"type":"remove_worktree","repo":"a","path":"/p","force":true,"delete_branch":true}"#).unwrap();
        assert!(matches!(r, Request::RemoveWorktree { force: true, force_branch: false, .. }));
        let a: AgentInfo = serde_json::from_str(r#"{"kind":"claude","session_id":null,"transcript":null,"state":"idle","updated_at":1}"#).unwrap();
        assert_eq!((a.prompt, a.turn_ended_at), (None, None));
        let e = Event::SessionNotification { session: SessionId(3), title: "t".into(), body: "b".into() };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"session_notification","session":3,"title":"t","body":"b"}"#);
    }

    #[test]
    fn clips_text_by_chars() {
        assert_eq!(clip_text("  hi  ", 5).as_deref(), Some("hi"));
        assert_eq!(clip_text("   ", 5), None);
        assert_eq!(clip_text("가나다라마바", 3).as_deref(), Some("가나다…"));
        assert_eq!(clip_text("abc", 3).as_deref(), Some("abc"));
    }
}
