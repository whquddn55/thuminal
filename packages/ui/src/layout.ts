// 데몬이 보내 준 배치(워크스페이스 → 탭 → 칸 트리)를 읽는 도구. 바꾸는 일은 데몬이 한다.

import type { Pane, PaneId, PaneNode, SessionId, Side, Tab, WorkspaceLayout } from "@thuminal/term-core";

/** 칸 트리의 칸을 왼쪽 위부터 차례로 */
export function panesOf(node: PaneNode): Pane[] {
  if (node.type === "pane") return [node.pane];
  return node.children.flatMap(panesOf);
}

export function findPane(layouts: Iterable<WorkspaceLayout>, id: PaneId): { layout: WorkspaceLayout; tab: Tab; pane: Pane } | null {
  for (const layout of layouts)
    for (const tab of layout.tabs)
      for (const pane of panesOf(tab.root)) if (pane.id === id) return { layout, tab, pane };
  return null;
}

/** 세션이 든 칸 */
export function paneOfSession(layouts: Iterable<WorkspaceLayout>, session: SessionId): { layout: WorkspaceLayout; tab: Tab; pane: Pane } | null {
  for (const layout of layouts)
    for (const tab of layout.tabs)
      for (const pane of panesOf(tab.root)) if (pane.type === "terminal" && pane.session === session) return { layout, tab, pane };
  return null;
}

/** 워크스페이스의 모든 터미널 세션 */
export function sessionsOf(layout: WorkspaceLayout | undefined): SessionId[] {
  if (!layout) return [];
  return layout.tabs.flatMap((t) => panesOf(t.root)).flatMap((p) => (p.type === "terminal" ? [p.session] : []));
}

export function activeTab(layout: WorkspaceLayout | undefined): Tab | null {
  if (!layout || layout.tabs.length === 0) return null;
  return layout.tabs.find((t) => t.id === layout.active_tab) ?? layout.tabs[0];
}

export function focusedPane(tab: Tab | null): Pane | null {
  if (!tab) return null;
  const all = panesOf(tab.root);
  return all.find((p) => p.id === tab.focused) ?? all[0] ?? null;
}

/** 놓을 자리: 칸 가운데에서 가장 가까운 변 (대각선으로 나눈 네 구역). 가운데 작은 네모는 맞바꾸기 */
export function dropSide(rect: DOMRect, x: number, y: number): Side | "center" {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (Math.abs(fx - 0.5) < 0.15 && Math.abs(fy - 0.5) < 0.15) return "center";
  const d = { left: fx, right: 1 - fx, up: fy, down: 1 - fy };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

/** 놓을 자리 미리보기: 그 변 쪽 반쪽 (가운데면 칸 전체) */
export function dropRect(side: Side | "center"): React.CSSProperties {
  switch (side) {
    case "left":
      return { left: 0, top: 0, width: "50%", height: "100%" };
    case "right":
      return { left: "50%", top: 0, width: "50%", height: "100%" };
    case "up":
      return { left: 0, top: 0, width: "100%", height: "50%" };
    case "down":
      return { left: 0, top: "50%", width: "100%", height: "50%" };
    default:
      return { left: 0, top: 0, width: "100%", height: "100%" };
  }
}

/** 문서 칸이 같은 문서인지 */
export function sameDoc(a: Record<string, string>, b: Record<string, string>): boolean {
  return a.kind === b.kind && a.file === b.file && (a.staged ?? "") === (b.staged ?? "");
}
