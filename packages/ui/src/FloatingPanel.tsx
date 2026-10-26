// 플로팅 워크스페이스: 메인 창 위에 떠 있는 패널. 워크트리에 묶이지 않고 자기 탭과 칸을 가진다.
//
// 제목 줄을 끌어 옮기고, 가장자리 여덟 곳을 끌어 크기를 바꾸고, 제목 줄을 두 번 눌러 최대화한다.
// 자리와 크기는 다시 켜도 남는다. 닫아도 터미널은 데몬에서 계속 돈다.
// 여닫는 버튼(FloatingTrigger)은 창 오른쪽 아래에 떠 있고 끌어서 옮길 수 있다.

import { ArrowsInIcon, ArrowsOutIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
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
        // 떠 있는 느낌: 넓게 퍼진 그림자와 가까운 그림자를 겹친다. 어두운 테마는 검은 그림자가 잘 안 보여 진하게 하고 바깥 테두리를 밝게 둔다
        "fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-background",
        "shadow-[0_28px_70px_-10px_rgb(0_0_0/0.45),0_10px_24px_-6px_rgb(0_0_0/0.3)]",
        "dark:shadow-[0_28px_80px_-6px_rgb(0_0_0/0.85),0_10px_28px_rgb(0_0_0/0.6),0_0_0_1px_rgb(255_255_255/0.07)]",
        focused ? "border-ring/50" : "border-border",
      )}
      style={style}
      data-floating-panel
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
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="닫기 (⌘⌥A)" onClick={() => void model.toggleFloating()}>
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

// ---- 플로팅 워크스페이스를 여닫는 떠 있는 버튼 (Orca 와 같이 창 오른쪽 아래, 끌어서 옮긴다) ----

const TRIGGER = 36;
const TRIGGER_KEY = "thuminal.floatingTrigger";
/** 창 위 제목 줄 높이. 버튼이 그 위로 올라가 창 끌기를 가리지 않게 한다 */
const TITLEBAR = 40;

/** 가까운 모서리에서 떨어진 거리로 남긴다. 창 크기가 바뀌어도 그 모서리에 붙어 있다 */
interface Anchored {
  right: boolean;
  bottom: boolean;
  dx: number;
  dy: number;
}

const DEFAULT_TRIGGER: Anchored = { right: true, bottom: true, dx: 24, dy: 72 };

function loadTrigger(): Anchored {
  try {
    return { ...DEFAULT_TRIGGER, ...JSON.parse(localStorage.getItem(TRIGGER_KEY) ?? "{}") };
  } catch {
    return DEFAULT_TRIGGER;
  }
}

function clampTrigger(left: number, top: number) {
  return {
    left: Math.min(Math.max(8, left), window.innerWidth - TRIGGER - 8),
    top: Math.min(Math.max(TITLEBAR, top), window.innerHeight - TRIGGER - 8),
  };
}

function resolveTrigger(a: Anchored) {
  return clampTrigger(a.right ? window.innerWidth - TRIGGER - a.dx : a.dx, a.bottom ? window.innerHeight - TRIGGER - a.dy : a.dy);
}

function anchorTrigger(left: number, top: number): Anchored {
  const right = left + TRIGGER / 2 > window.innerWidth / 2;
  const bottom = top + TRIGGER / 2 > window.innerHeight / 2;
  return { right, bottom, dx: right ? window.innerWidth - left - TRIGGER : left, dy: bottom ? window.innerHeight - top - TRIGGER : top };
}

export function FloatingTrigger() {
  const model = useModel();
  const open = useApp((s) => s.floating.open);
  // 닫혀 있는 동안 플로팅 탭에 새 출력이 있으면 주황 점을 띄운다
  const unread = useApp((s) => !s.floating.open && model.unread(FLOATING_WORKSPACE, { ...s, active: "" }));
  const [anchored, setAnchored] = useState(loadTrigger);
  const [live, setLive] = useState<{ left: number; top: number } | null>(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    const on = () => redraw((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const pos = live ?? resolveTrigger(anchored);
  // 브라우저 칸의 웹뷰는 HTML 위에 그려져 버튼을 가린다. 웹뷰와 겹치는 동안에는 버튼을 숨긴다 (⌘⌥A 는 된다)
  const [underWebview, setUnderWebview] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => {
      const r = { left: pos.left, top: pos.top, right: pos.left + TRIGGER, bottom: pos.top + TRIGGER };
      const hit = [...document.querySelectorAll("[data-browser-host]")].some((el) => {
        const b = el.getBoundingClientRect();
        return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
      });
      setUnderWebview(hit);
    }, 300);
    return () => window.clearInterval(t);
  }, [pos.left, pos.top]);
  if (underWebview && !live) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "fixed z-[46] flex size-9 cursor-grab items-center justify-center rounded-lg bg-card text-foreground transition-transform active:cursor-grabbing",
            "shadow-[0_4px_12px_rgb(0_0_0/0.22),0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent)] hover:-translate-y-0.5 hover:bg-accent",
            "dark:bg-accent dark:shadow-[0_6px_16px_rgb(0_0_0/0.55),0_0_0_1px_rgb(255_255_255/0.22)]",
            open && "ring-2 ring-ring/50",
          )}
          style={pos}
          aria-label={open ? "플로팅 워크스페이스 접기" : "플로팅 워크스페이스 열기"}
          aria-pressed={open}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const x0 = e.clientX;
            const y0 = e.clientY;
            const p0 = pos;
            let moved = false;
            let last = p0;
            const move = (ev: PointerEvent) => {
              // 4px 넘게 움직이면 누르기가 아니라 옮기기로 본다
              if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
              moved = true;
              last = clampTrigger(p0.left + ev.clientX - x0, p0.top + ev.clientY - y0);
              setLive(last);
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              if (moved) {
                const a = anchorTrigger(last.left, last.top);
                localStorage.setItem(TRIGGER_KEY, JSON.stringify(a));
                setAnchored(a);
                setLive(null);
              } else void model.toggleFloating();
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          <SquaresFourIcon className="size-4" />
          {unread && <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-amber-500 ring-2 ring-card dark:ring-accent" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        플로팅 워크스페이스 {open ? "접기" : "열기"} (⌘⌥A)
      </TooltipContent>
    </Tooltip>
  );
}
