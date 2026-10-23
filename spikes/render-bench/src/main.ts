// 렌더링 측정 장치.
//
// 시나리오는 BENCH_ARGS (쿼리 문자열) 로 받는다.
// - mode: ghostty | xterm
// - terms: 터미널 수 (기본 20)
// - visible: 화면에 보이는 터미널 수 (1, 4, 20 …). 나머지는 숨긴 채 출력만 받는다
// - rate: 터미널마다 초당 넣을 바이트 (기본 65536)
// - duration: 측정 시간 초 (기본 20)
// - warmup: 측정 전 흘려 보내는 시간 초 (기본 3)

import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { GhosttyPane, GhosttyVt, drawOpts, measureCell } from "./ghostty";
import { GlRenderer } from "./webgl";

const FONT_SIZE = 13;
const FONT_FAMILY = "Menlo, monospace";
const SCROLLBACK = 10_000;
const TICK_MS = 8;

interface Pane {
  write(data: Uint8Array): void;
  /** 쓴 바이트 가운데 엔진이 아직 처리하지 못한 양 */
  backlog(): number;
  frame(): void;
}

function params() {
  return invoke<string>("bench_args").then((raw) => {
    const q = new URLSearchParams(raw || location.search);
    const num = (k: string, d: number) => Number(q.get(k) ?? d);
    return {
      mode: q.get("mode") ?? "ghostty",
      terms: num("terms", 20),
      visible: num("visible", 1),
      rate: num("rate", 65536),
      duration: num("duration", 20),
      warmup: num("warmup", 3),
      noText: q.get("notext") === "1",
      raw,
    };
  });
}

function layout(visible: number): { cols: number; rows: number; hosts: HTMLElement[] } {
  const grid = document.getElementById("grid")!;
  const gc = Math.ceil(Math.sqrt(visible));
  const gr = Math.ceil(visible / gc);
  grid.style.gridTemplateColumns = `repeat(${gc}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${gr}, 1fr)`;
  const hosts: HTMLElement[] = [];
  for (let i = 0; i < visible; i++) {
    const d = document.createElement("div");
    d.className = "pane";
    grid.appendChild(d);
    hosts.push(d);
  }
  const m = measureCell(FONT_SIZE, FONT_FAMILY);
  const r = hosts[0].getBoundingClientRect();
  return { cols: Math.floor(r.width / m.w) - 1, rows: Math.floor(r.height / m.h), hosts };
}

let wasmBytes = () => 0;
/** 모든 터미널의 frame() 뒤에 한 번 부른다 (WebGL 렌더러) */
let afterFrame = () => {};

async function makeGhostty(n: number, cols: number, rows: number, hosts: HTMLElement[], webgl: boolean): Promise<Pane[]> {
  const vt = await GhosttyVt.load();
  wasmBytes = () => vt.ex.memory.buffer.byteLength;
  const m = measureCell(FONT_SIZE, FONT_FAMILY);
  // WebGL 모드: 창 전체를 덮는 canvas 하나에 보이는 터미널을 모두 그린다
  const gl = webgl ? new GlRenderer(document.getElementById("grid")!, m) : null;
  const panes: Pane[] = [];
  for (let i = 0; i < n; i++) {
    const p = new GhosttyPane(vt, cols, rows, m, SCROLLBACK);
    if (gl) {
      if (hosts[i]) gl.add(p, hosts[i]);
    } else {
      p.attach(hosts[i] ?? null);
    }
    panes.push({ write: (d) => p.write(d), backlog: () => 0, frame: gl ? () => {} : () => p.render() });
  }
  if (gl) afterFrame = () => gl.frame();
  return panes;
}

function makeXterm(n: number, cols: number, rows: number, hosts: HTMLElement[]): Pane[] {
  const hidden = document.createElement("div");
  hidden.className = "pane hidden";
  document.body.appendChild(hidden);
  const panes: Pane[] = [];
  let webgl = 0;
  for (let i = 0; i < n; i++) {
    const t = new Terminal({ cols, rows, scrollback: SCROLLBACK, fontSize: FONT_SIZE, fontFamily: FONT_FAMILY });
    const host = hosts[i];
    if (host) {
      t.open(host);
      // WebKit 은 페이지당 WebGL 화면이 16개 안팎이라 보이는 터미널에만 붙이고, 넘치면 DOM 렌더러로 둔다
      if (webgl < 16) {
        t.loadAddon(new WebglAddon());
        webgl++;
      }
    } else {
      const d = document.createElement("div");
      hidden.appendChild(d);
      t.open(d);
    }
    let pending = 0;
    panes.push({
      write: (d) => {
        pending += d.length;
        t.write(d, () => {
          pending -= d.length;
        });
      },
      backlog: () => pending,
      frame: () => {},
    });
  }
  return panes;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const log = (msg: string) => invoke("bench_log", { msg }).catch(() => {});

async function main() {
  const status = document.getElementById("status")!;
  log(`시작 visibility=${document.visibilityState} dpr=${devicePixelRatio} size=${innerWidth}x${innerHeight}`);
  const a = await params();
  drawOpts.noText = a.noText;
  // 창이 가려져 있으면 rAF 가 오지 않아 측정이 안 된다. 보일 때까지 기다린다
  if (document.visibilityState !== "visible") {
    log("창이 안 보여 기다린다");
    await new Promise<void>((r) => {
      const on = () => {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", on);
          r();
        }
      };
      document.addEventListener("visibilitychange", on);
    });
    log("창이 보임");
  }
  const nWork = await invoke<number>("workload_count");
  const workloads: Uint8Array[] = [];
  for (let i = 0; i < nWork; i++) {
    workloads.push(new Uint8Array(await invoke<ArrayBuffer>("load_workload", { index: i })));
  }

  log(`입력 ${workloads.length}개 받음`);
  const { cols, rows, hosts } = layout(Math.min(a.visible, a.terms));
  const panes =
    a.mode === "xterm"
      ? makeXterm(a.terms, cols, rows, hosts)
      : await makeGhostty(a.terms, cols, rows, hosts, a.mode === "ghostty-gl");

  // 터미널마다 다른 위치에서 시작해 같은 출력이 한꺼번에 몰리지 않게 한다
  const sent = panes.map(() => 0);
  const offsets = panes.map((_, i) => Math.floor((workloads[i % nWork].length / panes.length) * i));
  const t0 = performance.now();
  const measureFrom = t0 + a.warmup * 1000;
  const end = measureFrom + a.duration * 1000;

  let bytesIn = 0;
  let maxBacklog = 0;
  const frameGaps: number[] = [];
  let lastFrame = 0;
  let tickWorkMs = 0;

  const feed = () => {
    const now = performance.now();
    const w0 = performance.now();
    const due = ((now - t0) / 1000) * a.rate;
    for (let i = 0; i < panes.length; i++) {
      const want = Math.floor(due) - sent[i];
      if (want <= 0) continue;
      const src = workloads[i % nWork];
      let off = (offsets[i] + sent[i]) % src.length;
      let left = want;
      while (left > 0) {
        const n = Math.min(left, src.length - off);
        panes[i].write(src.subarray(off, off + n));
        left -= n;
        off = 0;
      }
      sent[i] += want;
      if (now >= measureFrom) bytesIn += want;
    }
    if (now >= measureFrom) {
      tickWorkMs += performance.now() - w0;
      maxBacklog = Math.max(maxBacklog, panes.reduce((s, p) => s + p.backlog(), 0));
    }
    if (now < end) setTimeout(feed, TICK_MS);
  };

  const frame = (ts: number) => {
    const w0 = performance.now();
    for (const p of panes) p.frame();
    afterFrame();
    if (ts >= measureFrom) {
      tickWorkMs += performance.now() - w0;
      if (lastFrame) frameGaps.push(ts - lastFrame);
      lastFrame = ts;
    }
    if (ts < end) {
      status.textContent = `${a.mode} · 터미널 ${a.terms} · 보임 ${a.visible} · ${cols}x${rows} · ${Math.max(0, (end - ts) / 1000).toFixed(0)}초 남음`;
      requestAnimationFrame(frame);
    } else {
      finish();
    }
  };

  const finish = async () => {
    // 측정이 끝난 뒤 남은 출력을 다 처리할 때까지 걸린 시간 (xterm 은 비동기로 밀려 있을 수 있다)
    const drain0 = performance.now();
    const finalBacklog = panes.reduce((s, p) => s + p.backlog(), 0);
    while (panes.reduce((s, p) => s + p.backlog(), 0) > 0 && performance.now() - drain0 < 30_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const drainMs = performance.now() - drain0;
    const gaps = [...frameGaps].sort((x, y) => x - y);
    const total = frameGaps.reduce((s, g) => s + g, 0);
    const result = {
      args: a,
      cols,
      rows,
      dpr: window.devicePixelRatio,
      inputMBps: bytesIn / 1_048_576 / a.duration,
      frames: frameGaps.length,
      fps: frameGaps.length / (total / 1000),
      frameP50: pct(gaps, 0.5),
      frameP95: pct(gaps, 0.95),
      frameMax: gaps[gaps.length - 1] ?? 0,
      framesOver50ms: frameGaps.filter((g) => g > 50).length,
      /** 피드와 그리기에 직접 쓴 메인 스레드 시간 비율 (xterm 은 내부 처리 시간이 빠진다) */
      directWorkPct: (tickWorkMs / (a.duration * 1000)) * 100,
      maxBacklogKB: maxBacklog / 1024,
      finalBacklogKB: finalBacklog / 1024,
      drainMs,
      wasmMemoryMB: wasmBytes() / 1_048_576,
    };
    status.textContent = JSON.stringify(result);
    await invoke("bench_done", { result: JSON.stringify(result, null, 2) });
  };

  log(`터미널 ${panes.length}개 만듦 ${cols}x${rows}`);
  let firstFrame = true;
  requestAnimationFrame(() => {
    if (firstFrame) log("첫 rAF");
    firstFrame = false;
  });
  setTimeout(feed, 0);
  requestAnimationFrame(frame);
}

main().catch(async (e) => {
  log(`오류 ${e}`);
  document.getElementById("status")!.textContent = `오류: ${e}`;
  await invoke("bench_done", { result: JSON.stringify({ error: String(e) }) });
});
