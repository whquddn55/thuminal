// 브라우저 칸마다 지금 페이지 (웹뷰가 알려 준다). 탭 제목과 주소 칸이 읽는다.

import { createStore } from "zustand/vanilla";

/** 칸마다 지금 페이지 (웹뷰가 알려 준다) */
export interface PageState {
  url: string;
  title: string;
  loading: boolean;
}

export const pageStore = createStore<Record<number, PageState>>(() => ({}));

export function setPage(id: number, patch: Partial<PageState>) {
  const empty: PageState = { url: "", title: "", loading: false };
  pageStore.setState((s) => ({ [id]: { ...empty, ...s[id], ...patch } }));
}
