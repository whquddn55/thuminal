// 화면 상태: 저장소, 워크트리, 데몬 세션, 지금 고른 워크트리와 탭.
//
// 세션은 꼬리표 `worktree`(데몬이 시작 폴더로 채운다)로 워크트리에 묶는다.
// 워크트리 밖에서 띄운 세션은 "기타" 에 모인다.

import { type DaemonEvent, type RepoInfo, type SessionId, type SessionInfo, WORKTREE_LABEL, type WorktreeInfo } from "@thuminal/term-core";

import type { Services } from "./services";
import { TerminalController } from "./terminal-controller";

/** 워크트리에 묶이지 않은 세션 자리 */
export const OTHER = "";
/** 플로팅 터미널 세션 꼬리표 (사이드바, 탭에 나오지 않는다) */
export const FLOATING_LABEL = "floating";
const FLOATING = "\u0000floating";

export interface Snapshot {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  sessions: SessionInfo[];
  /** 고른 워크트리 경로 (OTHER 면 기타) */
  active: string;
  activeTab: SessionId | null;
  /** 플로팅 터미널이 열려 있으면 그 세션 */
  floating: SessionId | null;
  /** 데몬에 다시 붙을 때마다 는다. 세션 번호가 같아도 다시 붙게 한다 */
  generation: number;
  error: string | null;
}

export class Store {
  private repos: RepoInfo[] = [];
  private worktrees: WorktreeInfo[] = [];
  private sessions = new Map<SessionId, SessionInfo>();
  private controllers = new Map<SessionId, TerminalController>();
  private active = OTHER;
  private activeByPlace = new Map<string, SessionId>();
  private error: string | null = null;
  private floatingOpen = false;
  private generation = 0;
  private listeners = new Set<() => void>();
  private snap: Snapshot;

  constructor(private readonly s: Services) {
    this.snap = this.build();
  }

  async start(): Promise<void> {
    try {
      for (const info of await this.s.host.listSessions()) this.sessions.set(info.id, info);
      await this.refreshWorkspace();
      // 처음에는 세션이 있는 첫 워크트리를 고른다
      const first = this.worktrees.find((w) => this.tabsAt(w.path).length > 0) ?? this.worktrees[0];
      if (first) this.active = first.path;
      this.s.host.onEvent((e) => this.onEvent(e));
    } catch (e) {
      this.fail(e);
    }
    this.emit();
  }

  private async refreshWorkspace() {
    [this.repos, this.worktrees] = await Promise.all([this.s.host.listRepos(), this.s.host.listWorktrees()]);
  }

  private onEvent(e: DaemonEvent) {
    switch (e.type) {
      case "session_created":
      case "session_updated":
        this.sessions.set(e.session.id, e.session);
        break;
      case "session_exited": {
        const s = this.sessions.get(e.session);
        if (s) this.sessions.set(e.session, { ...s, state: { state: "exited", code: e.code } });
        break;
      }
      case "session_removed":
        this.sessions.delete(e.session);
        void this.controllers.get(e.session)?.dispose();
        this.controllers.delete(e.session);
        break;
      case "workspace_changed":
        void this.refreshWorkspace().then(() => this.emit(), (err) => this.fail(err));
        return;
      case "daemon_reconnected":
        void this.reload();
        return;
    }
    this.emit();
  }

  /** 데몬이 다시 떴다: 붙어 있던 탭을 모두 놓고 세션 목록부터 다시 읽는다 */
  private async reload() {
    for (const c of this.controllers.values()) void c.dispose();
    this.controllers.clear();
    this.sessions.clear();
    this.generation++;
    try {
      for (const info of await this.s.host.listSessions()) this.sessions.set(info.id, info);
      await this.refreshWorkspace();
    } catch (e) {
      this.fail(e);
    }
    this.emit();
  }

  private fail(e: unknown) {
    this.error = String(e);
    this.emit();
  }

  clearError() {
    this.error = null;
    this.emit();
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  get = () => this.snap;

  placeOf(s: SessionInfo): string {
    if (s.labels[FLOATING_LABEL]) return FLOATING;
    const w = s.labels[WORKTREE_LABEL];
    return w && this.worktrees.some((x) => x.path === w) ? w : OTHER;
  }

  tabsAt(place: string): SessionInfo[] {
    return [...this.sessions.values()].filter((s) => this.placeOf(s) === place).sort((a, b) => a.created_at - b.created_at);
  }

  private build(): Snapshot {
    const tabs = this.tabsAt(this.active);
    let activeTab = this.activeByPlace.get(this.active) ?? null;
    if (activeTab === null || !tabs.some((s) => s.id === activeTab)) activeTab = tabs[0]?.id ?? null;
    return {
      repos: this.repos,
      worktrees: this.worktrees,
      sessions: [...this.sessions.values()],
      active: this.active,
      activeTab,
      floating: this.floatingOpen ? (this.floatingSession()?.id ?? null) : null,
      generation: this.generation,
      error: this.error,
    };
  }

  private emit() {
    this.snap = this.build();
    for (const l of this.listeners) l();
  }

  /** 탭을 처음 볼 때 한 번 붙는다. 그 뒤로는 탭이 닫힐 때까지 붙어 있다 */
  controller(id: SessionId): TerminalController {
    let c = this.controllers.get(id);
    if (!c) {
      c = new TerminalController(this.s, id);
      this.controllers.set(id, c);
      c.open().catch((e) => this.fail(`세션 ${id} 에 붙지 못했다: ${e}`));
    }
    return c;
  }

  private floatingSession(): SessionInfo | undefined {
    return this.tabsAt(FLOATING).find((s) => s.state.state === "running");
  }

  /** 플로팅 터미널을 열고 닫는다. 처음 열 때 홈 폴더에서 셸을 띄운다 */
  async toggleFloating() {
    if (this.floatingOpen) {
      this.floatingOpen = false;
      this.emit();
      return;
    }
    if (!this.floatingSession()) {
      try {
        const info = await this.s.host.createSession({ cols: 120, rows: 30, labels: { [FLOATING_LABEL]: "1" } });
        this.sessions.set(info.id, info);
      } catch (e) {
        this.fail(`플로팅 터미널을 열지 못했다: ${e}`);
        return;
      }
    }
    this.floatingOpen = true;
    this.emit();
  }

  select(place: string) {
    this.active = place;
    this.emit();
  }

  selectTab(id: SessionId) {
    this.activeByPlace.set(this.active, id);
    this.emit();
  }

  async newTab(command?: string[]) {
    try {
      const cwd = this.active === OTHER ? null : this.active;
      const info = await this.s.host.createSession({ command, cwd, cols: 120, rows: 40 });
      this.sessions.set(info.id, info);
      this.activeByPlace.set(this.placeOf(info), info.id);
      this.emit();
    } catch (e) {
      this.fail(`새 탭을 열지 못했다: ${e}`);
    }
  }

  async closeTab(id: SessionId) {
    await this.s.host.remove(id).catch((e) => this.fail(e));
  }

  async addRepo(path: string) {
    try {
      const r = await this.s.host.addRepo(path);
      await this.refreshWorkspace();
      const main = this.worktrees.find((w) => w.repo === r.id && w.is_main);
      if (main) this.active = main.path;
      this.emit();
    } catch (e) {
      this.fail(`저장소를 등록하지 못했다: ${e}`);
    }
  }

  async newWorktree(repo: string, branch: string) {
    try {
      const w = await this.s.host.createWorktree(repo, branch);
      await this.refreshWorkspace();
      this.active = w.path;
      this.emit();
      await this.newTab();
    } catch (e) {
      this.fail(`워크트리를 만들지 못했다: ${e}`);
    }
  }

  async removeWorktree(w: WorktreeInfo) {
    try {
      for (const s of this.tabsAt(w.path)) await this.s.host.remove(s.id);
      await this.s.host.removeWorktree(w.repo, w.path, { force: true, deleteBranch: false });
      if (this.active === w.path) this.active = OTHER;
      await this.refreshWorkspace();
      this.emit();
    } catch (e) {
      this.fail(`워크트리를 지우지 못했다: ${e}`);
    }
  }
}
