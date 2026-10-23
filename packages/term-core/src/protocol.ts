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
}

export type AgentState = "idle" | "working" | "needs_attention";

export interface AgentInfo {
  kind: string;
  session_id: string | null;
  transcript: string | null;
  state: AgentState;
  updated_at: number;
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

export interface FileContent {
  text: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
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
  /** 앱 껍데기가 데몬에 다시 붙었다 (데몬이 다시 떴다). 세션 목록을 다시 읽고 다시 붙는다 */
  | { type: "daemon_reconnected" };
