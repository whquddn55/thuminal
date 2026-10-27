// 포트 표시와 동작: 탭의 포트 표시, 워크트리 카드의 포트 수, 브라우저로 열기 · 주소 복사.
//
// 탭 표시는 탭 줄이 좁아지지 않게 작게 그린다: 포트가 하나면 `:3000`, 둘 이상이면 플러그 아이콘 + 개수.
// 누르면 그 탭 세션들의 포트 목록(포트 · 프로세스 · pid)과 [브라우저로 열기] · [주소 복사] 를 작은 메뉴로 보인다.

import { CopyIcon, GlobeIcon, PlugIcon } from "@phosphor-icons/react";
import { useMemo } from "react";

import type { ListenPort, SessionId } from "@thuminal/term-core";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { BACKGROUND_POLL_MS, portsOfSessions, portsOfWorktree, portUrl, useProcesses } from "./processes";
import { type AppModel, FLOATING_WORKSPACE, useModel } from "./store";

/** 원격 컴퓨터 포트면 그 컴퓨터 이름 (주소에 쓴다). 이 컴퓨터면 null */
export function remoteHostname(model: AppModel): string | null {
  const host = model.services.host;
  if (!host.isRemote) return null;
  if (host.hostId) {
    const h = model.root.get().remoteHosts.find((x) => x.id === host.hostId);
    return h ? h.address.replace(/:\d+$/, "") : null;
  }
  // 웹 화면: 데몬이 뜬 컴퓨터가 이 페이지를 낸 곳이다
  return typeof location !== "undefined" ? location.hostname : null;
}

export function portAddress(model: AppModel, p: ListenPort): string {
  return portUrl(p, remoteHostname(model));
}

/** 브라우저로 연다. system 이면(⇧⌘클릭) 시스템 브라우저, 아니면 앱 안 브라우저 칸 (그 포트의 워크트리 · 세션 워크스페이스에) */
export function openPort(model: AppModel, p: ListenPort, system = false) {
  const url = portAddress(model, p);
  const host = model.services.host;
  if (!system && host.browser) {
    const s = model.get();
    const ws = (p.session !== null ? model.workspaceOf(p.session) : null) ?? (p.worktree && s.worktrees.some((w) => w.path === p.worktree) ? p.worktree : null);
    if (ws && ws !== FLOATING_WORKSPACE && (s.active !== ws || s.activeHost !== model.hostKey)) model.select(ws);
    void model.newBrowserTab(ws ?? undefined, url).catch(model.fail);
  } else if (host.openUrl) void host.openUrl(url).catch(model.fail);
  else window.open(url, "_blank", "noopener");
}

export function copyPort(model: AppModel, p: ListenPort) {
  void navigator.clipboard.writeText(portAddress(model, p)).catch(() => undefined);
}

/** 탭 줄의 포트 표시. 포트가 없으면 그리지 않는다 */
export function TabPorts({ sessions }: { sessions: SessionId[] }) {
  const model = useModel();
  const { report } = useProcesses(model.services.host, BACKGROUND_POLL_MS);
  // sessions 는 그릴 때마다 새 배열이라 글로 바꿔 본다
  const key = sessions.join(",");
  const ports = useMemo(() => portsOfSessions(report, key ? key.split(",").map(Number) : []), [report, key]);
  if (!ports.length) return null;
  const one = ports.length === 1 ? ports[0] : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-4 shrink-0 items-center gap-0.5 rounded bg-foreground/10 px-1 font-mono text-[10px] leading-none tabular-nums text-muted-foreground hover:bg-foreground/15 hover:text-foreground"
          title={ports.map((p) => `:${p.port} ${p.process} (pid ${p.pid})`).join("\n")}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {one ? (
            `:${one.port}`
          ) : (
            <>
              <PlugIcon className="size-2.5" />
              {ports.length}
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">이 탭이 연 포트 · ⇧⌘클릭은 시스템 브라우저</DropdownMenuLabel>
        {ports.map((p) => (
          <PortMenuItem key={`${p.pid}:${p.port}`} p={p} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PortMenuItem({ p }: { p: ListenPort }) {
  const model = useModel();
  return (
    <DropdownMenuItem
      className="group/port gap-1.5 text-xs"
      title={`${portAddress(model, p)}\n${p.command}`}
      onClick={(e) => openPort(model, p, e.metaKey && e.shiftKey)}
    >
      <GlobeIcon className="size-3.5" />
      <span className="w-12 shrink-0 font-mono tabular-nums">:{p.port}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.process}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{p.pid}</span>
      <button
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        title="주소 복사"
        onClick={(e) => {
          e.stopPropagation();
          copyPort(model, p);
        }}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <CopyIcon className="size-3" />
      </button>
    </DropdownMenuItem>
  );
}

/** 워크트리 카드 브랜치 줄 오른쪽의 포트 수 */
export function WorktreePortCount({ worktree }: { worktree: string }) {
  const model = useModel();
  const { report } = useProcesses(model.services.host, BACKGROUND_POLL_MS);
  const ports = useMemo(() => portsOfWorktree(report, worktree), [report, worktree]);
  if (!ports.length) return null;
  return (
    <span
      className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] leading-none tabular-nums text-muted-foreground/80"
      title={ports.map((p) => `:${p.port} ${p.process} (pid ${p.pid})`).join("\n")}
    >
      <PlugIcon className="size-2.5" />
      {ports.length}
    </span>
  );
}
