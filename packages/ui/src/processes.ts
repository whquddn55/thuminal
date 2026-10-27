// 세션 프로세스 · 포트 읽기 (리소스 관리자, 탭 포트 표시, 워크트리 카드 포트 수).
//
// 호스트마다 읽는 곳 하나를 두고 보는 곳들이 함께 쓴다. 보는 곳마다 원하는 간격을 알리고, 가장 짧은 간격으로 다시 읽는다
// (탭 · 카드는 30초, 리소스 관리자가 열려 있으면 2초. Orca 와 같다). 창이 보이지 않으면 쉰다.
// 옛 데몬은 모르는 요청을 받으면 연결을 끊는다. 그래서 데몬 부 판이 `PROCESSES_PROTOCOL_MINOR` 이상일 때만 보낸다.

import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { type HostApi, type ListenPort, PROCESSES_PROTOCOL_MINOR, type ProcessReport, type SessionId } from "@thuminal/term-core";

export interface ProcessesState {
  /** 데몬이 이 요청을 아는지. 묻는 중이면 null */
  supported: boolean | null;
  report: ProcessReport | null;
  error: string | null;
  /** 마지막으로 받은 때 (ms) */
  at: number;
}

/** 탭 · 워크트리 카드가 다시 읽는 간격 */
export const BACKGROUND_POLL_MS = 30_000;
/** 리소스 관리자가 열려 있는 동안 다시 읽는 간격 */
export const OPEN_POLL_MS = 2_000;

class Poller {
  readonly store: StoreApi<ProcessesState> = createStore<ProcessesState>(() => ({ supported: null, report: null, error: null, at: 0 }));
  private wants = new Map<symbol, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private checking: Promise<void> | null = null;

  constructor(private host: HostApi) {
    host.onEvent((e) => {
      if (e.type !== "daemon_reconnected") return;
      this.store.setState({ supported: null });
      void this.check().then(() => {
        if (this.wants.size) void this.refresh();
      });
    });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => (this.visible() ? void this.refresh() : this.stop()));
  }

  private visible() {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  private check(): Promise<void> {
    this.checking ??= this.host
      .daemon()
      .then(
        (d) => this.store.setState({ supported: (d.protocol?.[0] ?? 0) >= 1 && (d.protocol?.[1] ?? 0) >= PROCESSES_PROTOCOL_MINOR }),
        () => this.store.setState({ supported: false }),
      )
      .finally(() => (this.checking = null));
    return this.checking;
  }

  /** 이 간격으로 보고 싶다. 돌려준 함수로 그만 본다. 지금보다 짧은 간격이 오면 바로 읽는다 */
  want(ms: number): () => void {
    const key = Symbol();
    const before = this.interval();
    this.wants.set(key, ms);
    if (before === null || ms < before || Date.now() - this.store.getState().at > ms) void this.refresh();
    else this.schedule();
    return () => {
      this.wants.delete(key);
      this.schedule();
    };
  }

  private interval(): number | null {
    return this.wants.size ? Math.min(...this.wants.values()) : null;
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.stop();
    const ms = this.interval();
    if (ms === null || !this.visible() || this.store.getState().supported === false) return;
    this.timer = setTimeout(() => void this.refresh(), ms);
  }

  /** 바로 다시 읽는다 (멈추기 뒤 등). 읽는 중이면 그것을 기다린다 */
  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      if (this.store.getState().supported === null) await this.check();
      if (!this.store.getState().supported) return;
      try {
        const report = await this.host.listProcesses();
        this.store.setState({ report, error: null, at: Date.now() });
      } catch (e) {
        this.store.setState({ error: e instanceof Error ? e.message : String(e) });
      }
    })().finally(() => {
      this.inflight = null;
      this.schedule();
    });
    return this.inflight;
  }
}

const pollers = new WeakMap<HostApi, Poller>();

export function processesOf(host: HostApi): Poller {
  let p = pollers.get(host);
  if (!p) pollers.set(host, (p = new Poller(host)));
  return p;
}

/** 이 호스트의 프로세스 · 포트. `everyMs` 간격으로 다시 읽게 한다 (null 이면 읽은 것만 본다) */
export function useProcesses(host: HostApi, everyMs: number | null): ProcessesState {
  const poller = processesOf(host);
  useEffect(() => (everyMs === null ? undefined : poller.want(everyMs)), [poller, everyMs]);
  return useStore(poller.store);
}

// ---- 보이기 ----

/** 세션들이 연 포트 (포트 번호 차례) */
export function portsOfSessions(report: ProcessReport | null, sessions: SessionId[]): ListenPort[] {
  if (!report) return [];
  return report.ports.filter((p) => p.session !== null && sessions.includes(p.session)).sort((a, b) => a.port - b.port);
}

/** 워크트리에 붙은 포트 (세션 · 폴더 · 명령줄 어느 근거든) */
export function portsOfWorktree(report: ProcessReport | null, worktree: string): ListenPort[] {
  if (!report) return [];
  return report.ports.filter((p) => p.via !== "external" && p.worktree === worktree);
}

const WILDCARD = new Set(["*", "0.0.0.0", "::", "[::]"]);
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/**
 * 포트를 열 주소. `0.0.0.0` · `::` 와 `127.0.0.1` · `[::1]` 은 localhost 로, 443 · 8443 은 https.
 * `remoteHost` 를 주면(원격 컴퓨터의 포트) 모든 주소 · 이 컴퓨터 주소를 그 컴퓨터 이름으로 바꾼다
 */
export function portUrl(p: Pick<ListenPort, "address" | "port">, remoteHost?: string | null): string {
  let host = WILDCARD.has(p.address) || LOOPBACK.has(p.address) ? "localhost" : p.address.includes(":") && !p.address.startsWith("[") ? `[${p.address}]` : p.address;
  if (remoteHost && (WILDCARD.has(p.address) || LOOPBACK.has(p.address))) host = remoteHost.includes(":") && !remoteHost.startsWith("[") ? `[${remoteHost}]` : remoteHost;
  const scheme = p.port === 443 || p.port === 8443 ? "https" : "http";
  return `${scheme}://${host}:${p.port}`;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatCpu(n: number): string {
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
}

export const VIA_LABEL: Record<ListenPort["via"], string> = {
  tree: "세션 프로세스",
  cwd: "작업 폴더가 워크트리 안",
  command: "명령줄에 워크트리 경로",
  external: "워크트리 밖",
};

/** 명령줄에서 실행 파일 이름 (로그인 셸의 `-zsh` 는 `zsh`) */
export function programName(command: string): string {
  const parts = command.trim().split(/\s+/);
  const base = (t: string) => t.split("/").pop() ?? t;
  const first = base(parts[0] ?? "").replace(/^-/, "");
  return first || command;
}
