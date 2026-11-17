// 보낸 알림 기록. 사이드바 머리의 알림 단추가 목록으로 보인다.
//
// 앱이 실제로 띄운 알림(과 시험 알림)만 남긴다. 최근 MAX 개를 localStorage 에 두어 앱을 다시 켜도 남는다.
// 목록을 마지막으로 연 때(`seen`) 뒤에 온 알림이 있으면 단추에 점을 찍는다 (시험 알림은 세지 않는다).

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
}

interface NoticeLogState {
  entries: NoticeEntry[];
  /** 목록을 마지막으로 연 때 (ms) */
  seen: number;
}

const KEY = "thuminal.noticeLog";
const SEEN_KEY = "thuminal.noticeSeen";
const MAX = 200;

function load(): NoticeEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as NoticeEntry[]).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

const store = createStore<NoticeLogState>(() =>
  typeof localStorage === "undefined" ? { entries: [], seen: 0 } : { entries: load(), seen: Number(localStorage.getItem(SEEN_KEY)) || 0 },
);

/** 보낸 알림을 맨 앞에 남긴다 */
export function logNotice(e: NoticeEntry) {
  const entries = [e, ...store.getState().entries].slice(0, MAX);
  store.setState({ entries });
  localStorage.setItem(KEY, JSON.stringify(entries));
}

/** 목록을 열었다: 지금까지 온 알림은 본 것으로 */
export function markNoticesSeen() {
  const seen = Date.now();
  store.setState({ seen });
  localStorage.setItem(SEEN_KEY, String(seen));
}

export function clearNotices() {
  store.setState({ entries: [] });
  localStorage.removeItem(KEY);
}

export function useNoticeLog<T>(sel: (s: NoticeLogState) => T): T {
  return useStore(store, sel);
}
