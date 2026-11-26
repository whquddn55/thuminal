// 대화 보기 상태: 에이전트 칸을 대화로 볼지 원본(터미널)으로 볼지, 그리고 세션마다 읽어 둔 대화 조각.
//
// - 보기 방식은 설정의 기본값(처음엔 대화)을 따르고, 칸에서 바꾸면 그 세션만 따로 기억한다 (창을 닫으면 잊는다).
// - 대화 조각은 데몬이 대화 기록을 정규화해 준 것이다 (`agent_chat`). 데몬이 기록이 자랐다고 알리면(`agent_chat_changed`)
//   지난 자리 뒤만 이어 읽는다. 보고 있는 화면이 없으면 읽지 않고, 다시 보일 때 한 번에 따라잡는다.
// - 옛 데몬(프로토콜 부 버전이 낮아 `agent_chat` 을 모른다)이면 그 호스트는 원본으로만 본다.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { AGENT_CHAT_PROTOCOL_MINOR, type AgentSession, CHAT_LISTS_PROTOCOL_MINOR, type ChatItem, type ClaudeCommand, type ChatStatus, type ClaudeModel, type HostApi, type SessionId, type SessionInfo } from "@thuminal/term-core";

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
  /** 호스트 데몬의 프로토콜 부 버전 (아직 묻지 않았으면 없다). 새로 생긴 요청을 옛 데몬에 보내지 않으려고 본다 */
  minor: Record<string, number>;
}

export const chatViewStore = createStore<ViewState>(() => ({
  base: localStorage.getItem(VIEW_KEY) === "terminal" ? "terminal" : "chat",
  overrides: {},
  supported: {},
  minor: {},
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
      (d) => d.protocol?.[1] ?? 0,
      () => null,
    )
    .then((minor) => {
      probing.delete(hostKey);
      if (minor !== null)
        chatViewStore.setState((s) => ({ supported: { ...s.supported, [hostKey]: minor >= AGENT_CHAT_PROTOCOL_MINOR }, minor: { ...s.minor, [hostKey]: minor } }));
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
 * claude 가 `/` 목록에 올리는 스킬 · 사용자 명령. 데몬이 claude 를 한 번 실행해 받아 오므로 처음에는 몇 초 걸린다
 * (데몬이 폴더마다 잠깐 기억한다). 그동안과 옛 데몬에서는 빈 목록이다
 */
export function useClaudeCommands(host: HostApi, hostKey: string, session: SessionId): ClaudeCommand[] {
  const [list, setList] = useState<ClaudeCommand[]>([]);
  const known = useStore(chatViewStore, (v) => (v.minor[hostKey] ?? 0) >= CHAT_LISTS_PROTOCOL_MINOR);
  useEffect(() => {
    if (!known) return;
    let alive = true;
    host.claudeCommands(session).then(
      (l) => alive && setList(l),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [host, session, known]);
  return list;
}

/**
 * 이어 갈 수 있는 지난 대화 (`/resume` 목록). `tick` 이 바뀔 때마다 다시 읽고, 0 이면 읽지 않는다 (입력창에 `/` 를 칠 때 읽는다).
 * 옛 데몬이면 빈 목록이다
 */
export function useAgentSessions(host: HostApi, hostKey: string, session: SessionId, tick: number): AgentSession[] {
  const [list, setList] = useState<AgentSession[]>([]);
  const known = useStore(chatViewStore, (v) => (v.minor[hostKey] ?? 0) >= CHAT_LISTS_PROTOCOL_MINOR);
  useEffect(() => {
    if (!tick || !known) return;
    let alive = true;
    host.agentSessions(session).then(
      (l) => alive && setList(l),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [host, session, tick, known]);
  return list;
}

/** 보낸 뒤 아직 기록에 나타나지 않은 글 (claude 가 일하는 중이면 줄 서 있다) */
export interface PendingSend {
  id: number;
  text: string;
  at: number;
  /** 같이 붙여 보낸 그림 (입력창으로 되돌릴 때 쓴다) */
  images: ChatDraft["images"];
}

/** 대기 글이 없어질 때 그림 미리 보기 주소를 놓는다 */
const release = (list: PendingSend[]) => list.forEach((p) => p.images.forEach((i) => URL.revokeObjectURL(i.url)));

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
  /** 감출 조각 id: 멈춰서 입력창으로 되돌린 글 (기록에는 남지만 claude 대화에서는 빠졌다) */
  hidden: ReadonlySet<string>;
}

const EMPTY: ChatSnapshot = { items: [], more: false, loaded: false, pending: [], error: null, status: {}, hidden: new Set() };

/** 되돌린 글이 기록에 늦게 나타나는 것을 기다리는 시간 (ms). 이 뒤에 같은 글을 다시 보내면 그것은 새 글이다 */
const RETRACT_WAIT_MS = 2500;

/** 줄바꿈 자리(터미널이 접은 줄)와 그림 표시를 빼고 견줄 때 쓴다 */
export const flatText = (t: string) => t.replace(/\[Image #\d+\]/g, "").replace(/\s+/g, "");

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
  /** 되돌렸지만 아직 기록에 나타나지 않은 글 (나타나면 감춘다) */
  private retracting: { key: string; until: number }[] = [];

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
        release(this.snap.pending.filter((p) => !pending.includes(p)));
        // 되돌린 글이 이제야 기록에 나타났으면 감춘다
        let hidden = this.snap.hidden;
        this.retracting = this.retracting.filter((r) => r.until > Date.now());
        for (const i of chat.items) {
          const at = i.type === "user" ? this.retracting.findIndex((r) => r.key === flatText(i.text)) : -1;
          if (at < 0) continue;
          this.retracting.splice(at, 1);
          hidden = new Set(hidden).add(i.id);
        }
        this.emit({ items, hidden, more: chat.reset ? chat.more : this.snap.more, loaded: true, pending, error: null, status: mergeStatus(chat.reset ? {} : this.snap.status, chat.status) });
      } while (this.dirty);
    } catch (e) {
      this.emit({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  /**
   * 멈춰서 입력창으로 되돌린 글을 대화에서 감춘다. 이미 기록에 나타난 것은 바로, 아직이면 잠깐 기다렸다 나타날 때 감춘다.
   * 다음 글이 오면 데몬이 알려 준 갈래(`parent`)로 가려지므로 다시 켜도 감춰진다
   */
  retract(texts: string[]) {
    const hidden = new Set(this.snap.hidden);
    const users = this.snap.items.flatMap((i) => (i.type === "user" ? [i] : [])).slice(-8).reverse();
    for (const t of texts) {
      const key = flatText(t);
      const hit = users.find((u) => !hidden.has(u.id) && flatText(u.text) === key);
      if (hit) hidden.add(hit.id);
      else this.retracting.push({ key, until: Date.now() + RETRACT_WAIT_MS });
    }
    this.emit({ hidden });
  }

  /** 이 조각부터 뒤를 모두 감춘다 (되감기로 대화를 되돌렸다. 다음 글이 오면 데몬이 알려 준 갈래로도 가려진다) */
  hideFrom(id: string) {
    const at = this.snap.items.findIndex((i) => i.id === id);
    if (at < 0) return;
    const hidden = new Set(this.snap.hidden);
    for (const i of this.snap.items.slice(at)) hidden.add(i.id);
    this.emit({ hidden });
  }

  addPending(text: string, images: ChatDraft["images"] = []) {
    // 새로 보내는 글은 되돌린 글과 같아도 감추지 않는다
    this.retracting = [];
    this.emit({ pending: [...this.snap.pending, { id: this.nextPending++, text, at: Date.now(), images }] });
  }

  dropPending(id: number) {
    release(this.snap.pending.filter((p) => p.id === id));
    this.emit({ pending: this.snap.pending.filter((p) => p.id !== id) });
  }

  /** 대기 글을 목록에서 빼서 돌려준다 (입력창으로 되돌린다. 그림 주소는 놓지 않는다) */
  takePending(id: number): PendingSend | undefined {
    const hit = this.snap.pending.find((p) => p.id === id);
    if (hit) this.emit({ pending: this.snap.pending.filter((p) => p.id !== id) });
    return hit;
  }
}

const feeds = new Map<string, ChatFeed>();

/** 입력창에 쓰다 만 글과 붙인 그림. 칸이 화면에서 사라졌다 돌아와도(탭 · 워크트리를 오가도) 남는다. 앱을 끄면 잊는다 */
export interface ChatDraft {
  text: string;
  /** 붙인 그림: 데몬 쪽 임시 파일 경로와 미리 보기 주소 */
  images: { path: string; url: string }[];
}

const drafts = new Map<string, ChatDraft>();

/** 쓰다 만 것을 가르는 키. 데몬이 다시 뜨면 세션 번호를 다시 쓰므로 세션을 만든 때까지 넣는다 */
export const draftKey = (host: string, session: SessionId, createdAt: number) => `${chatKey(host, session)}|${createdAt}`;

export function loadDraft(key: string): ChatDraft {
  return drafts.get(key) ?? { text: "", images: [] };
}

/** 비었으면 지운다 */
export function saveDraft(key: string, d: ChatDraft) {
  if (d.text || d.images.length) drafts.set(key, d);
  else drafts.delete(key);
}

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
  for (const [k, d] of [...drafts])
    if (k.startsWith(`${key}|`)) {
      for (const i of d.images) URL.revokeObjectURL(i.url);
      drafts.delete(k);
    }
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
      const minor = { ...s.minor };
      delete supported[hostKey];
      delete minor[hostKey];
      return { supported, minor };
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
