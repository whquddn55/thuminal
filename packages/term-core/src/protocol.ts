// 데몬 프로토콜 타입의 TypeScript 쪽 모양.
// 원본은 crates/thuminal-protocol/src/message.rs 다. 바꾸면 같이 바꾼다.

export type SessionId = number;

export type SnapshotFormat = "native" | "vt";
export type ScreenFormat = "plain" | "vt";

export type SessionState = { state: "running" } | { state: "exited"; code: number | null };

export interface SessionInfo {
  id: SessionId;
  title: string;
  cwd: string;
  command: string[];
  cols: number;
  rows: number;
  pid: number | null;
  state: SessionState;
  created_at: number;
  last_output_at: number;
  attached: number;
  labels: Record<string, string>;
  /** 이 세션 안에서 도는 에이전트 (훅이 알려 준다) */
  agent: AgentInfo | null;
  /** 데몬이 다시 뜨며 되살린 세션이면 이전 번호 */
  restored_from: SessionId | null;
  /** 마지막 BEL 때 (ms, 없으면 0). 세션마다 1초에 한 번까지만 바뀐다 */
  bell_at: number;
}

export type AgentState = "idle" | "working" | "needs_attention" | "failed";

export interface AgentInfo {
  kind: string;
  session_id: string | null;
  transcript: string | null;
  state: AgentState;
  /** 상태가 마지막으로 바뀐 때 (ms) */
  updated_at: number;
  /** 마지막 사용자 프롬프트 (200자까지) */
  prompt: string | null;
  /** 마지막 답 (Stop 의 last_assistant_message, 200자까지) */
  last_assistant_message: string | null;
  /** 지금 쓰는(또는 막 쓴) 도구. 턴이 끝나면 비운다 */
  tool_name: string | null;
  model: string | null;
  /** 턴이 Stop 으로 끝난 때 (ms). 있고 state 가 idle 이면 "끝남", 없이 idle 이면 막 시작해 기다리는 중 */
  turn_ended_at: number | null;
  /** 에이전트가 도는 폴더 (훅의 cwd). 셸이 알린 폴더와 다를 수 있다 */
  cwd?: string | null;
  /** 사용자가 Esc · ⌃C 로 턴을 멈췄다 (데몬이 추론한다). 다음 프롬프트에서 지운다 */
  interrupted?: boolean;
  /** 이 대화 기록에서 사용자가 붙여 보낸 그림 수 (데몬이 센다. 기록이 바뀌면 0 부터). 보내기 전 그림도 더한 수 */
  image_count?: number;
  /** image_count 가운데 입력창에 붙였지만 아직 보내지 않은 그림 수 */
  draft_images?: number;
  /** 에이전트가 백그라운드로 돌려 두고 아직 끝나지 않은 작업 수 (데몬이 센다). idle 이어도 있으면 작업을 기다리는 중 */
  background_tasks?: number;
  /** 이 에이전트가 부른 도구 수 (PreToolUse 수). 새 세션이면 0 부터 */
  tool_count?: number;
  /** 도구가 마지막으로 실패한 때 (ms) */
  tool_failed_at?: number | null;
  /** 모델 · 생각 강도 · 컨텍스트 · 사용량 (claude 상태 줄 명령이 알린다. thuminal 실행기로 실행한 claude 만) */
  usage?: AgentUsage | null;
}

/** claude 가 상태 줄 명령에 넘겨 주는 값에서 뽑은 것. 모르는 값은 null */
export interface AgentUsage {
  model_id?: string | null;
  /** Fable 5.2 */
  model_name?: string | null;
  effort?: string | null;
  /** 마지막 요청이 쓴 컨텍스트 토큰 수 */
  context_tokens?: number | null;
  context_size?: number | null;
  /** 컨텍스트를 쓴 비율 (%) */
  context_pct?: number | null;
  /** 5시간 한도를 쓴 비율 (%)과 다시 차는 때 (유닉스 시간 초) */
  five_hour_pct?: number | null;
  five_hour_resets?: number | null;
  seven_day_pct?: number | null;
  seven_day_resets?: number | null;
  /** 로그인한 계정 (이메일) */
  account?: string | null;
}

/** 에이전트 대화 기록에서 사용자가 붙여 보낸 그림 하나 (`agent_images` 요청) */
export interface AgentImage {
  /** 기록 안 자리. 그림을 받을 때 쓴다 */
  id: string;
  /** 대화에 `[Image #N]` 으로 남은 번호 */
  n: number;
  media_type: string;
  /** 원본 크기 (px). 모르면 0 */
  width: number;
  height: number;
  bytes: number;
  /** 보낸 때 (ms, 모르면 0). 보내기 전 그림이면 붙인 때 */
  at: number;
  /** 입력창에 붙였지만 아직 보내지 않은 그림 */
  pending?: boolean;
}

export interface CreateSession {
  command?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  labels?: Record<string, string>;
}

export interface RepoInfo {
  id: string;
  name: string;
  path: string;
  /** 이 프로젝트의 워크트리 그룹, 사이드바 차례. 데몬 부 버전 `WORKTREE_GROUPS_PROTOCOL_MINOR` 부터 늘 들어 있다 (옛 데몬은 없다) */
  groups?: WorktreeGroup[];
}

/** 한 프로젝트 안의 워크트리 그룹 (크롬 탭 그룹처럼 이름 · 색을 붙여 고른 워크트리끼리 묶는다) */
export interface WorktreeGroup {
  /** `set_worktree_groups` 에 빈 글로 주면 데몬이 새 id 를 붙인다 */
  id: string;
  name: string;
  /** 색 이름 (`blue` 등, ui `worktree-groups.ts`). 데몬은 뜻을 모른다 */
  color: string;
}

/** 기본 워크스페이스의 id. 지울 수 없고, 다른 워크스페이스에 넣지 않은 프로젝트가 여기 든다 */
export const DEFAULT_GROUP = "default";

/**
 * 사이드바 워크스페이스: 프로젝트(저장소) 묶음. 목록 차례가 사이드바 차례다.
 * (`WorkspaceId` 는 워크트리 경로·floating·other 를 뜻하므로 묶음은 코드에서 `group` 이라 부른다)
 */
export interface RepoGroup {
  /** 기본은 `DEFAULT_GROUP`. `set_groups` 에 빈 글로 주면 데몬이 새 id 를 붙인다 */
  id: string;
  name: string;
  /** 든 프로젝트(저장소 id), 사이드바 차례 */
  repos: string[];
}

/** 저장소 안에서 찾은 아이콘 그림 (`repo_icon` 요청) */
export interface RepoIcon {
  /** `image/png` 또는 `image/webp` */
  mime: string;
  /** 파일 내용 base64 */
  data: string;
  /** 저장소 기준 상대 경로 */
  file: string;
}

export interface WorktreeInfo {
  repo: string;
  path: string;
  branch: string | null;
  head: string;
  is_main: boolean;
  /** 사용자가 붙인 이름 */
  name: string | null;
  pinned: boolean;
  /** 부모 워크트리 경로 (하위 워크트리면) */
  parent?: string | null;
  /** 든 워크트리 그룹 id (`RepoInfo.groups`). 하위 워크트리는 화면이 맨 위 부모의 그룹을 따른다 */
  group?: string | null;
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "untracked" | "conflicted";

export interface FileChange {
  path: string;
  orig_path: string | null;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileChange[];
}

export interface BranchList {
  local: string[];
  remote: string[];
  current: string | null;
  default: string | null;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  /** git 이 무시하는 파일 */
  ignored: boolean;
}

/** 파일 내용 찾기 결과 한 줄 */
export interface SearchHit {
  path: string;
  /** 1 부터 */
  line: number;
  text: string;
}

/** 파일 하나의 바뀐 줄 수. 바이너리면 null */
export interface LineCount {
  path: string;
  staged: boolean;
  added: number | null;
  removed: number | null;
}

export interface FileContent {
  text: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
  /** 마지막으로 바뀐 때 (유닉스 밀리초). 고쳐 쓸 때 그사이 바뀌었는지 본다. 옛 데몬은 보내지 않는다 */
  modified?: number | null;
}

/** 데몬 프로토콜 부 판이 이 값 이상이어야 파일 쓰기(`write_file`) · 바이트 읽기(`read_file_bytes`)가 된다 */
export const FILES_PROTOCOL_MINOR = 5;

/** 데몬 프로토콜 부 판이 이 값 이상이어야 원격 기기용 브라우저 칸 대리(`browser_proxy`)가 된다 */
export const BROWSER_PROXY_PROTOCOL_MINOR = 6;

/** 데몬 프로토콜 부 판이 이 값 이상이어야 프로세스 · 포트 읽기(`list_processes`) · 멈추기(`stop_process`)가 된다 */
export const PROCESSES_PROTOCOL_MINOR = 6;

/** 데몬 프로토콜 부 판이 이 값 이상이어야 파일 칸이 워크트리 밖 파일을 절대 경로로 읽고 쓴다 */
export const OUTSIDE_FILES_PROTOCOL_MINOR = 9;
/** 이 부 버전부터 데몬이 에이전트 대화 기록을 대화 조각으로 읽어 준다 (`agent_chat`, `agent_chat_changed`) */
export const AGENT_CHAT_PROTOCOL_MINOR = 12;

/** 데몬 프로토콜 부 판이 이 값 이상이어야 `stop_process` 의 강제 종료(`force`, SIGKILL)가 된다 */
export const FORCE_STOP_PROTOCOL_MINOR = 10;

/** 데몬 프로토콜 부 판이 이 값 이상이어야 워크트리 그룹(`set_worktree_groups`, `update_worktree` 의 `group`)이 된다 */
export const WORKTREE_GROUPS_PROTOCOL_MINOR = 11;

// ---- 리소스 관리자 (세션 프로세스와 LISTEN 포트, `list_processes`) ----

/** 프로세스 하나. cpu 는 ps 의 %CPU (코어 하나가 100), rss 는 바이트 */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** 세션 셸에서 몇 단계 아래인지 (셸이 0) */
  depth: number;
  cpu: number;
  rss: number;
  /** 명령줄 (길면 자른다) */
  command: string;
  /** 이 프로세스가 LISTEN 중인 포트 */
  ports: number[];
}

export interface SessionProcesses {
  session: SessionId;
  /** 셸 pid */
  pid: number;
  /** 셸과 그 자손 합계 */
  cpu: number;
  rss: number;
  /** 셸부터 자손을 트리 차례로 */
  processes: ProcessInfo[];
  truncated: boolean;
}

/** 포트를 붙인 근거: 세션 셸 자손, 작업 폴더가 워크트리 안, 명령줄에 워크트리 경로, 어디에도 없음 */
export type PortVia = "tree" | "cwd" | "command" | "external";

export interface ListenPort {
  port: number;
  /** 받는 주소 (`*`, `127.0.0.1`, `[::1]` …) */
  address: string;
  pid: number;
  /** 프로세스 이름 */
  process: string;
  command: string;
  cwd: string | null;
  /** 세션 셸 밑이면 그 세션 */
  session: SessionId | null;
  /** 붙인 워크트리 */
  worktree: string | null;
  via: PortVia;
}

export interface ProcessReport {
  /** 데몬 자신 (thuminald) */
  daemon: ProcessInfo;
  sessions: SessionProcesses[];
  /** 세션 · 워크트리 것 먼저, 그다음 밖. 그 안에서는 포트 번호 차례 */
  ports: ListenPort[];
  ports_truncated: boolean;
  /** 포트를 읽지 못한 까닭 */
  ports_error: string | null;
}
/**
 * 에이전트 대화 기록 한 조각 (`agent_chat` 요청). 대화 보기가 이것만으로 그린다.
 * 도구 호출(`tool_use`)과 결과(`tool_result`)는 같은 `id`(도구 호출 id)로 짝짓는다
 */
export type ChatItem =
  /** 사용자가 보낸 글. images 는 같이 붙인 그림 id (`agentImage` 로 받는다) */
  | { type: "user"; id: string; at: number; text: string; images?: string[] }
  | { type: "assistant"; id: string; at: number; text: string }
  | { type: "thinking"; id: string; at: number; text: string }
  | { type: "tool_use"; id: string; at: number; name: string; input: unknown }
  | { type: "tool_result"; id: string; at: number; text: string; is_error?: boolean; truncated?: boolean }
  /** kind: command(슬래시 명령) · command_output · compact · interrupted · error · info · turn(턴에 걸린 ms) · teammate(팀원이 보낸 글: 첫 줄 이름, 나머지 내용) */
  | { type: "notice"; id: string; at: number; kind: string; text: string };

/** claude 가 고를 수 있는 모델 하나 (`claude_models`). claude 의 `/model` 창에 뜨는 줄과 같다 */
export interface ClaudeModel {
  /** `/model` 에 붙일 값 (default, opus, claude-opus-4-8 …) */
  value: string;
  /** 화면 이름 (Opus 5.5) */
  label: string;
  description?: string;
  /** 이 값이 가리키는 모델 id */
  resolved?: string;
  /** 고를 수 있는 생각 강도 (없으면 바꿀 수 없는 모델) */
  efforts?: string[];
}

/** 이어 갈 수 있는 지난 claude 대화 하나 (`agent_sessions`) */
export interface AgentSession {
  /** claude 세션 id (`/resume` 에 붙일 값) */
  id: string;
  /** claude 가 붙인 제목. 없으면 사용자 글의 앞머리 */
  title: string;
  /** 기록을 마지막으로 쓴 때 (ms) */
  modified: number;
}

/** 대화 기록에서 읽은 에이전트 상태. 이번에 읽은 줄에 없던 것은 null 이고, 화면은 앞서 받은 값을 그대로 둔다 */
export interface ChatStatus {
  /** 마지막 답의 모델 id (`claude-sonnet-5-5`)나 `/model` 이 알린 이름 (`Sonnet 5.5`) */
  model?: string | null;
  /** 생각 강도 (low · medium · high …) */
  effort?: string | null;
  /** 마지막 요청이 쓴 컨텍스트 토큰 수 */
  context_tokens?: number | null;
  /** 컨텍스트 창 크기 (`/context` 를 친 적이 있어야 안다) */
  context_window?: number | null;
}

/** `agent_chat` 응답 */
export interface AgentChat {
  /** 읽은 기록 파일. 에이전트나 기록이 없으면 빈 글 */
  transcript: string;
  /** 여기까지 읽었다. 다음 요청에 그대로 돌려준다 */
  offset: number;
  /** 처음부터 다시 읽었다. 가진 것을 버리고 items 로 바꾼다 */
  reset: boolean;
  /** 처음부터 읽었는데 tail 보다 많아 앞쪽을 뺐다 */
  more: boolean;
  items: ChatItem[];
  /** 읽은 줄에서 알아낸 모델 · 생각 강도 · 컨텍스트 (옛 빌드는 보내지 않는다) */
  status?: ChatStatus;
}


/** 세션 꼬리표 중 워크트리 경로를 담는 키 (데몬이 시작 폴더로 채운다) */
export const WORKTREE_LABEL = "worktree";

export type DaemonEvent =
  | { type: "session_created"; session: SessionInfo }
  | { type: "session_updated"; session: SessionInfo }
  | { type: "session_exited"; session: SessionId; code: number | null }
  | { type: "session_removed"; session: SessionId }
  | { type: "workspace_changed" }
  | { type: "git_changed"; worktree: string }
  | { type: "layout_changed"; layout: WorkspaceLayout }
  | { type: "layout_removed"; workspace: string }
  | { type: "terminal_colors_changed"; colors: TerminalColors }
  /** 세션 프로그램이 OSC 9 / 777 로 데스크톱 알림을 청했다 (세션마다 1초에 한 번까지) */
  | { type: "session_notification"; session: SessionId; title: string; body: string }
  /** 세션 에이전트의 대화 기록이 자랐거나 바뀌었다. 대화 보기가 `agent_chat` 으로 이어 읽는다 */
  | { type: "agent_chat_changed"; session: SessionId }
  /** 앱 껍데기가 데몬에 다시 붙었다 (데몬이 다시 떴다). 세션 목록을 다시 읽고 다시 붙는다 */
  | { type: "daemon_reconnected" };

// ---- 배치: 워크스페이스마다 탭, 탭마다 칸 트리 (tmux 식) ----

/** 워크트리 경로, 또는 플로팅 워크스페이스, 워크트리 밖 세션 */
export type WorkspaceId = string;
export const FLOATING_WORKSPACE = "floating";
export const OTHER_WORKSPACE = "other";

/** 절대 경로인지: 유닉스 `/…`, Windows `C:\…` · `C:/…` · `\\서버\…`. 다른 OS 데몬의 경로도 가른다 */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

/** 워크트리 workspace 인지 (워크트리 workspace 는 그 절대 경로다. floating · other 가 아니다) */
export const isWorktreeWorkspace = (ws: string): boolean => isAbsolutePath(ws);

/** 경로의 마지막 이름 (`/` 와 Windows `\` 를 모두 가른다) */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export type PaneId = number;
export type TabId = number;
/** row: 좌우로 늘어놓는다, column: 위아래로 늘어놓는다 */
export type Axis = "row" | "column";
export type Side = "left" | "right" | "up" | "down";

export type PaneContent = { type: "terminal"; session: SessionId } | { type: "doc"; doc: Record<string, string> };
export type Pane = { id: PaneId } & PaneContent;

export type PaneNode = { type: "split"; axis: Axis; children: PaneNode[]; sizes: number[] } | { type: "pane"; pane: Pane };

export interface Tab {
  id: TabId;
  /** 사용자가 붙인 이름 (없으면 포커스 칸 세션 제목) */
  title: string | null;
  root: PaneNode;
  focused: PaneId;
  zoomed: PaneId | null;
}

export interface WorkspaceLayout {
  workspace: WorkspaceId;
  tabs: Tab[];
  active_tab: TabId | null;
}

/** 새 세션. command 를 비우면 로그인 셸, input 은 셸이 뜬 뒤 입력할 명령 */
export interface Spawn {
  command?: string[];
  input?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
}

export type PaneRef = { by: "id"; value: PaneId } | { by: "session"; value: SessionId } | { by: "focused"; value: WorkspaceId };
export type TabRef = { by: "id"; value: TabId } | { by: "pane"; value: PaneRef } | { by: "active"; value: WorkspaceId };

export type LayoutSpec =
  | { type: "split"; axis: Axis; children: LayoutSpec[]; sizes?: number[] | null }
  | { type: "pane"; pane: PaneRef }
  | { type: "spawn"; spawn?: Spawn };

export type LayoutOp =
  | { op: "new_tab"; workspace: WorkspaceId; spawn?: Spawn; index?: number | null; focus?: boolean; title?: string | null; doc?: Record<string, string> | null }
  | { op: "open_doc"; workspace: WorkspaceId; doc: Record<string, string> }
  | { op: "split"; target: PaneRef; side: Side; size?: number | null; spawn?: Spawn; focus?: boolean; doc?: Record<string, string> | null }
  /** 문서 칸 내용을 바꾼다 (브라우저 칸 주소 남기기) */
  | { op: "update_doc"; pane: PaneRef; doc: Record<string, string> }
  | { op: "resize"; target: PaneRef; size: number; axis?: Axis | null }
  | { op: "resize_by"; target: PaneRef; delta: number; axis?: Axis | null }
  | { op: "set_sizes"; tab: TabId; path: number[]; sizes: number[] }
  | { op: "equalize"; tab: TabRef }
  | { op: "focus"; target: PaneRef }
  | { op: "focus_dir"; from: PaneRef; side: Side }
  | { op: "focus_cycle"; from: PaneRef; delta: number }
  | { op: "zoom"; target: PaneRef; on?: boolean | null }
  | { op: "move_pane"; pane: PaneRef; to: PaneRef; side: Side }
  | { op: "swap"; a: PaneRef; b: PaneRef }
  | { op: "break_pane"; pane: PaneRef; workspace?: WorkspaceId | null; index?: number | null }
  | { op: "join_tab"; tab: TabRef; to: PaneRef; side: Side }
  | { op: "move_tab"; tab: TabRef; workspace?: WorkspaceId | null; index: number }
  | { op: "select_tab"; tab: TabRef }
  | { op: "rename_tab"; tab: TabRef; title?: string | null }
  | { op: "close_pane"; target: PaneRef }
  | { op: "close_tab"; tab: TabRef }
  | { op: "apply"; workspace: WorkspaceId; tab?: TabRef | null; spec: LayoutSpec; focus?: boolean };

export interface LayoutResult {
  layouts: WorkspaceLayout[];
  created: PaneId[];
}

// ---- 원격 접속 (폰·다른 컴퓨터 브라우저가 Tailscale 로 데몬에 붙는다) ----

export interface RemoteDevice {
  id: string;
  name: string;
  created_at: number;
  /** 마지막으로 붙은 때 (ms). 붙은 적이 없으면 0 */
  last_seen: number;
  /** 지금 붙어 있는 연결 수 */
  connected: number;
}

export interface RemoteStatus {
  enabled: boolean;
  port: number;
  /** 같은 Wi‑Fi(모든 주소)에서도 받는다 */
  lan: boolean;
  /** 지금 받고 있는 주소들 */
  listening: string[];
  /** 찾은 Tailscale 주소들 */
  tailnet: string[];
  error?: string | null;
  /** 웹 화면 파일을 찾았는지 */
  web: boolean;
  /** 안드로이드 앱을 내려받을 수 있는지 (`/download/thuminal.apk`) */
  apk: boolean;
  /** 이 컴퓨터의 접속 주소들 (`http://100.x.y.z:6780/#token=…`, 데몬 부 버전 8 부터). 토큰은 컴퓨터마다 하나다 */
  urls?: string[];
  /** 접속 주소로 지금 붙어 있는 연결 수 */
  connected?: number;
  /** 접속 주소로 마지막으로 붙은 때 (ms) */
  last_seen?: number;
  /** 예전(기기마다 토큰을 주던 때)에 등록한 기기. 토큰을 바꾸면 지워진다 */
  devices: RemoteDevice[];
}

// ---- Orca 에서 가져오기 (데몬이 Orca 상태 파일을 읽기만 한다) ----

export interface OrcaScan {
  repos: { path: string; name: string; exists: boolean; registered: boolean }[];
  /** 표시 이름·메모·부모가 있는 워크트리 */
  worktrees: { path: string; name: string | null; comment: string | null; parent?: string | null }[];
  /** Orca 탭에 붙은 claude 세션 (최근에 쓴 것부터) */
  sessions: OrcaSession[];
}

export interface OrcaSession {
  session_id: string;
  title: string;
  /** Orca 워크트리 경로. 떠 있는 터미널이면 null */
  worktree: string | null;
  /** claude 를 띄운 폴더 (`--resume` 은 여기서) */
  cwd: string;
  /** 세션 기록을 마지막으로 쓴 때 (ms) */
  updated_at: number;
  floating: boolean;
  teams: boolean;
  /** 지금 이 세션으로 떠 있는 claude 가 있다. 또 띄우면 두 claude 가 한 세션을 같이 쓴다 */
  running: boolean;
}

// ---- 에이전트 설정 (데몬이 에이전트를 띄울 때 붙이는 옵션, `agent-settings.json`) ----

export interface AgentSettings {
  claude: {
    /** `--dangerously-skip-permissions` 를 붙인다 (기본 켬) */
    skip_permissions: boolean;
    /** 에이전트 팀을 켜고 팀원을 리더 칸에 딸린 터미널로 연다 (기본 켬) */
    teams: boolean;
    /** thuminal claude 플러그인에서 끈 스킬 이름들 (옛 데몬은 보내지 않는다) */
    disabled_skills?: string[];
  };
}

/** thuminal claude 플러그인의 스킬 하나 (`skills/<name>/SKILL.md`) */
export interface PluginSkill {
  name: string;
  description: string;
}

// ---- 터미널 색 (데몬 엔진의 기본색. 프로그램 질의에 이 색으로 답한다) ----

export type ColorScheme = "dark" | "light";

export interface TerminalColors {
  /** 0xRRGGBB */
  foreground: number;
  background: number;
  cursor: number | null;
  /** 16개 또는 256개 */
  palette: number[];
  scheme: ColorScheme;
}
