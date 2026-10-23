// 화면 상태: 저장소, 워크트리와 git 상태, 데몬 세션, 탭(터미널과 문서), 오른쪽 패널.
//
// 세션은 꼬리표 `worktree`(데몬이 시작 폴더로 채운다)로 워크트리에 묶는다.
// 워크트리 밖에서 띄운 세션은 "기타" 에 모인다.

import {
  type DaemonEvent,
  type GitStatus,
  type RepoInfo,
  type SessionId,
  type SessionInfo,
  WORKTREE_LABEL,
  type WorktreeInfo,
} from "@thuminal/term-core";

import type { Services } from "./services";
import { TerminalController } from "./terminal-controller";

/** 워크트리에 묶이지 않은 세션 자리 */
export const OTHER = "";
/** 플로팅 터미널 세션 꼬리표 (사이드바, 탭에 나오지 않는다) */
export const FLOATING_LABEL = "floating";
const FLOATING = "\u0000floating";

/** 문서 탭: 파일 보기, diff 보기 */
export interface DocTab {
  id: string;
  kind: "diff" | "file";
  file: string;
  /** diff 탭이면 스테이지된 변경을 보는지 */
  staged?: boolean;
}

/** 탭 열쇠: 터미널은 세션 번호, 문서는 문자열 id */
export type TabKey = SessionId | string;

export type Panel = "files" | "changes" | null;

export interface NewWorktree {
  repo: string;
  name: string;
  branch: string;
  base?: string;
  /** 처음 띄울 것 */
  start: "shell" | "claude" | "none";
}

export interface Snapshot {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  sessions: SessionInfo[];
  status: ReadonlyMap<string, GitStatus>;
  /** 고른 워크트리 경로 (OTHER 면 기타) */
  active: string;
  activeTab: TabKey | null;
  docs: DocTab[];
  panel: Panel;
  /** 플로팅 터미널이 열려 있으면 그 세션 */
  floating: SessionId | null;
  /** 데몬에 다시 붙을 때마다 는다. 세션 번호가 같아도 다시 붙게 한다 */
  generation: number;
  /** 워크트리마다 마지막으로 본 때 (ms) */
  seen: ReadonlyMap<string, number>;
  /** 만드는 중인 워크트리 */
  creating: { repo: string; branch: string }[];
  error: string | null;
}

export const worktreeTitle = (w: WorktreeInfo) => w.name || w.branch || w.path.split("/").pop() || w.path;

export class Store {
  private repos: RepoInfo[] = [];
  private worktrees: WorktreeInfo[] = [];
  private sessions = new Map<SessionId, SessionInfo>();
  private controllers = new Map<SessionId, TerminalController>();
  private status = new Map<string, GitStatus>();
  private docs = new Map<string, DocTab[]>();
  private active = OTHER;
  private activeByPlace = new Map<string, TabKey>();
  private seen = new Map<string, number>();
  private panel: Panel = null;
  private creating: { repo: string; branch: string }[] = [];
  private error: string | null = null;
  private floatingOpen = false;
  private generation = 0;
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private timers: number[] = [];

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
    this.markSeen();
    this.emit();
    void this.refreshStatus();
    // git 상태: 지금 워크트리는 2초, 모두는 4초마다
    this.timers.push(window.setInterval(() => void this.refreshStatus(this.active), 2000));
    this.timers.push(window.setInterval(() => void this.refreshStatus(), 4000));
  }

  stop() {
    for (const t of this.timers) window.clearInterval(t);
  }

  private async refreshWorkspace() {
    [this.repos, this.worktrees] = await Promise.all([this.s.host.listRepos(), this.s.host.listWorktrees()]);
  }

  /** git 상태를 다시 읽는다. `only` 를 주면 그 워크트리만 */
  async refreshStatus(only?: string) {
    const targets = only !== undefined ? this.worktrees.filter((w) => w.path === only) : this.worktrees;
    let changed = false;
    await Promise.all(
      targets.map(async (w) => {
        try {
          const st = await this.s.host.git.status(w.path);
          if (JSON.stringify(st) !== JSON.stringify(this.status.get(w.path))) {
            this.status.set(w.path, st);
            changed = true;
          }
        } catch {
          // 지워지는 중인 워크트리 등은 넘어간다
        }
      }),
    );
    if (changed) this.emit();
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
        void this.refreshWorkspace().then(
          () => {
            this.emit();
            void this.refreshStatus();
          },
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

  fail(e: unknown) {
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

  /** 마지막으로 본 뒤 출력이 있었는지 (사이드바에서 굵게 보인다) */
  unread(place: string): boolean {
    const seen = this.seen.get(place) ?? 0;
    return place !== this.active && this.tabsAt(place).some((s) => s.last_output_at > seen + 1500);
  }

  private markSeen() {
    this.seen.set(this.active, Date.now());
  }

  private build(): Snapshot {
    const tabs = this.tabsAt(this.active);
    const docs = this.docs.get(this.active) ?? [];
    let activeTab = this.activeByPlace.get(this.active) ?? null;
    const exists = (k: TabKey | null) => k !== null && (typeof k === "number" ? tabs.some((s) => s.id === k) : docs.some((d) => d.id === k));
    if (!exists(activeTab)) activeTab = tabs[0]?.id ?? docs[0]?.id ?? null;
    return {
      repos: this.repos,
      worktrees: this.worktrees,
      sessions: [...this.sessions.values()],
      status: new Map(this.status),
      active: this.active,
      activeTab,
      docs,
      panel: this.panel,
      floating: this.floatingOpen ? (this.floatingSession()?.id ?? null) : null,
      generation: this.generation,
      seen: new Map(this.seen),
      creating: [...this.creating],
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
    this.markSeen();
    this.active = place;
    this.markSeen();
    this.emit();
    void this.refreshStatus(place);
  }

  selectTab(key: TabKey) {
    this.activeByPlace.set(this.active, key);
    this.emit();
  }

  setPanel(p: Panel) {
    this.panel = this.panel === p ? null : p;
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

  async closeTab(key: TabKey) {
    if (typeof key === "string") {
      this.docs.set(this.active, (this.docs.get(this.active) ?? []).filter((d) => d.id !== key));
      this.emit();
      return;
    }
    await this.s.host.remove(key).catch((e) => this.fail(e));
  }

  /** 문서 탭을 열거나 이미 있으면 그리로 간다 */
  openDoc(doc: Omit<DocTab, "id">) {
    const id = `${doc.kind}:${doc.staged ? "staged:" : ""}${doc.file}`;
    const list = this.docs.get(this.active) ?? [];
    if (!list.some((d) => d.id === id)) this.docs.set(this.active, [...list, { ...doc, id }]);
    this.activeByPlace.set(this.active, id);
    this.emit();
  }

  /** 폴더를 골라 프로젝트로 등록한다 (안에 저장소가 여럿이면 모두) */
  async addProject(path?: string) {
    try {
      const p = path ?? (await this.s.host.pickFolder());
      if (!p) return;
      const repos = await this.s.host.addRepos(p);
      await this.refreshWorkspace();
      const main = this.worktrees.find((w) => w.repo === repos[0]?.id && w.is_main);
      if (main) this.select(main.path);
      this.emit();
    } catch (e) {
      this.fail(`프로젝트를 등록하지 못했다: ${e}`);
    }
  }

  async removeProject(repo: string) {
    await this.s.host.removeRepo(repo).catch((e) => this.fail(e));
  }

  /** 워크트리를 만든다. 창은 바로 닫히고, 만드는 동안 사이드바에 진행 줄이 보인다 */
  async newWorktree(req: NewWorktree) {
    this.creating.push({ repo: req.repo, branch: req.branch });
    this.emit();
    try {
      const w = await this.s.host.createWorktree(req.repo, req.branch, { base: req.base, name: req.name || undefined });
      await this.refreshWorkspace();
      this.select(w.path);
      if (req.start === "shell") await this.newTab();
      else if (req.start === "claude") await this.newTab(["claude"]);
    } catch (e) {
      this.fail(`워크트리를 만들지 못했다: ${e}`);
    } finally {
      this.creating = this.creating.filter((c) => !(c.repo === req.repo && c.branch === req.branch));
      this.emit();
    }
  }

  async removeWorktree(w: WorktreeInfo, opts: { force: boolean; deleteBranch: boolean }) {
    try {
      for (const s of this.tabsAt(w.path)) await this.s.host.remove(s.id);
      await this.s.host.removeWorktree(w.repo, w.path, opts);
      if (this.active === w.path) this.active = OTHER;
      this.docs.delete(w.path);
      await this.refreshWorkspace();
      this.emit();
    } catch (e) {
      this.fail(`워크트리를 지우지 못했다: ${e}`);
    }
  }

  async renameWorktree(w: WorktreeInfo, name: string) {
    await this.s.host.updateWorktree(w.path, { name }).catch((e) => this.fail(e));
  }

  async togglePin(w: WorktreeInfo) {
    await this.s.host.updateWorktree(w.path, { pinned: !w.pinned }).catch((e) => this.fail(e));
  }
}
