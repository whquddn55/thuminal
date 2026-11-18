// 워크트리 그룹: 한 프로젝트 안에서 고른 워크트리끼리 이름 · 색을 붙여 묶는다 (크롬 탭 그룹처럼).
// 그룹 목록은 데몬이 프로젝트마다 들고(`RepoInfo.groups`, 차례 = 사이드바 차례), 워크트리는 든 그룹 id 를 든다(`WorktreeInfo.group`).
// 하위 워크트리는 자기 그룹 대신 맨 위 부모의 그룹을 따른다. 메인 워크트리는 그룹에 넣지 않고 늘 맨 위다.
// 데스크톱 사이드바와 폰 화면이 같은 계산을 쓴다.

import type { RepoInfo, WorktreeGroup, WorktreeInfo } from "@thuminal/term-core";

/** 그룹 색 (크롬 탭 그룹과 같은 아홉 개). 실제 색은 styles.css 의 `--wtg-<색>` 이 테마(라이트 · 다크)마다 정한다 */
export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const GROUP_COLOR_LABEL: Record<GroupColor, string> = {
  grey: "회색",
  blue: "파랑",
  red: "빨강",
  yellow: "노랑",
  green: "초록",
  pink: "분홍",
  purple: "보라",
  cyan: "청록",
  orange: "주황",
};

/** 그룹 색의 CSS 값. 모르는 이름(다른 버전 앱이 쓴 색)은 회색으로 본다 */
export function groupColorVar(color: string): string {
  return `var(--wtg-${(GROUP_COLORS as readonly string[]).includes(color) ? color : "grey"})`;
}

/** 새 그룹에 미리 골라 둘 색: 이 프로젝트에서 아직 쓰지 않은 첫 색. 다 썼으면 그룹 수대로 돌린다 (회색은 맨 뒤) */
export function nextGroupColor(groups: WorktreeGroup[]): GroupColor {
  const order: GroupColor[] = [...GROUP_COLORS.slice(1), "grey"];
  return order.find((c) => !groups.some((g) => g.color === c)) ?? order[groups.length % order.length];
}

/** 그룹을 접었는지 적는 키 (사이드바의 접은 묶음과 같은 모음에 든다. 그룹 id 는 프로젝트끼리도 겹치지 않는다) */
export function groupFoldKey(id: string): string {
  return `wtgroup:${id}`;
}

/**
 * 워크트리마다 실제로 든 그룹 id. 하위 워크트리는 맨 위 부모(목록 `all` 안에서 부모를 따라 올라간 끝)의 그룹을 따르고,
 * 메인 워크트리와 지운 그룹은 그룹 밖(없음)이다
 */
export function effectiveGroup(w: WorktreeInfo, all: WorktreeInfo[], groups: WorktreeGroup[]): string | null {
  const top = topOf(w, new Map(all.map((x) => [x.path, x])));
  if (top.is_main || !top.group || !groups.some((g) => g.id === top.group)) return null;
  return top.group;
}

/** 부모를 따라 올라간 맨 위 워크트리 (부모가 목록에 없으면 거기서 멈춘다. 고리는 데몬이 막지만 혹시 돌면 멈춘다) */
function topOf(w: WorktreeInfo, byPath: Map<string, WorktreeInfo>): WorktreeInfo {
  let top = w;
  const seen = new Set<string>([w.path]);
  while (top.parent && byPath.has(top.parent) && !seen.has(top.parent)) {
    seen.add(top.parent);
    top = byPath.get(top.parent)!;
  }
  return top;
}

/** 그룹에 넣고 뺄 수 있는 워크트리: 메인이 아니고 부모가 없는(맨 위) 워크트리. 하위 워크트리는 부모를 따라간다 */
export function canGroup(w: WorktreeInfo, all: WorktreeInfo[]): boolean {
  return !w.is_main && !(w.parent && all.some((x) => x.path === w.parent));
}

export interface ArrangedWorktrees {
  /** 메인 워크트리와 그 밑의 하위 워크트리 (맨 위) */
  main: WorktreeInfo[];
  /** 그룹 차례대로, 든 워크트리가 있는 그룹만 (고정해 고정 칸으로 간 것은 빠진다) */
  groups: { group: WorktreeGroup; members: WorktreeInfo[] }[];
  /** 그룹 밖 워크트리 */
  loose: WorktreeInfo[];
}

/**
 * 프로젝트 칸에 늘어놓을 차례: main → 그룹들 → 그룹 밖 워크트리. `list` 는 그릴 워크트리(고정한 것을 뺀 것),
 * `all` 은 그 프로젝트의 모든 워크트리(하위 워크트리의 맨 위 부모를 찾는 데 쓴다)다. 안의 차례는 `list` 차례를 따른다
 */
export function arrangeWorktrees(list: WorktreeInfo[], all: WorktreeInfo[], groups: WorktreeGroup[]): ArrangedWorktrees {
  const byPath = new Map(all.map((x) => [x.path, x]));
  const underMain = (w: WorktreeInfo) => topOf(w, byPath).is_main;
  const of = new Map(list.map((w) => [w.path, effectiveGroup(w, all, groups)]));
  return {
    main: list.filter(underMain),
    groups: groups.map((group) => ({ group, members: list.filter((w) => of.get(w.path) === group.id) })).filter((g) => g.members.length > 0),
    loose: list.filter((w) => !underMain(w) && !of.get(w.path)),
  };
}

/** 프로젝트의 그룹 목록 (옛 데몬은 주지 않는다) */
export function repoGroups(repos: RepoInfo[], repo: string): WorktreeGroup[] {
  return repos.find((r) => r.id === repo)?.groups ?? [];
}

/** 그룹 차례를 `delta` 칸 옮긴다 */
export function shiftWorktreeGroup(groups: WorktreeGroup[], id: string, delta: number): WorktreeGroup[] {
  const i = groups.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= groups.length) return groups;
  const out = [...groups];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
