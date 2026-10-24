// 플로팅 워크스페이스: 메인 창 위에 떠 있는 패널. 워크트리에 묶이지 않고 자기 탭과 칸을 가진다.
//
// 제목 줄을 끌어 옮기고, 가장자리 여덟 곳을 끌어 크기를 바꾸고, 제목 줄을 두 번 눌러 최대화한다.
// 자리와 크기는 다시 켜도 남는다. 닫아도 터미널은 데몬에서 계속 돈다.

import { ArrowsInIcon, ArrowsOutIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { FLOATING_WORKSPACE, type FloatingRect, useApp, useModel } from "./store";
import { TabBar, TerminalSurface, WorkspaceView } from "./Workspace";

const MIN_W = 420;
const MIN_H = 280;
const MARGIN = 16;

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const EDGES: { edge: Edge; className: string }[] = [
  { edge: "n", className: "top-0 left-2 right-2 h-1.5 cursor-ns-resize" },
  { edge: "s", className: "bottom-0 left-2 right-2 h-1.5 cursor-ns-resize" },
  { edge: "e", className: "right-0 top-2 bottom-2 w-1.5 cursor-ew-resize" },
  { edge: "w", className: "left-0 top-2 bottom-2 w-1.5 cursor-ew-resize" },
  { edge: "nw", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { edge: "se", className: "bottom-0 right-0 size-3 cursor-nwse-resize" },
  { edge: "ne", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
];

/** 저장된 자리를 창 안으로 맞춘다. 없으면 오른쪽 아래 920×560 */
function fit(rect: FloatingRect | null): FloatingRect {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.min(W - 2 * MARGIN, Math.max(MIN_W, rect?.w ?? 920));
  const h = Math.min(H - 2 * MARGIN, Math.max(MIN_H, rect?.h ?? 560));
  const x = Math.min(W - w - MARGIN, Math.max(MARGIN, rect?.x ?? W - w - MARGIN));
  const y = Math.min(H - h - MARGIN, Math.max(MARGIN, rect?.y ?? H - h - MARGIN));
  return { x, y, w, h };
}

export function FloatingPanel() {
  const model = useModel();
  const saved = useApp((s) => s.floating.rect);
  const maximized = useApp((s) => s.floating.maximized);
  const focused = useApp((s) => s.focusArea === "floating");
  const [live, setLive] = useState<FloatingRect | null>(null);
  const [, redraw] = useState(0);

  // 창 크기가 바뀌면 패널이 창 밖으로 나가지 않게 다시 맞춘다
  useEffect(() => {
    const on = () => redraw((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const rect = live ?? fit(saved);

  const drag = (e: React.PointerEvent, edge: Edge | "move") => {
    if (e.button !== 0 || maximized) return;
    if (edge === "move" && (e.target as HTMLElement).closest("button,input,[data-tab-index]")) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r0 = rect;
    let last = r0;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      let { x, y, w, h } = r0;
      if (edge === "move") {
        x += dx;
        y += dy;
      } else {
        if (edge.includes("e")) w = Math.max(MIN_W, r0.w + dx);
        if (edge.includes("s")) h = Math.max(MIN_H, r0.h + dy);
        if (edge.includes("w")) {
          w = Math.max(MIN_W, r0.w - dx);
          x = r0.x + r0.w - w;
        }
        if (edge.includes("n")) {
          h = Math.max(MIN_H, r0.h - dy);
          y = r0.y + r0.h - h;
        }
      }
      last = fit({ x, y, w, h });
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      model.setFloatingRect(last);
      setLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const style: React.CSSProperties = maximized
    ? { left: 8, top: 8, right: 8, bottom: 8 }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };

  return (
    <div
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-background shadow-2xl",
        focused ? "border-ring/50" : "border-border",
      )}
      style={style}
      onPointerDownCapture={() => !focused && model.setFocusArea("floating")}
    >
      <div
        className="flex h-9 shrink-0 cursor-default items-center gap-1 border-b bg-sidebar pr-1.5 pl-2"
        onPointerDown={(e) => drag(e, "move")}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button,[data-tab-index]")) return;
          model.setFloatingRect(saved, !maximized);
        }}
      >
        <span className="shrink-0 pr-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">플로팅</span>
        <TabBar ws={FLOATING_WORKSPACE} className="h-full flex-1">
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title={maximized ? "원래 크기" : "최대화"} onClick={() => model.setFloatingRect(saved, !maximized)}>
            {maximized ? <ArrowsInIcon /> : <ArrowsOutIcon />}
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="닫기 (Ctrl+`)" onClick={() => void model.toggleFloating()}>
            <XIcon />
          </Button>
        </TabBar>
      </div>
      <TerminalSurface surface="floating" className="flex-1">
        <WorkspaceView
          ws={FLOATING_WORKSPACE}
          empty={
            <div className="grid h-full place-content-center gap-2 text-center text-muted-foreground">
              <p>열린 터미널이 없다.</p>
              <Button size="sm" variant="outline" onClick={() => void model.newTab(FLOATING_WORKSPACE)}>
                새 터미널 (⌘T)
              </Button>
            </div>
          }
        />
      </TerminalSurface>
      {!maximized && EDGES.map(({ edge, className }) => <div key={edge} className={cn("absolute z-10", className)} onPointerDown={(e) => drag(e, edge)} />)}
    </div>
  );
}
