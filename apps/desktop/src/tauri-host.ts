// term-core HostApi 의 Tauri 구현. src-tauri/src/lib.rs 의 명령을 부른다.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AgentSettings,
  Attachment,
  BranchList,
  BrowserEvent,
  BrowserHost,
  CreateSession,
  DaemonEvent,
  DaemonInfo,
  DirEntry,
  FileContent,
  FilesApi,
  GitApi,
  GitStatus,
  HostApi,
  LayoutOp,
  LayoutResult,
  LineCount,
  OrcaScan,
  RemoteApi,
  RemoteDevice,
  RemoteStatus,
  RepoInfo,
  SearchHit,
  SessionId,
  SessionInfo,
  SnapshotFormat,
  TerminalColors,
  WorkspaceLayout,
  WorktreeInfo,
} from "@thuminal/term-core";

/** 데몬 요청을 그대로 넘긴다 (src-tauri daemon_request). 응답은 `{ type, ... }` 모양이다 */
async function req<T>(request: Record<string, unknown>, pick: (r: Record<string, unknown>) => unknown = () => undefined): Promise<T> {
  const r = await invoke<Record<string, unknown>>("daemon_request", { request });
  return pick(r) as T;
}

export class TauriHostApi implements HostApi {
  readonly git: GitApi = {
    status: (worktree) => req<GitStatus>({ type: "git_status", worktree }, (r) => r.status),
    diff: (worktree, file, staged) => req<string>({ type: "git_diff", worktree, file, staged }, (r) => r.text),
    stage: (worktree, files) => req({ type: "git_stage", worktree, files }),
    unstage: (worktree, files) => req({ type: "git_unstage", worktree, files }),
    discard: (worktree, files) => req({ type: "git_discard", worktree, files }),
    commit: (worktree, message, all) => req<string>({ type: "git_commit", worktree, message, all }, (r) => r.text),
    push: (worktree) => req<string>({ type: "git_push", worktree }, (r) => r.text),
    branches: (repo) => req<BranchList>({ type: "list_branches", repo }, (r) => r.branches),
    lineCounts: (worktree) => req<LineCount[]>({ type: "git_line_counts", worktree }, (r) => r.counts),
  };

  readonly files: FilesApi = {
    list: (worktree, dir) => req<DirEntry[]>({ type: "list_dir", worktree, dir }, (r) => r.entries),
    read: (worktree, file) => req<FileContent>({ type: "read_file", worktree, file }, (r) => r.file),
    search: (worktree, query, caseSensitive) =>
      req({ type: "search_text", worktree, query, case_sensitive: caseSensitive }, (r) => ({ hits: r.hits as SearchHit[], truncated: !!r.truncated })),
    all: (worktree) => req({ type: "list_files", worktree }, (r) => ({ files: r.files as string[], truncated: !!r.truncated })),
  };

  readonly browser: BrowserHost = {
    open: (id, url, at) => invoke("browser_open", { id, url, x: at.x, y: at.y, w: at.width, h: at.height }),
    setBounds: (id, at) => invoke("browser_bounds", { id, x: at.x, y: at.y, w: at.width, h: at.height }),
    setVisible: (id, visible) => invoke("browser_visible", { id, visible }),
    navigate: (id, url) => invoke("browser_navigate", { id, url }),
    go: (id, delta) => invoke("browser_go", { id, delta }),
    reload: (id) => invoke("browser_reload", { id }),
    focus: (id) => invoke("browser_focus", { id }),
    devtools: (id) => invoke("browser_devtools", { id }),
    close: (id) => invoke("browser_close", { id }),
    onEvent: (cb) => {
      let stop: (() => void) | null = null;
      let cancelled = false;
      void listen<BrowserEvent>("thuminal://browser", (e) => cb(e.payload)).then((un) => (cancelled ? un() : (stop = un)));
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };

  readonly remote: RemoteApi = {
    status: () => req<RemoteStatus>({ type: "get_remote" }, (r) => r.remote),
    set: (c) => req<RemoteStatus>({ type: "set_remote", enabled: c.enabled ?? null, port: c.port ?? null, lan: c.lan ?? null }, (r) => r.remote),
    pair: (name) => req({ type: "pair_remote", name }, (r) => ({ device: r.device as RemoteDevice, urls: r.urls as string[] })),
    removeDevice: (id) => req<RemoteStatus>({ type: "remove_remote_device", id }, (r) => r.remote),
  };

  openUrl(url: string): Promise<void> {
    return openUrl(url);
  }

  private listeners = new Set<(e: DaemonEvent) => void>();
  private subscribed: Promise<void> | null = null;
  private info: Promise<DaemonInfo> | null = null;

  daemon(): Promise<DaemonInfo> {
    this.info ??= invoke<DaemonInfo>("daemon_info");
    return this.info;
  }

  listSessions(): Promise<SessionInfo[]> {
    return invoke("list_sessions");
  }

  createSession(req: CreateSession): Promise<SessionInfo> {
    return invoke("create_session", { req });
  }

  async attach(id: SessionId, format: SnapshotFormat, onOutput: (bytes: Uint8Array) => void): Promise<Attachment> {
    // 채널의 첫 메시지는 저장본, 그 뒤는 출력이다 (src-tauri attach 명령 참고)
    let snapshot: Uint8Array | null = null;
    let resolveSnapshot!: () => void;
    const gotSnapshot = new Promise<void>((r) => (resolveSnapshot = r));
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      if (snapshot === null) {
        snapshot = bytes;
        resolveSnapshot();
      } else {
        onOutput(bytes);
      }
    };
    const r = await invoke<{ session: SessionInfo; format: SnapshotFormat }>("attach", { id, format, channel });
    await gotSnapshot;
    return {
      session: r.session,
      format: r.format,
      snapshot: snapshot!,
      detach: () => invoke("detach", { id }),
    };
  }

  input(id: SessionId, bytes: Uint8Array): Promise<void> {
    return invoke("input", { id, data: Array.from(bytes) });
  }

  resize(id: SessionId, cols: number, rows: number): Promise<void> {
    return invoke("resize", { id, cols, rows });
  }

  setLabels(id: SessionId, labels: Record<string, string>): Promise<void> {
    return invoke("set_labels", { id, labels });
  }

  kill(id: SessionId): Promise<void> {
    return invoke("kill", { id });
  }

  remove(id: SessionId): Promise<void> {
    return invoke("remove", { id });
  }

  listRepos(): Promise<RepoInfo[]> {
    return invoke("list_repos");
  }

  addRepo(path: string): Promise<RepoInfo> {
    return invoke("add_repo", { path });
  }

  removeRepo(repo: string): Promise<void> {
    return invoke("remove_repo", { repo });
  }

  listWorktrees(): Promise<WorktreeInfo[]> {
    return invoke("list_worktrees");
  }

  createWorktree(repo: string, branch: string, opts?: { base?: string; name?: string; parent?: string }): Promise<WorktreeInfo> {
    return req<WorktreeInfo>(
      { type: "create_worktree", repo, branch, base: opts?.base ?? null, name: opts?.name ?? null, parent: opts?.parent ?? null },
      (r) => r.worktree,
    );
  }

  addRepos(path: string): Promise<RepoInfo[]> {
    return req<RepoInfo[]>({ type: "add_repos", path }, (r) => r.repos);
  }

  updateWorktree(path: string, change: { name?: string; pinned?: boolean; parent?: string | null }): Promise<void> {
    // 데몬은 빈 글을 "부모에서 떼기" 로 받는다
    const parent = change.parent === undefined ? null : (change.parent ?? "");
    return req({ type: "update_worktree", path, name: change.name ?? null, pinned: change.pinned ?? null, parent });
  }

  getLayout(workspace?: string): Promise<WorkspaceLayout[]> {
    return req<WorkspaceLayout[]>({ type: "get_layout", workspace: workspace ?? null }, (r) => r.layouts);
  }

  layout(op: LayoutOp): Promise<LayoutResult> {
    return req<LayoutResult>({ type: "layout", op }, (r) => ({ layouts: r.layouts, created: r.created }));
  }

  layoutBatch(ops: LayoutOp[]): Promise<LayoutResult> {
    return req<LayoutResult>({ type: "layout_batch", ops }, (r) => ({ layouts: r.layouts, created: r.created }));
  }

  getTerminalColors(): Promise<TerminalColors | null> {
    return req<TerminalColors | null>({ type: "get_terminal_colors" }, (r) => r.colors ?? null);
  }

  setTerminalColors(colors: TerminalColors): Promise<void> {
    return req({ type: "set_terminal_colors", colors });
  }

  scanOrca(): Promise<OrcaScan> {
    return req<OrcaScan>({ type: "scan_orca" }, (r) => r.scan);
  }

  stopClaudeSession(sessionId: string): Promise<void> {
    return req({ type: "stop_claude_session", session_id: sessionId });
  }

  getAgentSettings(): Promise<AgentSettings> {
    return req<AgentSettings>({ type: "get_agent_settings" }, (r) => r.settings);
  }

  setAgentSettings(settings: AgentSettings): Promise<AgentSettings> {
    return req<AgentSettings>({ type: "set_agent_settings", settings }, (r) => r.settings);
  }

  findCommands(names: string[]): Promise<string[]> {
    return req<string[]>({ type: "find_commands", names }, (r) => r.found);
  }

  async pickFolder(): Promise<string | null> {
    const r = await openDialog({ directory: true, multiple: false, title: "프로젝트 폴더 고르기" });
    return typeof r === "string" ? r : null;
  }

  reveal(path: string): Promise<void> {
    return revealItemInDir(path);
  }

  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean; forceBranch?: boolean }): Promise<string> {
    return invoke("remove_worktree", { repo, path, force: opts.force, deleteBranch: opts.deleteBranch, forceBranch: opts.forceBranch ?? false });
  }

  async registerFont(family: string): Promise<number> {
    const faces = await invoke<{ id: number; weight: number; italic: boolean }[]>("font_faces", { family });
    await Promise.all(
      faces.map(async (f) => {
        const data = await invoke<ArrayBuffer>("font_face_data", { id: f.id });
        const face = new FontFace(family, data, { weight: String(f.weight), style: f.italic ? "italic" : "normal" });
        document.fonts.add(await face.load());
      }),
    );
    return faces.length;
  }

  onFileDrop(cb: (paths: string[], x: number, y: number) => void): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        // 놓은 자리는 기기 픽셀이다
        const r = window.devicePixelRatio || 1;
        cb(e.payload.paths, e.payload.position.x / r, e.payload.position.y / r);
      })
      .then((un) => (cancelled ? un() : (stop = un)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  notify(n: { title: string; subtitle?: string; body: string; session: number; sound: boolean }): Promise<void> {
    return invoke("notify", { title: n.title, subtitle: n.subtitle ?? null, body: n.body, session: n.session, sound: n.sound });
  }

  onNotificationClick(cb: (session: number) => void): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void listen<{ session: number }>("thuminal://notification-click", (e) => cb(e.payload.session)).then((un) => (cancelled ? un() : (stop = un)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  setBadge(count: number): Promise<void> {
    return invoke("set_badge", { count });
  }

  onEvent(cb: (e: DaemonEvent) => void): () => void {
    this.listeners.add(cb);
    this.subscribed ??= (async () => {
      const channel = new Channel<DaemonEvent>();
      channel.onmessage = (e) => {
        for (const l of this.listeners) l(e);
      };
      await invoke("subscribe_events", { channel });
    })();
    return () => this.listeners.delete(cb);
  }
}
