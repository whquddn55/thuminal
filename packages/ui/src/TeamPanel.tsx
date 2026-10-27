// 에이전트 팀: claude 리더가 띄운 팀원 터미널을 리더 칸 위 팝업으로 본다.
//
// 팀원은 배치 트리(분할)에 없다. 데몬이 꼬리표(`team.leader`)로 리더에 묶어 둔 세션이다 (daemon teams.rs).
// 리더 터미널 폭은 그대로 두고, [팀원 N] 단추를 누르면 리더 칸 오른쪽 위에 팝업이 뜬다.
// 팝업은 목록(팀원 이름) → 이름을 누르면 그 팀원 터미널 → [← 목록] 으로 돌아간다.
//
// 팝업 틀(머리 줄)은 HTML 이라 그림판 위에 뜨고, 터미널 자리는 비워 두어 그림판이 비치게 한다.
// 팀원 터미널은 그림판의 위층(layer 1)이라 리더가 다시 그려도 그 위에 다시 그린다 (renderer-webgl).

import { CaretLeftIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useContext, useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import type { SessionInfo, Tab, WorkspaceId } from "@thuminal/term-core";

import { GalleryButton, ImageGallery, useGallery } from "./ImagePanel";
import { cn } from "./lib/utils";
import { PopupHead, ResizablePopup } from "./PanePopup";
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
  const gallery = useGallery(session);
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
      {(mates.length > 0 || gallery.count > 0) && !header && (
        <div className={cn("absolute top-1.5 right-2 z-[8] flex items-center gap-1", (open || gallery.open) && "invisible")}>
          {gallery.count > 0 && <GalleryButton session={session} floating />}
          {mates.length > 0 && (
            <button
              className="flex h-5 items-center gap-1 rounded-md border bg-popover/90 px-1.5 text-[10px] text-popover-foreground shadow-sm hover:bg-accent"
              title={`팀원 ${mates.map(mateName).join(", ")}`}
              onClick={() => model.toggleTeam(session)}
            >
              {mates.map((m) => (
                <span key={m.id} className="size-1.5 rounded-full" style={{ background: mateColor(m) }} />
              ))}
              팀원 {mates.length}
            </button>
          )}
        </div>
      )}
      {open && (mate ? <MateDetail ws={ws} leader={session} paneId={paneId} mate={mate} focused={focused && mateKeys} /> : <MateList leader={session} mates={mates} />)}
      {gallery.open && !open && <ImageGallery session={session} />}
    </>
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

/** 팀원 하나의 터미널. 팝업 크기는 모든 팀원·리더가 같이 쓴다 */
function MateDetail({ ws, leader, paneId, mate, focused }: { ws: WorkspaceId; leader: number; paneId: number; mate: SessionInfo; focused: boolean }) {
  const model = useModel();
  const color = mateColor(mate);
  const { renderer } = useContext(RendererContext);

  return (
    <ResizablePopup sizeKey="thuminal.teamPopupSize" defaultSize={{ w: 680, h: 560 }} className="ring-1 ring-primary/50" onResize={() => renderer?.layout()}>
      <PopupHead onClose={() => model.toggleTeam(leader, false)}>
        <button className="flex h-5 items-center gap-0.5 rounded pr-1.5 pl-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" title="팀원 목록으로" onClick={() => model.showTeammate(leader, null)}>
          <CaretLeftIcon className="size-3" />
          목록
        </button>
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 truncate font-medium">{mateName(mate)}</span>
        {mate.state.state === "exited" && <span className="text-muted-foreground">끝남{mate.state.code !== null && ` (코드 ${mate.state.code})`}</span>}
      </PopupHead>
      <div className="flex min-h-0 flex-1">
        {/* 글자는 그림판이 그리므로 색 띠는 터미널 자리 밖에 둔다 */}
        <div className="w-0.5 shrink-0" style={{ background: color }} />
        {/* 터미널 자리는 비워 둔다: 그림판(아래)의 위층 팀원 터미널이 비친다 */}
        <div className="relative min-w-0 flex-1">
          <TerminalPane ws={ws} paneId={paneId} session={mate.id} focused={focused} layer={1} onActivate={() => model.teamKeys(leader, true)} />
        </div>
      </div>
    </ResizablePopup>
  );
}
