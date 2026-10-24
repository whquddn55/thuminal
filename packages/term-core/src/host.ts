// 앱 껍데기(Tauri, Electron, 브라우저 등)가 제공하는 기능.
//
// 화면 코드는 이 인터페이스로만 데몬과 운영체제에 닿는다. 껍데기를 바꾸면 이 구현만 새로 쓴다.

import type {
  BranchList,
  CreateSession,
  DaemonEvent,
  DirEntry,
  FileContent,
  GitStatus,
  LayoutOp,
  LayoutResult,
  RepoInfo,
  SessionId,
  SessionInfo,
  SnapshotFormat,
  TerminalColors,
  WorkspaceLayout,
  WorktreeInfo,
} from "./protocol";

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
}

/** 워크트리 안 파일 읽기 */
export interface FilesApi {
  list(worktree: string, dir: string): Promise<DirEntry[]>;
  read(worktree: string, file: string): Promise<FileContent>;
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
  createWorktree(repo: string, branch: string, opts?: { base?: string; name?: string }): Promise<WorktreeInfo>;
  updateWorktree(path: string, change: { name?: string; pinned?: boolean }): Promise<void>;
  readonly git: GitApi;
  readonly files: FilesApi;
  /** 운영체제 폴더 고르기 창. 고르지 않으면 null */
  pickFolder(): Promise<string | null>;
  /** Finder 에서 보기 */
  reveal(path: string): Promise<void>;
  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean }): Promise<void>;
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
  /** 사용자 로그인 셸 PATH 에 있는 명령만 돌려준다 (설치된 에이전트 찾기) */
  findCommands(names: string[]): Promise<string[]>;
  /**
   * 운영체제에서 파일을 창으로 끌어 놓았다. 놓은 자리는 창 왼쪽 위 기준 CSS 픽셀.
   * 지원하지 않는 껍데기는 두지 않는다. 돌려준 함수로 끊는다
   */
  onFileDrop?(cb: (paths: string[], x: number, y: number) => void): () => void;
  /** 데몬 이벤트 구독. 돌려준 함수로 끊는다 */
  onEvent(cb: (e: DaemonEvent) => void): () => void;
}
