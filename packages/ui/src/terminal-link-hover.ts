// 터미널 링크: ⌘ 를 누른 채 올리면 밑줄 · 손가락 커서 · 칸 왼쪽 아래 주소를 보이고, ⌘+클릭은 기본 앱, ⌘⇧+클릭은 thuminal 안에서 연다.
//
// 1. 칸에 OSC 8 주소가 붙어 있으면 그것을 쓴다 (claude 는 FORCE_HYPERLINK 로 URL 에 붙인다. 줄이 잘려도 주소가 온전하다).
// 2. 없으면 화면 글자에서 찾는다 (links.ts). 파일은 데몬에 있는지 물어 있는 것만 링크로 본다.

import type { CellPoint, CellRange, LineText, TerminalEngine } from "@thuminal/term-core";

import { type FoundLink, type LinkTarget, linkCandidatesAt, parseHyperlink } from "./links";

/** 열 수 있게 푼 링크 (파일은 절대 경로) */
export type ResolvedLink = { kind: "url"; url: string } | { kind: "path"; path: string; isDir: boolean; line?: number; col?: number };

export interface LinkHandler {
  /** 파일 경로가 있는지 본다 (세션 폴더 · claude 폴더 · 워크트리 기준) */
  resolve(path: string): Promise<{ path: string; isDir: boolean } | null>;
  /** system: 기본 앱(⌘+클릭), app: thuminal 안(⌘⇧+클릭) */
  open(link: ResolvedLink, mode: "system" | "app"): void;
}

interface Hovered {
  at: CellPoint;
  /** 다 풀리면 채운다. 파일이 없으면 null */
  link: Promise<{ link: ResolvedLink; ranges: CellRange[]; label: string } | null>;
  done: { link: ResolvedLink; ranges: CellRange[]; label: string } | null;
  settled: boolean;
}

/** 파일이 있는지 물은 결과를 잠깐 둔다 (마우스를 움직일 때마다 묻지 않게) */
const RESOLVE_TTL_MS = 5000;

export class LinkHover {
  private hovered: Hovered | null = null;
  private tip: HTMLDivElement | null = null;
  private readonly cache = new Map<string, { at: number; value: Promise<{ path: string; isDir: boolean } | null> }>();

  constructor(
    private readonly host: HTMLElement,
    private readonly engine: () => TerminalEngine | null,
    private readonly handler: () => LinkHandler | null,
  ) {}

  /** 마우스 자리(칸)와 ⌘ 상태가 바뀌었다 */
  update(at: CellPoint | null, meta: boolean) {
    if (!meta || !at || !this.handler() || !this.engine()) return this.clear();
    if (this.hovered && this.hovered.at.x === at.x && this.hovered.at.y === at.y) return;
    // 같은 링크 안에서 움직이면 그대로 둔다
    if (this.hovered?.done?.ranges.some((r) => r.y === at.y && at.x >= r.x0 && at.x < r.x1)) return;
    const h: Hovered = { at, link: this.find(at), done: null, settled: false };
    this.hovered = h;
    void h.link.then((found) => {
      h.done = found;
      h.settled = true;
      if (this.hovered !== h) return;
      this.show(found);
    });
  }

  /** ⌘+클릭이면 링크를 연다. 연 링크가 있으면 true (마우스 보고 · 고르기를 하지 않는다) */
  click(at: CellPoint | null, ev: MouseEvent): boolean {
    if (!ev.metaKey || !at || ev.button !== 0) return false;
    const handler = this.handler();
    if (!handler) return false;
    this.update(at, true);
    const h = this.hovered;
    // 링크가 아닌 것으로 끝났으면 보통 클릭으로 둔다
    if (!h || (h.settled && !h.done)) return false;
    const mode = ev.shiftKey ? "app" : "system";
    // 아직 파일 확인 중이면 끝난 뒤 연다
    void h.link.then((found) => found && handler.open(found.link, mode));
    return true;
  }

  clear() {
    this.hovered = null;
    this.show(null);
  }

  dispose() {
    this.clear();
    this.tip?.remove();
    this.tip = null;
  }

  private show(found: { ranges: CellRange[]; label: string } | null) {
    this.engine()?.setLinkHighlight(found?.ranges ?? null);
    this.host.style.cursor = found ? "pointer" : "";
    if (!found) {
      if (this.tip) this.tip.style.display = "none";
      return;
    }
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "thm-link-tip";
      this.host.appendChild(this.tip);
    }
    this.tip.textContent = `${found.label} · ⌘+클릭 기본 앱으로 열기, ⌘⇧+클릭 thuminal에서 열기`;
    this.tip.style.display = "";
  }

  private resolve(path: string) {
    const handler = this.handler()!;
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < RESOLVE_TTL_MS) return hit.value;
    const value = handler.resolve(path).catch(() => null);
    this.cache.set(path, { at: now, value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async find(at: CellPoint): Promise<{ link: ResolvedLink; ranges: CellRange[]; label: string } | null> {
    const engine = this.engine();
    if (!engine) return null;
    // 1. OSC 8
    const uri = engine.hyperlinkAt(at);
    if (uri) {
      const target = parseHyperlink(uri);
      const ranges = this.hyperlinkRanges(engine, at, uri);
      if (target?.kind === "url") return { link: target, ranges, label: target.url };
      if (target?.kind === "path") {
        const r = await this.resolve(target.path);
        return r ? { link: { ...target, path: r.path, isDir: r.isDir }, ranges, label: labelOf(r.path, target) } : null;
      }
    }
    // 2. 화면 글자
    const lines = new Map<number, LineText | null>();
    const getLine = (y: number) => {
      if (!lines.has(y)) lines.set(y, y >= 0 && y < engine.rows ? engine.lineText(y) : null);
      return lines.get(y)!;
    };
    const candidates: FoundLink[] = linkCandidatesAt(getLine, engine.rows, engine.cols, at);
    for (const c of candidates) {
      if (c.target.kind === "url") return { link: c.target, ranges: c.ranges, label: c.target.url };
      const r = await this.resolve(c.target.path);
      if (r) return { link: { ...c.target, path: r.path, isDir: r.isDir }, ranges: c.ranges, label: labelOf(r.path, c.target) };
    }
    return null;
  }

  /** 같은 주소가 붙은 칸들 (그 줄과 위아래 줄) */
  private hyperlinkRanges(engine: TerminalEngine, at: CellPoint, uri: string): CellRange[] {
    const out: CellRange[] = [];
    const rowRanges = (y: number) => {
      const rs: CellRange[] = [];
      for (let x = 0; x < engine.cols; x++) {
        if (engine.hyperlinkAt({ x, y }) !== uri) continue;
        const last = rs[rs.length - 1];
        if (last && last.x1 === x) last.x1 = x + 1;
        else rs.push({ y, x0: x, x1: x + 1 });
      }
      return rs;
    };
    // 링크가 걸친 줄까지만 넓힌다 (위아래로 붙어 있는 동안)
    for (let y = at.y; y >= 0; y--) {
      const rs = rowRanges(y);
      if (!rs.length) break;
      out.unshift(...rs);
      if (at.y - y >= 4) break;
    }
    for (let y = at.y + 1; y < engine.rows && y - at.y <= 4; y++) {
      const rs = rowRanges(y);
      if (!rs.length) break;
      out.push(...rs);
    }
    return out;
  }
}

function labelOf(path: string, t: LinkTarget): string {
  if (t.kind !== "path") return path;
  return `${path}${t.line ? `:${t.line}` : ""}${t.col ? `:${t.col}` : ""}`;
}
