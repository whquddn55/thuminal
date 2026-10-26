// 화면 상태 (zustand 하나) 와 그 상태를 바꾸는 동작.
//
// - 저장소, 워크트리, git 상태, 세션, 배치는 데몬 것을 받아 들고 있기만 한다. 배치는 데몬이 바꾸고 이벤트로 알린다.
// - 고른 워크트리, 열린 창, 플로팅 패널 자리, 테마 설정처럼 화면에만 있는 것은 여기서 정한다.
// - 터미널 컨트롤러(엔진, 붙기)는 상태가 아니라서 zustand 밖에 둔다.
// - 호스트(데몬)마다 AppModel 이 하나다. 로컬이 root 이고, 원격 컴퓨터마다 자식 모델을 root 가 만든다.
//   세션·칸·탭 번호와 워크트리 경로는 호스트마다 따로라 모델이 갈라 든다. 창 전체 상태(`WINDOW_KEYS`: 테마, 글꼴, 플로팅,
//   창, 알림 설정, 사이드바, 읽은 때, 최근 목록, 고른 호스트 …)는 root 가 들고 자식 store 에 그대로 비춘다.
//   자식이 그 키를 바꾸면 root 로 보낸다. 고른 곳은 (activeHost, 그 모델의 active) 다.

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
  type RemoteHost,
  type RemoteHostState,
  type RepoGroup,
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
import { pageKey, setPage } from "./browser-state";
import { moveRepo, NEW_GROUP_NAME, normalizeGroups, removeGroup, shiftGroup } from "./groups";
import { activeTab, focusedPane, paneOfSession, panesOf, sameDoc, sessionsOf } from "./layout";
import type { Services } from "./services";
import { allowed, loadNotifySettings, type Notice, noticeFor, type NotifySettings, saveNotifySettings } from "./notifications";
import { TerminalController } from "./terminal-controller";
import type { ResolvedLink } from "./terminal-link-hover";
import {
  clampFontSize,
  loadTerminalFont,
  loadZoom,
  nextUiZoom,
  registerTerminalFonts,
  saveTerminalFont,
  saveZoom,
  type TerminalFont,
  type Zoom,
} from "./terminal-font";
import { applyTheme, loadThemeSettings, saveThemeSettings, type ThemeSettings } from "./theme";

export { FLOATING_WORKSPACE, OTHER_WORKSPACE };

/** 플로팅 터미널 세션 꼬리표 (데몬이 이 꼬리표로 플로팅 워크스페이스에 넣는다) */
export const FLOATING_LABEL = "floating";

/** 오른쪽 사이드바의 탭 (null 이면 닫혀 있다) */
export type Panel = "files" | "changes" | "search" | null;

export interface NewWorktree {
  repo: string;
  name: string;
  branch: string;
  base?: string;
  /** 처음 띄울 것 */
  start: "shell" | "claude" | "none";
  /** 이 워크트리의 하위 워크트리로 만든다 */
  parent?: string;
}

/** 설정창의 칸. remote 는 이 컴퓨터 원격 접속, hosts 는 내가 붙는 원격 컴퓨터 */
export type SettingsSection = "theme" | "font" | "agent" | "notify" | "remote" | "hosts";

export type Dialog =
  | { kind: "new-worktree"; repo: string; parent?: string }
  | { kind: "delete-worktree"; worktree: WorktreeInfo }
  | { kind: "jump" }
  /** section 이 있으면 그 칸을 펴서 연다 */
  | { kind: "settings"; section?: SettingsSection }
  /** ⌘⇧O: 지금 워크트리의 Markdown 파일을 골라 연다 */
  | { kind: "open-markdown" }
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
  /** 사이드바 워크스페이스(프로젝트 묶음), 데몬이 준 그대로. 그릴 때는 `normalizeGroups` 로 저장소 목록에 맞춘다 */
  groups: RepoGroup[];
  worktrees: WorktreeInfo[];
  sessions: Record<SessionId, SessionInfo>;
  status: Record<string, GitStatus>;
  layouts: Record<WorkspaceId, WorkspaceLayout>;
  /** 고른 워크스페이스 (워크트리 경로나 OTHER_WORKSPACE) */
  active: WorkspaceId;
  panel: Panel;
  /** 오른쪽 사이드바 폭 (CSS 픽셀). 다시 켜도 남는다 */
  rightWidth: number;
  /** 워크트리마다 쓰다 만 커밋 메시지 (워크트리를 바꿔도 남는다) */
  commitDrafts: Record<string, string>;
  floating: FloatingState;
  /** 키보드가 가는 곳 */
  focusArea: "main" | "floating";
  dialog: Dialog;
  theme: ThemeSettings;
  /** 터미널 글꼴 설정 (설정창) */
  terminalFont: TerminalFont;
  /** ⌘+ ⌘- 로 바꾼 터미널 글자 크기와 앱 화면 배율 */
  zoom: Zoom;
  /** 시스템 다크 모드 여부 (테마 설정이 시스템 따라가기일 때 쓴다) */
  systemDark: boolean;
  sidebarWidth: number;
  /** ⌘B 로 사이드바를 접는다 */
  sidebarOpen: boolean;
  /** 로그인 셸 PATH 에서 찾은 에이전트 명령 (새 탭 메뉴에 보인다) */
  agents: string[];
  /** 워크스페이스마다 마지막으로 본 때 (ms). 키는 `placeKey` (원격은 `<호스트>|<워크스페이스>`). 다시 켜도 남는다 */
  seen: Record<string, number>;
  /** 최근에 고른 곳의 `placeKey` (앞이 가장 최근). ⌘J 빈 검색이 이 순서로 보인다 */
  recent: string[];
  /** 만드는 중인 워크트리 */
  creating: { repo: string; branch: string }[];
  /** 알림 설정 */
  notify: NotifySettings;
  /** 에이전트 팀 패널을 펼쳤는지, 어느 팀원이 키보드를 받는지 (리더 세션마다) */
  teams: Record<SessionId, TeamView>;
  /** 붙인 그림 팝업을 펼친 세션. 팀 팝업과 한 칸에 하나만 열린다 */
  gallery: Record<SessionId, boolean>;
  /** 메인 면에 보이는 호스트 (""는 로컬, 아니면 원격 호스트 id). 창 전체 상태 */
  activeHost: string;
  /** 열린 창(dialog)이 다룰 호스트. 창 전체 상태 */
  dialogHost: string;
  /** 등록한 원격 컴퓨터와 연결 상태 (껍데기가 알려 준 그대로). 창 전체 상태 */
  remoteHosts: RemoteHost[];
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
const RIGHT_WIDTH_KEY = "thuminal.rightWidth";
const RIGHT_TAB_KEY = "thuminal.rightTab";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

const byId = (id: number): PaneRef => ({ by: "id", value: id });

/** 창 하나에 하나만 있는 상태. 자식(원격 호스트) 모델은 root 것을 비춰 들고, 바꾸면 root 로 보낸다 */
export const WINDOW_KEYS = [
  "panel",
  "rightWidth",
  "floating",
  "focusArea",
  "dialog",
  "dialogHost",
  "theme",
  "terminalFont",
  "zoom",
  "systemDark",
  "sidebarWidth",
  "sidebarOpen",
  "seen",
  "recent",
  "notify",
  "activeHost",
  "remoteHosts",
  "error",
  "notice",
] as const satisfies readonly (keyof AppState)[];
const WINDOW_KEY_SET = new Set<string>(WINDOW_KEYS);

/** 호스트 안 워크스페이스를 창 전체에서 가르는 키. 로컬은 워크스페이스 그대로, 원격은 `<호스트 id>|<워크스페이스>` */
export function placeKey(host: string, ws: WorkspaceId): string {
  return host ? `${host}|${ws}` : ws;
}

/** `placeKey` 를 되돌린다. 원격 호스트 id 는 16진수라 로컬 경로(`/…`)·floating·other 와 겹치지 않는다 */
export function parsePlace(key: string): { host: string; ws: WorkspaceId } {
  const m = /^([0-9a-zA-Z]+)\|(.*)$/s.exec(key);
  return m && !key.startsWith("/") ? { host: m[1], ws: m[2] } : { host: "", ws: key };
}

/** 원격 호스트 연결 상태 이름 (사이드바 배지, 메인 면 띠) */
export const HOST_STATE_LABEL: Record<RemoteHostState, string> = {
  connected: "연결됨",
  connecting: "연결 중",
  disconnected: "끊김",
  unauthorized: "토큰 거절",
  version_mismatch: "판이 다름",
};

/** 다시 등록해야 풀리는 상태 (다시 붙어도 그대로다) */
export const hostStateIsError = (s: RemoteHostState) => s === "unauthorized" || s === "version_mismatch";

/** 원격 호스트 알림을 누르면 돌아올 번호를 이 수부터 센다 (로컬 세션 번호와 겹치지 않게) */
const REMOTE_NOTICE_BASE = 1_000_000_000;

export class AppModel {
  readonly store: StoreApi<AppState>;
  /** 로컬 모델 (창 전체 상태의 주인). root 면 자기 자신 */
  readonly root: AppModel;
  /** 이 모델의 호스트. 로컬은 "", 원격은 호스트 id */
  readonly hostKey: string;
  private readonly controllers = new Map<SessionId, TerminalController>();
  private timers: number[] = [];
  private unsubscribe: (() => void) | null = null;
  /** 원격 호스트 모델 (root 만 든다) */
  private readonly children = new Map<string, AppModel>();

  /** parent 를 주면 그 root 아래 원격 호스트 모델이 된다 (`services.host` 는 그 호스트 HostApi) */
  constructor(
    readonly services: Services,
    parent?: AppModel,
  ) {
    this.root = parent?.root ?? this;
    this.hostKey = parent ? (services.host.hostId ?? "") : "";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    this.store = createStore<AppState>(() => ({
      repos: [],
      groups: [],
      worktrees: [],
      sessions: {},
      status: {},
      layouts: {},
      active: OTHER_WORKSPACE,
      panel: null,
      rightWidth: Number(localStorage.getItem(RIGHT_WIDTH_KEY)) || 300,
      commitDrafts: {},
      floating: { ...loadJson<FloatingState>(FLOATING_KEY, { open: false, rect: null, maximized: false }), open: false },
      focusArea: "main",
      dialog: null,
      theme: loadThemeSettings(),
      terminalFont: loadTerminalFont(),
      zoom: loadZoom(),
      systemDark: media.matches,
      sidebarWidth: Number(localStorage.getItem(SIDEBAR_KEY)) || 280,
      sidebarOpen: localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0",
      agents: [],
      seen: loadJson<Record<string, number>>(SEEN_KEY, {}),
      recent: JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[],
      creating: [],
      notify: loadNotifySettings(),
      teams: {},
      gallery: {},
      activeHost: "",
      dialogHost: "",
      remoteHosts: [],
      generation: 0,
      error: null,
      notice: null,
      ...(parent ? pickWindow(this.root.get()) : {}),
    }));
    if (parent) {
      // 창 전체 상태를 root 에서 비춰 받는다 (root 가 바뀌면 같은 차례 안에 바로 따라 바뀐다)
      this.unmirror = this.root.store.subscribe((st, prev) => {
        const patch: Partial<AppState> = {};
        let changed = false;
        for (const k of WINDOW_KEYS)
          if (st[k] !== prev[k]) {
            (patch as Record<string, unknown>)[k] = st[k];
            changed = true;
          }
        if (changed) this.store.setState(patch);
      });
      return;
    }
    media.addEventListener("change", (e) => {
      this.set({ systemDark: e.matches });
      this.applyTheme();
    });
  }

  private unmirror: (() => void) | null = null;

  get isRoot(): boolean {
    return this.root === this;
  }

  get = () => this.store.getState();

  /** 창 전체 키는 root 로, 나머지는 이 모델 store 로 */
  private set = (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => {
    if (this.isRoot) return this.store.setState(p);
    const patch = typeof p === "function" ? p(this.get()) : p;
    const mine: Record<string, unknown> = {};
    const win: Record<string, unknown> = {};
    let m = false;
    let w = false;
    for (const [k, v] of Object.entries(patch)) {
      if (WINDOW_KEY_SET.has(k)) {
        win[k] = v;
        w = true;
      } else {
        mine[k] = v;
        m = true;
      }
    }
    if (w) this.root.store.setState(win as Partial<AppState>);
    if (m) this.store.setState(mine as Partial<AppState>);
  };

  // ---- 호스트 ----

  /** 이 모델 안 워크스페이스의 창 전체 키 (`placeKey`) */
  placeKey = (ws: WorkspaceId): string => placeKey(this.hostKey, ws);

  /** 호스트 모델. "" 는 root(로컬). 없는 원격 호스트면 undefined */
  hostModel(host: string): AppModel | undefined {
    return host ? this.root.children.get(host) : this.root;
  }

  /** 로컬과 원격 호스트 모델 모두 (로컬이 앞) */
  models(): AppModel[] {
    return [this.root, ...this.root.children.values()];
  }

  /** 메인 면에 보이는 호스트 모델 */
  activeModel(): AppModel {
    return this.hostModel(this.root.get().activeHost) ?? this.root;
  }

  /** 키보드 단축키가 다룰 모델: 플로팅 패널에 키보드가 있으면 로컬, 아니면 메인 면 호스트 */
  focusedModel(): AppModel {
    const s = this.root.get();
    return s.floating.open && s.focusArea === "floating" ? this.root : this.activeModel();
  }

  /** 이 모델 호스트의 연결 상태 (로컬은 늘 connected 로 본다) */
  hostState(s: AppState = this.get()): RemoteHostState {
    if (this.isRoot) return "connected";
    return s.remoteHosts.find((h) => h.id === this.hostKey)?.state ?? "disconnected";
  }

  /** 원격 호스트 이름 (로컬은 "") */
  hostName(s: AppState = this.get()): string {
    if (this.isRoot) return "";
    return s.remoteHosts.find((h) => h.id === this.hostKey)?.name ?? this.hostKey;
  }

  /** 껍데기가 알려 준 원격 호스트 목록에 맞춰 호스트 모델을 만들고 없앤다 (root 만) */
  private syncHosts(list: RemoteHost[]) {
    const hosts = this.services.host.hosts;
    if (!hosts) return;
    for (const h of list) {
      let child = this.children.get(h.id);
      if (!child) {
        child = new AppModel({ ...this.services, host: hosts.forHost(h.id) }, this);
        this.children.set(h.id, child);
        void child.start(this.startOpts);
      }
    }
    for (const [id, child] of [...this.children])
      if (!list.some((h) => h.id === id)) {
        child.stop();
        this.children.delete(id);
      }
    const gone = this.get().activeHost && !list.some((h) => h.id === this.get().activeHost);
    this.set({ remoteHosts: list, ...(gone ? { activeHost: "", focusArea: "main" as const } : {}) });
    for (const h of list) this.children.get(h.id)?.hostStateChanged(h.state);
  }

  /** 처음 붙었는데 아직 읽지 못했으면 읽는다. 다시 붙은 것은 `daemon_reconnected` 가 알린다 */
  private hostStateChanged(state: RemoteHostState) {
    if (state === "connected" && !this.loaded && !this.loading) void this.reload();
  }

  /** 데몬 것을 한 번이라도 읽었는지, 읽는 중인지 */
  private loaded = false;
  private loading = false;
  private startOpts: { gitStatus?: boolean } = {};

  /** gitStatus 를 끄면 git 상태를 주기적으로 읽지 않는다 (폰 화면은 쓰지 않는다) */
  async start(opts: { gitStatus?: boolean } = {}): Promise<void> {
    const host = this.services.host;
    this.startOpts = opts;
    const offDaemon = host.onEvent((e) => this.onEvent(e));
    const offBrowser = host.browser?.onEvent((e) => this.onBrowserEvent(e));
    // 알림 누르기·Dock 배지·원격 호스트 목록은 창 하나의 일이라 root 만 맡는다
    const offClick = this.isRoot ? host.onNotificationClick?.((n) => this.onNoticeClick(n)) : undefined;
    const offBadge = this.store.subscribe(() => this.root.updateBadge());
    const offHosts = this.isRoot ? host.hosts?.onChange((list) => this.syncHosts(list)) : undefined;
    this.unsubscribe = () => {
      offDaemon();
      offBrowser?.();
      offClick?.();
      offBadge();
      offHosts?.();
    };
    // 원격이 아직 붙지 않았으면 읽지 않는다. 붙으면 hostStateChanged 가 읽는다
    if (this.isRoot || this.hostState() === "connected") {
      this.loading = true;
      try {
        await this.reloadAll();
        this.loaded = true;
        this.pickInitial();
      } catch (e) {
        this.failQuiet(e);
      } finally {
        this.loading = false;
      }
    }
    if (this.isRoot) {
      this.markSeen();
      if (this.get().zoom.ui !== 1) void host.setUiZoom?.(this.get().zoom.ui).catch(() => undefined);
    }
    void this.applyTheme();
    if (this.loaded) this.findAgents();
    if (opts.gitStatus === false) return;
    void this.refreshStatus();
    // git 상태: 지금 워크트리는 2초, 모두는 10초마다 (워크트리가 수십 개면 한 바퀴에 몇 초 걸린다). 원격은 붙어 있을 때만
    this.timers.push(window.setInterval(() => this.shown() && void this.refreshStatus(this.get().active), 2000));
    this.timers.push(window.setInterval(() => this.hostState() === "connected" && void this.refreshStatus(), 10000));
  }

  /** 이 모델이 메인 면에 보이고 붙어 있는지 */
  private shown(s: AppState = this.get()): boolean {
    return s.activeHost === this.hostKey && this.hostState(s) === "connected";
  }

  /** 처음 고를 워크스페이스: 이 호스트에서 마지막에 보던 곳, 없으면 터미널이 있는 첫 워크트리 */
  private pickInitial() {
    const { worktrees, layouts, recent } = this.get();
    const last = recent
      .map(parsePlace)
      .find((p) => p.host === this.hostKey && (p.ws === OTHER_WORKSPACE || worktrees.some((w) => w.path === p.ws)))?.ws;
    const first = worktrees.find((w) => (layouts[w.path]?.tabs.length ?? 0) > 0) ?? worktrees[0];
    if (last) this.set({ active: last });
    else if (first) this.set({ active: first.path });
  }

  private findAgents() {
    void this.services.host.findCommands(AGENTS.map((a) => a.cmd)).then(
      (agents) => this.set({ agents }),
      () => undefined,
    );
  }

  stop() {
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const child of this.children.values()) child.stop();
    if (!this.isRoot) {
      // 원격 호스트를 지웠다: 붙기를 놓고 그 호스트 브라우저 칸을 닫는다
      this.unmirror?.();
      this.unmirror = null;
      for (const c of this.controllers.values()) void c.dispose();
      this.controllers.clear();
      for (const id of this.browsers) void this.services.host.browser?.close(id).catch(() => undefined);
      this.browsers.clear();
    }
  }

  /** Dock 배지: 모든 호스트의 안 읽은 워크스페이스 수 (root 만) */
  private badge = -1;
  private updateBadge() {
    if (!this.isRoot) return;
    let n = 0;
    for (const m of this.models()) {
      const st = m.get();
      n += Object.keys(st.layouts).filter((ws) => m.unread(ws, st)).length;
    }
    if (n !== this.badge) {
      this.badge = n;
      void this.services.host.setBadge?.(n).catch(() => undefined);
    }
  }

  private async reloadAll() {
    const host = this.services.host;
    const [sessions, repos, groups, worktrees, layouts] = await Promise.all([
      host.listSessions(),
      host.listRepos(),
      this.loadGroups(),
      host.listWorktrees(),
      host.getLayout(),
    ]);
    this.set({
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
      repos,
      groups,
      worktrees,
      layouts: Object.fromEntries(layouts.map((l) => [l.workspace, l])),
    });
  }

  private async refreshWorkspace() {
    const [repos, groups, worktrees] = await Promise.all([this.services.host.listRepos(), this.loadGroups(), this.services.host.listWorktrees()]);
    this.set({ repos, groups, worktrees });
  }

  /** 옛 데몬은 모르는 요청을 받으면 연결을 끊는다. 한 번 실패하면 이 앱 실행 동안 다시 묻지 않는다 (안 그러면 붙자마자 끊기길 되풀이한다) */
  private groupsUnsupported = false;

  /** 워크스페이스 목록. 옛 데몬이라 모르면 빈 목록(모두 기본)으로 본다 */
  private loadGroups(): Promise<RepoGroup[]> {
    if (this.groupsUnsupported) return Promise.resolve([]);
    return this.services.host.listGroups().catch(() => {
      this.groupsUnsupported = true;
      return [];
    });
  }

  /** git 상태를 다시 읽는다. `only` 를 주면 그 워크트리만 */
  /** git 상태를 읽고 있는 워크트리. 앞 요청이 끝나기 전에는 다시 묻지 않는다 */
  private statusInFlight = new Set<string>();

  async refreshStatus(only?: string) {
    const { worktrees } = this.get();
    const targets = (only !== undefined ? worktrees.filter((w) => w.path === only) : worktrees).filter((w) => !this.statusInFlight.has(w.path));
    const next: Record<string, GitStatus> = {};
    // 워크트리가 많으면 git 이 한꺼번에 수십 개 뜨지 않게 4개씩 묻는다
    const queue = [...targets];
    const worker = async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        this.statusInFlight.add(w.path);
        try {
          const st = await this.services.host.git.status(w.path);
          if (JSON.stringify(st) !== JSON.stringify(this.get().status[w.path])) next[w.path] = st;
        } catch {
          // 지워지는 중인 워크트리 등은 넘어간다
        } finally {
          this.statusInFlight.delete(w.path);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (Object.keys(next).length) this.set((s) => ({ status: { ...s.status, ...next } }));
  }

  private onEvent(e: DaemonEvent) {
    switch (e.type) {
      case "session_created":
      case "session_updated": {
        const prev = this.get().sessions[e.session.id];
        this.set((s) => ({ sessions: { ...s.sessions, [e.session.id]: e.session } }));
        // 다른 화면(폰 등)이 크기를 바꿨는지 컨트롤러가 알게 한다 (입력하면 이 화면 크기로 되돌린다)
        this.controllers.get(e.session.id)?.noteSize(e.session.cols, e.session.rows);
        const n = e.type === "session_updated" ? noticeFor(prev, e.session) : null;
        if (n) this.notifySession(e.session.id, n);
        return;
      }
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
        this.notifySession(e.session, { kind: "bell", subtitle: e.title || "터미널 알림", body: e.body });
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

  /** 데몬이 다시 떴다(원격은 다시 붙었다): 붙어 있던 터미널을 모두 놓고 처음부터 다시 읽는다. 터미널은 저장본으로 다시 그린다 */
  private async reload() {
    for (const c of this.controllers.values()) void c.dispose();
    this.controllers.clear();
    this.set((s) => ({ generation: s.generation + 1, sessions: {} }));
    const first = !this.loaded;
    this.loading = true;
    try {
      await this.reloadAll();
      this.loaded = true;
      if (first) {
        this.pickInitial();
        this.findAgents();
        void this.refreshStatus();
      }
      void this.applyTheme();
    } catch (e) {
      this.failQuiet(e);
    } finally {
      this.loading = false;
    }
  }

  fail = (e: unknown) => {
    console.error("[thuminal]", this.hostKey || "로컬", e);
    const name = this.hostName();
    this.set({ error: name ? `${name}: ${e}` : String(e) });
  };

  /** 원격이 끊겨 있어 실패한 것은 띠에 띄우지 않는다 (사이드바 연결 배지가 알린다) */
  private failQuiet(e: unknown) {
    if (!this.isRoot && this.hostState() !== "connected") console.warn("[thuminal]", this.hostKey, e);
    else this.fail(e);
  }

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
      c.links = {
        resolve: (path) => this.services.host.resolvePath(path, this.linkBases(id)),
        open: (link, mode) => this.openLink(id, link, mode),
      };
      c.isAgent = () => !!this.get().sessions[id]?.agent;
      this.controllers.set(id, c);
      c.open().catch((e) => this.fail(`세션 ${id}에 붙지 못했다: ${e}`));
    }
    return c;
  }

  private engineColors: Parameters<TerminalController["setColors"]>[0] = null;

  private setEngineColors(colors: Parameters<TerminalController["setColors"]>[0]) {
    this.engineColors = colors;
    for (const c of this.controllers.values()) c.setColors(colors);
  }

  // ---- 터미널 링크 ----

  /** 터미널 글자 속 상대 경로를 풀 기준 폴더: 셸 폴더, claude 폴더, 그 칸의 워크트리 */
  private linkBases(id: SessionId): string[] {
    const s = this.get().sessions[id];
    const ws = this.workspaceOf(id);
    const all = [s?.cwd, s?.agent?.cwd, ws && ws !== OTHER_WORKSPACE && ws !== FLOATING_WORKSPACE ? ws : null];
    return [...new Set(all.filter((p): p is string => !!p && p.startsWith("/")))];
  }

  /** 링크를 연다. system: 기본 앱(⌘+클릭), app: thuminal 안(⌘⇧+클릭) */
  openLink = (id: SessionId, link: ResolvedLink, mode: "system" | "app") => {
    const host = this.services.host;
    const fail = (e: unknown) => this.fail(e);
    if (link.kind === "url") {
      if (mode === "app" && host.browser) void this.newBrowserTab(this.workspaceOf(id) ?? undefined, link.url);
      else if (host.openUrl) void host.openUrl(link.url).catch(fail);
      else window.open(link.url, "_blank", "noopener");
      return;
    }
    // 원격 경로는 이 컴퓨터 앱·Finder·file:// 로 열 수 없다. 워크트리 안 파일만 파일 칸으로 연다 (내려받아 열기는 다음 단계)
    const remote = !!host.isRemote;
    if (mode === "system" && host.openPath && !remote) return void host.openPath(link.path).catch(fail);
    // thuminal 안: 폴더는 Finder, HTML 은 브라우저 칸, 워크트리 안 파일은 파일 칸 (줄까지)
    if (link.isDir) return remote ? this.notice("원격 컴퓨터 폴더는 아직 열 수 없다") : void host.reveal(link.path).catch(fail);
    if (/\.html?$/i.test(link.path) && host.browser && !remote) return void this.newBrowserTab(this.workspaceOf(id) ?? undefined, `file://${encodeURI(link.path)}`);
    const wt = this.get()
      .worktrees.filter((w) => link.path.startsWith(`${w.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!wt) {
      if (remote) return this.notice("원격 컴퓨터의 워크트리 밖 파일은 아직 열 수 없다");
      // 파일 칸은 워크트리 안 파일만 연다. 밖이면 기본 앱으로
      if (host.openPath) {
        this.notice("워크트리 밖 파일이라 기본 앱으로 열었다");
        return void host.openPath(link.path).catch(fail);
      }
      return this.notice("워크트리 밖 파일은 열 수 없다");
    }
    if (this.get().active !== wt.path) this.select(wt.path);
    this.openDoc({ kind: "file", file: link.path.slice(wt.path.length + 1), ...(link.line ? { line: String(link.line) } : {}) });
  };

  // ---- 워크스페이스 ----

  workspaceOf(session: SessionId): WorkspaceId | null {
    return paneOfSession(Object.values(this.get().layouts), session)?.layout.workspace ?? null;
  }

  /**
   * 마지막으로 본 뒤 알릴 일이 생겼는지 (사이드바에서 굵게, 종이 보인다).
   * Orca 와 같이 에이전트가 턴을 끝냈거나, 사용자를 부르거나, 벨이 울렸을 때만 친다. 출력만 나온 것은 치지 않는다
   */
  unread(ws: WorkspaceId, s: AppState = this.get()): boolean {
    if (ws === s.active && s.activeHost === this.hostKey) return false;
    const seen = s.seen[this.placeKey(ws)] ?? 0;
    return sessionsOf(s.layouts[ws]).some((id) => {
      const x = s.sessions[id];
      if (!x) return false;
      const a = x.agent;
      return (x.bell_at ?? 0) > seen || (!a?.interrupted && (a?.turn_ended_at ?? 0) > seen) || (a?.state === "needs_attention" && a.updated_at > seen);
    });
  }

  private markSeen(ws: WorkspaceId = this.get().active) {
    this.set((s) => ({ seen: { ...s.seen, [this.placeKey(ws)]: Date.now() } }));
    localStorage.setItem(SEEN_KEY, JSON.stringify(this.get().seen));
  }

  /** 상태 칸을 눌러 읽음으로 돌린다 */
  markRead = (ws: WorkspaceId) => this.markSeen(ws);

  /** 워크트리 방문 기록의 `placeKey` (⌘⌥← → 로 오간다. root 가 든다). 기록 안에서 옮겨 다닐 때는 쌓지 않는다 */
  private history: string[] = [];
  private historyAt = -1;

  /** 지금 메인 면에 보이는 곳의 `placeKey` */
  currentPlace(): string {
    const m = this.activeModel();
    return m.placeKey(m.get().active);
  }

  /** 이 호스트의 워크스페이스를 메인 면에 고른다 (호스트도 바뀐다) */
  select = (ws: WorkspaceId, fromHistory = false) => {
    const root = this.root;
    const key = this.placeKey(ws);
    const before = this.activeModel();
    if (!fromHistory && key !== root.currentPlace()) {
      root.history = [...root.history.slice(0, root.historyAt + 1), key].slice(-50);
      root.historyAt = root.history.length - 1;
    }
    // 떠나는 곳을 읽음으로 (다른 호스트에서 올 수도 있다)
    before.markSeen();
    const recent = [key, ...this.get().recent.filter((x) => x !== key)].slice(0, 30);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    this.set({ active: ws, activeHost: this.hostKey, focusArea: "main", recent });
    this.markSeen();
    void this.refreshStatus(ws);
  };

  /** `placeKey` 로 고른다. 그 호스트가 없으면(지운 원격) false */
  selectPlace = (key: string, fromHistory = false): boolean => {
    const p = parsePlace(key);
    const m = this.hostModel(p.host);
    if (!m) return false;
    m.select(p.ws, fromHistory);
    return true;
  };

  goHistory = (delta: number) => {
    const root = this.root;
    if (root.historyAt < 0) root.history = [root.currentPlace()];
    const at = Math.max(0, Math.min(root.history.length - 1, (root.historyAt < 0 ? 0 : root.historyAt) + delta));
    root.historyAt = at;
    const key = root.history[at];
    if (key && key !== root.currentPlace()) root.selectPlace(key, true);
  };

  /** 사이드바에 보이는 순서의 `placeKey` (DOM 에서 읽는다. 접힌 그룹은 빠진다. 호스트는 가장 가까운 `data-host`) */
  private sidebarOrder(): string[] {
    const order = [...document.querySelectorAll<HTMLElement>("[data-drop-workspace]")].map((e) =>
      placeKey(e.closest<HTMLElement>("[data-host]")?.dataset.host ?? "", e.dataset.dropWorkspace!),
    );
    return order.filter((ws, i) => order.indexOf(ws) === i);
  }

  /** ⌘1~9 */
  selectWorktreeIndex = (i: number) => {
    const key = this.root.sidebarOrder()[i];
    if (key) this.root.selectPlace(key);
  };

  /** ⌘⇧↑ ↓: 사이드바 순서로 이전·다음 워크트리 */
  selectNearWorktree = (delta: number) => {
    const list = this.root.sidebarOrder();
    if (!list.length) return;
    const i = list.indexOf(this.root.currentPlace());
    this.root.selectPlace(list[(i + delta + list.length) % list.length]);
  };

  /** 그 탭을 연다. 이미 그 탭이 열려 있으면 오른쪽 사이드바를 닫는다 */
  setPanel = (p: Panel) => {
    if (p) localStorage.setItem(RIGHT_TAB_KEY, p);
    this.set((s) => ({ panel: s.panel === p ? null : p }));
  };

  /** 오른쪽 사이드바를 열고 닫는다 (⌘L). 열면 마지막에 본 탭 */
  toggleRight = () =>
    this.set((s) => ({ panel: s.panel ? null : ((localStorage.getItem(RIGHT_TAB_KEY) as Panel) ?? "changes") }));

  setRightWidth = (w: number) => {
    const width = Math.round(Math.min(720, Math.max(220, w)));
    localStorage.setItem(RIGHT_WIDTH_KEY, String(width));
    this.set({ rightWidth: width });
  };

  setCommitDraft = (ws: string, text: string) => this.set((s) => ({ commitDrafts: { ...s.commitDrafts, [ws]: text } }));
  /** 창을 연다. 창 안 동작은 이 모델(호스트)이 맡는다 */
  setDialog = (d: Dialog) => this.set({ dialog: d, dialogHost: this.hostKey });
  setFocusArea = (a: AppState["focusArea"]) => this.set({ focusArea: a });

  // ---- 알림 ----

  setNotify = (patch: Partial<NotifySettings>) => {
    const notify = { ...this.get().notify, ...patch };
    saveNotifySettings(notify);
    this.set({ notify });
  };

  /** 세션이 든 워크스페이스 이름 (알림 제목). 원격이면 컴퓨터 이름을 앞에 붙인다 */
  private workspaceTitle(ws: WorkspaceId): string {
    const name = this.hostName();
    const prefix = name ? `${name} · ` : "";
    if (ws === FLOATING_WORKSPACE) return "플로팅 터미널";
    if (ws === OTHER_WORKSPACE) return `${prefix}워크트리 밖 터미널`;
    const w = this.get().worktrees.find((x) => x.path === ws);
    return prefix + (w ? worktreeTitle(w) : (ws.split("/").pop() ?? ws));
  }

  /** 지금 그 칸을 보고 있는지: 앱이 앞에 있고, 그 호스트·워크스페이스·탭이 화면에 있다 */
  private watching(session: SessionId): boolean {
    if (!document.hasFocus()) return false;
    const s = this.get();
    const at = paneOfSession(Object.values(s.layouts), session);
    if (!at) return false;
    const ws = at.layout.workspace;
    const shown = ws === FLOATING_WORKSPACE ? this.isRoot && s.floating.open : ws === s.active && s.activeHost === this.hostKey;
    return shown && activeTab(at.layout)?.id === at.tab.id;
  }

  private notifySession(session: SessionId, n: Notice) {
    const s = this.get();
    // 알림은 창 하나의 일이라 로컬 껍데기로 띄운다
    const notify = this.root.services.host.notify;
    if (!notify || !allowed(s.notify, n.kind) || this.watching(session)) return;
    const at = paneOfSession(Object.values(s.layouts), session);
    if (!at) return;
    const id = this.root.noticeId(this.hostKey, session);
    void notify({ title: this.workspaceTitle(at.layout.workspace), subtitle: n.subtitle, body: n.body, session: id, sound: s.notify.sound }).catch(() => undefined);
  }

  /** 원격 호스트 알림 번호 → (호스트, 세션). 로컬 세션은 세션 번호를 그대로 쓴다 (root 만 든다) */
  private readonly notices = new Map<number, { host: string; session: SessionId }>();
  private nextNotice = REMOTE_NOTICE_BASE;

  /** 알림에 실을 번호. 누르면 이 번호가 돌아온다 */
  private noticeId(host: string, session: SessionId): number {
    if (!host) return session;
    for (const [id, v] of this.notices) if (v.host === host && v.session === session) return id;
    const id = this.nextNotice++;
    this.notices.set(id, { host, session });
    // 오래된 것부터 버린다
    if (this.notices.size > 500) this.notices.delete(this.notices.keys().next().value!);
    return id;
  }

  /** 알림을 눌렀다 (root) */
  private onNoticeClick(id: number) {
    const hit = this.notices.get(id);
    if (!hit) return this.revealSession(id);
    this.hostModel(hit.host)?.revealSession(hit.session);
  }

  /** 알림을 눌렀다: 그 세션이 든 호스트·워크스페이스·탭·칸으로 간다 */
  revealSession = (session: SessionId) => {
    const s = this.get();
    const at = paneOfSession(Object.values(s.layouts), session);
    if (!at) return;
    const ws = at.layout.workspace;
    if (ws === FLOATING_WORKSPACE) {
      if (!s.floating.open) void this.toggleFloating();
    } else if (ws !== s.active || s.activeHost !== this.hostKey) this.select(ws);
    if (activeTab(at.layout)?.id !== at.tab.id) this.selectTab(at.tab.id);
    this.focusPane(at.pane.id);
  };

  // ---- 에이전트 팀 (팀원은 칸이 아니라 리더 칸에 딸린 패널에 그린다) ----

  private setTeam = (leader: SessionId, f: (v: TeamView) => TeamView) =>
    this.set((s) => {
      const v = teamView(s, leader);
      const next = f(v);
      if (next.open === v.open && next.mate === v.mate && next.keys === v.keys) return {};
      // 팀 팝업을 열면 그림 팝업은 닫는다
      return { teams: { ...s.teams, [leader]: next }, ...(next.open && s.gallery[leader] ? { gallery: { ...s.gallery, [leader]: false } } : {}) };
    });

  /** 붙인 그림 팝업을 열고 닫는다. 열면 팀 팝업은 닫는다 */
  toggleGallery = (session: SessionId, open?: boolean) =>
    this.set((s) => {
      const o = open ?? !s.gallery[session];
      if (o === !!s.gallery[session]) return {};
      return { gallery: { ...s.gallery, [session]: o }, ...(o && s.teams[session]?.open ? { teams: { ...s.teams, [session]: DEFAULT_TEAM_VIEW } } : {}) };
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

  /** 키보드 단축키가 다룰 워크스페이스 (플로팅은 로컬 모델에만 있다) */
  currentWorkspace(): WorkspaceId {
    const s = this.get();
    return this.isRoot && s.floating.open && s.focusArea === "floating" ? FLOATING_WORKSPACE : s.active;
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

  /**
   * 에이전트가 든 칸은 닫기 전에 묻는다 (닫으면 그 세션이 끝난다). 다른 터미널은 바로 닫는다.
   * 훅이 알려 온 에이전트가 없어도 셸 밑에 claude 같은 프로세스가 돌면 묻는다 (플러그인 없이 띄운 claude 등)
   */
  private guardClose(panes: number[], what: string, run: () => void) {
    const s = this.get();
    const terms = Object.values(s.layouts)
      .flatMap((l) => l.tabs)
      .flatMap((t) => panesOf(t.root))
      .flatMap((p) => (panes.includes(p.id) && p.type === "terminal" && s.sessions[p.session] ? [s.sessions[p.session]] : []))
      .filter((info) => info.state.state !== "exited");
    const ask = (busy: string[]) =>
      this.setDialog({
        kind: "confirm",
        title: `${what} 닫을까?`,
        body: `${[...new Set(busy)].join(", ")}가 돌고 있다. 닫으면 그 세션이 끝난다.`,
        action: "닫기",
        run,
      });
    const reported = terms.flatMap((t) => (t.agent ? [t.agent.kind] : []));
    if (reported.length) return ask(reported);
    if (!terms.length) return run();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500));
    Promise.race([this.services.host.runningAgents(terms.map((t) => t.id), AGENTS.map((a) => a.cmd)), timeout])
      .then((found) => (found.length ? ask(found.map((f) => f.name)) : run()))
      .catch(() => run());
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
          // 같은 파일이 열려 있으면 그 칸으로. 줄이 다르면 그 줄로 옮긴다 (Markdown 이 미리보기였어도 줄을 보이게 원문으로)
          if ((p.doc.line ?? "") !== (doc.line ?? "")) {
            const next = { ...p.doc, ...doc };
            if (doc.line) delete next.view;
            void this.op({ op: "update_doc", pane: byId(p.id), doc: next });
          }
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
  toggleFloating = async (maximized?: boolean): Promise<void> => {
    if (!this.isRoot) return this.root.toggleFloating(maximized);
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

  // ---- 글꼴과 확대 ----

  /** 터미널 글꼴을 바꾼다. 새 글꼴을 등록한 뒤에 바꿔야 칸 크기를 그 글꼴로 잰다 */
  setTerminalFont = async (patch: Partial<TerminalFont>) => {
    const font = { ...this.get().terminalFont, ...patch };
    if (patch.size !== undefined) font.size = clampFontSize(patch.size);
    saveTerminalFont(font);
    if (patch.family !== undefined) await registerTerminalFonts(this.services.host, font.family);
    this.set({ terminalFont: font });
  };

  /** 지금 터미널 글자 크기 (설정 + ⌘+ ⌘-) */
  terminalFontSize = (s: AppState = this.get()) => clampFontSize(s.terminalFont.size + s.zoom.terminal);

  private setZoom(zoom: Zoom) {
    saveZoom(zoom);
    this.set({ zoom });
  }

  /** ⌘+ ⌘- ⌘0 을 터미널에서: 모든 터미널 글자 크기를 1px 씩, 0 이면 설정 크기로 */
  zoomTerminal = (dir: 1 | -1 | 0) => {
    const s = this.get();
    const terminal = dir === 0 ? 0 : clampFontSize(this.terminalFontSize() + dir) - s.terminalFont.size;
    this.setZoom({ ...s.zoom, terminal });
  };

  /** ⌘+ ⌘- ⌘0 을 터미널 밖에서: 앱 화면 배율. 껍데기가 확대를 못 하면(웹) false 를 돌려 브라우저에 맡긴다 */
  zoomUi = (dir: 1 | -1 | 0): boolean => {
    const host = this.services.host;
    if (!host.setUiZoom) return false;
    const s = this.get();
    const ui = dir === 0 ? 1 : nextUiZoom(s.zoom.ui, dir);
    this.setZoom({ ...s.zoom, ui });
    void host.setUiZoom(ui).catch((e) => this.fail(e));
    return true;
  };

  /**
   * 화면 토큰, 앱 엔진 색, 데몬 엔진 색을 지금 테마로 맞춘다. 원격 호스트 모델은 앱 엔진 색만 root 것을 따른다
   * (원격 데몬 터미널 색은 그 컴퓨터 설정 그대로 둔다)
   */
  private async applyTheme() {
    if (!this.isRoot) return this.setEngineColors(this.root.engineColors);
    const { theme, systemDark } = this.get();
    const r = applyTheme(theme, systemDark);
    this.setEngineColors(r.engine);
    for (const child of this.children.values()) child.setEngineColors(r.engine);
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
        setPage(pageKey(this.hostKey, e.id), { title: e.title });
        return;
      case "load": {
        setPage(pageKey(this.hostKey, e.id), { url: e.url, loading: e.loading });
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
    const area = this.isRoot && hit.workspace === FLOATING_WORKSPACE ? "floating" : "main";
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
  /**
   * 떠 있는 claude 세션(`running`)은 `running` 방식으로 가져온다:
   * - fork: `--fork-session` 으로 기록을 복사한 새 세션을 연다. Orca 쪽 claude 는 그대로 돈다
   * - move: Orca 쪽 claude 를 끝낸 뒤 같은 세션을 이어 붙인다
   */
  importOrca = async (pick: {
    repos: string[];
    names: { path: string; name: string }[];
    parents: { path: string; parent: string }[];
    sessions: OrcaSession[];
    running: "fork" | "move";
  }) => {
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
    // 하위 워크트리: thuminal 에 부모가 없는 워크트리만, 부모도 등록돼 있을 때
    let parents = 0;
    const wts = this.get().worktrees;
    const orphan = pick.parents.filter(({ path, parent }) => wts.some((w) => w.path === path && !w.parent) && wts.some((w) => w.path === parent));
    // 부모가 돌고 도는 경우는 데몬이 거절한다. 차례로 보낸다
    for (const { path, parent } of orphan) await host.updateWorktree(path, { parent }).then(() => parents++, () => undefined);
    let sessions = 0;
    for (const s of pick.sessions) {
      const wts = this.get().worktrees;
      const inside = (p: string) => s.cwd === p || s.cwd.startsWith(`${p}/`);
      const ws = s.floating
        ? FLOATING_WORKSPACE
        : (wts.find((w) => w.path === s.worktree)?.path ?? wts.filter((w) => inside(w.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path ?? OTHER_WORKSPACE);
      let input = `claude --resume ${s.session_id}`;
      if (s.running && pick.running === "fork") input += " --fork-session";
      if (s.running && pick.running === "move") {
        const stopped = await host.stopClaudeSession(s.session_id).then(
          () => true,
          (e) => (failed.push(`${s.title || s.session_id}: Orca 쪽 claude를 끄지 못했다 (${e})`), false),
        );
        if (!stopped) continue;
      }
      // 셸에서 치게 해서 thuminal claude 실행기(훅·권한·팀)로 뜨게 한다
      await host.layout({ op: "new_tab", workspace: ws, spawn: { command: [], input, cwd: s.cwd, env: {} }, focus: false }).then(
        () => sessions++,
        (e) => failed.push(`${s.title || s.session_id}: ${e}`),
      );
    }
    if (names || parents) await this.refreshWorkspace();
    const done = `Orca에서 가져왔다: 프로젝트 ${repos}개, 워크트리 이름 ${names}개, 하위 워크트리 ${parents}개, claude 세션 ${sessions}개`;
    if (failed.length) this.fail(`${done}. 못 가져온 것: ${failed.join(" / ")}`);
    else this.notice(done);
  };

  removeProject = async (repo: string) => {
    await this.services.host.removeRepo(repo).catch(this.fail);
  };

  /** 그릴 워크스페이스 목록 (저장소 목록에 맞춘 것) */
  groupsOf = (s: AppState = this.get()): RepoGroup[] => normalizeGroups(s.groups, s.repos);

  /** 워크스페이스 목록을 통째로 데몬에 보낸다. 화면은 바로 바꾸고, 데몬이 거절하면 되돌린다. 데몬이 맞춘 목록을 돌려준다 */
  private saveGroups = async (next: RepoGroup[] | null): Promise<RepoGroup[] | null> => {
    if (!next) return null;
    const prev = this.get().groups;
    this.set({ groups: next });
    try {
      const groups = await this.services.host.setGroups(next);
      this.set({ groups });
      return groups;
    } catch (e) {
      this.set({ groups: prev });
      this.fail(`워크스페이스를 바꾸지 못했다: ${e}`);
      return null;
    }
  };

  /** 새 워크스페이스를 끝에 만들고(프로젝트 `repos` 를 옮겨 넣고) 새 id 를 돌려준다 */
  createGroup = async (name = NEW_GROUP_NAME, repos: string[] = []): Promise<string | null> => {
    const cur = this.groupsOf().map((g) => ({ ...g, repos: g.repos.filter((r) => !repos.includes(r)) }));
    const got = await this.saveGroups([...cur, { id: "", name, repos }]);
    return got?.find((g) => !cur.some((c) => c.id === g.id))?.id ?? null;
  };

  renameGroup = (id: string, name: string) => {
    const n = name.trim();
    if (!n) return;
    void this.saveGroups(this.groupsOf().map((g) => (g.id === id ? { ...g, name: n } : g)));
  };

  /** 워크스페이스를 지운다. 든 프로젝트는 기본으로 간다 */
  deleteGroup = (id: string) => void this.saveGroups(removeGroup(this.groupsOf(), id));

  /** 워크스페이스 차례를 `delta` 칸 옮긴다 */
  shiftGroup = (id: string, delta: number) => void this.saveGroups(shiftGroup(this.groupsOf(), id, delta));

  /** 프로젝트를 워크스페이스 `group` 의 `index` 자리(없으면 끝)로 옮긴다 */
  moveProject = (repo: string, group: string, index?: number) => void this.saveGroups(moveRepo(this.groupsOf(), repo, group, index));

  /** 워크트리를 만든다. 창은 바로 닫히고, 만드는 동안 사이드바에 진행 줄이 보인다 */
  newWorktree = async (req: NewWorktree) => {
    const item = { repo: req.repo, branch: req.branch };
    this.set((s) => ({ creating: [...s.creating, item] }));
    try {
      const w = await this.services.host.createWorktree(req.repo, req.branch, { base: req.base, name: req.name || undefined, parent: req.parent });
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

  /** 부모 워크트리를 바꾼다 (null 이면 부모에서 뗀다) */
  setWorktreeParent = async (w: WorktreeInfo, parent: string | null) => {
    await this.services.host.updateWorktree(w.path, { parent }).catch(this.fail);
  };
}

/** 창 전체 키만 고른다 */
function pickWindow(s: AppState): Partial<AppState> {
  const out: Record<string, unknown> = {};
  for (const k of WINDOW_KEYS) out[k] = s[k];
  return out as Partial<AppState>;
}

/** 화면 조각이 다룰 모델. 사이드바 원격 칸은 그 호스트 모델, 메인 면은 고른 호스트 모델로 감싼다 */
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
