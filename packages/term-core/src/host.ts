// 앱 껍데기(Tauri, Electron, 브라우저 등)가 제공하는 기능.
//
// 화면 코드는 이 인터페이스로만 데몬과 운영체제에 닿는다. 껍데기를 바꾸면 이 구현만 새로 쓴다.

import type {
  AgentImage,
  AgentSettings,
  PluginSkill,
  BranchList,
  CreateSession,
  DaemonEvent,
  DirEntry,
  FileContent,
  GitStatus,
  LayoutOp,
  LayoutResult,
  LineCount,
  OrcaScan,
  RemoteDevice,
  RemoteStatus,
  RepoGroup,
  RepoIcon,
  RepoInfo,
  SearchHit,
  SessionId,
  SessionInfo,
  SnapshotFormat,
  TerminalColors,
  WorkspaceLayout,
  WorktreeInfo,
} from "./protocol";

/** 창 안의 사각형 (CSS 픽셀, 창 왼쪽 위 기준) */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 브라우저 칸 웹뷰가 보내는 일 */
export type BrowserEvent =
  | { type: "title"; id: number; title: string }
  | { type: "load"; id: number; url: string; loading: boolean }
  /** 페이지가 키보드를 잡고 있을 때 누른 앱 단축키 (⌘ 조합) */
  | { type: "key"; id: number; key: string; code: string; alt: boolean; shift: boolean; ctrl: boolean }
  /** 페이지가 키보드를 받기 시작했다 */
  | { type: "focus"; id: number }
  /** 페이지가 새 창을 열려 했다 */
  | { type: "new_window"; id: number; url: string };

/**
 * 브라우저 칸. 칸 자리(사각형)는 화면이 잡고, 껍데기는 그 자리에 진짜 웹뷰를 얹는다.
 * 웹뷰는 화면(HTML) 위에 그려지므로 메뉴·창이 겹치는 동안에는 화면이 숨겨 달라고 한다. id 는 칸 번호
 */
export interface BrowserHost {
  open(id: number, url: string, at: Bounds): Promise<void>;
  setBounds(id: number, at: Bounds): Promise<void>;
  setVisible(id: number, visible: boolean): Promise<void>;
  navigate(id: number, url: string): Promise<void>;
  /** 뒤로(-1) · 앞으로(+1) */
  go(id: number, delta: number): Promise<void>;
  reload(id: number): Promise<void>;
  focus(id: number): Promise<void>;
  devtools(id: number): Promise<void>;
  close(id: number): Promise<void>;
  onEvent(cb: (e: BrowserEvent) => void): () => void;
}

/** 워크트리의 git 작업. 경로는 워크트리 기준 상대 경로 */
export interface GitApi {
  status(worktree: string): Promise<GitStatus>;
  diff(worktree: string, file: string, staged: boolean): Promise<string>;
  stage(worktree: string, files: string[]): Promise<void>;
  unstage(worktree: string, files: string[]): Promise<void>;
  /** 작업 폴더 변경을 버린다 (새 파일은 지운다) */
  discard(worktree: string, files: string[]): Promise<void>;
  /** 커밋 id 를 돌려준다. all 이면 바뀐 파일을 모두 담는다 */
  commit(worktree: string, message: string, all: boolean): Promise<string>;
  push(worktree: string): Promise<string>;
  branches(repo: string): Promise<BranchList>;
  /** 바뀐 파일마다 더하고 지운 줄 수 */
  lineCounts(worktree: string): Promise<LineCount[]>;
}

/** 워크트리 안 파일 읽기 */
export interface FilesApi {
  list(worktree: string, dir: string): Promise<DirEntry[]>;
  read(worktree: string, file: string): Promise<FileContent>;
  /** 파일 내용에서 글을 찾는다 (무시하는 파일은 뺀다). 많으면 앞부분과 truncated */
  search(worktree: string, query: string, caseSensitive: boolean): Promise<{ hits: SearchHit[]; truncated: boolean }>;
  /** 워크트리 안 파일 경로 전부 (추적 + 무시하지 않는 새 파일) */
  all(worktree: string): Promise<{ files: string[]; truncated: boolean }>;
  /**
   * 글자 파일을 통째로 쓴다 (데몬 부 판 `FILES_PROTOCOL_MINOR` 부터). expectModified 를 주면 그사이 파일이 바뀌었을 때
   * 쓰지 않고 `FileConflictError` 로 거절한다. 새 크기 · 바뀐 때를 돌려준다
   */
  write(worktree: string, file: string, text: string, expectModified?: number | null): Promise<FileContent>;
  /** `<img>` · `<video>` 가 받을 파일 주소 (Range 를 받는다). 데몬 부 판 `FILES_PROTOCOL_MINOR` 부터 된다 */
  mediaUrl(worktree: string, file: string): string;
}

/** 에이전트 설정과 thuminal claude 플러그인의 스킬 목록 (옛 데몬은 스킬을 보내지 않아 빈 목록) */
export interface AgentSettingsState {
  settings: AgentSettings;
  skills: PluginSkill[];
}

/** `agent_settings` 응답에서 설정 · 스킬을 꺼낸다 (옛 데몬은 skills 가 없다) */
export function agentSettingsState(r: Record<string, unknown>): AgentSettingsState {
  return { settings: r.settings as AgentSettings, skills: (r.skills as PluginSkill[] | undefined) ?? [] };
}

/** 고쳐 쓰려는 파일이 그사이 다른 곳에서 바뀌었다 (데몬 `conflict`) */
export class FileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileConflictError";
  }
}

/** 원격 접속 설정. 데몬이 원격 연결에서는 받지 않으므로 데스크톱 껍데기만 둔다 */
export interface RemoteApi {
  status(): Promise<RemoteStatus>;
  /** 준 것만 바꾼다 */
  set(change: { enabled?: boolean; port?: number; lan?: boolean }): Promise<RemoteStatus>;
  /** 기기를 등록하고 그 기기가 열 주소들(토큰이 든)을 돌려준다. 꺼져 있으면 켠다 */
  pair(name: string): Promise<{ device: RemoteDevice; urls: string[] }>;
  removeDevice(id: string): Promise<RemoteStatus>;
}

/** 원격 호스트 연결 상태 */
export type RemoteHostState = "connecting" | "connected" | "disconnected" | "unauthorized" | "version_mismatch";

/** 등록한 원격 호스트(다른 컴퓨터의 thuminal 데몬) 하나. 토큰은 껍데기만 들고 화면에는 오지 않는다 */
export interface RemoteHost {
  /** 껍데기가 정한 호스트 id (8자리 16진수). 세션·칸 번호와 워크트리 경로는 호스트마다 따로라 이것으로 가른다 */
  id: string;
  name: string;
  /** `100.x.y.z:6780` */
  address: string;
  state: RemoteHostState;
  /** 마지막 실패 까닭 */
  error: string | null;
  /** 붙은 데몬의 판 (붙은 적이 있으면 마지막 것) */
  daemonVersion: string | null;
  /** 프로토콜 [주 판, 부 판] */
  protocol: [number, number] | null;
  /** 부 판이 달라 알릴 글 (주 판이 다르면 state 가 version_mismatch) */
  warning: string | null;
  /** 끊겼을 때 다시 붙기까지 남은 시간 */
  retryInMs: number | null;
}

/**
 * 원격 호스트 관리 (데스크톱 껍데기만). 원격 컴퓨터에서 `thuminal remote pair <이름>` 이 찍는 주소를 붙여 넣어 등록한다.
 * 껍데기가 호스트마다 연결을 들고 끊기면 스스로 다시 붙는다
 */
export interface RemoteHostsApi {
  list(): Promise<RemoteHost[]>;
  /** 짝짓기 주소(`http://100.x.y.z:6780/#token=…`)로 등록한다. Tailscale 주소만 받고, 붙어 보고 되면 남긴다. 같은 주소면 이름·토큰을 바꾼다 */
  add(url: string, name?: string): Promise<RemoteHost>;
  remove(id: string): Promise<void>;
  /** 기다리는 중이면 바로 다시 붙어 본다 */
  reconnect(id: string): Promise<void>;
  /** 목록이나 연결 상태가 바뀔 때마다 목록 전체. 구독하자마자 지금 목록을 한 번 준다 */
  onChange(cb: (hosts: RemoteHost[]) => void): () => void;
  /**
   * 그 호스트 데몬으로 보내는 HostApi (`isRemote` true, `hostId` 가 id). 같은 id 면 같은 것을 돌려준다.
   * 이벤트(`onEvent`)는 그 호스트 것만 오고, 다시 붙으면 `daemon_reconnected` 가 온다
   */
  forHost(id: string): HostApi;
}

export interface Attachment {
  session: SessionInfo;
  format: SnapshotFormat;
  snapshot: Uint8Array;
  /** 출력 받기를 멈추고 세션에서 떨어진다 */
  detach(): Promise<void>;
}

export interface DaemonInfo {
  engine: string;
  version: string;
  /** 프로토콜 [주 판, 부 판]. 새 요청을 보내도 되는지 본다 (옛 데몬은 모른다: 앱 껍데기가 hello 에서 채운다) */
  protocol?: [number, number];
}

export interface HostApi {
  daemon(): Promise<DaemonInfo>;
  listSessions(): Promise<SessionInfo[]>;
  createSession(req: CreateSession): Promise<SessionInfo>;
  /** 붙는다. 저장본을 돌려주고, 그 뒤 출력은 onOutput 으로 온다 */
  attach(id: SessionId, format: SnapshotFormat, onOutput: (bytes: Uint8Array) => void): Promise<Attachment>;
  input(id: SessionId, bytes: Uint8Array): Promise<void>;
  resize(id: SessionId, cols: number, rows: number): Promise<void>;
  setLabels(id: SessionId, labels: Record<string, string>): Promise<void>;
  kill(id: SessionId): Promise<void>;
  remove(id: SessionId): Promise<void>;
  listRepos(): Promise<RepoInfo[]>;
  addRepo(path: string): Promise<RepoInfo>;
  /** 폴더가 저장소가 아니면 바로 아래 저장소들을 모두 등록한다 */
  addRepos(path: string): Promise<RepoInfo[]>;
  removeRepo(repo: string): Promise<void>;
  /** 저장소(id) 안의 흔한 자리(favicon, logo, Tauri 아이콘 …)에서 찾은 아이콘. 없으면 null */
  repoIcon(repo: string): Promise<RepoIcon | null>;
  /** 사이드바 워크스페이스. 기본이 늘 들어 있고, 프로젝트는 저마다 꼭 한 워크스페이스에 든다 */
  listGroups(): Promise<RepoGroup[]>;
  /** 워크스페이스 목록을 통째로 바꾸고 데몬이 맞춘 목록을 돌려받는다 (빈 id 는 새로 붙는다. 빠진 워크스페이스의 프로젝트는 기본으로) */
  setGroups(groups: RepoGroup[]): Promise<RepoGroup[]>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  createWorktree(repo: string, branch: string, opts?: { base?: string; name?: string; parent?: string }): Promise<WorktreeInfo>;
  /** 이름·고정·부모를 바꾼다. 준 것만 바꾼다. parent 를 null 로 주면 부모에서 뗀다 */
  updateWorktree(path: string, change: { name?: string; pinned?: boolean; parent?: string | null }): Promise<void>;
  readonly git: GitApi;
  readonly files: FilesApi;
  /** 운영체제 폴더 고르기 창. 고르지 않으면 null */
  pickFolder(): Promise<string | null>;
  /** Finder 에서 보기 */
  reveal(path: string): Promise<void>;
  /** 시스템 브라우저로 열기 */
  openUrl?(url: string): Promise<void>;
  /**
   * 브라우저 칸 주소를 이 화면에서 열 주소로 바꾼다. 데몬 컴퓨터의 `localhost` 개발 서버면 데몬 대리 주소(토큰 포함)를,
   * 바꿀 필요가 없으면(같은 컴퓨터, 공개 주소) null 을 준다. 데몬 부 판 `BROWSER_PROXY_PROTOCOL_MINOR` 부터 된다
   */
  browserProxyUrl?(url: string): Promise<string | null>;
  /** 파일·폴더를 그 종류의 기본 앱으로 열기 (데스크톱만) */
  openPath?(path: string): Promise<void>;
  /**
   * 경로가 있는지 본다. `~` 를 풀고, 상대 경로는 bases(절대 경로) 앞에서부터 붙여 본다.
   * 처음 있는 절대 경로를 돌려주고, 없으면 null (터미널 링크)
   */
  resolvePath(path: string, bases: string[]): Promise<{ path: string; isDir: boolean } | null>;
  /** 세션 에이전트 대화 기록에서 사용자가 붙여 보낸 그림 목록 (보낸 차례대로) */
  agentImages(session: SessionId): Promise<AgentImage[]>;
  /** 그림 하나. thumb 이면 긴 변을 줄인 작은 그림. data 는 base64 */
  agentImage(session: SessionId, id: string, thumb: boolean): Promise<{ mediaType: string; data: string }>;
  /** 붙여넣은 그림을 데몬 쪽 임시 파일로 쓰고 그 경로를 돌려준다. data 는 base64 */
  savePasteImage(data: string, ext: string): Promise<string>;
  /** 세션 셸 밑에서 이름이 names 에 든 프로세스(에이전트)가 도는 세션들 */
  runningAgents(sessions: SessionId[], names: string[]): Promise<{ session: SessionId; name: string }[]>;
  /** 브라우저 칸을 지원하는 껍데기만 둔다 */
  readonly browser?: BrowserHost;
  /**
   * 워크트리를 지운다. force 는 바뀐 파일이 있어도 지우기, forceBranch 는 합치지 않은 브랜치도 지우기.
   * 알릴 것(예: 합치지 않은 브랜치를 남겼다)이 있으면 그 글, 없으면 빈 글을 돌려준다
   */
  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean; forceBranch?: boolean }): Promise<string>;
  /**
   * 설치된 글꼴 파일을 웹 글꼴로 등록한다. WebKit 처럼 사용자 설치 글꼴을 웹에 숨기는 껍데기에서 필요하다.
   * 찾은 글꼴 면(굵기, 기울임) 수를 돌려준다. 없으면 0.
   */
  registerFont?(family: string): Promise<number>;
  /**
   * 앱 화면 전체 배율 (1 이 원래 크기). 껍데기가 웹뷰 확대를 지원할 때만 있다.
   * 없으면(웹) 브라우저가 ⌘+ ⌘- 로 스스로 확대한다
   */
  setUiZoom?(scale: number): Promise<void>;
  /** 배치. workspace 를 비우면 모두 */
  getLayout(workspace?: string): Promise<WorkspaceLayout[]>;
  /** 배치를 바꾼다. 바뀐 배치와 새로 만든 칸을 돌려준다 */
  layout(op: LayoutOp): Promise<LayoutResult>;
  layoutBatch(ops: LayoutOp[]): Promise<LayoutResult>;
  /** 데몬 엔진의 기본 터미널 색 (아직 정한 적 없으면 null) */
  getTerminalColors(): Promise<TerminalColors | null>;
  setTerminalColors(colors: TerminalColors): Promise<void>;
  /** Orca 에 등록한 저장소·워크트리 이름·claude 세션 (읽기만) */
  scanOrca(): Promise<OrcaScan>;
  /** 이 claude 세션으로 떠 있는 claude 를 끝낸다 (Orca 에서 옮겨 올 때) */
  stopClaudeSession(sessionId: string): Promise<void>;
  /** 에이전트를 띄울 때 붙일 옵션 (데몬이 들고 있다) */
  getAgentSettings(): Promise<AgentSettingsState>;
  setAgentSettings(settings: AgentSettings): Promise<AgentSettingsState>;
  /** 사용자 로그인 셸 PATH 에 있는 명령만 돌려준다 (설치된 에이전트 찾기) */
  findCommands(names: string[]): Promise<string[]>;
  /**
   * 운영체제에서 파일을 창으로 끌어 놓았다. 놓은 자리는 창 왼쪽 위 기준 CSS 픽셀.
   * 지원하지 않는 껍데기는 두지 않는다. 돌려준 함수로 끊는다
   */
  onFileDrop?(cb: (paths: string[], x: number, y: number) => void): () => void;
  /** 운영체제 알림을 띄운다. 누르면 onNotificationClick 으로 그 세션을 알린다. 지원하지 않는 껍데기는 두지 않는다 */
  notify?(n: { title: string; subtitle?: string; body: string; session: number; sound: boolean }): Promise<void>;
  onNotificationClick?(cb: (session: number) => void): () => void;
  /** 원격 접속 설정 (데스크톱 껍데기만) */
  readonly remote?: RemoteApi;
  /** 원격 호스트 관리 (데스크톱 껍데기의 로컬 HostApi 만) */
  readonly hosts?: RemoteHostsApi;
  /** 원격으로 붙은 껍데기(웹)나 원격 호스트 HostApi 인지. 화면이 운영체제 기능(폴더 고르기 등)을 대신할 때 본다 */
  readonly isRemote?: boolean;
  /** 원격 호스트 HostApi 면 그 호스트 id (`RemoteHost.id`). 로컬과 웹은 없다 */
  readonly hostId?: string;
  /** Dock 배지 숫자 (0 이면 지운다) */
  setBadge?(count: number): Promise<void>;
  /** 데몬 이벤트 구독. 돌려준 함수로 끊는다 */
  onEvent(cb: (e: DaemonEvent) => void): () => void;
}
