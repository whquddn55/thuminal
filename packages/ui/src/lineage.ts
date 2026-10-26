// 하위 워크트리 계층: 워크트리는 부모 워크트리를 기억하고(`WorktreeInfo.parent`), 화면은 부모 밑에 자식을 들여 그린다.
// 데스크톱 사이드바와 폰 화면이 같은 계산을 쓴다.

import type { WorktreeInfo } from "@thuminal/term-core";

import type { Status } from "./Sidebar";

export interface WorktreeForest {
  /** 맨 위 워크트리 (목록 차례) */
  roots: WorktreeInfo[];
  /** 부모 경로 → 바로 밑 자식들 (목록 차례) */
  kids: Map<string, WorktreeInfo[]>;
}

/** 워크트리를 부모 → 자식으로 묶는다. 부모가 목록에 없으면(지웠거나 고정했으면) 맨 위로 올린다 */
export function worktreeForest(list: WorktreeInfo[]): WorktreeForest {
  const paths = new Set(list.map((w) => w.path));
  const kids = new Map<string, WorktreeInfo[]>();
  const roots: WorktreeInfo[] = [];
  for (const w of list) {
    if (w.parent && w.parent !== w.path && paths.has(w.parent)) kids.set(w.parent, [...(kids.get(w.parent) ?? []), w]);
    else roots.push(w);
  }
  // 부모가 돌고 도는 고리(데몬이 막지만 혹시)는 빠지지 않게 맨 위로 올린다
  const seen = new Set<string>();
  const walk = (w: WorktreeInfo) => {
    if (seen.has(w.path)) return;
    seen.add(w.path);
    for (const k of kids.get(w.path) ?? []) walk(k);
  };
  roots.forEach(walk);
  for (const w of list) {
    if (seen.has(w.path)) continue;
    roots.push(w);
    walk(w);
  }
  return { roots, kids };
}

/** 워크트리 밑의 모든 하위 워크트리 (자식, 손자 … 그린 차례) */
export function descendantsOf(path: string, kids: Map<string, WorktreeInfo[]>, seen = new Set<string>([path])): WorktreeInfo[] {
  return (kids.get(path) ?? []).flatMap((k) => (seen.has(k.path) ? [] : (seen.add(k.path), [k, ...descendantsOf(k.path, kids, seen)])));
}

/** 접은 하위 워크트리를 적는 키 (사이드바의 접은 묶음과 같은 모음에 든다) */
export function lineageKey(path: string): string {
  return `lineage:${path}`;
}

/** 접힌 "N개 하위" 단추에 보일 상태 */
const LINEAGE_SHOWN: Status[] = ["attention", "error", "working", "done"];

/** 하위 워크트리 상태들을 단추에 보일 상태별 개수로 센다 (없는 상태는 뺀다) */
export function lineageCounts(statuses: Status[]): [Status, number][] {
  return LINEAGE_SHOWN.map((st) => [st, statuses.filter((x) => x === st).length] as [Status, number]).filter(([, n]) => n > 0);
}

/** 접은 묶음(저장소, 고정, 기타)과 접은 하위 워크트리를 남기는 곳. 다시 켜도 남는다 */
const COLLAPSED_KEY = "thuminal.sidebarCollapsed";

export function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** 키 하나를 접거나 펴고 남긴다. 새 모음을 돌려준다 */
export function toggleCollapsed(collapsed: Set<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  return next;
}
