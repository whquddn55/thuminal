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
  type OrcaSession,
  type Side,
  type Spawn,
  type WorkspaceId,
  type WorkspaceLayout,
  type WorktreeInfo,
} from "@thuminal/term-core";

import { AGENTS } from "./agents";
import { setPage } from "./browser-state";
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
  | { kind: "import-orca" }
  /** 되돌릴 수 없는 일을 하기 전에 묻는 창 */
  | { kind: "confirm"; title: string; body: string; action: string; run: () => void }
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
  /** ⌘B 로 사이드바를 접는다 */
  sidebarOpen: boolean;
  /** 로그인 셸 PATH 에서 찾은 에이전트 명령 (새 탭 메뉴에 보인다) */
  agents: string[];
  /** 워크스페이스마다 마지막으로 본 때 (ms). 다시 켜도 남는다 */
  seen: Record<WorkspaceId, number>;
  /** 최근에 고른 워크스페이스 (앞이 가장 최근). ⌘J 빈 검색이 이 순서로 보인다 */
  recent: WorkspaceId[];
  /** 만드는 중인 워크트리 */
  creating: { repo: string; branch: string }[];
  /** 에이전트 팀 패널을 펼쳤는지, 어느 팀원이 키보드를 받는지 (리더 세션마다) */
  teams: Record<SessionId, TeamView>;
  /** 데몬에 다시 붙을 때마다 는다 (세션 번호가 같아도 다시 붙게 한다) */
  generation: number;
  error: string | null;
  notice: string | null;
}

/** 에이전트 팀 팝업 (리더 세션마다). 목록 → 팀원 하나(터미널) → 뒤로 목록 */
export interface TeamView {
  open: boolean;
  /** 팝업에 띄운 팀원. null 이면 목록 */
  mate: SessionId | null;
  /** 팝업의 팀원이 키보드를 받는다 (리더를 누르면 리더로 돌아간다) */
  keys: boolean;
}

/** 팀원 세션 꼬리표 (데몬 teams.rs 와 같다) */
export const TEAM_LEADER_LABEL = "team.leader";
export const TEAM_NAME_LABEL = "team.name";
export const TEAM_COLOR_LABEL = "team.color";
export const TEAM_PANE_LABEL = "team.pane";

/** 리더 세션의 팀원들 (claude 가 만든 차례대로) */
export function teammatesOf(sessions: Record<SessionId, SessionInfo>, leader: SessionId): SessionInfo[] {
  const order = (s: SessionInfo) => Number(s.labels[TEAM_PANE_LABEL]?.slice(1)) || s.id;
  return Object.values(sessions)
    .filter((s) => s.labels[TEAM_LEADER_LABEL] === String(leader))
    .sort((a, b) => order(a) - order(b));
}

const DEFAULT_TEAM_VIEW: TeamView = { open: false, mate: null, keys: false };
/** 늘 같은 객체를 돌려준다 (zustand 선택자로 쓴다) */
export const teamView = (s: AppState, leader: SessionId): TeamView => s.teams[leader] ?? DEFAULT_TEAM_VIEW;

export const worktreeTitle = (w: WorktreeInfo) => w.name || w.branch || w.path.split("/").pop() || w.path;

const FLOATING_KEY = "thuminal.floating";
const SIDEBAR_KEY = "thuminal.sidebarWidth";
const SEEN_KEY = "thuminal.seen";
const SIDEBAR_OPEN_KEY = "thuminal.sidebarOpen";
const RECENT_KEY = "thuminal.recent";

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
      sidebarOpen: localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0",
      agents: [],
      seen: loadJson<Record<string, number>>(SEEN_KEY, {}),
      recent: JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[],
      creating: [],
      teams: {},
      generation: 0,
      error: null,
      notice: null,
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
    const offDaemon = host.onEvent((e) => this.onEvent(e));
    const offBrowser = host.browser?.onEvent((e) => this.onBrowserEvent(e));
    this.unsubscribe = () => {
      offDaemon();
      offBrowser?.();
    };
    try {
      await this.reloadAll();
      // 처음에는 마지막에 보던 워크트리를 고른다. 없으면 터미널이 있는 첫 워크트리
      const { worktrees, layouts, recent } = this.get();
      const last = recent.find((ws) => ws === OTHER_WORKSPACE || worktrees.some((w) => w.path === ws));
      const first = worktrees.find((w) => (layouts[w.path]?.tabs.length ?? 0) > 0) ?? worktrees[0];
      if (last) this.set({ active: last });
      else if (first) this.set({ active: first.path });
    } catch (e) {
      this.fail(e);
    }
    this.markSeen();
    void this.applyTheme();
    void this.refreshStatus();
    void this.services.host.findCommands(AGENTS.map((a) => a.cmd)).then(
      (agents) => this.set({ agents }),
      () => undefined,
    );
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
        this.reapBrowsers();
        return;
      case "layout_removed":
        this.set((s) => {
          const layouts = { ...s.layouts };
          delete layouts[e.workspace];
          return { layouts };
        });
        this.reapBrowsers();
        return;
      case "terminal_colors_changed":
        // 다른 창이나 CLI 가 바꿨다. 화면 테마는 앱 설정이 정하므로 따로 하지 않는다
        return;
      case "session_notification":
        // 알림 기능을 만들 때 쓴다
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

  clearError = () => this.set({ error: null, notice: null });

  /** 오류는 아니지만 알릴 것 (아래 띠에 잠깐 보인다) */
  notice = (text: string) => {
    this.set({ notice: text });
    window.setTimeout(() => this.get().notice === text && this.set({ notice: null }), 6000);
  };

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

  /**
   * 마지막으로 본 뒤 알릴 일이 생겼는지 (사이드바에서 굵게, 종이 보인다).
   * Orca 와 같이 에이전트가 턴을 끝냈거나, 사용자를 부르거나, 벨이 울렸을 때만 친다. 출력만 나온 것은 치지 않는다
   */
  unread(ws: WorkspaceId, s: AppState = this.get()): boolean {
    if (ws === s.active) return false;
    const seen = s.seen[ws] ?? 0;
    return sessionsOf(s.layouts[ws]).some((id) => {
      const x = s.sessions[id];
      if (!x) return false;
      const a = x.agent;
      return (x.bell_at ?? 0) > seen || (a?.turn_ended_at ?? 0) > seen || (a?.state === "needs_attention" && a.updated_at > seen);
    });
  }

  private markSeen(ws: WorkspaceId = this.get().active) {
    this.set((s) => ({ seen: { ...s.seen, [ws]: Date.now() } }));
    localStorage.setItem(SEEN_KEY, JSON.stringify(this.get().seen));
  }

  /** 상태 칸을 눌러 읽음으로 돌린다 */
  markRead = (ws: WorkspaceId) => this.markSeen(ws);

  /** 워크트리 방문 기록 (⌘⌥← → 로 오간다). 기록 안에서 옮겨 다닐 때는 쌓지 않는다 */
  private history: WorkspaceId[] = [];
  private historyAt = -1;

  select = (ws: WorkspaceId, fromHistory = false) => {
    if (!fromHistory && ws !== this.get().active) {
      this.history = [...this.history.slice(0, this.historyAt + 1), ws].slice(-50);
      this.historyAt = this.history.length - 1;
    }
    this.markSeen();
    const recent = [ws, ...this.get().recent.filter((x) => x !== ws)].slice(0, 30);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    this.set({ active: ws, focusArea: "main", recent });
    this.markSeen();
    void this.refreshStatus(ws);
  };

  goHistory = (delta: number) => {
    if (this.historyAt < 0) this.history = [this.get().active];
    const at = Math.max(0, Math.min(this.history.length - 1, (this.historyAt < 0 ? 0 : this.historyAt) + delta));
    this.historyAt = at;
    const ws = this.history[at];
    if (ws && ws !== this.get().active) this.select(ws, true);
  };

  /** 사이드바에 보이는 순서의 워크트리 (DOM 에서 읽는다. 접힌 그룹은 빠진다) */
  private sidebarOrder(): WorkspaceId[] {
    const order = [...document.querySelectorAll<HTMLElement>("[data-drop-workspace]")].map((e) => e.dataset.dropWorkspace!);
    return order.filter((ws, i) => order.indexOf(ws) === i);
  }

  /** ⌘1~9 */
  selectWorktreeIndex = (i: number) => {
    const ws = this.sidebarOrder()[i];
    if (ws) this.select(ws);
  };

  /** ⌘⇧↑ ↓: 사이드바 순서로 이전·다음 워크트리 */
  selectNearWorktree = (delta: number) => {
    const list = this.sidebarOrder();
    if (!list.length) return;
    const i = list.indexOf(this.get().active);
    this.select(list[(i + delta + list.length) % list.length]);
  };

  setPanel = (p: Panel) => this.set((s) => ({ panel: s.panel === p ? null : p }));
  setDialog = (d: Dialog) => this.set({ dialog: d });
  setFocusArea = (a: AppState["focusArea"]) => this.set({ focusArea: a });

  // ---- 에이전트 팀 (팀원은 칸이 아니라 리더 칸에 딸린 패널에 그린다) ----

  private setTeam = (leader: SessionId, f: (v: TeamView) => TeamView) =>
    this.set((s) => {
      const v = teamView(s, leader);
      const next = f(v);
      return next.open === v.open && next.mate === v.mate && next.keys === v.keys ? {} : { teams: { ...s.teams, [leader]: next } };
    });

  /** 팀원 팝업을 열고 닫는다. 열면 목록부터 */
  toggleTeam = (leader: SessionId, open?: boolean) =>
    this.setTeam(leader, (v) => {
      const o = open ?? !v.open;
      return o ? { open: true, mate: null, keys: false } : DEFAULT_TEAM_VIEW;
    });

  /** 팝업에 팀원 하나(터미널)를 띄우고 키보드를 준다. null 이면 목록으로 돌아간다 */
  showTeammate = (leader: SessionId, mate: SessionId | null) => this.setTeam(leader, () => ({ open: true, mate, keys: mate !== null }));

  /** 키보드를 팝업의 팀원(true) 또는 리더(false)에게 준다 */
  teamKeys = (leader: SessionId, toMate: boolean) => this.setTeam(leader, (v) => ({ ...v, keys: toMate && v.mate !== null }));

  toggleSidebar = () => {
    const open = !this.get().sidebarOpen;
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
    this.set({ sidebarOpen: open });
  };

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
      this.reapBrowsers();
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

  /** 에이전트가 든 칸은 닫기 전에 묻는다 (닫으면 그 세션이 끝난다) */
  private guardClose(panes: number[], what: string, run: () => void) {
    const s = this.get();
    const busy = Object.values(s.layouts)
      .flatMap((l) => l.tabs)
      .flatMap((t) => panesOf(t.root))
      .filter((p) => panes.includes(p.id) && p.type === "terminal" && s.sessions[p.session]?.agent)
      .map((p) => (p.type === "terminal" ? s.sessions[p.session].agent!.kind : ""));
    if (!busy.length) return run();
    this.setDialog({
      kind: "confirm",
      title: `${what} 닫을까?`,
      body: `${[...new Set(busy)].join(", ")} 가 돌고 있다. 닫으면 그 세션이 끝난다.`,
      action: "닫기",
      run,
    });
  }

  closePane = (id: number) => this.guardClose([id], "칸을", () => void this.op({ op: "close_pane", target: byId(id) }));

  /** ⌘W: 칸 닫기 (탭의 마지막 칸이면 탭이 닫힌다) */
  closeCurrent = async () => {
    const t = this.currentPane();
    if (t?.by === "id") this.closePane(t.value);
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
  closeTab = (id: number) => {
    const tab = Object.values(this.get().layouts).flatMap((l) => l.tabs).find((t) => t.id === id);
    this.guardClose(tab ? panesOf(tab.root).map((p) => p.id) : [], "탭을", () => void this.op({ op: "close_tab", tab: { by: "id", value: id } }));
  };
  /** 이 탭만 남기고 같은 워크스페이스의 다른 탭을 닫는다 */
  closeOtherTabs = (id: number) => {
    const layout = Object.values(this.get().layouts).find((l) => l.tabs.some((t) => t.id === id));
    const others = layout?.tabs.filter((t) => t.id !== id) ?? [];
    this.guardClose(
      others.flatMap((t) => panesOf(t.root).map((p) => p.id)),
      `다른 탭 ${others.length}개를`,
      () => void this.services.host.layoutBatch(others.map((t) => ({ op: "close_tab" as const, tab: { by: "id" as const, value: t.id } }))).catch(this.fail),
    );
  };
  /** ⌘⇧[ ]: 이전·다음 탭 */
  selectNearTab = (delta: number) => {
    const layout = this.get().layouts[this.currentWorkspace()];
    if (!layout?.tabs.length) return;
    const i = layout.tabs.findIndex((t) => t.id === activeTab(layout)?.id);
    this.selectTab(layout.tabs[(i + delta + layout.tabs.length) % layout.tabs.length].id);
  };
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

  /** ⌘⌥A, Ctrl+`: 플로팅 패널을 열고 닫는다. 처음 열 때 탭이 없으면 홈 폴더에서 셸을 띄운다 */
  toggleFloating = async (maximized?: boolean) => {
    const s = this.get();
    if (s.floating.open) {
      this.set({ floating: { ...s.floating, open: false }, focusArea: "main" });
      return;
    }
    this.set({ floating: { ...s.floating, open: true, maximized: maximized || s.floating.maximized }, focusArea: "floating" });
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

  // ---- 브라우저 칸 ----

  private readonly browsers = new Set<number>();
  private readonly browserCommands = new Map<number, (cmd: "address") => void>();

  browserOpened = (id: number) => void this.browsers.add(id);

  /** 칸이 배치에서 없어진 웹뷰를 닫는다 */
  private reapBrowsers() {
    const live = new Set(Object.values(this.get().layouts).flatMap((l) => l.tabs.flatMap((t) => panesOf(t.root).map((p) => p.id))));
    for (const id of this.browsers)
      if (!live.has(id)) {
        this.browsers.delete(id);
        void this.services.host.browser?.close(id).catch(() => undefined);
      }
  }

  onBrowserCommand(id: number, cb: (cmd: "address") => void) {
    this.browserCommands.set(id, cb);
    return () => {
      if (this.browserCommands.get(id) === cb) this.browserCommands.delete(id);
    };
  }

  private onBrowserEvent(e: import("@thuminal/term-core").BrowserEvent) {
    switch (e.type) {
      case "title":
        setPage(e.id, { title: e.title });
        return;
      case "load": {
        setPage(e.id, { url: e.url, loading: e.loading });
        // 옮겨 간 주소를 배치에 남겨 다시 켜도 그 페이지로 연다
        const hit = Object.values(this.get().layouts).flatMap((l) => l.tabs.flatMap((t) => panesOf(t.root))).find((p) => p.id === e.id);
        if (!e.loading && hit?.type === "doc" && hit.doc.url !== e.url && !e.url.startsWith("about:"))
          void this.op({ op: "update_doc", pane: byId(e.id), doc: { ...hit.doc, url: e.url } });
        return;
      }
      case "focus":
        this.focusPaneQuiet(e.id);
        return;
      case "key":
        // 페이지가 키보드를 잡고 있을 때 누른 앱 단축키를 메인 화면 단축키로 다시 보낸다
        this.focusPaneQuiet(e.id);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, metaKey: true, altKey: e.alt, shiftKey: e.shift, ctrlKey: e.ctrl, bubbles: true, cancelable: true }));
        return;
      case "new_window": {
        const ws = Object.values(this.get().layouts).find((l) => l.tabs.some((t) => panesOf(t.root).some((p) => p.id === e.id)))?.workspace;
        if (ws) void this.newBrowserTab(ws, e.url);
        return;
      }
    }
  }

  /** 이 칸이 든 면에 키보드를 두고 그 칸을 포커스 칸으로 (이미 그렇다면 아무것도 하지 않는다) */
  private focusPaneQuiet(id: number) {
    const s = this.get();
    const hit = Object.values(s.layouts).find((l) => l.tabs.some((t) => panesOf(t.root).some((p) => p.id === id)));
    if (!hit) return;
    const area = hit.workspace === FLOATING_WORKSPACE ? "floating" : "main";
    if (s.focusArea !== area) this.setFocusArea(area);
    if (focusedPane(activeTab(hit))?.id !== id) this.focusPane(id);
  }

  /** ⌘⇧B, "+" 메뉴: 새 브라우저 탭 */
  newBrowserTab = async (ws: WorkspaceId = this.currentWorkspace(), url = "about:blank") => {
    await this.op({ op: "new_tab", workspace: ws, doc: { kind: "browser", url } });
  };

  /** 칸 옆을 나눠 브라우저 칸을 연다 */
  splitBrowser = async (side: Side, target: PaneRef | null = this.currentPane(), url = "about:blank") => {
    if (!target) return this.newBrowserTab(undefined, url);
    await this.op({ op: "split", target, side, doc: { kind: "browser", url } });
  };

  /** 지금 포커스 칸이 브라우저면 그 칸 번호 */
  currentBrowser(): number | null {
    const p = focusedPane(activeTab(this.get().layouts[this.currentWorkspace()]));
    return p?.type === "doc" && p.doc.kind === "browser" ? p.id : null;
  }

  browserCommand(cmd: "back" | "forward" | "reload" | "address"): boolean {
    const id = this.currentBrowser();
    const b = this.services.host.browser;
    if (id === null || !b) return false;
    if (cmd === "back") void b.go(id, -1);
    else if (cmd === "forward") void b.go(id, 1);
    else if (cmd === "reload") void b.reload(id);
    else this.browserCommands.get(id)?.("address");
    return true;
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

  /**
   * Orca 에서 고른 것을 가져온다: 저장소 등록, (이름 없는) 워크트리에 Orca 표시 이름, claude 세션은 새 탭에서 `claude --resume`.
   * 하나가 실패해도 나머지는 한다. 끝나면 무엇을 했는지 알린다
   */
  importOrca = async (pick: { repos: string[]; names: { path: string; name: string }[]; sessions: OrcaSession[] }) => {
    const host = this.services.host;
    const failed: string[] = [];
    let repos = 0;
    // 등록마다 앱이 워크트리 목록을 다시 읽으므로 하나씩 기다리지 않고 한꺼번에 보낸다
    await Promise.all(
      pick.repos.map((path) =>
        host.addRepo(path).then(
          () => repos++,
          (e) => failed.push(`${path.split("/").pop()}: ${e}`),
        ),
      ),
    );
    await this.refreshWorkspace();
    let names = 0;
    const unnamed = pick.names.filter(({ path }) => this.get().worktrees.some((w) => w.path === path && !w.name));
    await Promise.all(unnamed.map(({ path, name }) => host.updateWorktree(path, { name }).then(() => names++, () => undefined)));
    let sessions = 0;
    for (const s of pick.sessions) {
      const wts = this.get().worktrees;
      const inside = (p: string) => s.cwd === p || s.cwd.startsWith(`${p}/`);
      const ws = s.floating
        ? FLOATING_WORKSPACE
        : (wts.find((w) => w.path === s.worktree)?.path ?? wts.filter((w) => inside(w.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path ?? OTHER_WORKSPACE);
      // 셸에서 치게 해서 thuminal claude 실행기(훅·권한·팀)로 뜨게 한다
      await host.layout({ op: "new_tab", workspace: ws, spawn: { command: [], input: `claude --resume ${s.session_id}`, cwd: s.cwd, env: {} }, focus: false }).then(
        () => sessions++,
        (e) => failed.push(`${s.title || s.session_id}: ${e}`),
      );
    }
    if (names) await this.refreshWorkspace();
    const done = `Orca 에서 가져왔다: 프로젝트 ${repos}개, 워크트리 이름 ${names}개, claude 세션 ${sessions}개`;
    if (failed.length) this.fail(`${done}. 못 가져온 것: ${failed.join(" · ")}`);
    else this.notice(done);
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

  removeWorktree = async (w: WorktreeInfo, opts: { force: boolean; deleteBranch: boolean; forceBranch: boolean }) => {
    try {
      for (const id of sessionsOf(this.get().layouts[w.path])) await this.services.host.remove(id);
      const note = await this.services.host.removeWorktree(w.repo, w.path, opts);
      if (note) this.notice(note);
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
