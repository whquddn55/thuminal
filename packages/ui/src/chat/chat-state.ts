// 대화 보기 상태: 에이전트 칸을 대화로 볼지 원본(터미널)으로 볼지, 그리고 세션마다 읽어 둔 대화 조각.
//
// - 보기 방식은 설정의 기본값(처음엔 대화)을 따르고, 칸에서 바꾸면 그 세션만 따로 기억한다 (창을 닫으면 잊는다).
// - 대화 조각은 데몬이 대화 기록을 정규화해 준 것이다 (`agent_chat`). 데몬이 기록이 자랐다고 알리면(`agent_chat_changed`)
//   지난 자리 뒤만 이어 읽는다. 보고 있는 화면이 없으면 읽지 않고, 다시 보일 때 한 번에 따라잡는다.
// - 옛 데몬(프로토콜 부 버전이 낮아 `agent_chat` 을 모른다)이면 그 호스트는 원본으로만 본다.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { AGENT_CHAT_PROTOCOL_MINOR, type AgentSession, type ChatItem, type ChatStatus, type ClaudeModel, type HostApi, type SessionId, type SessionInfo } from "@thuminal/term-core";

export type AgentView = "chat" | "terminal";

const VIEW_KEY = "thuminal.agentView";
/** 처음 읽을 때 받는 조각 수. [이전 대화 보기] 를 누르면 모두 받는다 */
const TAIL = 400;

interface ViewState {
  /** 에이전트 칸의 기본 보기 (설정 창) */
  base: AgentView;
  /** 칸에서 바꾼 세션 (`chatKey`) */
  overrides: Record<string, AgentView>;
  /** 호스트의 데몬이 `agent_chat` 을 아는지 (아직 묻지 않았으면 없다) */
  supported: Record<string, boolean>;
}

export const chatViewStore = createStore<ViewState>(() => ({
  base: localStorage.getItem(VIEW_KEY) === "terminal" ? "terminal" : "chat",
  overrides: {},
  supported: {},
}));

/** 세션 번호는 호스트마다 따로라 `<호스트>|<세션>` 으로 가른다 */
export const chatKey = (host: string, session: SessionId) => `${host}|${session}`;

export function setDefaultAgentView(v: AgentView) {
  localStorage.setItem(VIEW_KEY, v);
  // 기본값을 바꾸면 칸에서 따로 바꿔 둔 것도 버리고 모두 새 기본값을 따른다
  chatViewStore.setState({ base: v, overrides: {} });
}

export function setAgentView(host: string, session: SessionId, v: AgentView) {
  chatViewStore.setState((s) => ({ overrides: { ...s.overrides, [chatKey(host, session)]: v } }));
}

/** 대화로 그릴 수 있는 세션인지: claude 가 떠 있고, 에이전트 팀원이 아니다 (팀원은 리더 칸 팝업의 터미널로 본다) */
export function chatCapable(s: SessionInfo | undefined): boolean {
  return !!s?.agent && s.agent.kind === "claude" && s.state.state === "running";
}

const probing = new Set<string>();

/** 호스트의 데몬이 대화 기록을 읽어 주는지 한 번 묻는다 */
function probe(host: HostApi, hostKey: string) {
  if (probing.has(hostKey)) return;
  probing.add(hostKey);
  host
    .daemon()
    .then(
      (d) => (d.protocol?.[1] ?? 0) >= AGENT_CHAT_PROTOCOL_MINOR,
      () => null,
    )
    .then((ok) => {
      probing.delete(hostKey);
      if (ok !== null) chatViewStore.setState((s) => ({ supported: { ...s.supported, [hostKey]: ok } }));
    });
}

/** 이 세션을 지금 어떻게 볼지. 대화로 그릴 수 없으면(에이전트가 없다, 옛 데몬) null 이고 보기 단추도 숨긴다 */
export function useAgentView(host: HostApi, hostKey: string, s: SessionInfo | undefined): AgentView | null {
  const capable = chatCapable(s);
  const view = useStore(chatViewStore, (v) => (v.supported[hostKey] ? (v.overrides[chatKey(hostKey, s?.id ?? -1)] ?? v.base) : null));
  const asked = useStore(chatViewStore, (v) => hostKey in v.supported);
  useEffect(() => {
    if (capable && !asked) probe(host, hostKey);
  }, [host, hostKey, capable, asked]);
  return capable ? view : null;
}

export function useDefaultAgentView(): AgentView {
  return useStore(chatViewStore, (v) => v.base);
}

/**
 * 이어 갈 수 있는 지난 대화 (`/resume` 목록). `tick` 이 바뀔 때마다 다시 읽고, 0 이면 읽지 않는다 (입력창에 `/` 를 칠 때 읽는다).
 * 옛 데몬이면 빈 목록이다
 */
export function useAgentSessions(host: HostApi, session: SessionId, tick: number): AgentSession[] {
  const [list, setList] = useState<AgentSession[]>([]);
  useEffect(() => {
    if (!tick) return;
    let alive = true;
    host.agentSessions(session).then(
      (l) => alive && setList(l),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [host, session, tick]);
  return list;
}

/** 보낸 뒤 아직 기록에 나타나지 않은 글 (claude 가 일하는 중이면 줄 서 있다) */
export interface PendingSend {
  id: number;
  text: string;
  at: number;
}

export interface ChatSnapshot {
  items: ChatItem[];
  /** 앞쪽 대화를 빼고 받았다 */
  more: boolean;
  /** 처음 읽기가 끝났다 */
  loaded: boolean;
  pending: PendingSend[];
  error: string | null;
  /** 기록에서 읽은 모델 · 생각 강도 · 컨텍스트 (아는 것만) */
  status: ChatStatus;
}

const EMPTY: ChatSnapshot = { items: [], more: false, loaded: false, pending: [], error: null, status: {} };

/** 새로 읽은 상태를 얹는다. 이번에 없던 값(null)은 앞서 받은 값을 둔다 */
function mergeStatus(prev: ChatStatus, next: ChatStatus | undefined): ChatStatus {
  if (!next) return prev;
  const out = { ...prev };
  for (const k of ["model", "effort", "context_tokens", "context_window"] as const) {
    if (next[k] != null) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

/** 사용자 글을 견줄 때: 앞뒤 공백과 줄 끝 공백 차이는 같은 글로 본다 */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 세션 하나의 대화 조각을 들고 이어 읽는다 */
export class ChatFeed {
  private snap: ChatSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private known: { transcript: string; offset: number } | null = null;
  private tail = TAIL;
  private busy = false;
  private dirty = false;
  private stale = true;
  private nextPending = 1;

  constructor(
    private readonly host: HostApi,
    readonly session: SessionId,
    /** 서브에이전트를 부른 도구 호출 id (그 서브에이전트의 대화를 읽는다) */
    private readonly subagent?: string,
  ) {}

  get = () => this.snap;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    if (this.stale) void this.pull();
    return () => this.listeners.delete(cb);
  };

  private emit(patch: Partial<ChatSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  /** 데몬이 기록이 자랐다고 알렸다. 보는 화면이 없으면 표시만 해 둔다 */
  changed() {
    if (this.listeners.size) void this.pull();
    else this.stale = true;
  }

  /** 데몬에 다시 붙었다: 처음부터 다시 읽는다 */
  reset() {
    this.known = null;
    this.changed();
  }

  /** 앞쪽 대화까지 모두 읽는다 */
  loadAll() {
    this.tail = 0;
    this.known = null;
    void this.pull();
  }

  async pull(): Promise<void> {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    this.stale = false;
    try {
      do {
        this.dirty = false;
        const chat = await this.host.agentChat(this.session, this.known, this.tail, this.subagent);
        this.known = chat.transcript ? { transcript: chat.transcript, offset: chat.offset } : null;
        const items = chat.reset ? chat.items : chat.items.length ? [...this.snap.items, ...chat.items] : this.snap.items;
        // 보낸 글이 기록에 나타났으면 대기 목록에서 뺀다
        const arrived = chat.items.flatMap((i) => (i.type === "user" ? [norm(i.text)] : []));
        // claude 가 글을 감싸거나(붙여 넣은 글 꼬리표) 그림 표시를 붙이기도 해서 앞머리가 들어 있으면 같은 글로 본다
        const pending = arrived.length ? this.snap.pending.filter((p) => !arrived.some((t) => t.includes(norm(p.text).slice(0, 80)))) : this.snap.pending;
        this.emit({ items, more: chat.reset ? chat.more : this.snap.more, loaded: true, pending, error: null, status: mergeStatus(chat.reset ? {} : this.snap.status, chat.status) });
      } while (this.dirty);
    } catch (e) {
      this.emit({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  addPending(text: string): number {
    const id = this.nextPending++;
    this.emit({ pending: [...this.snap.pending, { id, text, at: Date.now() }] });
    return id;
  }

  dropPending(id: number) {
    this.emit({ pending: this.snap.pending.filter((p) => p.id !== id) });
  }
}

const feeds = new Map<string, ChatFeed>();

export function chatFeed(host: HostApi, hostKey: string, session: SessionId, subagent?: string): ChatFeed {
  const key = subagent ? `${chatKey(hostKey, session)}|${subagent}` : chatKey(hostKey, session);
  let f = feeds.get(key);
  if (!f) feeds.set(key, (f = new ChatFeed(host, session, subagent)));
  return f;
}

/** 데몬 이벤트 `agent_chat_changed` (화면 모델이 부른다) */
export function chatChanged(hostKey: string, session: SessionId) {
  feeds.get(chatKey(hostKey, session))?.changed();
}

/** 세션이 없어졌다 */
export function chatRemoved(hostKey: string, session: SessionId) {
  const key = chatKey(hostKey, session);
  for (const k of [...feeds.keys()]) if (k === key || k.startsWith(`${key}|`)) feeds.delete(k);
  if (key in chatViewStore.getState().overrides) {
    chatViewStore.setState((s) => {
      const overrides = { ...s.overrides };
      delete overrides[key];
      return { overrides };
    });
  }
}

/** 데몬에 다시 붙었다: 그 호스트의 대화를 모두 다시 읽는다 (데몬이 새 버전이 됐을 수도 있다) */
export function chatReconnected(hostKey: string) {
  if (hostKey in chatViewStore.getState().supported) {
    chatViewStore.setState((s) => {
      const supported = { ...s.supported };
      delete supported[hostKey];
      return { supported };
    });
  }
  for (const [key, f] of feeds) if (key.startsWith(`${hostKey}|`)) f.reset();
}

export function useChat(feed: ChatFeed, pollMs = 5000): ChatSnapshot {
  const snap = useSyncExternalStore(feed.subscribe, feed.get);
  // 이벤트를 놓쳤을 때를 대비해 보는 동안 가끔 따라잡는다 (원격 연결이 잠깐 끊겼다 붙은 경우 등).
  // 서브에이전트 기록은 자랐다는 알림이 없어 펴 둔 동안 이것으로 따라간다
  useEffect(() => {
    const t = window.setInterval(() => void feed.pull(), pollMs);
    return () => window.clearInterval(t);
  }, [feed, pollMs]);
  return snap;
}

const modelLists = new Map<string, Promise<ClaudeModel[]>>();

/**
 * claude 가 고를 수 있는 모델 목록 (호스트마다 한 번 묻고, 못 얻었으면 다음에 다시 묻는다).
 * 데몬이 claude 를 한 번 실행해 받아 오므로 처음에는 몇 초 걸린다. 그동안과 옛 데몬에서는 빈 목록이다
 */
export function useClaudeModels(host: HostApi, hostKey: string): ClaudeModel[] {
  const [models, setModels] = useState<ClaudeModel[]>([]);
  useEffect(() => {
    let alive = true;
    let p = modelLists.get(hostKey);
    if (!p) {
      p = host.claudeModels().catch(() => []);
      modelLists.set(hostKey, p);
      void p.then((list) => !list.length && modelLists.delete(hostKey));
    }
    void p.then((list) => alive && setModels(list));
    return () => {
      alive = false;
    };
  }, [host, hostKey]);
  return models;
}
