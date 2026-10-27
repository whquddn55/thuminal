// 왼쪽 사이드바: 워크스페이스(프로젝트 묶음) → 프로젝트(저장소) → 워크트리 카드. 카드 모양은 Orca 를 따른다.
//
// 워크스페이스가 기본 하나뿐이고 원격 컴퓨터도 없으면 머리를 감춰 프로젝트만 늘어놓는다 (묶음을 쓰지 않는 사람에게는 전과 같다).
// 원격 컴퓨터마다 그 이름의 고정 워크스페이스가 내 워크스페이스들 아래에 하나씩 붙고, 그 컴퓨터의 프로젝트는 모두 그 안에만 든다
// (그 칸은 그 호스트 모델로 감싸 그린다. 옮기기·끌어 넣기·이름 고치기는 막는다).
//
// 카드 = 왼쪽 상태 칸(16px) + 제목 줄(13px) + 브랜치 줄(11px) + 에이전트 줄(터미널마다 하나).
// 고른 카드는 전경색을 옅게 덮고 1px 테두리를 둔다 (styles.css 의 [data-card-active]).

import {
  BellIcon,
  BellSimpleRingingIcon,
  CaretDownIcon,
  ChatCircleDotsIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FolderPlusIcon,
  GearSixIcon,
  GitForkIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PushPinIcon,
  StackPlusIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type AgentInfo,
  DEFAULT_GROUP,
  type RemoteHost,
  type RepoGroup,
  type RepoInfo,
  type SessionInfo,
  type WorkspaceId,
  type WorktreeInfo,
} from "@thuminal/term-core";

import { Button } from "./components/ui/button";
import { AgentIcon } from "./agent-icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { beginDrag, useDrag } from "./dnd";
import { GroupSection } from "./GroupSection";
import { groupKey, NEW_GROUP_NAME, normalizeGroups } from "./groups";
import { paneOfSession, sessionsOf } from "./layout";
import { descendantsOf, lineageCounts, lineageKey, loadCollapsed, toggleCollapsed, worktreeForest } from "./lineage";
import { cn } from "./lib/utils";
import { RepoMark } from "./repo-icon";
import { type AppState, FLOATING_WORKSPACE, HOST_STATE_LABEL, ModelContext, OTHER_WORKSPACE, useApp, useModel, worktreeTitle } from "./store";

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

export type Status = "attention" | "working" | "error" | "interrupted" | "done" | "ready" | "active" | "failed" | "inactive";

/** 에이전트 하나의 상태: 부름, 일하는 중, 오류로 끝남, 턴을 끝냄, 막 떠서 기다림 */
export function agentStatus(a: AgentInfo): Status {
  switch (a.state) {
    case "needs_attention":
      return "attention";
    case "working":
      return "working";
    case "failed":
      return "error";
    default:
      // 사용자가 멈춘 턴은 "끝남" 이 아니다 (Orca 처럼 흐린 점)
      return a.interrupted ? "interrupted" : a.turn_ended_at ? "done" : "ready";
  }
}

const RANK: Status[] = ["attention", "error", "working", "interrupted", "done", "ready"];

/** 워크스페이스 상태: 부름 > 오류 > 일하는 중 > 끝낸 에이전트 > 막 뜬 에이전트 > 열린 터미널 > 없음 */
export function statusOf(sessions: SessionInfo[]): Status {
  const agents = sessions.flatMap((s) => (s.agent ? [agentStatus(s.agent)] : []));
  const top = RANK.find((r) => agents.includes(r));
  if (top) return top;
  if (sessions.some((s) => s.state.state === "running")) return "active";
  if (sessions.length) return "failed";
  return "inactive";
}

const STATUS_LABEL: Record<Status, string> = {
  attention: "에이전트가 묻고 있다",
  working: "에이전트가 일하는 중",
  error: "에이전트 턴이 오류로 끝났다",
  interrupted: "에이전트를 멈췄다",
  done: "에이전트가 일을 마쳤다",
  ready: "에이전트가 첫 입력을 기다린다",
  active: "터미널이 열려 있다",
  failed: "터미널이 끝났다",
  inactive: "열린 터미널이 없다",
};

export function StatusIndicator({ status, className }: { status: Status; className?: string }) {
  const s = status;
  return (
    <span className={cn("inline-flex size-3 shrink-0 items-center justify-center", className)} title={STATUS_LABEL[s]}>
      {s === "working" ? (
        <span className="thm-spinner block size-2 rounded-full border-2 border-agent-working border-t-transparent" />
      ) : s === "attention" ? (
        <ChatCircleDotsIcon weight="fill" className="size-3 text-agent-attention" />
      ) : s === "error" ? (
        <WarningCircleIcon weight="fill" className="size-3 text-agent-failed" />
      ) : s === "ready" ? (
        <span className="block size-2 rounded-full border-[1.5px] border-muted-foreground/70" />
      ) : (
        <span
          className={cn(
            "block rounded-full",
            s === "failed" ? "size-1.5 bg-muted-foreground" : "size-2",
            (s === "done" || s === "active") && "bg-agent-done",
            s === "inactive" && "bg-neutral-500/40",
            s === "interrupted" && "bg-muted-foreground/60",
          )}
        />
      )}
    </span>
  );
}

export function Sidebar() {
  // 사이드바는 로컬(root) 모델로 그린다. 원격 칸만 그 호스트 모델로 감싼다
  const model = useModel();
  const repos = useApp((s) => s.repos);
  const worktrees = useApp((s) => s.worktrees);
  const savedGroups = useApp((s) => s.groups);
  const groups = useMemo(() => normalizeGroups(savedGroups, repos), [savedGroups, repos]);
  const width = useApp((s) => s.sidebarWidth);
  const hasOther = useApp((s) => (s.layouts[OTHER_WORKSPACE]?.tabs.length ?? 0) > 0);
  // 접은 묶음(저장소, 고정, 기타)과 접은 하위 워크트리(`lineage:<경로>`). 다시 켜도 남는다
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const pinned = worktrees.filter((w) => w.pinned);

  const toggle = (key: string) => setCollapsed(toggleCollapsed(collapsed, key));
  // 이름을 고치는 워크스페이스 (막 만든 것 포함)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const remoteHosts = useApp((s) => s.remoteHosts);
  const repoById = new Map(repos.map((r) => [r.id, r]));

  /** 새 워크스페이스를 만들고(프로젝트 `move` 를 옮겨 넣고) 바로 이름을 고치게 한다 */
  const newGroup = async (move: string[] = []) => {
    const id = await model.createGroup(NEW_GROUP_NAME, move);
    if (!id) return;
    if (collapsed.has(groupKey(id))) toggle(groupKey(id));
    setRenamingGroup(id);
  };

  const projects = (g: RepoGroup) =>
    g.repos.flatMap((id, index) => {
      const r = repoById.get(id);
      return r ? [<ProjectGroup key={r.id} r={r} group={g.id} index={index} groups={groups} collapsed={collapsed} onToggle={toggle} onNewGroup={newGroup} />] : [];
    });

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
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="워크스페이스 만들기" onClick={() => void newGroup()}>
              <StackPlusIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>워크스페이스 만들기</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => void model.addProject()}>
              <FolderPlusIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>프로젝트 추가</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => model.setDialog({ kind: "import-orca" })}>
              <DownloadSimpleIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Orca에서 가져오기</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 pb-2 pl-1 thm-scroll" data-host="">
        {pinned.length > 0 && (
          <Group label="고정" icon={<PushPinIcon className="size-3" />} collapsed={collapsed.has("@pinned")} onToggle={() => toggle("@pinned")}>
            {pinned.map((w) => (
              <WorktreeCard key={`pin:${w.path}`} w={w} />
            ))}
          </Group>
        )}
        {groups.map((g, gi) => (
              <GroupSection
                key={g.id}
                id={g.id}
                name={g.name}
                count={g.repos.filter((id) => repoById.has(id)).length}
                collapsed={collapsed.has(groupKey(g.id))}
                onToggle={() => toggle(groupKey(g.id))}
                renaming={renamingGroup === g.id}
                onStartRename={() => setRenamingGroup(g.id)}
                onRename={(name) => {
                  setRenamingGroup(null);
                  if (name !== null && name.trim() && name.trim() !== g.name) model.renameGroup(g.id, name);
                }}
                menu={
                  <>
                    <DropdownMenuItem onSelect={() => setRenamingGroup(g.id)}>이름 바꾸기</DropdownMenuItem>
                    <DropdownMenuItem disabled={gi === 0} onSelect={() => model.shiftGroup(g.id, -1)}>
                      위로 옮기기
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={gi === groups.length - 1} onSelect={() => model.shiftGroup(g.id, 1)}>
                      아래로 옮기기
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={g.id === DEFAULT_GROUP} onSelect={() => model.deleteGroup(g.id)}>
                      {g.id === DEFAULT_GROUP ? "기본 워크스페이스는 지우지 못한다" : "지우기 (프로젝트는 기본으로)"}
                    </DropdownMenuItem>
                  </>
                }
              >
                {projects(g)}
              </GroupSection>
            ))}
        {remoteHosts.map((h) => {
          const m = model.hostModel(h.id);
          return m ? (
            <ModelContext.Provider key={h.id} value={m}>
              <RemoteHostSection host={h} collapsed={collapsed} onToggle={toggle} />
            </ModelContext.Provider>
          ) : null;
        })}
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
        {repos.length === 0 && (
          <button className="mx-2 mt-2 w-[calc(100%-1rem)] rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" onClick={() => model.setDialog({ kind: "import-orca" })}>
            Orca에서 프로젝트·claude 세션 가져오기
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

/**
 * 원격 컴퓨터 하나의 고정 워크스페이스 (그 호스트 모델 안에서 그린다). 그 컴퓨터의 프로젝트를 그 컴퓨터 워크스페이스 차례대로
 * 모두 늘어놓는다. 접은 상태 키는 `<호스트>|` 를 붙여 내 컴퓨터 것(같은 저장소 id·경로일 수 있다)과 가른다
 */
function RemoteHostSection({ host, collapsed, onToggle }: { host: RemoteHost; collapsed: Set<string>; onToggle: (key: string) => void }) {
  const model = useModel();
  const repos = useApp((s) => s.repos);
  const savedGroups = useApp((s) => s.groups);
  const worktrees = useApp((s) => s.worktrees);
  const hasOther = useApp((s) => (s.layouts[OTHER_WORKSPACE]?.tabs.length ?? 0) > 0);
  const order = useMemo(() => normalizeGroups(savedGroups, repos).flatMap((g) => g.repos), [savedGroups, repos]);
  const prefix = `${host.id}|`;
  const mine = useMemo(() => new Set([...collapsed].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))), [collapsed, prefix]);
  const toggle = (k: string) => onToggle(prefix + k);
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const pinned = worktrees.filter((w) => w.pinned);
  const key = groupKey(`host:${host.id}`);
  const title = [host.address, host.daemonVersion && `thuminal ${host.daemonVersion}`, host.error, host.warning].filter(Boolean).join("\n");
  return (
    <div data-host={host.id}>
      <GroupSection
        id={`host:${host.id}`}
        name={host.name}
        // 워크트리 밖 터미널만 있어도 펼쳐 보이게 기타 칸을 하나로 센다
        count={order.length + (hasOther ? 1 : 0)}
        collapsed={collapsed.has(key)}
        onToggle={() => onToggle(key)}
        remote={{ state: host.state, title }}
        empty={host.state === "connected" ? "이 컴퓨터에 등록한 프로젝트가 없다" : `${HOST_STATE_LABEL[host.state]} · 붙으면 프로젝트가 보인다`}
        menu={
          <>
            <DropdownMenuItem onSelect={() => void model.root.services.host.hosts?.reconnect(host.id).catch(model.fail)}>다시 붙기</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => model.root.setDialog({ kind: "settings", section: "hosts" })}>설정에서 다시 등록…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => copy(host.address)}>주소 복사</DropdownMenuItem>
          </>
        }
      >
        {pinned.length > 0 && (
          <Group nested label="고정" icon={<PushPinIcon className="size-3" />} collapsed={mine.has("@pinned")} onToggle={() => toggle("@pinned")}>
            {pinned.map((w) => (
              <WorktreeCard key={`pin:${w.path}`} w={w} />
            ))}
          </Group>
        )}
        {order.map((id, index) => {
          const r = repoById.get(id);
          return r ? <ProjectGroup key={r.id} r={r} group="" index={index} groups={[]} collapsed={mine} onToggle={toggle} /> : null;
        })}
        {hasOther && (
          <Group nested label="기타" icon={<TerminalWindowIcon className="size-3.5" />} collapsed={mine.has("@other")} onToggle={() => toggle("@other")}>
            <WorkspaceCard ws={OTHER_WORKSPACE} title="워크트리 밖 터미널" subtitle="홈 폴더 등" />
          </Group>
        )}
      </GroupSection>
    </div>
  );
}

/** 메인 워크트리를 맨 위로 */
const mainFirst = (list: WorktreeInfo[]) => [...list].sort((a, b) => Number(b.is_main) - Number(a.is_main));

/**
 * 프로젝트(저장소) 하나: 머리 줄 + 워크트리 카드. 머리를 끌어 다른 워크스페이스나 다른 프로젝트 위아래로 옮긴다.
 * `group`·`index` 는 든 워크스페이스와 그 안 자리 (끌어 놓기 자리로 쓴다)
 */
function ProjectGroup({
  r,
  group,
  index,
  groups,
  collapsed,
  onToggle,
  onNewGroup,
}: {
  r: RepoInfo;
  group: string;
  index: number;
  groups: RepoGroup[];
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  /** 없으면(원격 컴퓨터) 워크스페이스로 옮기기 메뉴를 숨긴다 */
  onNewGroup?: (move: string[]) => void;
}) {
  const model = useModel();
  // 원격 컴퓨터 프로젝트는 그 컴퓨터 워크스페이스에 붙어 있다: 끌어 옮기기·Finder 를 막는다
  const remote = !!model.services.host.isRemote;
  const worktrees = useApp(useShallow((s: AppState) => s.worktrees.filter((w) => w.repo === r.id)));
  const creating = useApp(useShallow((s: AppState) => s.creating.filter((c) => c.repo === r.id)));
  const others = groups.filter((g) => g.id !== group);
  return (
    <Group
      nested
      label={r.name}
      title={r.path}
      icon={<RepoMark repo={r.id} name={r.name} />}
      count={worktrees.length}
      collapsed={collapsed.has(r.id)}
      onToggle={() => onToggle(r.id)}
      onNew={() => model.setDialog({ kind: "new-worktree", repo: r.id })}
      drag={remote ? undefined : { repo: r.id, group, index }}
      menu={
        <>
          <DropdownMenuItem onSelect={() => model.setDialog({ kind: "new-worktree", repo: r.id })}>새 워크트리…</DropdownMenuItem>
          {onNewGroup && !remote && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>워크스페이스로 옮기기</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
              {others.map((g) => (
                <DropdownMenuItem key={g.id} onSelect={() => model.moveProject(r.id, g.id)}>
                  <span className="truncate">{g.name}</span>
                </DropdownMenuItem>
              ))}
              {others.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => onNewGroup([r.id])}>새 워크스페이스로…</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          {!remote && <DropdownMenuItem onSelect={() => void model.services.host.reveal(r.path).catch(model.fail)}>Finder에서 보기</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => copy(r.path)}>경로 복사</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => void model.removeProject(r.id)}>
            프로젝트 목록에서 빼기
          </DropdownMenuItem>
        </>
      }
    >
      <WorktreeTree list={mainFirst(worktrees.filter((w) => !w.pinned))} collapsed={collapsed} onToggle={onToggle} />
      {creating.map((c) => (
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

/**
 * 사이드바 묶음 (저장소, 고정, 기타). 묶음 사이에 구분선을 두고, 안의 카드는 머리 줄보다 들여 그린다
 * (저장소 이름과 워크트리가 같은 단계로 보이지 않게)
 */
function Group({
  label,
  title,
  icon,
  count,
  collapsed,
  onToggle,
  onNew,
  menu,
  drag,
  nested,
  children,
}: {
  label: string;
  title?: string;
  icon: React.ReactNode;
  /** 머리 줄 오른쪽에 흐리게 보일 개수 (워크트리 수) */
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  onNew?: () => void;
  menu?: React.ReactNode;
  /** 프로젝트 머리면 끌어 옮길 수 있다: 저장소 id, 든 워크스페이스, 그 안 자리 */
  drag?: { repo: string; group: string; index: number };
  /** 워크스페이스 안에 든다: 스크롤하면 워크스페이스 머리 밑에 쌓여 붙는다 */
  nested?: boolean;
  children: React.ReactNode;
}) {
  const model = useModel();
  const [menuOpen, setMenuOpen] = useState(false);
  // 다른 프로젝트를 이 머리 위나 아래에 놓으려 하면 그쪽에 줄을 긋는다
  const line = useDrag((d) => (drag && d.target?.kind === "group" && d.target.line?.repo === drag.repo ? (d.target.line.after ? "after" : "before") : null));
  const dragging = useDrag((d) => !!drag && d.source?.kind === "project" && d.source.repo === drag.repo);
  return (
    <div className={cn("border-t border-sidebar-border/70 pt-1.5 pb-1 first:border-t-0 first:pt-1", dragging && "opacity-50")}>
      <div
        role="button"
        tabIndex={0}
        title={title}
        data-drop-project={drag?.repo}
        data-group={drag?.group}
        data-index={drag?.index}
        className={cn(
          "group sticky z-[2] flex h-7 cursor-pointer items-center gap-1.5 bg-sidebar pr-1 pl-2",
          nested ? "top-7" : "top-0",
          line === "before" && "shadow-[inset_0_2px_0_var(--color-drop)]",
          line === "after" && "shadow-[inset_0_-2px_0_var(--color-drop)]",
        )}
        // 끌 수 있는 머리는 움직이지 않고 뗐을 때만 접고 편다 (beginDrag 가 부른다)
        onClick={drag ? undefined : onToggle}
        onPointerDown={drag ? (e) => beginDrag(e, model, { kind: "project", repo: drag.repo, title: label }, onToggle) : undefined}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-4">{label}</span>
        {count !== undefined && (
          <span className={cn("pr-1.5 text-[11px] tabular-nums text-muted-foreground/70 group-hover:hidden", menuOpen && "hidden")}>{count}</span>
        )}
        {/* 올렸을 때만 자리를 차지한다 (안 보일 때도 자리를 잡으면 개수가 가운데로 밀린다) */}
        <span
          className={cn("hidden items-center gap-0.5 group-hover:flex", menuOpen && "flex")}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
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
      {!collapsed && <div className="flex flex-col gap-1.5 pt-0.5 pl-3">{children}</div>}
    </div>
  );
}

/** 워크스페이스의 세션 (배치에 든 순서) */
function useWorkspaceSessions(ws: WorkspaceId): SessionInfo[] {
  return useApp(useShallow((s: AppState) => sessionsOf(s.layouts[ws]).flatMap((id) => (s.sessions[id] ? [s.sessions[id]] : []))));
}

/** 저장소 안 워크트리를 부모 → 자식으로 늘어놓는다 (`worktreeForest`) */
function WorktreeTree({ list, collapsed, onToggle }: { list: WorktreeInfo[]; collapsed: Set<string>; onToggle: (key: string) => void }) {
  const { roots, kids } = worktreeForest(list);
  return (
    <>
      {roots.map((w) => (
        <WorktreeBranch key={w.path} w={w} kids={kids} collapsed={collapsed} onToggle={onToggle} />
      ))}
    </>
  );
}

function WorktreeBranch({ w, kids, collapsed, onToggle }: { w: WorktreeInfo; kids: Map<string, WorktreeInfo[]>; collapsed: Set<string>; onToggle: (key: string) => void }) {
  const mine = kids.get(w.path) ?? [];
  const key = lineageKey(w.path);
  const open = !collapsed.has(key);
  return (
    <>
      <WorktreeCard w={w} />
      {mine.length > 0 && <LineageToggle paths={descendantsOf(w.path, kids).map((d) => d.path)} count={mine.length} open={open} onToggle={() => onToggle(key)} />}
      {mine.length > 0 && open && (
        // 하위 워크트리는 부모 밑에 세로 안내선과 함께 들여 그린다
        <div className="ml-3.5 flex flex-col gap-1.5 border-l border-sidebar-border pl-0.5">
          {mine.map((c) => (
            <WorktreeBranch key={c.path} w={c} kids={kids} collapsed={collapsed} onToggle={onToggle} />
          ))}
        </div>
      )}
    </>
  );
}

/** 부모 카드 밑 "⑂ 3개 하위 · 상태별 개수 ▾" 단추. 접어도 하위 워크트리의 에이전트 상태가 보인다 */
function LineageToggle({ paths, count, open, onToggle }: { paths: string[]; count: number; open: boolean; onToggle: () => void }) {
  const statuses = useApp(
    useShallow((s: AppState) => paths.map((p) => statusOf(sessionsOf(s.layouts[p]).flatMap((id) => (s.sessions[id] ? [s.sessions[id]] : []))))),
  );
  const counts = lineageCounts(statuses);
  return (
    <div className="mb-0.5 ml-6 flex">
      <button
        className="flex h-5 items-center gap-1 rounded-md border border-sidebar-border px-1.5 text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        title={open ? "하위 워크트리 접기" : "하위 워크트리 펴기"}
        onClick={onToggle}
      >
        <GitForkIcon className="size-2.5" />
        <span className="tabular-nums">{count}</span>
        <span>개 하위</span>
        {counts.length > 0 && (
          <span className="flex items-center gap-1 border-l border-sidebar-border pl-1">
            {counts.map(([st, n]) => (
              <span key={st} className="flex items-center gap-0.5 tabular-nums">
                <StatusIndicator status={st} className="size-2.5" />
                {n}
              </span>
            ))}
          </span>
        )}
        <CaretDownIcon className={cn("size-2.5 transition-transform", !open && "-rotate-90")} />
      </button>
    </div>
  );
}

function WorktreeCard({ w }: { w: WorktreeInfo }) {
  const model = useModel();
  const remote = !!model.services.host.isRemote;
  const [renaming, setRenaming] = useState(false);
  const title = worktreeTitle(w);
  const siblings = useApp(useShallow((s: AppState) => s.worktrees.filter((x) => x.repo === w.repo && x.path !== w.path)));
  // 부모로 삼을 수 있는 워크트리: 같은 저장소에서 자기와 자기 밑의 워크트리를 뺀 것
  const below = new Set<string>();
  const grow = (p: string) => siblings.filter((x) => x.parent === p && !below.has(x.path)).forEach((x) => (below.add(x.path), grow(x.path)));
  grow(w.path);
  const parentChoices = siblings.filter((x) => !below.has(x.path) && x.path !== w.parent);
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
        <ContextMenuItem onSelect={() => model.setDialog({ kind: "new-worktree", repo: w.repo, parent: w.path })}>하위 워크트리 만들기…</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={parentChoices.length === 0}>부모 정하기</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            {parentChoices.map((p) => (
              <ContextMenuItem key={p.path} onSelect={() => void model.setWorktreeParent(w, p.path)}>
                <span className="truncate">{worktreeTitle(p)}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled={!w.parent} onSelect={() => void model.setWorktreeParent(w, null)}>
          부모에서 떼기
        </ContextMenuItem>
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
        {!remote && <ContextMenuItem onSelect={() => void model.services.host.reveal(w.path).catch(model.fail)}>Finder에서 보기</ContextMenuItem>}
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
  const active = useApp((s) => s.active === ws && s.activeHost === model.hostKey);
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
        {/* overflow-hidden 을 두지 않는다: 에이전트 줄은 왼쪽으로 내밀어 그려 상태 아이콘이 반쪽으로 잘린다. 줄임은 줄마다 truncate 가 한다 */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
      <StatusIndicator status={agentStatus(agent)} className="size-2.5" />
      <AgentIcon kind={agent.kind} className="size-[13px]" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground/90">{lead}</span>
        {trail && <span className="text-muted-foreground/60"> - {trail}</span>}
      </span>
      {agent.model && <span className="max-w-20 shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">{agent.model}</span>}
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{ago(when, now)}</span>
    </div>
  );
}
