// 왼쪽 사이드바: 프로젝트(저장소)마다 워크트리 카드. 카드 모양은 Orca 를 따른다.
//
// 카드 = 왼쪽 상태 칸(16px) + 제목 줄(13px) + 브랜치 줄(11px) + 에이전트 줄(터미널마다 하나).
// 고른 카드는 전경색을 옅게 덮고 1px 테두리를 둔다 (styles.css 의 [data-card-active]).

import {
  BellIcon,
  BellSimpleRingingIcon,
  CaretDownIcon,
  ChatCircleDotsIcon,
  DotsThreeIcon,
  FolderIcon,
  FolderPlusIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PushPinIcon,
  RobotIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { AgentState, SessionInfo, WorkspaceId, WorktreeInfo } from "@thuminal/term-core";

import { Button } from "./components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { useDrag } from "./dnd";
import { paneOfSession, sessionsOf } from "./layout";
import { cn } from "./lib/utils";
import { type AppState, FLOATING_WORKSPACE, OTHER_WORKSPACE, useApp, useModel, worktreeTitle } from "./store";

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

/** 30초마다 다시 그린다 (상대 시간, 출력 중 표시) */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function ago(t: number, now: number): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간`;
  return `${Math.floor(s / 86400)}일`;
}

type Status = "attention" | "working" | "done" | "active" | "failed" | "inactive";

/** 워크스페이스 상태: 사용자를 부르는 에이전트 > 일하는 에이전트 > 끝낸 에이전트 > 열린 터미널 > 없음 */
function statusOf(sessions: SessionInfo[]): Status {
  const agents = sessions.map((s) => s.agent?.state).filter(Boolean) as AgentState[];
  if (agents.includes("needs_attention")) return "attention";
  if (agents.includes("working")) return "working";
  if (agents.includes("idle")) return "done";
  if (sessions.some((s) => s.state.state === "running")) return "active";
  if (sessions.length) return "failed";
  return "inactive";
}

const STATUS_LABEL: Record<Status, string> = {
  attention: "에이전트가 묻고 있다",
  working: "에이전트가 일하는 중",
  done: "에이전트가 기다린다",
  active: "터미널이 열려 있다",
  failed: "터미널이 끝났다",
  inactive: "열린 터미널이 없다",
};

export function StatusIndicator({ status, className }: { status: Status | AgentState; className?: string }) {
  const s = status === "needs_attention" ? "attention" : status === "idle" ? "done" : status;
  return (
    <span className={cn("inline-flex size-3 shrink-0 items-center justify-center", className)}>
      {s === "working" ? (
        <span className="thm-spinner block size-2 rounded-full border-2 border-agent-working border-t-transparent" />
      ) : s === "attention" ? (
        <ChatCircleDotsIcon weight="fill" className="size-3 text-agent-attention" />
      ) : (
        <span
          className={cn(
            "block rounded-full",
            s === "failed" ? "size-1.5 bg-muted-foreground" : "size-2",
            (s === "done" || s === "active") && "bg-agent-done",
            s === "inactive" && "bg-neutral-500/40",
          )}
        />
      )}
    </span>
  );
}

export function Sidebar() {
  const model = useModel();
  const repos = useApp((s) => s.repos);
  const worktrees = useApp((s) => s.worktrees);
  const creating = useApp((s) => s.creating);
  const width = useApp((s) => s.sidebarWidth);
  const hasOther = useApp((s) => (s.layouts[OTHER_WORKSPACE]?.tabs.length ?? 0) > 0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const pinned = worktrees.filter((w) => w.pinned);
  const order = (list: WorktreeInfo[]) => [...list].sort((a, b) => Number(b.is_main) - Number(a.is_main));

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground" style={{ width }}>
      {/* 창 단추(신호등) 자리를 비운 머리. 끌어서 창을 옮긴다 */}
      <div className="flex h-10 shrink-0 items-center justify-end gap-0.5 pr-2 pl-20" data-tauri-drag-region>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" onClick={() => model.setDialog({ kind: "jump" })}>
              <MagnifyingGlassIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>워크트리로 가기 (⌘J)</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 pr-2 pl-3">
        <span className="flex-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">프로젝트</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => void model.addProject()}>
              <FolderPlusIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>프로젝트 추가</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 pb-2 pl-1 thm-scroll">
        {pinned.length > 0 && (
          <Group label="고정" icon={<PushPinIcon className="size-3" />} collapsed={collapsed.has("@pinned")} onToggle={() => toggle("@pinned")}>
            {pinned.map((w) => (
              <WorktreeCard key={`pin:${w.path}`} w={w} />
            ))}
          </Group>
        )}
        {repos.map((r) => (
          <Group
            key={r.id}
            label={r.name}
            title={r.path}
            icon={<FolderIcon className="size-3.5" />}
            collapsed={collapsed.has(r.id)}
            onToggle={() => toggle(r.id)}
            onNew={() => model.setDialog({ kind: "new-worktree", repo: r.id })}
            menu={
              <>
                <DropdownMenuItem onSelect={() => model.setDialog({ kind: "new-worktree", repo: r.id })}>새 워크트리…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void model.services.host.reveal(r.path).catch(model.fail)}>Finder 에서 보기</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(r.path)}>경로 복사</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void model.removeProject(r.id)}>
                  프로젝트 목록에서 빼기
                </DropdownMenuItem>
              </>
            }
          >
            {order(worktrees.filter((w) => w.repo === r.id && !w.pinned)).map((w) => (
              <WorktreeCard key={w.path} w={w} />
            ))}
            {creating
              .filter((c) => c.repo === r.id)
              .map((c) => (
                <div key={c.branch} className="ml-1 flex gap-0.5 rounded-lg border border-transparent py-1.5 pr-1.5 opacity-70">
                  <span className="flex size-4 items-center justify-center">
                    <StatusIndicator status="working" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] leading-5">{c.branch}</div>
                    <div className="text-[11px] text-muted-foreground">만드는 중…</div>
                  </div>
                </div>
              ))}
          </Group>
        ))}
        {(hasOther || repos.length === 0) && (
          <Group label="기타" icon={<TerminalWindowIcon className="size-3.5" />} collapsed={collapsed.has("@other")} onToggle={() => toggle("@other")}>
            <WorkspaceCard ws={OTHER_WORKSPACE} title="워크트리 밖 터미널" subtitle="홈 폴더 등" />
          </Group>
        )}
        {repos.length === 0 && (
          <button
            className="mx-2 mt-3 flex w-[calc(100%-1rem)] flex-col items-center gap-1 rounded-lg border border-dashed border-sidebar-border px-3 py-4 text-muted-foreground hover:bg-sidebar-accent"
            onClick={() => void model.addProject()}
          >
            <FolderPlusIcon className="size-5" />
            <span className="text-foreground">프로젝트 폴더 추가</span>
            <small className="text-2xs">git 저장소, 또는 저장소들이 든 폴더</small>
          </button>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-t border-sidebar-border px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" onClick={() => model.setDialog({ kind: "settings" })}>
              <GearSixIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>설정 (⌘,)</TooltipContent>
        </Tooltip>
      </div>
      <SidebarResizer />
    </aside>
  );
}

/** 사이드바 오른쪽 경계를 끌어 폭을 바꾼다 */
function SidebarResizer() {
  const model = useModel();
  return (
    <div
      className="group absolute top-0 -right-1.5 z-10 flex h-full w-3 cursor-col-resize justify-center"
      onPointerDown={(e) => {
        const x0 = e.clientX;
        const w0 = model.get().sidebarWidth;
        const move = (ev: PointerEvent) => model.setSidebarWidth(w0 + ev.clientX - x0);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      <div className="h-full w-px transition-colors group-hover:bg-ring/50 group-active:bg-ring" />
    </div>
  );
}

function Group({
  label,
  title,
  icon,
  collapsed,
  onToggle,
  onNew,
  menu,
  children,
}: {
  label: string;
  title?: string;
  icon: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  onNew?: () => void;
  menu?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="pt-1">
      <div
        role="button"
        tabIndex={0}
        title={title}
        className="group sticky top-0 z-[2] flex h-7 cursor-pointer items-center gap-1.5 bg-sidebar pr-1 pl-2.5"
        onClick={onToggle}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-4">{label}</span>
        <span
          className={cn("flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100", menuOpen && "opacity-100")}
          onClick={(e) => e.stopPropagation()}
        >
          {menu && (
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground">
                  <DotsThreeIcon weight="bold" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {menu}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onNew && (
            <Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground" title="새 워크트리 (⌘⇧N)" onClick={onNew}>
              <PlusIcon className="size-3.5" />
            </Button>
          )}
          <span className="flex size-5 items-center justify-center text-muted-foreground" onClick={onToggle}>
            <CaretDownIcon className={cn("size-3 transition-transform", collapsed && "-rotate-90")} />
          </span>
        </span>
      </div>
      {!collapsed && <div className="flex flex-col gap-1.5 pt-0.5">{children}</div>}
    </div>
  );
}

/** 워크스페이스의 세션 (배치에 든 순서) */
function useWorkspaceSessions(ws: WorkspaceId): SessionInfo[] {
  return useApp(useShallow((s: AppState) => sessionsOf(s.layouts[ws]).flatMap((id) => (s.sessions[id] ? [s.sessions[id]] : []))));
}

function WorktreeCard({ w }: { w: WorktreeInfo }) {
  const model = useModel();
  const [renaming, setRenaming] = useState(false);
  const title = worktreeTitle(w);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <WorkspaceCard
            ws={w.path}
            title={title}
            subtitle={w.branch ?? "(detached)"}
            badge={w.is_main ? "기본" : undefined}
            renaming={renaming}
            onRename={(name) => {
              setRenaming(false);
              if (name !== null) void model.renameWorktree(w, name);
            }}
            onStartRename={() => setRenaming(true)}
            renamePlaceholder={w.branch ?? ""}
            renameValue={w.name ?? ""}
            onKeyDown={(e) => {
              if (e.metaKey && e.shiftKey && e.key === "Backspace" && !w.is_main) model.setDialog({ kind: "delete-worktree", worktree: w });
            }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => setRenaming(true)}>이름 바꾸기</ContextMenuItem>
        <ContextMenuItem onSelect={() => void model.togglePin(w)}>{w.pinned ? "고정 풀기" : "맨 위에 고정"}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            model.select(w.path);
            void model.newTab(w.path);
          }}
        >
          새 터미널
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            model.select(w.path);
            void model.newTab(w.path, "claude");
          }}
        >
          claude 띄우기
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(title)}>이름 복사</ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(w.path)}>경로 복사</ContextMenuItem>
        <ContextMenuItem disabled={!w.branch} onSelect={() => copy(w.branch ?? "")}>
          브랜치 이름 복사
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void model.services.host.reveal(w.path).catch(model.fail)}>Finder 에서 보기</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={w.is_main} onSelect={() => model.setDialog({ kind: "delete-worktree", worktree: w })}>
          워크트리 지우기…
          <ContextMenuShortcut>⌘⇧⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkspaceCard({
  ws,
  title,
  subtitle,
  badge,
  renaming,
  onRename,
  onStartRename,
  renamePlaceholder,
  renameValue,
  onKeyDown,
}: {
  ws: WorkspaceId;
  title: string;
  subtitle: string;
  badge?: string;
  renaming?: boolean;
  onRename?: (name: string | null) => void;
  onStartRename?: () => void;
  renamePlaceholder?: string;
  renameValue?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const model = useModel();
  const now = useNow();
  const active = useApp((s) => s.active === ws);
  const unread = useApp((s) => model.unread(ws, s));
  const sessions = useWorkspaceSessions(ws);
  const dropHere = useDrag((d) => d.target?.kind === "workspace" && d.target.workspace === ws);
  const status = statusOf(sessions);
  const agents = sessions.filter((s) => s.agent);

  return (
    <div
      data-drop-workspace={ws}
      data-card-active={active || undefined}
      tabIndex={0}
      title={ws.startsWith("/") ? ws : undefined}
      className={cn(
        "relative ml-1 flex cursor-pointer flex-col rounded-lg border border-transparent pt-1.25 pr-1.5 pb-1.5 pl-0.5 outline-none transition-[background-color,border-color] duration-200 select-none",
        !active && "thm-card-hover",
        dropHere && "border-drop/60 bg-drop/15",
      )}
      onClick={() => model.select(ws)}
      onKeyDown={onKeyDown}
    >
      <div className="flex w-full min-w-0 items-start gap-0.5">
        <div className="flex shrink-0 items-start justify-center pt-[2px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="group/unread relative flex size-4 items-center justify-center rounded hover:bg-accent/80"
                onClick={(e) => {
                  // 안 읽음이면 눌러서 읽음으로 돌린다 (그 워크트리로 가지 않는다)
                  if (!unread) return;
                  e.stopPropagation();
                  model.markRead(ws);
                }}
              >
                {unread ? (
                  <BellSimpleRingingIcon weight="fill" className="size-[13px] text-amber-500 drop-shadow-sm" />
                ) : (
                  <>
                    <StatusIndicator status={status} className="transition-opacity group-hover/unread:opacity-0" />
                    <BellIcon className="absolute size-3 text-muted-foreground/40 opacity-0 transition-opacity group-hover/unread:opacity-100" />
                  </>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{unread ? "새 출력이 있다" : STATUS_LABEL[status]}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                className="h-5 min-w-0 flex-1 rounded border bg-background px-1 text-[13px] outline-none focus:border-ring"
                defaultValue={renameValue}
                placeholder={renamePlaceholder}
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
                className={cn("block min-w-0 truncate text-[13px] leading-5", unread ? "font-semibold text-foreground" : "font-normal text-foreground")}
                onDoubleClick={(e) => {
                  if (!onStartRename) return;
                  e.stopPropagation();
                  onStartRename();
                }}
              >
                {title}
              </span>
            )}
            {badge && (
              <span className="inline-flex h-4 shrink-0 items-center rounded border border-foreground/20 bg-foreground/[0.06] px-1.5 text-[10px] leading-none font-medium text-foreground/70">
                {badge}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[11px] leading-none text-muted-foreground">{subtitle}</span>
          </div>
          {agents.length > 0 && (
            <div className="-ml-2 flex w-[calc(100%+0.5rem)] flex-col gap-0.5">
              {agents.map((s) => (
                <AgentRow key={s.id} s={s} now={now} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 에이전트 한 줄 (Orca 와 같다): 상태, 에이전트, 마지막 프롬프트 - 지금 도구 또는 마지막 답, 모델, 지난 시간.
 * 프롬프트가 아직 없으면 터미널 제목(claude 가 정한 작업 이름)을 쓴다
 */
function AgentRow({ s, now }: { s: SessionInfo; now: number }) {
  const model = useModel();
  const agent = s.agent!;
  const lead = agent.prompt?.trim() || s.title.replace(/^[✳✻✽✶·*\s]+/, "") || agent.kind;
  const trail = agent.state === "working" ? agent.tool_name : agent.state === "idle" ? agent.last_assistant_message : null;
  const when = agent.turn_ended_at ?? agent.updated_at;
  return (
    <div
      className="thm-agent-row flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-[11px] leading-none text-muted-foreground"
      title={[agent.prompt, agent.last_assistant_message].filter(Boolean).join("\n\n") || undefined}
      onClick={(e) => {
        e.stopPropagation();
        const hit = paneOfSession(Object.values(model.get().layouts), s.id);
        if (!hit) return;
        if (hit.layout.workspace !== FLOATING_WORKSPACE) model.select(hit.layout.workspace);
        model.focusPane(hit.pane.id);
      }}
    >
      <StatusIndicator status={agent.state} className="size-2.5" />
      <RobotIcon className="size-[13px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground/90">{lead}</span>
        {trail && <span className="text-muted-foreground/60"> - {trail}</span>}
      </span>
      {agent.model && <span className="max-w-20 shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">{agent.model}</span>}
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{ago(when, now)}</span>
    </div>
  );
}
