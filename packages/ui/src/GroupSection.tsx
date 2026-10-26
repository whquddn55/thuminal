// 사이드바 워크스페이스(프로젝트 묶음) 한 칸: 머리 줄 + 안의 프로젝트들.
//
// 내 컴퓨터 워크스페이스와 원격 컴퓨터 워크스페이스가 같은 컴포넌트를 쓴다. 원격은 `remote` 를 주면
// 머리에 컴퓨터 표시와 연결 상태가 붙고, 이름 고치기와 프로젝트 끌어 넣기가 막힌다.
// 끌어 넣기 자리는 `data-drop-group`(+`data-count`)로 dnd.ts 가 찾는다.

import { CaretDownIcon, DesktopIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { useDrag } from "./dnd";
import { cn } from "./lib/utils";

/** 원격 컴퓨터 연결 상태 */
export type RemoteState = "connected" | "connecting" | "offline";

export interface GroupSectionProps {
  /** 워크스페이스 id. 끌어 넣기 자리(`data-drop-group`)에 쓴다 */
  id: string;
  name: string;
  /** 든 프로젝트 수. 머리 오른쪽에 흐리게 보이고, 끌어 놓을 끝 자리로도 쓴다 */
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** 이름 앞 아이콘. 원격이면 주지 않아도 컴퓨터 아이콘을 그린다 */
  icon?: React.ReactNode;
  /**
   * 원격 컴퓨터 워크스페이스. 머리에 컴퓨터 아이콘과 연결 상태 배지(`state`)를 그리고,
   * 이름 고치기·프로젝트 끌어 넣기를 막는다 (`droppable` 로 따로 열 수 있다). `title` 은 머리에 올리면 보일 글(주소 등)
   */
  remote?: { state?: RemoteState; title?: string };
  /** 이름 옆에 덧붙일 배지 (원격 상태 배지 말고 더 보일 것) */
  badge?: React.ReactNode;
  /** 프로젝트를 끌어 넣을 수 있는가. 기본: 원격이 아니면 넣을 수 있다 */
  droppable?: boolean;
  /** 머리 … 메뉴 항목 (DropdownMenuItem 들). 없으면 단추를 그리지 않는다 */
  menu?: React.ReactNode;
  /** 이름 고치는 중 (머리 이름 자리에 입력 칸) */
  renaming?: boolean;
  /** 이름 고치기를 마쳤다. null 이면 그만뒀다 */
  onRename?: (name: string | null) => void;
  /** 이름을 두 번 눌러 고치기 시작 (없으면 두 번 눌러도 고치지 않는다) */
  onStartRename?: () => void;
  /** 프로젝트가 없을 때 보일 글. 기본은 끌어 넣기 안내 (끌어 넣지 못하면 "프로젝트가 없다") */
  empty?: React.ReactNode;
  children: React.ReactNode;
}

export function GroupSection({
  id,
  name,
  count,
  collapsed,
  onToggle,
  icon,
  remote,
  badge,
  droppable = !remote,
  menu,
  renaming,
  onRename,
  onStartRename,
  empty,
  children,
}: GroupSectionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dragging = useDrag((d) => droppable && d.source?.kind === "project");
  // 워크스페이스 끝에 놓는 자리 (프로젝트 머리 위아래에 놓을 때는 그쪽이 줄을 긋는다)
  const dropHere = useDrag((d) => droppable && d.target?.kind === "group" && d.target.group === id && !d.target.line);
  const lead = icon ?? (remote ? <DesktopIcon className="size-3.5" /> : null);
  return (
    <section
      data-drop-group={droppable ? id : undefined}
      data-count={count}
      className={cn("mt-1 rounded-lg pb-1 transition-colors first:mt-0", dropHere && "bg-drop/10 ring-1 ring-drop/50")}
    >
      <div
        role="button"
        tabIndex={0}
        title={remote?.title}
        className="group flex h-7 cursor-pointer items-center gap-1 rounded-md bg-sidebar-accent/50 pr-1 pl-1.5 select-none hover:bg-sidebar-accent"
        onClick={() => !renaming && onToggle()}
        onKeyDown={(e) => {
          if (!renaming && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <CaretDownIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
        {lead && <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{lead}</span>}
        {renaming ? (
          <input
            autoFocus
            className="h-5 min-w-0 flex-1 rounded border bg-background px-1 text-xs outline-none focus:border-ring"
            defaultValue={name}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onRename?.(e.currentTarget.value);
              else if (e.key === "Escape") onRename?.(null);
            }}
            onBlur={() => onRename?.(null)}
          />
        ) : (
          <span
            className="min-w-0 truncate text-xs font-semibold tracking-wide text-muted-foreground group-hover:text-foreground"
            onDoubleClick={(e) => {
              if (!onStartRename) return;
              e.stopPropagation();
              onStartRename();
            }}
          >
            {name}
          </span>
        )}
        {remote?.state && <RemoteBadge state={remote.state} />}
        {badge}
        <span className="flex-1" />
        <span className={cn("pr-1 text-[11px] tabular-nums text-muted-foreground/70", menu && "group-hover:hidden", menuOpen && "hidden")}>{count}</span>
        {menu && (
          <span
            className={cn("hidden items-center group-hover:flex", menuOpen && "flex")}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground" title="워크스페이스 메뉴">
                  <DotsThreeIcon weight="bold" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {menu}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="pt-0.5">
          {count > 0 ? (
            children
          ) : (
            <div
              className={cn(
                "mx-2 mt-1 rounded-md border border-dashed border-sidebar-border px-2 py-2 text-center text-[11px] text-muted-foreground",
                dragging && "border-drop/60",
              )}
            >
              {empty ?? (droppable ? "프로젝트를 여기로 끌어 놓는다" : "프로젝트가 없다")}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const REMOTE_LABEL: Record<RemoteState, string> = { connected: "연결됨", connecting: "연결 중", offline: "끊김" };

/** 원격 컴퓨터 연결 상태 배지 (워크스페이스 머리 이름 옆) */
export function RemoteBadge({ state, className }: { state: RemoteState; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-none",
        state === "connected" && "border-agent-done/40 text-foreground/70",
        state === "connecting" && "border-sidebar-border text-muted-foreground",
        state === "offline" && "border-sidebar-border text-muted-foreground/70",
        className,
      )}
    >
      {state === "connecting" ? (
        <span className="thm-spinner block size-1.5 rounded-full border border-muted-foreground border-t-transparent" />
      ) : (
        <span className={cn("block size-1.5 rounded-full", state === "connected" ? "bg-agent-done" : "bg-muted-foreground/50")} />
      )}
      {REMOTE_LABEL[state]}
    </span>
  );
}
