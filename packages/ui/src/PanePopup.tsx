// 칸 오른쪽 위에 뜨는 팝업 틀: 머리 줄과 크기 조절. 팀원 팝업(TeamPanel)과 붙인 그림 팝업(ImagePanel)이 같이 쓴다.

import { XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";

import { cn } from "./lib/utils";

const iconBtn = "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

/** 칸 위 팝업(팀원, 붙인 그림)의 머리 줄 */
export function PopupHead({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b bg-popover px-1.5 text-[11px] text-popover-foreground">
      {children}
      <button className={cn(iconBtn, "ml-auto")} title="닫기" onClick={onClose}>
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

type Size = { w: number; h: number };
const MIN_SIZE: Size = { w: 280, h: 160 };

function loadSize(key: string, fallback: Size): Size {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return fallback;
  }
}

/** 크기 조절 손잡이. 팝업이 칸 오른쪽 위에 붙어 있어 왼쪽·아래·왼쪽 아래만 잡는다 */
type Edge = "left" | "bottom" | "corner";
const HANDLES: Record<Edge, string> = {
  left: "inset-y-0 left-0 w-1.5 cursor-ew-resize",
  bottom: "inset-x-0 bottom-0 h-1.5 cursor-ns-resize",
  corner: "bottom-0 left-0 size-3 cursor-nesw-resize",
};

/** 칸 오른쪽 위에 붙는 크기 조절 팝업 (팀원 터미널, 붙인 그림). 크기는 `sizeKey` 로 남아 다시 켜도 그대로다 */
export function ResizablePopup({
  sizeKey,
  defaultSize,
  className,
  onResize,
  children,
}: {
  sizeKey: string;
  defaultSize: Size;
  className?: string;
  /** 끄는 동안 크기가 바뀔 때마다 부른다 (터미널이 든 팝업은 그림판 자리를 다시 잡는다) */
  onResize?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => loadSize(sizeKey, defaultSize));

  const startResize = (edge: Edge, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 지금 보이는 크기(칸에 맞춰 줄었을 수 있다)에서 시작한다
    const box = ref.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: box.width, h: box.height };
    let last = { w: box.width, h: box.height };
    const move = (ev: PointerEvent) => {
      last = {
        w: edge === "bottom" ? start.w : Math.max(MIN_SIZE.w, start.w - (ev.clientX - start.x)),
        h: edge === "left" ? start.h : Math.max(MIN_SIZE.h, start.h + (ev.clientY - start.y)),
      };
      setSize(last);
      onResize?.();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      localStorage.setItem(sizeKey, JSON.stringify({ w: Math.round(last.w), h: Math.round(last.h) }));
    };
    document.body.style.cursor = getComputedStyle(e.currentTarget).cursor;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={ref}
      className={cn("absolute top-1.5 right-2 z-[8] flex flex-col overflow-hidden rounded-lg shadow-2xl", className)}
      style={{ width: `min(${size.w}px, calc(100% - 16px))`, height: `min(${size.h}px, calc(100% - 12px))` }}
    >
      {children}
      {(Object.keys(HANDLES) as Edge[]).map((edge) => (
        <div key={edge} className={cn("absolute z-10", HANDLES[edge])} onPointerDown={(e) => startResize(edge, e)} onDoubleClick={() => (localStorage.removeItem(sizeKey), setSize(defaultSize))} />
      ))}
    </div>
  );
}
