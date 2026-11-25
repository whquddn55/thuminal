// 보낸 알림 기록. 사이드바 머리의 알림 단추가 목록으로 보인다.
//
// 앱이 실제로 띄운 알림(과 시험 알림)만 남긴다. 최근 MAX 개를 localStorage 에 두어 앱을 다시 켜도 남는다.
// 알림마다 읽었는지(`read`)를 두고, 읽지 않은 알림 수를 단추에 적는다 (시험 알림은 세지 않는다).
// 알림이 온 칸을 보면 읽은 것이 된다 (store.ts `syncNoticesRead`).

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { Notice } from "./notifications";

export interface NoticeEntry {
  /** 보낸 때 (ms) */
  at: number;
  /** 세션이 든 호스트 ("" 는 로컬) */
  host: string;
  session: number;
  kind: Notice["kind"] | "test";
  /** 알림 제목 (워크스페이스 이름) */
  title: string;
  subtitle: string;
  body: string;
  /** 읽었다: 그 칸을 봤거나, 목록에서 눌렀거나, [모두 읽음] */
  read?: boolean;
}

interface NoticeLogState {
  entries: NoticeEntry[];
}

const KEY = "thuminal.noticeLog";
const SEEN_KEY = "thuminal.noticeSeen";
const MAX = 200;

function load(): NoticeEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    // `read` 가 없던 때 남긴 기록은 목록을 마지막으로 연 때로 가른다
    const seen = Number(localStorage.getItem(SEEN_KEY)) || 0;
    return (v as NoticeEntry[]).slice(0, MAX).map((e) => (e.read === undefined ? { ...e, read: e.at <= seen } : e));
  } catch {
    return [];
  }
}

const store = createStore<NoticeLogState>(() => ({ entries: typeof localStorage === "undefined" ? [] : load() }));

/** 보낸 알림을 맨 앞에 남긴다 */
export function logNotice(e: NoticeEntry) {
  const entries = [e, ...store.getState().entries].slice(0, MAX);
  store.setState({ entries });
  localStorage.setItem(KEY, JSON.stringify(entries));
}

/** 읽지 않은 알림 가운데 hit 가 고른 것을 읽은 것으로 한다 (hit 가 없으면 모두) */
export function markNoticesRead(hit?: (e: NoticeEntry) => boolean) {
  const cur = store.getState().entries;
  if (cur.every((e) => e.read)) return;
  let changed = false;
  const entries = cur.map((e) => (!e.read && (!hit || hit(e)) ? ((changed = true), { ...e, read: true }) : e));
  if (!changed) return;
  store.setState({ entries });
  localStorage.setItem(KEY, JSON.stringify(entries));
}

/** 읽지 않은 알림 수 (시험 알림은 세지 않는다) */
export const unreadNotices = (s: NoticeLogState): number => s.entries.reduce((n, e) => n + (!e.read && e.kind !== "test" ? 1 : 0), 0);

export function clearNotices() {
  store.setState({ entries: [] });
  localStorage.removeItem(KEY);
}

export function useNoticeLog<T>(sel: (s: NoticeLogState) => T): T {
  return useStore(store, sel);
}
