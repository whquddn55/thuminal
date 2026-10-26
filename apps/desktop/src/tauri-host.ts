// term-core HostApi 의 Tauri 구현. src-tauri/src/lib.rs 의 명령을 부른다.
//
// 한 클래스로 로컬과 원격 호스트를 같이 맡는다. `new TauriHostApi()` 는 로컬 데몬, `hosts.forHost(id)` 는 그 원격 호스트 데몬으로
// 보낸다 (데몬에 닿는 명령마다 `host` 인자를 싣는다. 없으면 로컬). 알림·배지·글꼴·배율·파일 끌어 놓기는 창 하나의
// 기능이라 원격 HostApi 에서도 로컬 것과 같다. 브라우저 칸은 칸 번호가 호스트마다 따로라 호스트를 실어 가른다.
// Finder·기본 앱·폴더 고르기처럼 로컬 경로를 쓰는 것은 원격이면 오류다.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AgentImage,
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
  RemoteHost,
  RemoteHostsApi,
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
} from "@thuminal/term-core";

/** 앱 화면 배율. 창 하나의 것이라 로컬·원격 HostApi 가 같이 본다 */
let uiZoom = 1;

const remoteOnly = (what: string) => Promise.reject(new Error(`원격 컴퓨터에서는 아직 ${what}을(를) 할 수 없다`));

/** 원격 호스트 관리 (src-tauri hosts_* 명령). 호스트마다 HostApi 를 하나씩 만들어 둔다 */
class TauriHosts implements RemoteHostsApi {
  private apis = new Map<string, TauriHostApi>();
  private listeners = new Set<(hosts: RemoteHost[]) => void>();
  private last: RemoteHost[] | null = null;
  private subscribed: Promise<void> | null = null;

  list(): Promise<RemoteHost[]> {
    return invoke("hosts_list");
  }

  add(url: string, name?: string): Promise<RemoteHost> {
    return invoke("hosts_add", { url, name: name ?? null });
  }

  remove(id: string): Promise<void> {
    this.apis.delete(id);
    return invoke("hosts_remove", { id });
  }

  reconnect(id: string): Promise<void> {
    return invoke("hosts_reconnect", { id });
  }

  onChange(cb: (hosts: RemoteHost[]) => void): () => void {
    this.listeners.add(cb);
    if (this.last) cb(this.last);
    this.subscribed ??= (async () => {
      const channel = new Channel<RemoteHost[]>();
      channel.onmessage = (hosts) => {
        this.last = hosts;
        for (const l of this.listeners) l(hosts);
      };
      await invoke("hosts_subscribe", { channel });
    })().catch((e) => {
      this.subscribed = null;
      console.warn("원격 호스트 목록을 구독하지 못했다", e);
    });
    return () => this.listeners.delete(cb);
  }

  forHost(id: string): HostApi {
    let api = this.apis.get(id);
    if (!api) {
      api = new TauriHostApi(id);
      this.apis.set(id, api);
    }
    return api;
  }
}

export class TauriHostApi implements HostApi {
  readonly isRemote: boolean;
  readonly hosts?: RemoteHostsApi;
  readonly remote?: RemoteApi;

  /** hostId 를 비우면 로컬 데몬. 원격은 `hosts.forHost(id)` 로 만든다 */
  constructor(readonly hostId?: string) {
    this.isRemote = hostId !== undefined;
    if (!this.isRemote) {
      this.hosts = new TauriHosts();
      // 원격 접속 설정은 이 컴퓨터 데몬 것만 (원격 연결은 데몬이 받지 않는다)
      this.remote = {
        status: () => this.req<RemoteStatus>({ type: "get_remote" }, (r) => r.remote),
        set: (c) => this.req<RemoteStatus>({ type: "set_remote", enabled: c.enabled ?? null, port: c.port ?? null, lan: c.lan ?? null }, (r) => r.remote),
        pair: (name) => this.req({ type: "pair_remote", name }, (r) => ({ device: r.device as RemoteDevice, urls: r.urls as string[] })),
        removeDevice: (id) => this.req<RemoteStatus>({ type: "remove_remote_device", id }, (r) => r.remote),
      };
    }
  }

  /** 이 호스트 데몬으로 가는 Tauri 명령. `host` 가 undefined 면 JSON 에서 빠져 로컬이 된다 */
  private call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>(cmd, { ...args, host: this.hostId });
  }

  /** 데몬 요청을 그대로 넘긴다 (src-tauri daemon_request). 응답은 `{ type, ... }` 모양이다 */
  private async req<T>(request: Record<string, unknown>, pick: (r: Record<string, unknown>) => unknown = () => undefined): Promise<T> {
    const r = await this.call<Record<string, unknown>>("daemon_request", { request });
    return pick(r) as T;
  }

  /** 브라우저 칸(네이티브 웹뷰)은 창 좌표로 놓으므로 DOM 좌표에 앱 화면 배율을 곱한다 */
  private readonly at = (r: { x: number; y: number; width: number; height: number }) => {
    const z = uiZoom;
    return { x: r.x * z, y: r.y * z, w: r.width * z, h: r.height * z };
  };

  readonly git: GitApi = {
    status: (worktree) => this.req<GitStatus>({ type: "git_status", worktree }, (r) => r.status),
    diff: (worktree, file, staged) => this.req<string>({ type: "git_diff", worktree, file, staged }, (r) => r.text),
    stage: (worktree, files) => this.req({ type: "git_stage", worktree, files }),
    unstage: (worktree, files) => this.req({ type: "git_unstage", worktree, files }),
    discard: (worktree, files) => this.req({ type: "git_discard", worktree, files }),
    commit: (worktree, message, all) => this.req<string>({ type: "git_commit", worktree, message, all }, (r) => r.text),
    push: (worktree) => this.req<string>({ type: "git_push", worktree }, (r) => r.text),
    branches: (repo) => this.req<BranchList>({ type: "list_branches", repo }, (r) => r.branches),
    lineCounts: (worktree) => this.req<LineCount[]>({ type: "git_line_counts", worktree }, (r) => r.counts),
  };

  readonly files: FilesApi = {
    list: (worktree, dir) => this.req<DirEntry[]>({ type: "list_dir", worktree, dir }, (r) => r.entries),
    read: (worktree, file) => this.req<FileContent>({ type: "read_file", worktree, file }, (r) => r.file),
    search: (worktree, query, caseSensitive) =>
      this.req({ type: "search_text", worktree, query, case_sensitive: caseSensitive }, (r) => ({ hits: r.hits as SearchHit[], truncated: !!r.truncated })),
    all: (worktree) => this.req({ type: "list_files", worktree }, (r) => ({ files: r.files as string[], truncated: !!r.truncated })),
  };

  /**
   * 브라우저 칸. 칸 번호는 호스트마다 따로라 웹뷰 이름·이벤트에 호스트를 싣는다 (src-tauri browser.rs).
   * 웹뷰 자체는 이 컴퓨터에 뜨므로 원격 칸에서 연 localhost 는 원격이 아니라 이 컴퓨터를 가리킨다
   */
  readonly browser: BrowserHost = {
    open: (id, url, at) => this.call("browser_open", { id, url, ...this.at(at) }),
    setBounds: (id, at) => this.call("browser_bounds", { id, ...this.at(at) }),
    setVisible: (id, visible) => this.call("browser_visible", { id, visible }),
    navigate: (id, url) => this.call("browser_navigate", { id, url }),
    go: (id, delta) => this.call("browser_go", { id, delta }),
    reload: (id) => this.call("browser_reload", { id }),
    focus: (id) => this.call("browser_focus", { id }),
    devtools: (id) => this.call("browser_devtools", { id }),
    close: (id) => this.call("browser_close", { id }),
    onEvent: (cb) => {
      let stop: (() => void) | null = null;
      let cancelled = false;
      const name = this.hostId ? `thuminal://browser/${this.hostId}` : "thuminal://browser";
      void listen<BrowserEvent>(name, (e) => cb(e.payload)).then((un) => (cancelled ? un() : (stop = un)));
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };

  openUrl(url: string): Promise<void> {
    return openUrl(url);
  }

  private listeners = new Set<(e: DaemonEvent) => void>();
  private subscribed: Promise<void> | null = null;
  private info: Promise<DaemonInfo> | null = null;

  daemon(): Promise<DaemonInfo> {
    // 실패(원격이 끊겨 있다)는 남기지 않는다
    this.info ??= this.call<DaemonInfo>("daemon_info").catch((e) => {
      this.info = null;
      throw e;
    });
    return this.info;
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.call("list_sessions");
  }

  createSession(req: CreateSession): Promise<SessionInfo> {
    return this.call("create_session", { req });
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
    const r = await this.call<{ session: SessionInfo; format: SnapshotFormat }>("attach", { id, format, channel });
    await gotSnapshot;
    return {
      session: r.session,
      format: r.format,
      snapshot: snapshot!,
      detach: () => this.call("detach", { id }),
    };
  }

  input(id: SessionId, bytes: Uint8Array): Promise<void> {
    return this.call("input", { id, data: Array.from(bytes) });
  }

  resize(id: SessionId, cols: number, rows: number): Promise<void> {
    return this.call("resize", { id, cols, rows });
  }

  setLabels(id: SessionId, labels: Record<string, string>): Promise<void> {
    return this.call("set_labels", { id, labels });
  }

  kill(id: SessionId): Promise<void> {
    return this.call("kill", { id });
  }

  remove(id: SessionId): Promise<void> {
    return this.call("remove", { id });
  }

  listRepos(): Promise<RepoInfo[]> {
    return this.call("list_repos");
  }

  addRepo(path: string): Promise<RepoInfo> {
    return this.call("add_repo", { path });
  }

  removeRepo(repo: string): Promise<void> {
    return this.call("remove_repo", { repo });
  }

  repoIcon(repo: string): Promise<RepoIcon | null> {
    return this.req({ type: "repo_icon", repo }, (r) => r.icon ?? null);
  }

  listGroups(): Promise<RepoGroup[]> {
    return this.req<RepoGroup[]>({ type: "list_groups" }, (r) => r.groups);
  }

  setGroups(groups: RepoGroup[]): Promise<RepoGroup[]> {
    return this.req<RepoGroup[]>({ type: "set_groups", groups }, (r) => r.groups);
  }

  listWorktrees(): Promise<WorktreeInfo[]> {
    return this.call("list_worktrees");
  }

  createWorktree(repo: string, branch: string, opts?: { base?: string; name?: string; parent?: string }): Promise<WorktreeInfo> {
    return this.req<WorktreeInfo>(
      { type: "create_worktree", repo, branch, base: opts?.base ?? null, name: opts?.name ?? null, parent: opts?.parent ?? null },
      (r) => r.worktree,
    );
  }

  addRepos(path: string): Promise<RepoInfo[]> {
    return this.req<RepoInfo[]>({ type: "add_repos", path }, (r) => r.repos);
  }

  updateWorktree(path: string, change: { name?: string; pinned?: boolean; parent?: string | null }): Promise<void> {
    // 데몬은 빈 글을 "부모에서 떼기" 로 받는다
    const parent = change.parent === undefined ? null : (change.parent ?? "");
    return this.req({ type: "update_worktree", path, name: change.name ?? null, pinned: change.pinned ?? null, parent });
  }

  getLayout(workspace?: string): Promise<WorkspaceLayout[]> {
    return this.req<WorkspaceLayout[]>({ type: "get_layout", workspace: workspace ?? null }, (r) => r.layouts);
  }

  layout(op: LayoutOp): Promise<LayoutResult> {
    return this.req<LayoutResult>({ type: "layout", op }, (r) => ({ layouts: r.layouts, created: r.created }));
  }

  layoutBatch(ops: LayoutOp[]): Promise<LayoutResult> {
    return this.req<LayoutResult>({ type: "layout_batch", ops }, (r) => ({ layouts: r.layouts, created: r.created }));
  }

  getTerminalColors(): Promise<TerminalColors | null> {
    return this.req<TerminalColors | null>({ type: "get_terminal_colors" }, (r) => r.colors ?? null);
  }

  setTerminalColors(colors: TerminalColors): Promise<void> {
    // 원격 터미널 색은 원격 설정 그대로 둔다 (그 컴퓨터 앱의 테마와 다투지 않는다)
    if (this.isRemote) return Promise.resolve();
    return this.req({ type: "set_terminal_colors", colors });
  }

  scanOrca(): Promise<OrcaScan> {
    return this.req<OrcaScan>({ type: "scan_orca" }, (r) => r.scan);
  }

  stopClaudeSession(sessionId: string): Promise<void> {
    return this.req({ type: "stop_claude_session", session_id: sessionId });
  }

  getAgentSettings(): Promise<AgentSettings> {
    return this.req<AgentSettings>({ type: "get_agent_settings" }, (r) => r.settings);
  }

  setAgentSettings(settings: AgentSettings): Promise<AgentSettings> {
    return this.req<AgentSettings>({ type: "set_agent_settings", settings }, (r) => r.settings);
  }

  openPath(path: string): Promise<void> {
    if (this.isRemote) return remoteOnly("기본 앱으로 열기");
    return openPath(path);
  }

  resolvePath(path: string, bases: string[]): Promise<{ path: string; isDir: boolean } | null> {
    return this.req({ type: "resolve_path", path, bases }, (r) => (r.path ? { path: String(r.path), isDir: !!r.is_dir } : null));
  }

  agentImages(session: SessionId): Promise<AgentImage[]> {
    return this.req({ type: "agent_images", session }, (r) => r.images);
  }

  agentImage(session: SessionId, id: string, thumb: boolean): Promise<{ mediaType: string; data: string }> {
    return this.req({ type: "agent_image", session, id, thumb }, (r) => ({ mediaType: String(r.media_type), data: String(r.data) }));
  }

  savePasteImage(data: string, ext: string): Promise<string> {
    return this.req({ type: "save_paste_image", data, ext }, (r) => String(r.path));
  }

  runningAgents(sessions: SessionId[], names: string[]): Promise<{ session: SessionId; name: string }[]> {
    return this.req({ type: "running_agents", sessions, names }, (r) => r.found);
  }

  findCommands(names: string[]): Promise<string[]> {
    return this.req<string[]>({ type: "find_commands", names }, (r) => r.found);
  }

  async pickFolder(): Promise<string | null> {
    if (this.isRemote) return remoteOnly("폴더 고르기");
    const r = await openDialog({ directory: true, multiple: false, title: "프로젝트 폴더 고르기" });
    return typeof r === "string" ? r : null;
  }

  reveal(path: string): Promise<void> {
    if (this.isRemote) return remoteOnly("Finder 에서 보기");
    return revealItemInDir(path);
  }

  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean; forceBranch?: boolean }): Promise<string> {
    return this.call("remove_worktree", { repo, path, force: opts.force, deleteBranch: opts.deleteBranch, forceBranch: opts.forceBranch ?? false });
  }

  async setUiZoom(scale: number): Promise<void> {
    uiZoom = scale;
    await invoke("set_ui_zoom", { scale });
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
      await this.call("subscribe_events", { channel });
    })().catch((e) => {
      this.subscribed = null;
      console.warn("데몬 이벤트를 구독하지 못했다", this.hostId ?? "로컬", e);
    });
    return () => this.listeners.delete(cb);
  }
}
