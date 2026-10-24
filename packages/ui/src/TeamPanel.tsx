// 에이전트 팀: claude 리더가 띄운 팀원 터미널을 리더 칸 위 팝업으로 본다.
//
// 팀원은 배치 트리(분할)에 없다. 데몬이 꼬리표(`team.leader`)로 리더에 묶어 둔 세션이다 (daemon teams.rs).
// 리더 터미널 폭은 그대로 두고, [팀원 N] 단추를 누르면 리더 칸 오른쪽 위에 팝업이 뜬다.
// 팝업은 목록(팀원 이름) → 이름을 누르면 그 팀원 터미널 → [← 목록] 으로 돌아간다.
//
// 팝업 틀(머리 줄)은 HTML 이라 그림판 위에 뜨고, 터미널 자리는 비워 두어 그림판이 비치게 한다.
// 팀원 터미널은 그림판의 위층(layer 1)이라 리더가 다시 그려도 그 위에 다시 그린다 (renderer-webgl).

import { CaretLeftIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { SessionInfo, Tab, WorkspaceId } from "@thuminal/term-core";

import { cn } from "./lib/utils";
import { TEAM_COLOR_LABEL, TEAM_NAME_LABEL, teammatesOf, teamView, useApp, useModel } from "./store";
import { RendererContext, TerminalMenu, TerminalPane } from "./Workspace";

/** claude 가 tmux 색 이름으로 주는 팀원 색 */
const COLORS: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  magenta: "#a855f7",
  colour208: "#f97316",
  colour205: "#ec4899",
  cyan: "#06b6d4",
};

export const mateColor = (s: SessionInfo) => COLORS[s.labels[TEAM_COLOR_LABEL] ?? ""] ?? "var(--muted-foreground)";
export const mateName = (s: SessionInfo) => s.labels[TEAM_NAME_LABEL] || `팀원 ${s.id}`;

export function useTeammates(leader: number): SessionInfo[] {
  return useApp(useShallow((s) => teammatesOf(s.sessions, leader)));
}

const iconBtn = "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

/** 리더 터미널 + 팀원 팝업. header 가 있으면 [팀원 N] 단추는 칸 머리 줄에 있다 */
export function TeamTerminal({
  ws,
  tab,
  paneId,
  session,
  focused,
  header,
}: {
  ws: WorkspaceId;
  tab: Tab;
  paneId: number;
  session: number;
  focused: boolean;
  header: boolean;
}) {
  const model = useModel();
  const mates = useTeammates(session);
  const view = useApp((s) => teamView(s, session));
  const { renderer } = useContext(RendererContext);
  const open = view.open && mates.length > 0;
  // 띄운 팀원이 끝나 지워졌으면 목록으로
  const mate = open ? (mates.find((m) => m.id === view.mate) ?? null) : null;
  const mateKeys = mate !== null && view.keys;
  useLayoutEffect(() => {
    renderer?.layout();
  }, [renderer, open, mate?.id]);

  return (
    <>
      <TerminalMenu tab={tab} paneId={paneId} session={session}>
        <TerminalPane ws={ws} paneId={paneId} session={session} focused={focused && !mateKeys} onActivate={() => model.teamKeys(session, false)} />
      </TerminalMenu>
      {mates.length > 0 && !header && (
        <button
          className={cn(
            "absolute top-1.5 right-2 z-[8] flex h-5 items-center gap-1 rounded-md border bg-popover/90 px-1.5 text-[10px] text-popover-foreground shadow-sm hover:bg-accent",
            open && "invisible",
          )}
          title={`팀원 ${mates.map(mateName).join(", ")}`}
          onClick={() => model.toggleTeam(session)}
        >
          {mates.map((m) => (
            <span key={m.id} className="size-1.5 rounded-full" style={{ background: mateColor(m) }} />
          ))}
          팀원 {mates.length}
        </button>
      )}
      {open && (mate ? <MateDetail ws={ws} leader={session} paneId={paneId} mate={mate} focused={focused && mateKeys} /> : <MateList leader={session} mates={mates} />)}
    </>
  );
}

function PopupHead({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b bg-popover px-1.5 text-[11px] text-popover-foreground">
      {children}
      <button className={cn(iconBtn, "ml-auto")} title="닫기" onClick={onClose}>
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** 팀원 이름 목록 */
function MateList({ leader, mates }: { leader: number; mates: SessionInfo[] }) {
  const model = useModel();
  return (
    <div className="absolute top-1.5 right-2 z-[8] w-56 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
      <PopupHead onClose={() => model.toggleTeam(leader, false)}>
        <UsersThreeIcon className="size-3.5 text-primary" />
        <span className="font-medium">팀원 {mates.length}</span>
      </PopupHead>
      <div className="max-h-72 overflow-y-auto p-1 thm-scroll">
        {mates.map((m) => (
          <button
            key={m.id}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent", m.state.state === "exited" && "opacity-50")}
            onClick={() => model.showTeammate(leader, m.id)}
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: mateColor(m) }} />
            <span className="min-w-0 truncate">{mateName(m)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 팀원 하나의 터미널 */
/** 팀원 터미널 팝업 크기 (CSS 픽셀). 모든 팀원·리더가 같이 쓰고 다시 켜도 남는다 */
const SIZE_KEY = "thuminal.teamPopupSize";
const DEFAULT_SIZE = { w: 680, h: 560 };
const MIN_SIZE = { w: 280, h: 160 };

function loadSize(): { w: number; h: number } {
  try {
    return { ...DEFAULT_SIZE, ...JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SIZE;
  }
}

/** 크기 조절 손잡이. 팝업이 칸 오른쪽 위에 붙어 있어 왼쪽·아래·왼쪽 아래만 잡는다 */
type Edge = "left" | "bottom" | "corner";
const HANDLES: Record<Edge, string> = {
  left: "inset-y-0 left-0 w-1.5 cursor-ew-resize",
  bottom: "inset-x-0 bottom-0 h-1.5 cursor-ns-resize",
  corner: "bottom-0 left-0 size-3 cursor-nesw-resize",
};

function MateDetail({ ws, leader, paneId, mate, focused }: { ws: WorkspaceId; leader: number; paneId: number; mate: SessionInfo; focused: boolean }) {
  const model = useModel();
  const color = mateColor(mate);
  const { renderer } = useContext(RendererContext);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(loadSize);

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
      renderer?.layout();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(last.w), h: Math.round(last.h) }));
    };
    document.body.style.cursor = getComputedStyle(e.currentTarget).cursor;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={ref}
      className="absolute top-1.5 right-2 z-[8] flex flex-col overflow-hidden rounded-lg shadow-2xl ring-1 ring-primary/50"
      style={{ width: `min(${size.w}px, calc(100% - 16px))`, height: `min(${size.h}px, calc(100% - 12px))` }}
    >
      <PopupHead onClose={() => model.toggleTeam(leader, false)}>
        <button className="flex h-5 items-center gap-0.5 rounded pr-1.5 pl-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" title="팀원 목록으로" onClick={() => model.showTeammate(leader, null)}>
          <CaretLeftIcon className="size-3" />
          목록
        </button>
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 truncate font-medium">{mateName(mate)}</span>
        {mate.state.state === "exited" && <span className="text-muted-foreground">끝났다{mate.state.code !== null && ` (코드 ${mate.state.code})`}</span>}
      </PopupHead>
      <div className="flex min-h-0 flex-1">
        {/* 글자는 그림판이 그리므로 색 띠는 터미널 자리 밖에 둔다 */}
        <div className="w-0.5 shrink-0" style={{ background: color }} />
        {/* 터미널 자리는 비워 둔다: 그림판(아래)의 위층 팀원 터미널이 비친다 */}
        <div className="relative min-w-0 flex-1">
          <TerminalPane ws={ws} paneId={paneId} session={mate.id} focused={focused} layer={1} onActivate={() => model.teamKeys(leader, true)} />
        </div>
      </div>
      {(Object.keys(HANDLES) as Edge[]).map((edge) => (
        <div key={edge} className={cn("absolute z-10", HANDLES[edge])} onPointerDown={(e) => startResize(edge, e)} onDoubleClick={() => (localStorage.removeItem(SIZE_KEY), setSize(DEFAULT_SIZE))} />
      ))}
    </div>
  );
}
