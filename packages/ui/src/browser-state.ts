// 브라우저 칸마다 지금 페이지 (웹뷰가 알려 준다). 탭 제목과 주소 칸이 읽는다.

import { createStore } from "zustand/vanilla";

/** 칸마다 지금 페이지 (웹뷰가 알려 준다) */
export interface PageState {
  url: string;
  title: string;
  loading: boolean;
}

/** 칸 번호는 호스트마다 따로라 원격 칸은 `<호스트>|<칸>` 으로 가른다 (로컬은 칸 번호 그대로) */
export function pageKey(host: string, pane: number): string {
  return host ? `${host}|${pane}` : String(pane);
}

/** 키는 `pageKey` */
export const pageStore = createStore<Record<string, PageState>>(() => ({}));

export function setPage(key: string, patch: Partial<PageState>) {
  const empty: PageState = { url: "", title: "", loading: false };
  pageStore.setState((s) => ({ [key]: { ...empty, ...s[key], ...patch } }));
}
