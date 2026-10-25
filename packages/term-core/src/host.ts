// 앱 껍데기(Tauri, Electron, 브라우저 등)가 제공하는 기능.
//
// 화면 코드는 이 인터페이스로만 데몬과 운영체제에 닿는다. 껍데기를 바꾸면 이 구현만 새로 쓴다.

import type {
  AgentSettings,
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
  getAgentSettings(): Promise<AgentSettings>;
  setAgentSettings(settings: AgentSettings): Promise<AgentSettings>;
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
  /** Dock 배지 숫자 (0 이면 지운다) */
  setBadge?(count: number): Promise<void>;
  /** 데몬 이벤트 구독. 돌려준 함수로 끊는다 */
  onEvent(cb: (e: DaemonEvent) => void): () => void;
}
