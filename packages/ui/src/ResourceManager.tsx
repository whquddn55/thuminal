// 리소스 관리자 (Orca 와 같다 + 세션 펼치기). 사이드바 맨 아래 [리소스] 단추가 연다.
//
// - 위: LISTEN 포트. 워크트리별로 묶고, 밖 포트는 접히는 구역에 둔다. 포트마다 [브라우저로 열기] · [주소 복사] · [프로세스 멈추기].
//   멈추기는 데몬이 다시 읽어 아직 LISTEN 이고 워크트리 · 세션 것일 때만 그 pid 하나에 SIGTERM 을 보낸다. 끝나면 바로, 0.5초 뒤 다시 읽는다.
// - 아래: 저장소 → 워크트리 → 세션 트리에 CPU · 메모리(RSS). 이름 · CPU · 메모리로 정렬한다 (기본 메모리 내림차순).
//   세션을 펼치면 그 밑 프로세스(pid · 명령 · CPU · 메모리 · 연 포트)가 나온다. 세션을 누르면 그 칸으로 간다.
//   [세션 끝내기] 는 탭에 묶였거나 에이전트가 떠 있으면 묻는다.
// - 열려 있는 동안 2초마다 다시 읽는다.

import {
  CaretDownIcon,
  CaretRightIcon,
  CopyIcon,
  GaugeIcon,
  GlobeIcon,
  PlugIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  StopCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import type { ListenPort, ProcessInfo, SessionInfo, SessionProcesses } from "@thuminal/term-core";

import { AgentIcon } from "./agent-icons";
import { AGENTS } from "./agents";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { paneOfSession } from "./layout";
import { cn } from "./lib/utils";
import { copyPort, openPort, portAddress } from "./ports-ui";
import { BACKGROUND_POLL_MS, formatBytes, formatCpu, OPEN_POLL_MS, processesOf, programName, useProcesses, VIA_LABEL } from "./processes";
import { ModelContext, TEAM_LEADER_LABEL, TEAM_NAME_LABEL, useApp, useModel, worktreeTitle } from "./store";

/** 사이드바 맨 아래 줄 단추: 메모리 합계 · 세션 수. 누르면 리소스 관리자 */
export function ResourceButton() {
  const model = useModel();
  const [open, setOpen] = useState(false);
  const { report, supported } = useProcesses(model.services.host, BACKGROUND_POLL_MS);
  const total = report ? report.sessions.reduce((n, s) => n + s.rss, report.daemon.rss) : 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums">
              <GaugeIcon className="size-4" />
              {supported && report ? (
                <span>
                  {formatBytes(total)} · {report.sessions.length}개 세션
                </span>
              ) : (
                <span>리소스</span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>리소스 관리자</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        // 높이를 고정한다: 아래에 붙어 위로 자라므로, 세션을 펼칠 때마다 크기가 바뀌면 누르려던 줄이 밀린다
        className="flex h-[min(80vh,46rem)] w-[34rem] flex-col p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // 터미널이 키보드를 가져가도(붙기 · 새 출력) 닫지 않는다. 바깥을 누르거나 Esc 로 닫는다
        onFocusOutside={(e) => e.preventDefault()}
      >
        {open && <ResourceHosts onClose={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

/** 원격 컴퓨터가 붙어 있으면 위에 컴퓨터 고르기를 둔다 */
function ResourceHosts({ onClose }: { onClose: () => void }) {
  const root = useModel().root;
  const hosts = useApp((s) => s.remoteHosts).filter((h) => h.state === "connected");
  const [picked, setPicked] = useState("");
  const model = (picked && root.hostModel(picked)) || root;
  return (
    <>
      {hosts.length > 0 && (
        <div className="flex shrink-0 gap-1 border-b px-3 pt-2 pb-1.5">
          {[{ id: "", name: "이 컴퓨터" }, ...hosts].map((h) => (
            <button
              key={h.id}
              className={cn("rounded px-2 py-0.5 text-xs", model.hostKey === h.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}
              onClick={() => setPicked(h.id)}
            >
              {h.name}
            </button>
          ))}
        </div>
      )}
      <ModelContext.Provider value={model}>
        <ResourceManager key={model.hostKey} onClose={onClose} />
      </ModelContext.Provider>
    </>
  );
}

type SortKey = "name" | "cpu" | "mem";

interface Node {
  key: string;
  name: string;
  title?: string;
  cpu: number;
  rss: number;
}

interface SessionNode extends Node {
  sp: SessionProcesses;
  info: SessionInfo | undefined;
  agent: string | null;
}

interface WorktreeNode extends Node {
  sessions: SessionNode[];
}

interface RepoNode extends Node {
  worktrees: WorktreeNode[];
}

const AGENT_CMDS = new Set(AGENTS.map((a) => a.cmd));

/** 세션 밑에 떠 있는 에이전트: 훅이 알린 것, 없으면 프로세스 이름으로 */
function agentOf(info: SessionInfo | undefined, procs: ProcessInfo[]): string | null {
  if (info?.agent) return info.agent.kind;
  for (const p of procs) {
    const parts = p.command.split(/\s+/);
    const names = [programName(p.command), ...(/^(node|bun|deno)$/.test(programName(p.command)) ? [parts.find((t, i) => i > 0 && !t.startsWith("-"))?.split("/").pop() ?? ""] : [])];
    const hit = names.find((n) => AGENT_CMDS.has(n.replace(/\.(m?js|cjs)$/, "")));
    if (hit) return hit.replace(/\.(m?js|cjs)$/, "");
  }
  return null;
}

function sortNodes<T extends Node>(list: T[], key: SortKey, desc: boolean): T[] {
  const sign = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    const d = key === "name" ? a.name.localeCompare(b.name) : key === "cpu" ? a.cpu - b.cpu : a.rss - b.rss;
    return sign * d || a.name.localeCompare(b.name);
  });
}

function ResourceManager({ onClose }: { onClose: () => void }) {
  const model = useModel();
  const host = model.services.host;
  const { report, supported, error } = useProcesses(host, OPEN_POLL_MS);
  const repos = useApp((s) => s.repos);
  const worktrees = useApp((s) => s.worktrees);
  const sessions = useApp((s) => s.sessions);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "mem", desc: true });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<SessionNode | null>(null);

  const tree = useMemo(() => {
    if (!report) return [];
    const repoOf = new Map(repos.map((r) => [r.id, r]));
    const wtOf = new Map(worktrees.map((w) => [w.path, w]));
    const byRepo = new Map<string, RepoNode>();
    for (const sp of report.sessions) {
      const info = sessions[sp.session];
      const wtPath = info?.labels.worktree;
      const wt = wtPath ? wtOf.get(wtPath) : undefined;
      const repo = wt ? repoOf.get(wt.repo) : undefined;
      const repoKey = repo?.id ?? "@other";
      let r = byRepo.get(repoKey);
      if (!r) byRepo.set(repoKey, (r = { key: repoKey, name: repo?.name ?? "기타", title: repo?.path ?? "워크트리 밖 · 플로팅 터미널", cpu: 0, rss: 0, worktrees: [] }));
      const wKey = wt?.path ?? wtPath ?? "@other";
      let w = r.worktrees.find((x) => x.key === wKey);
      if (!w) r.worktrees.push((w = { key: wKey, name: wt ? worktreeTitle(wt) : wtPath ? (wtPath.split("/").pop() ?? wtPath) : "워크트리 밖", title: wtPath, cpu: 0, rss: 0, sessions: [] }));
      const team = info?.labels[TEAM_NAME_LABEL];
      const name = `${team ? `${team} · ` : ""}${info?.title || `세션 ${sp.session}`}`;
      w.sessions.push({ key: String(sp.session), name, cpu: sp.cpu, rss: sp.rss, sp, info, agent: agentOf(info, sp.processes) });
      w.cpu += sp.cpu;
      w.rss += sp.rss;
      r.cpu += sp.cpu;
      r.rss += sp.rss;
    }
    const { key, desc } = sort;
    return sortNodes([...byRepo.values()], key, desc).map((r) => ({
      ...r,
      worktrees: sortNodes(r.worktrees, key, desc).map((w) => ({ ...w, sessions: sortNodes(w.sessions, key, desc) })),
    }));
  }, [report, repos, worktrees, sessions, sort]);

  if (supported === false) {
    return <p className="p-4 text-xs text-muted-foreground">이 데몬은 리소스 읽기를 지원하지 않아요. 데몬을 다시 시작하면 볼 수 있어요.</p>;
  }
  if (!report) return <p className="p-4 text-xs text-muted-foreground">{error ?? "읽는 중…"}</p>;

  const total = report.sessions.reduce((n, s) => n + s.rss, report.daemon.rss);
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));
  const reveal = (n: SessionNode) => {
    const leader = Number(n.info?.labels[TEAM_LEADER_LABEL]);
    const target = paneOfSession(Object.values(model.get().layouts), n.sp.session) ? n.sp.session : leader || n.sp.session;
    model.revealSession(target);
    onClose();
  };
  const inTab = (n: SessionNode) => !!paneOfSession(Object.values(model.get().layouts), n.sp.session);
  /** 칸에 든 세션은 칸을 닫고(그 세션이 끝난다), 칸 밖 세션(팀원 등)은 지운다. 프로세스가 끝나는 데 틈이 있어 조금 뒤 한 번 더 읽는다 */
  const end = (n: SessionNode) => {
    const id = n.sp.session;
    const done = inTab(n) ? model.op({ op: "close_pane", target: { by: "session", value: id } }) : host.remove(id);
    const poller = processesOf(host);
    void done.then(() => {
      void poller.refresh();
      setTimeout(() => void poller.refresh(), 700);
    }, model.fail);
  };
  const kill = (n: SessionNode) => (inTab(n) || n.agent ? setConfirm(n) : end(n));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-baseline gap-2 border-b px-3 py-2">
        <span className="text-sm font-semibold">리소스 관리자</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatBytes(total)} · 터미널 세션 {report.sessions.length}개
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto thm-scroll">
        <PortsSection ports={report.ports} error={report.ports_error} truncated={report.ports_truncated} />
        <div className="sticky top-0 z-[1] flex h-7 items-center gap-1 border-y bg-popover px-3 text-2xs text-muted-foreground">
          <SortButton label="이름" k="name" sort={sort} onClick={toggleSort} className="flex-1 justify-start" />
          <SortButton label="CPU" k="cpu" sort={sort} onClick={toggleSort} className="w-14 justify-end" />
          <SortButton label="메모리" k="mem" sort={sort} onClick={toggleSort} className="w-[4.5rem] justify-end" />
          <span className="w-6" />
        </div>
        <div className="px-1.5 py-1">
          {tree.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">실행 중인 터미널 세션이 없어요</p>}
          {tree.map((r) => (
            <div key={r.key} className="pb-1">
              <Row depth={0} name={r.name} title={r.title} cpu={r.cpu} rss={r.rss} className="font-semibold" />
              {r.worktrees.map((w) => (
                <div key={w.key}>
                  <Row depth={1} name={w.name} title={w.title} cpu={w.cpu} rss={w.rss} />
                  {w.sessions.map((n) => (
                    <SessionRow
                      key={n.key}
                      n={n}
                      expanded={open.has(n.sp.session)}
                      onToggle={() =>
                        setOpen((o) => {
                          const next = new Set(o);
                          if (!next.delete(n.sp.session)) next.add(n.sp.session);
                          return next;
                        })
                      }
                      onReveal={() => reveal(n)}
                      onKill={() => kill(n)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}
          <Row depth={0} name="thuminal 데몬" title={`pid ${report.daemon.pid}`} cpu={report.daemon.cpu} rss={report.daemon.rss} className="text-muted-foreground" />
        </div>
      </div>
      {confirm && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-6" onClick={() => setConfirm(null)}>
          <div className="w-80 rounded-lg border bg-popover p-4 shadow-lg" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold">‘{confirm.name}’ 세션을 끝낼까요?</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {confirm.agent ? `${confirm.agent}가 실행 중이에요. ` : ""}이 터미널을 강제로 끝내요. 칸에서 저장하지 않은 작업은 사라져요.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirm(null)}>
                그만두기
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  end(confirm);
                  setConfirm(null);
                }}
              >
                끝내기
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SortButton({ label, k, sort, onClick, className }: { label: string; k: SortKey; sort: { key: SortKey; desc: boolean }; onClick: (k: SortKey) => void; className?: string }) {
  const on = sort.key === k;
  const Icon = sort.desc ? SortDescendingIcon : SortAscendingIcon;
  return (
    <button className={cn("flex items-center gap-0.5 hover:text-foreground", on && "text-foreground", className)} onClick={() => onClick(k)}>
      {label}
      {on && <Icon className="size-3" />}
    </button>
  );
}

function Row({ depth, name, title, cpu, rss, className }: { depth: number; name: string; title?: string; cpu: number; rss: number; className?: string }) {
  return (
    <div className={cn("flex h-6 items-center gap-1 rounded px-1.5 text-xs", className)} title={title}>
      <span className="min-w-0 flex-1 truncate" style={{ paddingLeft: depth * 12 }}>
        {name}
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums">{formatCpu(cpu)}</span>
      <span className="w-[4.5rem] shrink-0 text-right tabular-nums">{formatBytes(rss)}</span>
      <span className="w-6 shrink-0" />
    </div>
  );
}

function SessionRow({ n, expanded, onToggle, onReveal, onKill }: { n: SessionNode; expanded: boolean; onToggle: () => void; onReveal: () => void; onKill: () => void }) {
  const ports = n.sp.processes.flatMap((p) => p.ports);
  return (
    <>
      <div className="group flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-xs hover:bg-accent" onClick={onReveal} title={`s${n.sp.session} · 셸 pid ${n.sp.pid}\n누르면 그 칸으로 가요`}>
        <span className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: 18 }}>
          <button
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10"
            title={expanded ? "프로세스 접기" : "프로세스 펼치기"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {expanded ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />}
          </button>
          {n.agent && <AgentIcon kind={n.agent} className="size-3 shrink-0" />}
          <span className="min-w-0 truncate">{n.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">s{n.sp.session}</span>
          {ports.length > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground">
              <PlugIcon className="size-2.5" />
              {ports.length === 1 ? `:${ports[0]}` : ports.length}
            </span>
          )}
        </span>
        <span className="w-14 shrink-0 text-right tabular-nums">{formatCpu(n.cpu)}</span>
        <span className="w-[4.5rem] shrink-0 text-right tabular-nums">{formatBytes(n.rss)}</span>
        <span className="flex w-6 shrink-0 justify-end">
          <button
            className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive"
            title="세션 끝내기"
            onClick={(e) => {
              e.stopPropagation();
              onKill();
            }}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      </div>
      {expanded && (
        <div className="mb-1">
          {n.sp.processes.map((p) => (
            <div key={p.pid} className="flex h-5 items-center gap-1 px-1.5 text-[11px] text-muted-foreground" title={p.command}>
              <span className="flex min-w-0 flex-1 items-center gap-1.5" style={{ paddingLeft: 40 + p.depth * 10 }}>
                <span className="w-12 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{p.pid}</span>
                <span className="min-w-0 truncate font-mono text-[10.5px]">{p.command}</span>
                {p.ports.map((port) => (
                  <span key={port} className="shrink-0 rounded bg-foreground/10 px-1 font-mono text-[10px]">
                    :{port}
                  </span>
                ))}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{formatCpu(p.cpu)}</span>
              <span className="w-[4.5rem] shrink-0 text-right tabular-nums">{formatBytes(p.rss)}</span>
              <span className="w-6 shrink-0" />
            </div>
          ))}
          {n.sp.truncated && <div className="px-1.5 pl-12 text-[11px] text-muted-foreground/70">… 프로세스가 많아 앞부분만 보여요</div>}
        </div>
      )}
    </>
  );
}

function PortsSection({ ports, error, truncated }: { ports: ListenPort[]; error: string | null; truncated: boolean }) {
  const worktrees = useApp((s) => s.worktrees);
  const [showExternal, setShowExternal] = useState(false);
  const mine = ports.filter((p) => p.via !== "external");
  const external = ports.filter((p) => p.via === "external");
  const groups = new Map<string, ListenPort[]>();
  for (const p of mine) {
    const k = p.worktree ?? "";
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const titleOf = (path: string) => {
    if (!path) return "워크트리 밖 세션";
    const w = worktrees.find((x) => x.path === path);
    return w ? worktreeTitle(w) : (path.split("/").pop() ?? path);
  };
  return (
    <div className="px-1.5 pt-2 pb-2">
      <div className="flex items-baseline gap-2 px-1.5 pb-1">
        <span className="text-xs font-semibold">포트</span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          워크트리 포트 {mine.length}개 · 밖 {external.length}개
        </span>
      </div>
      {error && <p className="px-1.5 py-1 text-xs text-muted-foreground">{error}</p>}
      {!error && mine.length === 0 && <p className="px-1.5 py-1 text-xs text-muted-foreground">워크트리 포트가 없어요</p>}
      {[...groups.entries()].map(([path, list]) => (
        <div key={path} className="pb-1">
          <div className="truncate px-1.5 pt-1 text-2xs text-muted-foreground" title={path || undefined}>
            {titleOf(path)}
          </div>
          {list.map((p) => (
            <PortRow key={`${p.pid}:${p.port}`} p={p} />
          ))}
        </div>
      ))}
      {external.length > 0 && (
        <div className="pt-1">
          <button className="flex h-6 w-full items-center gap-1 rounded px-1.5 text-2xs text-muted-foreground hover:bg-accent/60" onClick={() => setShowExternal((v) => !v)}>
            {showExternal ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />}밖 포트 {external.length}개
          </button>
          {showExternal && external.map((p) => <PortRow key={`${p.pid}:${p.port}`} p={p} />)}
        </div>
      )}
      {truncated && <p className="px-1.5 pt-1 text-2xs text-muted-foreground/70">포트가 많아 앞부분만 보여요</p>}
    </div>
  );
}

function PortRow({ p }: { p: ListenPort }) {
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
    <div className="group flex h-6 items-center gap-1.5 rounded px-1.5 text-xs hover:bg-accent/60" title={`${portAddress(model, p)}\n${p.command}${p.cwd ? `\n폴더: ${p.cwd}` : ""}\n${VIA_LABEL[p.via]}`}>
      <span className="w-14 shrink-0 font-mono tabular-nums">:{p.port}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {p.process}
        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">{p.pid}</span>
        {p.session !== null && <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/70">s{p.session}</span>}
        {(p.via === "cwd" || p.via === "command") && <span className="ml-1.5 text-[10px] text-muted-foreground/70">{p.via === "cwd" ? "폴더" : "명령줄"}</span>}
      </span>
      <PortButton title="브라우저로 열기 (⇧⌘클릭은 시스템 브라우저)" onClick={(e) => openPort(model, p, e.metaKey && e.shiftKey)}>
        <GlobeIcon className="size-3.5" />
      </PortButton>
      <PortButton title="주소 복사" onClick={() => copyPort(model, p)}>
        <CopyIcon className="size-3.5" />
      </PortButton>
      {p.via !== "external" && !isDaemon(p) && (
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

