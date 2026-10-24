// 화면 상태 (zustand 하나) 와 그 상태를 바꾸는 동작.
//
// - 저장소, 워크트리, git 상태, 세션, 배치는 데몬 것을 받아 들고 있기만 한다. 배치는 데몬이 바꾸고 이벤트로 알린다.
// - 고른 워크트리, 열린 창, 플로팅 패널 자리, 테마 설정처럼 화면에만 있는 것은 여기서 정한다.
// - 터미널 컨트롤러(엔진, 붙기)는 상태가 아니라서 zustand 밖에 둔다.

import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  type DaemonEvent,
  FLOATING_WORKSPACE,
  type GitStatus,
  type LayoutOp,
  OTHER_WORKSPACE,
  type PaneRef,
  type RepoInfo,
  type SessionId,
  type SessionInfo,
  type Side,
  type Spawn,
  type WorkspaceId,
  type WorkspaceLayout,
  type WorktreeInfo,
} from "@thuminal/term-core";

import { activeTab, focusedPane, paneOfSession, panesOf, sameDoc, sessionsOf } from "./layout";
import type { Services } from "./services";
import { TerminalController } from "./terminal-controller";
import { applyTheme, loadThemeSettings, saveThemeSettings, type ThemeSettings } from "./theme";

export { FLOATING_WORKSPACE, OTHER_WORKSPACE };

/** 플로팅 터미널 세션 꼬리표 (데몬이 이 꼬리표로 플로팅 워크스페이스에 넣는다) */
export const FLOATING_LABEL = "floating";

export type Panel = "files" | "changes" | null;

export interface NewWorktree {
  repo: string;
  name: string;
  branch: string;
  base?: string;
  /** 처음 띄울 것 */
  start: "shell" | "claude" | "none";
}

export type Dialog =
  | { kind: "new-worktree"; repo: string }
  | { kind: "delete-worktree"; worktree: WorktreeInfo }
  | { kind: "jump" }
  | { kind: "settings" }
  | null;

export interface FloatingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingState {
  open: boolean;
  /** 창 오른쪽 아래 기준이 아니라 창 왼쪽 위 기준 자리 (CSS 픽셀). null 이면 처음 자리 */
  rect: FloatingRect | null;
  maximized: boolean;
}

export interface AppState {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  sessions: Record<SessionId, SessionInfo>;
  status: Record<string, GitStatus>;
  layouts: Record<WorkspaceId, WorkspaceLayout>;
  /** 고른 워크스페이스 (워크트리 경로나 OTHER_WORKSPACE) */
  active: WorkspaceId;
  panel: Panel;
  floating: FloatingState;
  /** 키보드가 가는 곳 */
  focusArea: "main" | "floating";
  dialog: Dialog;
  theme: ThemeSettings;
  /** 시스템 다크 모드 여부 (테마 설정이 시스템 따라가기일 때 쓴다) */
  systemDark: boolean;
  sidebarWidth: number;
  /** 워크스페이스마다 마지막으로 본 때 (ms) */
  seen: Record<WorkspaceId, number>;
  /** 만드는 중인 워크트리 */
  creating: { repo: string; branch: string }[];
  /** 데몬에 다시 붙을 때마다 는다 (세션 번호가 같아도 다시 붙게 한다) */
  generation: number;
  error: string | null;
}

export const worktreeTitle = (w: WorktreeInfo) => w.name || w.branch || w.path.split("/").pop() || w.path;

const FLOATING_KEY = "thuminal.floating";
const SIDEBAR_KEY = "thuminal.sidebarWidth";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

const byId = (id: number): PaneRef => ({ by: "id", value: id });

export class AppModel {
  readonly store: StoreApi<AppState>;
  private readonly controllers = new Map<SessionId, TerminalController>();
  private timers: number[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(readonly services: Services) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    this.store = createStore<AppState>(() => ({
      repos: [],
      worktrees: [],
      sessions: {},
      status: {},
      layouts: {},
      active: OTHER_WORKSPACE,
      panel: null,
      floating: { ...loadJson<FloatingState>(FLOATING_KEY, { open: false, rect: null, maximized: false }), open: false },
      focusArea: "main",
      dialog: null,
      theme: loadThemeSettings(),
      systemDark: media.matches,
      sidebarWidth: Number(localStorage.getItem(SIDEBAR_KEY)) || 280,
      seen: {},
      creating: [],
      generation: 0,
      error: null,
    }));
    media.addEventListener("change", (e) => {
      this.set({ systemDark: e.matches });
      this.applyTheme();
    });
  }

  get = () => this.store.getState();
  private set = (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => this.store.setState(p);

  async start(): Promise<void> {
    const host = this.services.host;
    this.unsubscribe = host.onEvent((e) => this.onEvent(e));
    try {
      await this.reloadAll();
      // 처음에는 터미널이 있는 첫 워크트리를 고른다
      const { worktrees, layouts } = this.get();
      const first = worktrees.find((w) => (layouts[w.path]?.tabs.length ?? 0) > 0) ?? worktrees[0];
      if (first) this.set({ active: first.path });
    } catch (e) {
      this.fail(e);
    }
    this.markSeen();
    void this.applyTheme();
    void this.refreshStatus();
    // git 상태: 지금 워크트리는 2초, 모두는 4초마다
    this.timers.push(window.setInterval(() => void this.refreshStatus(this.get().active), 2000));
    this.timers.push(window.setInterval(() => void this.refreshStatus(), 4000));
  }

  stop() {
    for (const t of this.timers) window.clearInterval(t);
    this.unsubscribe?.();
  }

  private async reloadAll() {
    const host = this.services.host;
    const [sessions, repos, worktrees, layouts] = await Promise.all([host.listSessions(), host.listRepos(), host.listWorktrees(), host.getLayout()]);
    this.set({
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
      repos,
      worktrees,
      layouts: Object.fromEntries(layouts.map((l) => [l.workspace, l])),
    });
  }

  private async refreshWorkspace() {
    const [repos, worktrees] = await Promise.all([this.services.host.listRepos(), this.services.host.listWorktrees()]);
    this.set({ repos, worktrees });
  }

  /** git 상태를 다시 읽는다. `only` 를 주면 그 워크트리만 */
  async refreshStatus(only?: string) {
    const { worktrees } = this.get();
    const targets = only !== undefined ? worktrees.filter((w) => w.path === only) : worktrees;
    const next: Record<string, GitStatus> = {};
    await Promise.all(
      targets.map(async (w) => {
        try {
          const st = await this.services.host.git.status(w.path);
          if (JSON.stringify(st) !== JSON.stringify(this.get().status[w.path])) next[w.path] = st;
        } catch {
          // 지워지는 중인 워크트리 등은 넘어간다
        }
      }),
    );
    if (Object.keys(next).length) this.set((s) => ({ status: { ...s.status, ...next } }));
  }

  private onEvent(e: DaemonEvent) {
    switch (e.type) {
      case "session_created":
      case "session_updated":
        this.set((s) => ({ sessions: { ...s.sessions, [e.session.id]: e.session } }));
        return;
      case "session_exited":
        this.set((s) => {
          const cur = s.sessions[e.session];
          return cur ? { sessions: { ...s.sessions, [e.session]: { ...cur, state: { state: "exited", code: e.code } } } } : {};
        });
        return;
      case "session_removed": {
        this.set((s) => {
          const sessions = { ...s.sessions };
          delete sessions[e.session];
          return { sessions };
        });
        void this.controllers.get(e.session)?.dispose();
        this.controllers.delete(e.session);
        return;
      }
      case "layout_changed":
        this.set((s) => ({ layouts: { ...s.layouts, [e.layout.workspace]: e.layout } }));
        return;
      case "layout_removed":
        this.set((s) => {
          const layouts = { ...s.layouts };
          delete layouts[e.workspace];
          return { layouts };
        });
        return;
      case "terminal_colors_changed":
        // 다른 창이나 CLI 가 바꿨다. 화면 테마는 앱 설정이 정하므로 따로 하지 않는다
        return;
      case "workspace_changed":
        void this.refreshWorkspace().then(
          () => void this.refreshStatus(),
          (err) => this.fail(err),
        );
        return;
      case "git_changed":
        void this.refreshStatus(e.worktree);
        return;
      case "daemon_reconnected":
        void this.reload();
        return;
    }
  }

  /** 데몬이 다시 떴다: 붙어 있던 터미널을 모두 놓고 처음부터 다시 읽는다 */
  private async reload() {
    for (const c of this.controllers.values()) void c.dispose();
    this.controllers.clear();
    this.set((s) => ({ generation: s.generation + 1, sessions: {} }));
    try {
      await this.reloadAll();
      void this.applyTheme();
    } catch (e) {
      this.fail(e);
    }
  }

  fail = (e: unknown) => {
    console.error("[thuminal]", e);
    this.set({ error: String(e) });
  };

  clearError = () => this.set({ error: null });

  // ---- 터미널 ----

  /** 칸을 처음 볼 때 한 번 붙는다. 그 뒤로는 세션이 없어질 때까지 붙어 있다 */
  controller(id: SessionId): TerminalController {
    let c = this.controllers.get(id);
    if (!c) {
      c = new TerminalController(this.services, id);
      c.setColors(this.engineColors);
      this.controllers.set(id, c);
      c.open().catch((e) => this.fail(`세션 ${id} 에 붙지 못했다: ${e}`));
    }
    return c;
  }

  private engineColors: Parameters<TerminalController["setColors"]>[0] = null;

  // ---- 워크스페이스 ----

  workspaceOf(session: SessionId): WorkspaceId | null {
    return paneOfSession(Object.values(this.get().layouts), session)?.layout.workspace ?? null;
  }

  /** 마지막으로 본 뒤 출력이 있었는지 (사이드바에서 굵게, 종이 보인다) */
  unread(ws: WorkspaceId, s: AppState = this.get()): boolean {
    if (ws === s.active) return false;
    const seen = s.seen[ws] ?? 0;
    return sessionsOf(s.layouts[ws]).some((id) => (s.sessions[id]?.last_output_at ?? 0) > seen + 1500);
  }

  private markSeen() {
    const { active } = this.get();
    this.set((s) => ({ seen: { ...s.seen, [active]: Date.now() } }));
  }

  select = (ws: WorkspaceId) => {
    this.markSeen();
    this.set({ active: ws, focusArea: "main" });
    this.markSeen();
    void this.refreshStatus(ws);
  };

  setPanel = (p: Panel) => this.set((s) => ({ panel: s.panel === p ? null : p }));
  setDialog = (d: Dialog) => this.set({ dialog: d });
  setFocusArea = (a: AppState["focusArea"]) => this.set({ focusArea: a });

  setSidebarWidth = (w: number) => {
    const width = Math.round(Math.min(500, Math.max(200, w)));
    localStorage.setItem(SIDEBAR_KEY, String(width));
    this.set({ sidebarWidth: width });
  };

  // ---- 배치 (데몬에 부탁하고, 돌아온 배치를 바로 끼운다. 같은 것이 이벤트로도 온다) ----

  async op(op: LayoutOp): Promise<number[]> {
    try {
      const r = await this.services.host.layout(op);
      this.set((s) => ({ layouts: { ...s.layouts, ...Object.fromEntries(r.layouts.map((l) => [l.workspace, l])) } }));
      return r.created;
    } catch (e) {
      this.fail(e);
      return [];
    }
  }

  /** 키보드 단축키가 다룰 워크스페이스 */
  currentWorkspace(): WorkspaceId {
    const s = this.get();
    return s.floating.open && s.focusArea === "floating" ? FLOATING_WORKSPACE : s.active;
  }

  /** 지금 워크스페이스에서 포커스된 칸 */
  currentPane(ws: WorkspaceId = this.currentWorkspace()): PaneRef | null {
    const p = focusedPane(activeTab(this.get().layouts[ws]));
    return p ? byId(p.id) : null;
  }

  /** 새 탭. 워크트리면 그 폴더에서, 아니면 홈에서 */
  newTab = async (ws: WorkspaceId = this.currentWorkspace(), input?: string) => {
    const spawn: Spawn = { input: input ?? null, cwd: ws.startsWith("/") ? ws : null };
    await this.op({ op: "new_tab", workspace: ws, spawn });
  };

  split = async (side: Side, target: PaneRef | null = this.currentPane()) => {
    if (!target) return this.newTab();
    await this.op({ op: "split", target, side });
  };

  /** ⌘W: 칸 닫기 (탭의 마지막 칸이면 탭이 닫힌다) */
  closeCurrent = async () => {
    const t = this.currentPane();
    if (t) await this.op({ op: "close_pane", target: t });
  };

  focusPane = (id: number) => void this.op({ op: "focus", target: byId(id) });
  focusDir = (side: Side) => {
    const t = this.currentPane();
    if (t) void this.op({ op: "focus_dir", from: t, side });
  };
  focusCycle = (delta: number) => {
    const t = this.currentPane();
    if (t) void this.op({ op: "focus_cycle", from: t, delta });
  };
  zoom = () => {
    const t = this.currentPane();
    if (t) void this.op({ op: "zoom", target: t });
  };
  resizeBy = (delta: number, axis: "row" | "column") => {
    const t = this.currentPane();
    if (t) void this.op({ op: "resize_by", target: t, delta, axis });
  };
  equalize = () => {
    const ws = this.currentWorkspace();
    void this.op({ op: "equalize", tab: { by: "active", value: ws } });
  };
  selectTab = (id: number) => void this.op({ op: "select_tab", tab: { by: "id", value: id } });
  closeTab = (id: number) => void this.op({ op: "close_tab", tab: { by: "id", value: id } });
  renameTab = (id: number, title: string) => void this.op({ op: "rename_tab", tab: { by: "id", value: id }, title: title || null });

  /** ⌘1~9: 지금 워크스페이스의 n 번째 탭 */
  selectTabIndex = (i: number) => {
    const tab = this.get().layouts[this.currentWorkspace()]?.tabs[i];
    if (tab) this.selectTab(tab.id);
  };

  /** 문서(diff, 파일)를 새 탭으로 연다. 이미 열려 있으면 그 칸으로 간다 */
  openDoc = (doc: Record<string, string>) => {
    const ws = this.get().active;
    for (const tab of this.get().layouts[ws]?.tabs ?? [])
      for (const p of panesOf(tab.root))
        if (p.type === "doc" && sameDoc(p.doc, doc)) {
          void this.op({ op: "focus", target: byId(p.id) });
          return;
        }
    void this.op({ op: "open_doc", workspace: ws, doc });
  };

  // ---- 플로팅 워크스페이스 ----

  private saveFloating() {
    const { rect, maximized } = this.get().floating;
    localStorage.setItem(FLOATING_KEY, JSON.stringify({ rect, maximized }));
  }

  /** Ctrl+`: 플로팅 패널을 열고 닫는다. 처음 열 때 탭이 없으면 홈 폴더에서 셸을 띄운다 */
  toggleFloating = async () => {
    const s = this.get();
    if (s.floating.open) {
      this.set({ floating: { ...s.floating, open: false }, focusArea: "main" });
      return;
    }
    this.set({ floating: { ...s.floating, open: true }, focusArea: "floating" });
    if (!s.layouts[FLOATING_WORKSPACE]?.tabs.length) await this.newTab(FLOATING_WORKSPACE);
  };

  setFloatingRect = (rect: FloatingRect | null, maximized?: boolean) => {
    this.set((s) => ({ floating: { ...s.floating, rect, maximized: maximized ?? s.floating.maximized } }));
    this.saveFloating();
  };

  // ---- 테마 ----

  setTheme = (patch: Partial<ThemeSettings>) => {
    const theme = { ...this.get().theme, ...patch };
    saveThemeSettings(theme);
    this.set({ theme });
    void this.applyTheme();
  };

  /** 화면 토큰, 앱 엔진 색, 데몬 엔진 색을 지금 테마로 맞춘다 */
  private async applyTheme() {
    const { theme, systemDark } = this.get();
    const r = applyTheme(theme, systemDark);
    this.engineColors = r.engine;
    for (const c of this.controllers.values()) c.setColors(r.engine);
    this.services.engines.setDefaultColors?.(r.engine);
    try {
      await this.services.host.setTerminalColors(r.daemon);
    } catch (e) {
      console.warn("[thuminal] 데몬 터미널 색을 바꾸지 못했다", e);
    }
  }

  // ---- 프로젝트, 워크트리 ----

  /** 폴더를 골라 프로젝트로 등록한다 (안에 저장소가 여럿이면 모두) */
  addProject = async (path?: string) => {
    try {
      const p = path ?? (await this.services.host.pickFolder());
      if (!p) return;
      const repos = await this.services.host.addRepos(p);
      await this.refreshWorkspace();
      const main = this.get().worktrees.find((w) => w.repo === repos[0]?.id && w.is_main);
      if (main) this.select(main.path);
    } catch (e) {
      this.fail(`프로젝트를 등록하지 못했다: ${e}`);
    }
  };

  removeProject = async (repo: string) => {
    await this.services.host.removeRepo(repo).catch(this.fail);
  };

  /** 워크트리를 만든다. 창은 바로 닫히고, 만드는 동안 사이드바에 진행 줄이 보인다 */
  newWorktree = async (req: NewWorktree) => {
    const item = { repo: req.repo, branch: req.branch };
    this.set((s) => ({ creating: [...s.creating, item] }));
    try {
      const w = await this.services.host.createWorktree(req.repo, req.branch, { base: req.base, name: req.name || undefined });
      await this.refreshWorkspace();
      this.select(w.path);
      if (req.start === "shell") await this.newTab(w.path);
      else if (req.start === "claude") await this.newTab(w.path, "claude");
    } catch (e) {
      this.fail(`워크트리를 만들지 못했다: ${e}`);
    } finally {
      this.set((s) => ({ creating: s.creating.filter((c) => c !== item) }));
    }
  };

  removeWorktree = async (w: WorktreeInfo, opts: { force: boolean; deleteBranch: boolean }) => {
    try {
      for (const id of sessionsOf(this.get().layouts[w.path])) await this.services.host.remove(id);
      await this.services.host.removeWorktree(w.repo, w.path, opts);
      if (this.get().active === w.path) this.set({ active: OTHER_WORKSPACE });
      await this.refreshWorkspace();
    } catch (e) {
      this.fail(`워크트리를 지우지 못했다: ${e}`);
    }
  };

  renameWorktree = async (w: WorktreeInfo, name: string) => {
    await this.services.host.updateWorktree(w.path, { name }).catch(this.fail);
  };

  togglePin = async (w: WorktreeInfo) => {
    await this.services.host.updateWorktree(w.path, { pinned: !w.pinned }).catch(this.fail);
  };
}

export const ModelContext = createContext<AppModel | null>(null);

export function useModel(): AppModel {
  const m = useContext(ModelContext);
  if (!m) throw new Error("ModelContext 밖에서 썼다");
  return m;
}

/** 상태 한 조각을 읽는다. 여러 값을 묶어 읽으면 useShallow 로 감싼다 */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useModel().store, selector);
}
