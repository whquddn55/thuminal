// 포트 표시와 동작: 사이드바 워크트리 줄에 포트 수(플러그 아이콘), 세션 아이콘(탭 · 칸 머리 · 사이드바 세션 줄)에 마우스를
// 올리거나 우클릭하면 그 세션이 연 포트 팝업.
// 같은 워크트리에서 어느 세션에도 붙지 않은 포트(셸에서 떨어져 나간 서버)도 그 워크트리 세션 팝업에 함께 보인다.
// 포트마다 [브라우저로 열기] · [주소 복사] · [프로세스 멈추기]. 워크트리 밖 포트(밖)는 화면 어디에도 보이지 않는다.

import { CopyIcon, GlobeIcon, PlugIcon, StopCircleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ListenPort, SessionId } from "@thuminal/term-core";

import { Popover, PopoverAnchor, PopoverContent } from "./components/ui/popover";
import { cn } from "./lib/utils";
import { keyLabel, primaryMod } from "./platform";
import { BACKGROUND_POLL_MS, portsOfSessions, portsOfWorktree, portUrl, processesOf, programName, strayPortsOfWorktree, useProcesses } from "./processes";
import { type AppModel, FLOATING_WORKSPACE, OTHER_WORKSPACE, useApp, useModel } from "./store";

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

/**
 * 브라우저로 연다. 아니면 앱 안 브라우저 칸 (그 포트의 워크트리 · 세션 워크스페이스에), system 이면(⇧⌘클릭) 시스템 브라우저.
 * 브라우저 칸에는 데몬 컴퓨터 기준 주소(`localhost`)를 남긴다. 원격 컴퓨터 · 웹 · 폰은 칸이 데몬 대리 주소로 바꿔 연다
 * (daemon `browser_proxy.rs`). 시스템 브라우저도 대리 주소로 열고, 대리를 못 하면 그 컴퓨터 이름으로 바꾼 주소로 연다
 */
export function openPort(model: AppModel, p: ListenPort, system = false) {
  const local = portUrl(p);
  const host = model.services.host;
  if (!system) {
    const s = model.get();
    const ws = (p.session !== null ? model.workspaceOf(p.session) : null) ?? (p.worktree && s.worktrees.some((w) => w.path === p.worktree) ? p.worktree : null);
    if (ws && ws !== FLOATING_WORKSPACE && (s.active !== ws || s.activeHost !== model.hostKey)) model.select(ws);
    void model.newBrowserTab(ws ?? undefined, local).catch(model.fail);
    return;
  }
  void (async () => {
    const view = (host.isRemote ? await host.browserProxyUrl?.(local).catch(() => null) : null) ?? portAddress(model, p);
    if (host.openUrl) await host.openUrl(view);
    else window.open(view, "_blank", "noopener");
  })().catch(model.fail);
}

export function copyPort(model: AppModel, p: ListenPort) {
  void navigator.clipboard.writeText(portAddress(model, p)).catch(() => undefined);
}

/**
 * 세션 아이콘을 감싼다. 그 세션들이 연 포트나 그 워크트리의 세션 밖 포트가 있으면, 아이콘에 마우스를 올리거나(잠깐 머물면)
 * 우클릭하면 포트 팝업을 연다. 포트가 없으면 아이콘만 그린다. `marked` 면 포트가 있을 때 아이콘을 밝게 칠한다 (일반 터미널 아이콘)
 */
export function SessionPorts({ sessions, children, marked }: { sessions: SessionId[]; children: React.ReactNode; marked?: boolean }) {
  const model = useModel();
  const { report } = useProcesses(model.services.host, BACKGROUND_POLL_MS);
  // sessions 는 그릴 때마다 새 배열이라 글로 바꿔 본다
  const key = sessions.join(",");
  const ports = useMemo(() => portsOfSessions(report, key ? key.split(",").map(Number) : []), [report, key]);
  const ws = useApp(() => (sessions[0] === undefined ? null : model.workspaceOf(sessions[0])));
  const stray = useMemo(() => (ws && ws !== FLOATING_WORKSPACE && ws !== OTHER_WORKSPACE ? strayPortsOfWorktree(report, ws) : []), [report, ws]);
  if (!ports.length && !stray.length) return <>{children}</>;
  return (
    <PortsPopover ports={ports} stray={stray} className={cn("inline-flex shrink-0 items-center gap-1", marked && "text-foreground")}>
      {children}
    </PortsPopover>
  );
}

/**
 * 사이드바 워크트리 줄의 포트 표시: 그 워크트리에 열린 포트가 있으면 플러그 아이콘과 수를 보인다 (세션 · 작업 폴더 · 명령줄 어느 근거든).
 * 마우스를 올리거나 누르거나 우클릭하면 포트 팝업. 눌러도 워크트리를 고르지 않는다
 */
export function WorktreePorts({ worktree }: { worktree: string }) {
  const model = useModel();
  const { report } = useProcesses(model.services.host, BACKGROUND_POLL_MS);
  const ports = useMemo(() => portsOfWorktree(report, worktree).sort((a, b) => a.port - b.port), [report, worktree]);
  if (!ports.length) return null;
  return (
    <PortsPopover ports={ports} stray={[]} click className="ml-auto flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[10px] leading-none tabular-nums text-muted-foreground/80 hover:bg-foreground/10 hover:text-foreground">
      <PlugIcon className="size-2.5" />
      {ports.length}
    </PortsPopover>
  );
}

/** 포트 팝업: 감싼 것에 마우스를 올리면(잠깐 머물면) · 우클릭하면 (`click` 이면 누르면도) 연다 */
function PortsPopover({ ports, stray, className, click, children }: { ports: ListenPort[]; stray: ListenPort[]; className?: string; click?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const later = (v: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(v), ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const openNow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.clearTimeout(timer.current);
    setOpen(true);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          className={className}
          onMouseEnter={() => later(true, 300)}
          onMouseLeave={() => later(false, 200)}
          onContextMenu={openNow}
          onClick={click ? openNow : undefined}
          onPointerDown={click ? (e) => e.stopPropagation() : undefined}
        >
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={() => window.clearTimeout(timer.current)}
        onMouseLeave={() => later(false, 200)}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="px-1.5 pt-1 pb-0.5 text-2xs text-muted-foreground">열린 포트 · {keyLabel("⇧⌘")}클릭은 시스템 브라우저</div>
        {ports.map((p) => (
          <PortRow key={`${p.pid}:${p.port}`} p={p} />
        ))}
        {stray.length > 0 && (
          <>
            <div className={cn("px-1.5 pb-0.5 text-2xs text-muted-foreground", ports.length ? "mt-1 border-t pt-1.5" : "pt-0.5")}>이 워크트리 · 세션 밖에서 실행</div>
            {stray.map((p) => (
              <PortRow key={`${p.pid}:${p.port}`} p={p} />
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 포트 한 줄: 포트 · 프로세스 · pid, [브라우저로 열기] · [주소 복사] · [프로세스 멈추기] */
export function PortRow({ p }: { p: ListenPort }) {
  const model = useModel();
  const host = model.services.host;
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    const poller = processesOf(host);
    void host
      .stopProcess(p.pid, p.port)
      .then(
        () => {
          void poller.refresh();
          setTimeout(() => void poller.refresh(), 500);
        },
        (e) => model.fail(e),
      )
      .finally(() => setStopping(false));
  };
  return (
    <div className="group flex h-6 items-center gap-1.5 rounded px-1.5 text-xs hover:bg-accent/60" title={`${portAddress(model, p)}\n${p.command}${p.cwd ? `\n폴더: ${p.cwd}` : ""}`}>
      <span className="w-14 shrink-0 font-mono tabular-nums">:{p.port}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {p.process}
        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">{p.pid}</span>
      </span>
      <PortButton title={`브라우저로 열기 (${keyLabel("⇧⌘")}클릭은 시스템 브라우저)`} onClick={(e) => openPort(model, p, primaryMod(e) && e.shiftKey)}>
        <GlobeIcon className="size-3.5" />
      </PortButton>
      <PortButton title="주소 복사" onClick={() => copyPort(model, p)}>
        <CopyIcon className="size-3.5" />
      </PortButton>
      {!isDaemon(p) && (
        <PortButton title="프로세스 멈추기 (SIGTERM)" onClick={stop} disabled={stopping} danger>
          <StopCircleIcon className="size-3.5" />
        </PortButton>
      )}
    </div>
  );
}

/** thuminal 데몬(개발 데몬 등)은 그 밑 터미널이 모두 끝나므로 멈추지 않는다 (데몬도 거절한다) */
const isDaemon = (p: ListenPort) => p.process === "thuminald" || programName(p.command) === "thuminald";

function PortButton({ title, onClick, disabled, danger, children }: { title: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40",
        danger && "hover:bg-destructive/15 hover:text-destructive",
      )}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
