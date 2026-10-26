// 사이드바 워크스페이스(프로젝트 묶음) 계산. 목록의 주인은 데몬이고(`list_groups`, `set_groups`), 화면은 통째로 고쳐 보낸다.
// 코드의 `workspace`(WorkspaceId)는 워크트리 경로·floating·other 를 뜻하므로 묶음은 `group` 이라 부른다.
// 데스크톱 사이드바와 폰 화면이 같은 계산을 쓴다.

import { DEFAULT_GROUP, type RepoGroup, type RepoInfo } from "@thuminal/term-core";

/** 기본 워크스페이스 이름 (데몬과 같다) */
export const DEFAULT_GROUP_NAME = "기본";

/** 새로 만든 워크스페이스 이름 */
export const NEW_GROUP_NAME = "새 워크스페이스";

/**
 * 워크스페이스 목록을 저장소 목록에 맞춘다 (데몬의 정리와 같다). 저장소를 막 등록해 목록이 아직 오지 않았거나
 * 옛 데몬이라 목록이 없어도 화면이 프로젝트를 빠뜨리지 않게 한다: 같은 id 는 앞 것만, 없는 저장소와 두 번째로 나온 저장소는 빼고,
 * 기본이 없으면 맨 앞에 넣고, 어디에도 없는 저장소는 등록 차례대로 기본 끝에 붙인다
 */
export function normalizeGroups(groups: RepoGroup[], repos: RepoInfo[]): RepoGroup[] {
  const known = new Set(repos.map((r) => r.id));
  const ids = new Set<string>();
  const placed = new Set<string>();
  const out = groups
    .filter((g) => !ids.has(g.id) && (ids.add(g.id), true))
    .map((g) => ({ ...g, repos: g.repos.filter((r) => known.has(r) && !placed.has(r) && (placed.add(r), true)) }));
  if (!out.some((g) => g.id === DEFAULT_GROUP)) out.unshift({ id: DEFAULT_GROUP, name: DEFAULT_GROUP_NAME, repos: [] });
  const def = out.find((g) => g.id === DEFAULT_GROUP)!;
  def.repos = [...def.repos, ...repos.map((r) => r.id).filter((id) => !placed.has(id))];
  return out;
}

/** 프로젝트가 든 워크스페이스 id */
export function groupOf(groups: RepoGroup[], repo: string): string {
  return groups.find((g) => g.repos.includes(repo))?.id ?? DEFAULT_GROUP;
}

/**
 * 프로젝트를 워크스페이스 `to` 의 `index` 자리로 옮긴다 (`index` 는 옮기기 전 목록 기준, 없으면 끝).
 * 같은 워크스페이스 안에서 뒤로 옮기면 자기 자리가 빠지므로 하나 당긴다. 바뀐 것이 없으면 null
 */
export function moveRepo(groups: RepoGroup[], repo: string, to: string, index?: number): RepoGroup[] | null {
  const target = groups.find((g) => g.id === to);
  if (!target) return null;
  const from = groups.find((g) => g.repos.includes(repo));
  let at = index ?? target.repos.length;
  if (from === target) {
    const i = target.repos.indexOf(repo);
    if (i < at) at -= 1;
    if (i === at) return null;
  }
  return groups.map((g) => {
    const rest = g.repos.filter((r) => r !== repo);
    if (g.id !== to) return rest.length === g.repos.length ? g : { ...g, repos: rest };
    return { ...g, repos: [...rest.slice(0, at), repo, ...rest.slice(at)] };
  });
}

/** 워크스페이스를 `delta` 칸 옮긴다 (-1 위로, 1 아래로). 끝이라 못 옮기면 null */
export function shiftGroup(groups: RepoGroup[], id: string, delta: number): RepoGroup[] | null {
  const i = groups.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= groups.length) return null;
  const next = [...groups];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** 워크스페이스를 지운다. 든 프로젝트는 기본 끝으로 간다 (데몬도 그렇게 맞추지만 화면에 바로 보이게 여기서도 옮긴다). 기본은 지우지 않는다 */
export function removeGroup(groups: RepoGroup[], id: string): RepoGroup[] | null {
  const gone = groups.find((g) => g.id === id);
  if (!gone || id === DEFAULT_GROUP) return null;
  return groups.filter((g) => g !== gone).map((g) => (g.id === DEFAULT_GROUP ? { ...g, repos: [...g.repos, ...gone.repos] } : g));
}

/** 접은 워크스페이스를 적는 키 (사이드바의 접은 묶음과 같은 모음에 든다) */
export function groupKey(id: string): string {
  return `group:${id}`;
}
