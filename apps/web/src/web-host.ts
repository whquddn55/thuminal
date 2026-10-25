// term-core HostApi 의 웹 구현. 데몬 원격 접속(`/ws`) 웹소켓으로 데몬 프로토콜을 그대로 말한다.
//
// 웹소켓 메시지 하나 = 프레임 하나에서 길이 머리를 뗀 것: [종류 u8][내용]. 데몬 안에서 유닉스 소켓 연결과 똑같이 처리된다.
// - 0 JSON: 요청 `{kind:"request", id, request}` / 응답 `{kind:"response", id, ok|err}` / 이벤트 `{kind:"event", event}`
// - 1 출력 [세션 u64][바이트], 2 입력 [세션 u64][바이트], 3 저장본 [세션 u64][형식 u8][바이트]
// 연결이 끊기면 다시 붙고 `daemon_reconnected` 이벤트를 흘린다 (화면이 다시 붙는다). 폰이 잠들었다 깨면 바로 다시 붙는다.

import type {
  AgentSettings,
  Attachment,
  BranchList,
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
  RepoInfo,
  SearchHit,
  SessionId,
  SessionInfo,
  SnapshotFormat,
  TerminalColors,
  WorkspaceLayout,
  WorktreeInfo,
} from "@thuminal/term-core";

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 4;

const enc = new TextEncoder();
const dec = new TextDecoder();

type Json = Record<string, unknown>;

/** 연결 상태. 화면 위 띠가 본다 */
export type ConnState = "connecting" | "open" | "closed" | "unauthorized";

export class WebHostApi implements HostApi {
  readonly isRemote = true;
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private waits = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  private outputs = new Map<number, (bytes: Uint8Array) => void>();
  private snapshots = new Map<number, Uint8Array>();
  private listeners = new Set<(e: DaemonEvent) => void>();
  private stateListeners = new Set<(s: ConnState) => void>();
  private info: DaemonInfo | null = null;
  private everOpened = false;
  private retry = 0;
  private retryTimer = 0;
  state: ConnState = "connecting";

  constructor(
    /** `http://100.x.y.z:6780` (끝 / 없이) */
    private readonly base: string,
    private readonly token: string,
  ) {
    document.addEventListener("visibilitychange", () => {
      // 폰이 잠들면 웹소켓이 조용히 죽는다. 깨면 바로 다시 붙는다
      if (document.visibilityState === "visible" && this.state === "closed") this.reconnectNow();
    });
  }

  onState(cb: (s: ConnState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.state);
    return () => this.stateListeners.delete(cb);
  }

  private setState(s: ConnState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  private connect(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      this.setState("connecting");
      const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.token)}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let opened = false;
      ws.onopen = async () => {
        opened = true;
        try {
          const r = await this.send({ type: "hello", protocol_major: PROTOCOL_MAJOR, protocol_minor: PROTOCOL_MINOR, client: "web" });
          this.info = { engine: String(r.engine), version: String(r.daemon_version) };
          this.retry = 0;
          this.setState("open");
          const again = this.everOpened;
          this.everOpened = true;
          resolve();
          if (again) for (const l of this.listeners) l({ type: "daemon_reconnected" });
        } catch (e) {
          reject(e as Error);
        }
      };
      ws.onmessage = (e) => this.receive(new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.ready = null;
        for (const w of this.waits.values()) w.reject(new Error("데몬과 연결이 끊겼다"));
        this.waits.clear();
        this.outputs.clear();
        if (!opened) reject(new Error("데몬에 붙지 못했다"));
        void this.afterClose();
      };
    });
    return this.ready;
  }

  /** 끊긴 까닭이 토큰이면 멈추고, 아니면 조금 기다렸다 다시 붙는다 */
  private async afterClose() {
    try {
      const r = await fetch(`${this.base}/api/check?token=${encodeURIComponent(this.token)}`);
      if (r.status === 401) {
        this.setState("unauthorized");
        return;
      }
    } catch {
      // 망이 끊겼다. 아래에서 다시 해 본다
    }
    this.setState("closed");
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.connect().catch(() => {}), delay);
  }

  reconnectNow() {
    clearTimeout(this.retryTimer);
    this.retry = 0;
    void this.connect().catch(() => {});
  }

  private receive(b: Uint8Array) {
    const kind = b[0];
    if (kind === 0) {
      const m = JSON.parse(dec.decode(b.subarray(1))) as Json;
      if (m.kind === "response") {
        const w = this.waits.get(m.id as number);
        if (!w) return;
        this.waits.delete(m.id as number);
        if (m.ok) w.resolve(m.ok as Json);
        else w.reject(new Error(String((m.err as Json | undefined)?.message ?? "데몬 오류")));
      } else if (m.kind === "event") {
        for (const l of this.listeners) l(m.event as DaemonEvent);
      }
      return;
    }
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const session = Number(view.getBigUint64(1));
    if (kind === 1) this.outputs.get(session)?.(b.slice(9));
    else if (kind === 3) this.snapshots.set(session, b.slice(10));
  }

  /** 요청을 보내고 응답 `ok` 를 돌려준다 (붙기 전에는 쓰지 않는다: hello 가 쓴다) */
  private send(request: Json): Promise<Json> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("데몬과 연결이 끊겼다"));
    const id = this.nextId++;
    const body = enc.encode(JSON.stringify({ kind: "request", id, request }));
    const frame = new Uint8Array(1 + body.length);
    frame.set(body, 1);
    return new Promise((resolve, reject) => {
      this.waits.set(id, { resolve, reject });
      ws.send(frame);
    });
  }

  private async req<T>(request: Json, pick: (r: Json) => unknown = () => undefined): Promise<T> {
    await this.connect();
    return pick(await this.send(request)) as T;
  }

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

  async daemon(): Promise<DaemonInfo> {
    await this.connect();
    return this.info!;
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.req({ type: "list_sessions" }, (r) => r.sessions);
  }

  createSession(req: CreateSession): Promise<SessionInfo> {
    return this.req({ type: "create_session", ...req }, (r) => r.session);
  }

  async attach(id: SessionId, format: SnapshotFormat, onOutput: (bytes: Uint8Array) => void): Promise<Attachment> {
    await this.connect();
    // 출력 받을 곳을 먼저 건다. 데몬은 저장본 → 응답 → 출력 순서로 보낸다
    this.outputs.set(id, onOutput);
    let r: Json;
    try {
      r = await this.send({ type: "attach", session: id, snapshot: format });
    } catch (e) {
      this.outputs.delete(id);
      throw e;
    }
    const snapshot = this.snapshots.get(id) ?? new Uint8Array();
    this.snapshots.delete(id);
    return {
      session: r.session as SessionInfo,
      format,
      snapshot,
      detach: async () => {
        this.outputs.delete(id);
        await this.req({ type: "detach", session: id }).catch(() => {});
      },
    };
  }

  async input(id: SessionId, bytes: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(9 + bytes.length);
    frame[0] = 2;
    new DataView(frame.buffer).setBigUint64(1, BigInt(id));
    frame.set(bytes, 9);
    ws.send(frame);
  }

  resize(id: SessionId, cols: number, rows: number): Promise<void> {
    return this.req({ type: "resize", session: id, cols, rows });
  }

  setLabels(id: SessionId, labels: Record<string, string>): Promise<void> {
    return this.req({ type: "set_labels", session: id, labels });
  }

  kill(id: SessionId): Promise<void> {
    return this.req({ type: "kill", session: id });
  }

  remove(id: SessionId): Promise<void> {
    return this.req({ type: "remove", session: id });
  }

  listRepos(): Promise<RepoInfo[]> {
    return this.req({ type: "list_repos" }, (r) => r.repos);
  }

  addRepo(path: string): Promise<RepoInfo> {
    return this.req({ type: "add_repo", path }, (r) => r.repo);
  }

  addRepos(path: string): Promise<RepoInfo[]> {
    return this.req({ type: "add_repos", path }, (r) => r.repos);
  }

  removeRepo(repo: string): Promise<void> {
    return this.req({ type: "remove_repo", repo });
  }

  listWorktrees(): Promise<WorktreeInfo[]> {
    return this.req({ type: "list_worktrees", repo: null }, (r) => r.worktrees);
  }

  createWorktree(repo: string, branch: string, opts?: { base?: string; name?: string; parent?: string }): Promise<WorktreeInfo> {
    return this.req(
      { type: "create_worktree", repo, branch, base: opts?.base ?? null, name: opts?.name ?? null, parent: opts?.parent ?? null },
      (r) => r.worktree,
    );
  }

  updateWorktree(path: string, change: { name?: string; pinned?: boolean; parent?: string | null }): Promise<void> {
    const parent = change.parent === undefined ? null : (change.parent ?? "");
    return this.req({ type: "update_worktree", path, name: change.name ?? null, pinned: change.pinned ?? null, parent });
  }

  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean; forceBranch?: boolean }): Promise<string> {
    return this.req(
      { type: "remove_worktree", repo, path, force: opts.force, delete_branch: opts.deleteBranch, force_branch: opts.forceBranch ?? false },
      (r) => r.text,
    );
  }

  getLayout(workspace?: string): Promise<WorkspaceLayout[]> {
    return this.req({ type: "get_layout", workspace: workspace ?? null }, (r) => r.layouts);
  }

  layout(op: LayoutOp): Promise<LayoutResult> {
    return this.req({ type: "layout", op }, (r) => ({ layouts: r.layouts, created: r.created }));
  }

  layoutBatch(ops: LayoutOp[]): Promise<LayoutResult> {
    return this.req({ type: "layout_batch", ops }, (r) => ({ layouts: r.layouts, created: r.created }));
  }

  getTerminalColors(): Promise<TerminalColors | null> {
    return this.req({ type: "get_terminal_colors" }, (r) => r.colors ?? null);
  }

  setTerminalColors(colors: TerminalColors): Promise<void> {
    return this.req({ type: "set_terminal_colors", colors });
  }

  scanOrca(): Promise<OrcaScan> {
    return this.req({ type: "scan_orca" }, (r) => r.scan);
  }

  stopClaudeSession(sessionId: string): Promise<void> {
    return this.req({ type: "stop_claude_session", session_id: sessionId });
  }

  getAgentSettings(): Promise<AgentSettings> {
    return this.req({ type: "get_agent_settings" }, (r) => r.settings);
  }

  setAgentSettings(settings: AgentSettings): Promise<AgentSettings> {
    return this.req({ type: "set_agent_settings", settings }, (r) => r.settings);
  }

  findCommands(names: string[]): Promise<string[]> {
    return this.req({ type: "find_commands", names }, (r) => r.found);
  }

  /** 브라우저에는 폴더 고르기 창이 없다. 데스크톱의 경로를 글로 받는다 */
  async pickFolder(): Promise<string | null> {
    const p = window.prompt("데스크톱 컴퓨터의 폴더 경로 (예: ~/workspace/my-app)");
    return p?.trim() || null;
  }

  async reveal(): Promise<void> {
    // 원격에서는 데스크톱 Finder 를 열 수 없다
  }

  async openUrl(url: string): Promise<void> {
    window.open(url, "_blank", "noopener");
  }

  /** 데스크톱에 설치된 글꼴 파일을 받아 웹 글꼴로 등록한다 (폰에는 Nerd Font 가 없어 프롬프트 기호가 깨진다) */
  async registerFont(family: string): Promise<number> {
    const q = `token=${encodeURIComponent(this.token)}`;
    const r = await fetch(`${this.base}/api/fonts?${q}&family=${encodeURIComponent(family)}`);
    if (!r.ok) return 0;
    const faces = (await r.json()) as { id: number; weight: number; italic: boolean }[];
    await Promise.all(
      faces.map(async (f) => {
        const face = new FontFace(family, `url(${this.base}/api/font/${f.id}?${q})`, { weight: String(f.weight), style: f.italic ? "italic" : "normal" });
        document.fonts.add(await face.load());
      }),
    );
    return faces.length;
  }

  onEvent(cb: (e: DaemonEvent) => void): () => void {
    this.listeners.add(cb);
    void this.connect().catch(() => {});
    return () => this.listeners.delete(cb);
  }
}
