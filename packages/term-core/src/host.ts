// 앱 껍데기(Tauri, Electron, 브라우저 등)가 제공하는 기능.
//
// 화면 코드는 이 인터페이스로만 데몬과 운영체제에 닿는다. 껍데기를 바꾸면 이 구현만 새로 쓴다.

import type { CreateSession, DaemonEvent, RepoInfo, SessionId, SessionInfo, SnapshotFormat, WorktreeInfo } from "./protocol";

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
  removeRepo(repo: string): Promise<void>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  createWorktree(repo: string, branch: string, base?: string): Promise<WorktreeInfo>;
  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean }): Promise<void>;
  /**
   * 설치된 글꼴 파일을 웹 글꼴로 등록한다. WebKit 처럼 사용자 설치 글꼴을 웹에 숨기는 껍데기에서 필요하다.
   * 찾은 글꼴 면(굵기, 기울임) 수를 돌려준다. 없으면 0.
   */
  registerFont?(family: string): Promise<number>;
  /** 데몬 이벤트 구독. 돌려준 함수로 끊는다 */
  onEvent(cb: (e: DaemonEvent) => void): () => void;
}
