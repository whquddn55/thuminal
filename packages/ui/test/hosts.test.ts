// 한 창에 로컬과 원격 호스트 모델을 같이 둘 때: 같은 세션 번호·같은 워크트리 경로가 겹쳐도 섞이지 않는지,
// 고르기·⌘ 번호·방문 기록·알림 누르기가 호스트를 넘나드는지 본다. 화면 없이 AppModel 만 돌린다.

import type { DaemonEvent, HostApi, RemoteHost, SessionInfo, WorkspaceLayout, WorktreeInfo } from "@thuminal/term-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Store from "../src/store";

// ---- 브라우저 흉내 (store 는 window · document · localStorage 를 쓴다) ----

const storage = new Map<string, string>();
let sidebar: { host: string; ws: string }[] = [];

Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  window: Object.assign(globalThis, {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  }),
  document: {
    documentElement: { classList: { toggle: () => undefined }, style: { setProperty: () => undefined } },
    hasFocus: () => false,
    // 사이드바 워크트리 카드 (⌘1~9 가 DOM 차례를 읽는다)
    querySelectorAll: () =>
      sidebar.map((c) => ({ dataset: { dropWorkspace: c.ws }, closest: () => ({ dataset: { host: c.host } }) })),
  },
});

let S: typeof Store;
beforeAll(async () => {
  S = await import("../src/store");
});

// ---- 가짜 데몬 ----

const WT = "/Users/me/proj";

const session = (id: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `s${id}`,
  cwd: WT,
  command: [],
  cols: 80,
  rows: 24,
  pid: null,
  state: { state: "running" },
  created_at: 0,
  last_output_at: 0,
  attached: 0,
  labels: {},
  agent: null,
  restored_from: null,
  bell_at: 0,
  ...extra,
});

const layout = (ws: string, pane: number, sess: number, tab: number): WorkspaceLayout => ({
  workspace: ws,
  tabs: [{ id: tab, title: null, root: { type: "pane", pane: { id: pane, type: "terminal", session: sess } }, focused: pane, zoomed: null }],
  active_tab: tab,
});

const worktree = (path: string, repo = "r1"): WorktreeInfo => ({ repo, path, branch: "main", head: "abc", is_main: true, name: null, pinned: false });

interface Fake {
  api: HostApi;
  emit(e: DaemonEvent): void;
  ops: unknown[];
}

function fakeHost(hostId: string | undefined, data: { sessions: SessionInfo[]; worktrees: WorktreeInfo[]; layouts: WorkspaceLayout[] }): Fake {
  const listeners = new Set<(e: DaemonEvent) => void>();
  const ops: unknown[] = [];
  const api = {
    hostId,
    isRemote: hostId !== undefined,
    onEvent: (cb: (e: DaemonEvent) => void) => (listeners.add(cb), () => listeners.delete(cb)),
    listSessions: async () => data.sessions,
    listRepos: async () => [{ id: "r1", name: "proj", path: WT }],
    listGroups: async () => [],
    listWorktrees: async () => data.worktrees,
    getLayout: async () => data.layouts,
    findCommands: async () => [],
    setTerminalColors: async () => undefined,
    git: { status: () => Promise.reject(new Error("없다")) },
    layout: async (op: unknown) => {
      ops.push(op);
      return { layouts: [], created: [] };
    },
  } as unknown as HostApi;
  return { api, emit: (e) => listeners.forEach((l) => l(e)), ops };
}

const remoteHost = (id: string, state: RemoteHost["state"] = "connected"): RemoteHost => ({
  id,
  name: "집 맥",
  address: "100.64.0.2:6780",
  state,
  error: null,
  daemonVersion: "0.1.0",
  protocol: [1, 0],
  warning: null,
  retryInMs: null,
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const HOST = "a1b2c3d4";

/** 로컬과 원격 하나. 둘 다 세션 1 이 같은 경로 워크트리 WT 의 칸 1 에 들어 있다 */
async function setup(remoteState: RemoteHost["state"] = "connected") {
  const local = fakeHost(undefined, { sessions: [session(1)], worktrees: [worktree(WT)], layouts: [layout(WT, 1, 1, 1)] });
  const remote = fakeHost(HOST, {
    sessions: [session(1, { title: "원격 셸" })],
    worktrees: [worktree(WT), worktree("/Users/me/other")],
    layouts: [layout(WT, 1, 1, 1)],
  });
  const notify = vi.fn(async () => undefined);
  let click: ((n: number) => void) | null = null;
  let hostsCb: ((h: RemoteHost[]) => void) | null = null;
  Object.assign(local.api, {
    notify,
    onNotificationClick: (cb: (n: number) => void) => ((click = cb), () => undefined),
    hosts: {
      onChange: (cb: (h: RemoteHost[]) => void) => {
        hostsCb = cb;
        cb([remoteHost(HOST, remoteState)]);
        return () => undefined;
      },
      forHost: () => remote.api,
      reconnect: async () => undefined,
    },
  });
  const services = { host: local.api, engines: {}, renderer: () => null, scrollback: 100 } as unknown as Store.AppModel["services"];
  const root = new S.AppModel(services);
  await root.start({ gitStatus: false });
  await flush();
  const child = root.hostModel(HOST)!;
  return { root, child, local, remote, notify, click: (n: number) => click!(n), setHosts: (h: RemoteHost[]) => hostsCb!(h) };
}

beforeEach(() => {
  storage.clear();
  sidebar = [];
});

describe("호스트 모델", () => {
  it("같은 세션 번호·워크트리 경로가 겹쳐도 호스트마다 따로 든다", async () => {
    const { root, child, remote } = await setup();
    expect(child).toBeDefined();
    expect(root.get().sessions[1].title).toBe("s1");
    expect(child.get().sessions[1].title).toBe("원격 셸");
    expect(child.get().worktrees).toHaveLength(2);
    expect(root.get().worktrees).toHaveLength(1);

    // 원격 이벤트는 원격 모델만 바꾼다
    remote.emit({ type: "session_updated", session: session(1, { title: "바뀐 원격" }) });
    expect(child.get().sessions[1].title).toBe("바뀐 원격");
    expect(root.get().sessions[1].title).toBe("s1");
  });

  it("고르기: 호스트와 그 모델의 active 가 함께 바뀌고, 읽은 때·최근 목록 키가 갈린다", async () => {
    const { root, child } = await setup();
    expect(root.get().activeHost).toBe("");
    child.select("/Users/me/other");
    expect(root.get().activeHost).toBe(HOST);
    expect(child.get().active).toBe("/Users/me/other");
    // 로컬은 고른 곳을 그대로 둔다
    expect(root.get().active).toBe(WT);
    expect(root.get().recent[0]).toBe(`${HOST}|/Users/me/other`);
    expect(Object.keys(root.get().seen)).toContain(`${HOST}|/Users/me/other`);
    // 같은 경로라도 원격 WT 는 고른 것이 아니다
    expect(root.activeModel()).toBe(child);
    expect(root.currentPlace()).toBe(`${HOST}|/Users/me/other`);
  });

  it("창 전체 상태는 root 가 들고 자식이 비춘다", async () => {
    const { root, child } = await setup();
    child.setDialog({ kind: "jump" });
    expect(root.get().dialog).toEqual({ kind: "jump" });
    expect(root.get().dialogHost).toBe(HOST);
    root.setPanel("files");
    expect(child.get().panel).toBe("files");
    expect(child.get().remoteHosts[0].id).toBe(HOST);
  });

  it("안 읽음: 같은 경로라도 호스트마다 따로 친다", async () => {
    const { root, child, remote } = await setup();
    // 로컬 WT 를 보고 있다. 원격 WT 에서 에이전트가 턴을 끝냈다
    const agent = { kind: "claude", session_id: null, transcript: null, state: "idle" as const, updated_at: Date.now() + 10, prompt: null, last_assistant_message: "끝", tool_name: null, model: null, turn_ended_at: Date.now() + 10 };
    remote.emit({ type: "session_updated", session: session(1, { agent }) });
    expect(child.unread(WT)).toBe(true);
    expect(root.unread(WT)).toBe(false);
  });

  it("⌘ 번호: 사이드바 차례로 원격 워크트리도 고른다", async () => {
    const { root, child } = await setup();
    sidebar = [
      { host: "", ws: WT },
      { host: HOST, ws: WT },
      { host: HOST, ws: "/Users/me/other" },
    ];
    root.selectWorktreeIndex(1);
    expect(root.get().activeHost).toBe(HOST);
    expect(child.get().active).toBe(WT);
    root.selectNearWorktree(1);
    expect(child.get().active).toBe("/Users/me/other");
    root.selectWorktreeIndex(0);
    expect(root.get().activeHost).toBe("");
  });

  it("방문 기록: 호스트를 넘어 뒤로·앞으로 간다", async () => {
    const { root, child } = await setup();
    child.select("/Users/me/other");
    root.select(WT);
    expect(root.get().activeHost).toBe("");
    root.goHistory(-1);
    expect(root.get().activeHost).toBe(HOST);
    expect(child.get().active).toBe("/Users/me/other");
    root.goHistory(1);
    expect(root.get().activeHost).toBe("");
  });

  it("알림: 원격 세션은 따로 번호를 실어 띄우고, 누르면 그 호스트 세션으로 간다", async () => {
    const { root, remote, notify, click, child } = await setup();
    const agent = { kind: "claude", session_id: null, transcript: null, state: "idle" as const, updated_at: 5, prompt: "해 줘", last_assistant_message: "다 했다", tool_name: null, model: null, turn_ended_at: 5 };
    remote.emit({ type: "session_updated", session: session(1, { agent }) });
    expect(notify).toHaveBeenCalledTimes(1);
    const n = (notify.mock.calls[0] as unknown as [{ session: number; title: string }])[0];
    expect(n.session).not.toBe(1);
    expect(n.title).toContain("집 맥");
    click(n.session);
    expect(root.get().activeHost).toBe(HOST);
    expect(child.get().active).toBe(WT);
    // 로컬 세션 번호는 그대로 로컬로 간다
    child.select("/Users/me/other");
    click(1);
    expect(root.get().activeHost).toBe("");
  });

  it("아직 붙지 않은 원격은 붙으면 읽고, 지우면 모델을 없앤다", async () => {
    const { root, setHosts } = await setup("connecting");
    const child = root.hostModel(HOST)!;
    expect(child.get().worktrees).toHaveLength(0);
    setHosts([remoteHost(HOST, "connected")]);
    await flush();
    expect(child.get().worktrees).toHaveLength(2);
    child.select(WT);
    setHosts([]);
    expect(root.hostModel(HOST)).toBeUndefined();
    expect(root.get().activeHost).toBe("");
  });

  it("단축키가 다룰 모델: 메인 면 호스트, 플로팅에 키보드가 있으면 로컬", async () => {
    const { root, child } = await setup();
    child.select(WT);
    expect(root.focusedModel()).toBe(child);
    await root.toggleFloating();
    expect(root.focusedModel()).toBe(root);
    expect(child.currentWorkspace()).toBe(WT);
  });
});

describe("placeKey", () => {
  it("로컬은 그대로, 원격은 호스트를 붙이고 되돌린다", () => {
    expect(S.placeKey("", "/a/b")).toBe("/a/b");
    expect(S.parsePlace("/a/b")).toEqual({ host: "", ws: "/a/b" });
    expect(S.parsePlace(S.placeKey(HOST, "/a|b"))).toEqual({ host: HOST, ws: "/a|b" });
    expect(S.parsePlace("floating")).toEqual({ host: "", ws: "floating" });
  });
});
