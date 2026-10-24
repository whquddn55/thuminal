// 탭과 칸 끌어 놓기.
//
// - 탭을 칸 가장자리에 놓으면 그 탭이 칸으로 들어간다 (join_tab). 칸을 탭 줄에 놓으면 새 탭으로 떨어진다 (break_pane).
// - 칸을 다른 칸 가장자리에 놓으면 옮기고 (move_pane), 가운데에 놓으면 맞바꾼다 (swap).
// - 탭 줄 안에서는 순서를 바꾸고, 사이드바 워크트리 카드에 놓으면 그 워크트리로 보낸다.
//
// 놓을 곳은 DOM 의 data 속성으로 찾는다: data-drop-pane, data-drop-tabbar (안의 탭은 data-tab-index), data-drop-workspace.
// 터미널 그림판(canvas)은 마우스를 통과시키므로 그 아래 칸 자리가 잡힌다.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { PaneId, Side, TabId, WorkspaceId } from "@thuminal/term-core";

import { dropSide } from "./layout";
import type { AppModel } from "./store";

export type DragSource =
  | { kind: "tab"; tab: TabId; workspace: WorkspaceId; title: string; panes: PaneId[] }
  | { kind: "pane"; pane: PaneId; tab: TabId; workspace: WorkspaceId; title: string };

export type DropTarget =
  | { kind: "pane"; pane: PaneId; side: Side | "center" }
  | { kind: "tabbar"; workspace: WorkspaceId; index: number }
  | { kind: "workspace"; workspace: WorkspaceId };

interface DragState {
  source: DragSource | null;
  x: number;
  y: number;
  target: DropTarget | null;
}

export const dragStore = createStore<DragState>(() => ({ source: null, x: 0, y: 0, target: null }));

export function useDrag<T>(selector: (s: DragState) => T): T {
  return useStore(dragStore, selector);
}

/** 이만큼 움직여야 끌기로 본다 (누르기와 구분) */
const THRESHOLD = 5;

function hitTest(source: DragSource, x: number, y: number): DropTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement)) continue;
    const bar = el.closest<HTMLElement>("[data-drop-tabbar]");
    if (bar) {
      const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab-index]")];
      let index = tabs.length;
      for (const t of tabs) {
        const r = t.getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          index = Number(t.dataset.tabIndex);
          break;
        }
      }
      return { kind: "tabbar", workspace: bar.dataset.dropTabbar!, index };
    }
    const pane = el.closest<HTMLElement>("[data-drop-pane]");
    if (pane) {
      const id = Number(pane.dataset.dropPane);
      const side = dropSide(pane.getBoundingClientRect(), x, y);
      if (source.kind === "tab") {
        // 탭을 자기 칸 위에 놓거나 가운데에 놓는 것은 뜻이 없다
        if (source.panes.includes(id) || side === "center") return null;
      } else if (source.pane === id) return null;
      return { kind: "pane", pane: id, side };
    }
    const ws = el.closest<HTMLElement>("[data-drop-workspace]");
    if (ws) {
      const workspace = ws.dataset.dropWorkspace!;
      return workspace === source.workspace ? null : { kind: "workspace", workspace };
    }
  }
  return null;
}

/** 놓은 자리에 맞는 배치 요청을 보낸다 */
function commit(model: AppModel, source: DragSource, target: DropTarget) {
  const id = (value: number) => ({ by: "id" as const, value });
  if (source.kind === "tab") {
    const tab = id(source.tab);
    if (target.kind === "pane") return model.op({ op: "join_tab", tab, to: id(target.pane), side: target.side as Side });
    if (target.kind === "tabbar") {
      // 같은 탭 줄에서 오른쪽으로 옮기면 자기 자리가 빠지므로 하나 당긴다
      const from = model.get().layouts[source.workspace]?.tabs.findIndex((t) => t.id === source.tab) ?? -1;
      const same = target.workspace === source.workspace;
      const index = same && from >= 0 && from < target.index ? target.index - 1 : target.index;
      if (same && index === from) return;
      return model.op({ op: "move_tab", tab, workspace: target.workspace, index });
    }
    const end = model.get().layouts[target.workspace]?.tabs.length ?? 0;
    return model.op({ op: "move_tab", tab, workspace: target.workspace, index: end });
  }
  const pane = id(source.pane);
  if (target.kind === "pane") {
    if (target.side === "center") return model.op({ op: "swap", a: pane, b: id(target.pane) });
    return model.op({ op: "move_pane", pane, to: id(target.pane), side: target.side });
  }
  if (target.kind === "tabbar") return model.op({ op: "break_pane", pane, workspace: target.workspace, index: target.index });
  return model.op({ op: "break_pane", pane, workspace: target.workspace });
}

/** 누른 자리에서 끌기를 시작할 준비를 한다. 조금 움직이면 끌기가 되고, 움직이지 않고 떼면 onClick 을 부른다 */
export function beginDrag(e: React.PointerEvent, model: AppModel, source: DragSource, onClick?: () => void) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
      started = true;
      document.body.style.cursor = "grabbing";
    }
    dragStore.setState({ source, x: ev.clientX, y: ev.clientY, target: hitTest(source, ev.clientX, ev.clientY) });
  };
  const end = (ev: PointerEvent | KeyboardEvent) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("keydown", esc, true);
    document.body.style.cursor = "";
    const { target } = dragStore.getState();
    dragStore.setState({ source: null, target: null });
    if (started && ev.type === "pointerup" && target) void commit(model, source, target);
    else if (!started && ev.type === "pointerup") onClick?.();
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    started = false;
    end(ev);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("keydown", esc, true);
}
