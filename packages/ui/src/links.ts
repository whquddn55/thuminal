// 터미널 화면 글자에서 링크(URL, 파일 경로)를 찾는다.
//
// OSC 8 로 주소가 붙은 링크는 엔진에서 바로 읽는다 (claude 는 FORCE_HYPERLINK 로 URL 에 붙인다). 여기는 주소가 없는 글자용이다.
// - 자동 줄바꿈으로 이어진 줄은 한 줄로 잇는다.
// - claude 처럼 프로그램이 스스로 줄을 잘라 그리는 긴 경로·URL 은 터미널이 이어진 줄로 모른다. 줄 끝까지 닿은 글자는
//   다음 줄 앞 글자(들여쓰기를 뗀)를 이어 붙인 후보도 만든다. 파일은 실제로 있는지 확인해 맞는 쪽을 고른다.

import type { CellPoint, CellRange, LineText } from "@thuminal/term-core";

export type LinkTarget = { kind: "url"; url: string } | { kind: "path"; path: string; line?: number; col?: number };

export interface FoundLink {
  target: LinkTarget;
  /** 화면에서 이 링크가 차지한 칸 (밑줄) */
  ranges: CellRange[];
  /** 찾은 글자 그대로 */
  text: string;
}

/** 이 칸 수 안에 줄 끝이 닿으면 프로그램이 줄을 잘랐을 수 있다고 본다 */
const EDGE = 4;

const URL_RE = /\b(?:https?|file):\/\/[^\s<>"'`]+/g;
// 슬래시가 든 경로: ~/ / ./ ../ 로 시작하거나 이름/ 로 시작. 끝에 :줄:열
const PATH_RE = /(?:~\/|\.{1,2}\/|\/|[\p{L}\p{N}_.@+-]+\/)[\p{L}\p{N}_.@~+%=,#-]*(?:\/[\p{L}\p{N}_.@~+%=,#-]*)*(?::\d+){0,2}/gu;
// 슬래시 없는 파일 이름: 확장자가 있어야 한다
const FILE_RE = /(?<![\p{L}\p{N}_./-])[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+){0,2}(?![\p{L}\p{N}_/])/gu;
const NAMED_FILES = /(?<![\p{L}\p{N}_./-])(?:Makefile|Dockerfile|README|LICENSE|CHANGELOG|Justfile|Procfile)(?::\d+){0,2}(?![\p{L}\p{N}_./])/gu;

interface Mapped {
  text: string;
  /** 글자마다 [줄, 칸] */
  at: [number, number][];
}

function push(m: Mapped, line: LineText, y: number, from = 0) {
  for (let i = from; i < line.text.length; i++) {
    m.text += line.text[i];
    m.at.push([y, line.cols[i]]);
  }
}

/** 자동 줄바꿈으로 이어진 줄들을 하나로 (y 가 든 것) */
function softLine(getLine: (y: number) => LineText | null, rows: number, y: number): { m: Mapped; first: number; last: number } {
  let first = y;
  while (first > 0 && getLine(first - 1)?.wrapped) first--;
  let last = y;
  while (last < rows - 1 && getLine(last)?.wrapped) last++;
  const m: Mapped = { text: "", at: [] };
  for (let r = first; r <= last; r++) {
    const l = getLine(r);
    if (l) push(m, l, r);
  }
  return { m, first, last };
}

const lastInk = (l: LineText) => {
  const t = l.text.trimEnd();
  return t.length ? l.cols[t.length - 1] : -1;
};

/** 줄 끝(오른쪽 가장자리 근처)까지 글자가 찼다 */
const reachesEdge = (l: LineText | null, cols: number) => !!l && !l.wrapped && lastInk(l) >= cols - EDGE;

/** 앞뒤 따옴표·괄호·문장부호를 떼어 낸다 */
function trimToken(s: string, start: number): [string, number] {
  let a = 0;
  let b = s.length;
  while (a < b && `("'\`[{<`.includes(s[a])) a++;
  while (b > a) {
    const c = s[b - 1];
    if (`.,;!?'"\`>`.includes(c)) b--;
    else if (c === ")" && !s.slice(a, b - 1).includes("(")) b--;
    else if (c === "]" && !s.slice(a, b - 1).includes("[")) b--;
    else if (c === "}" && !s.slice(a, b - 1).includes("{")) b--;
    else if (c === ":" ) b--;
    else break;
  }
  return [s.slice(a, b), start + a];
}

/** `경로:줄:열`, `경로#L12C3` 을 나눈다 */
export function splitLine(raw: string): { path: string; line?: number; col?: number } {
  const hash = /^(.*)#L(\d+)(?:C(\d+))?$/.exec(raw);
  if (hash) return { path: hash[1], line: Number(hash[2]) || undefined, col: Number(hash[3]) || undefined };
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(raw)!;
  return { path: m[1], line: m[2] ? Number(m[2]) || undefined : undefined, col: m[3] ? Number(m[3]) || undefined : undefined };
}

/** OSC 8 주소를 링크로. http(s) 는 URL, file:// 은 경로 */
export function parseHyperlink(uri: string): LinkTarget | null {
  if (/^https?:\/\//i.test(uri)) return { kind: "url", url: uri };
  if (/^file:\/\//i.test(uri)) {
    try {
      const u = new URL(uri);
      const path = decodeURIComponent(u.pathname);
      const h = /^#L(\d+)(?:C(\d+))?$/.exec(u.hash);
      return { kind: "path", path, line: h ? Number(h[1]) : undefined, col: h?.[2] ? Number(h[2]) : undefined };
    } catch {
      return null;
    }
  }
  return null;
}

interface Span {
  start: number;
  end: number;
  text: string;
  url: boolean;
}

function spans(text: string): Span[] {
  const out: Span[] = [];
  const take = (re: RegExp, url: boolean) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const [t, s] = trimToken(m[0], m.index);
      if (t.length < 2) continue;
      const end = s + t.length;
      if (out.some((o) => s < o.end && end > o.start)) continue;
      out.push({ start: s, end, text: t, url });
    }
  };
  take(URL_RE, true);
  take(PATH_RE, false);
  take(FILE_RE, false);
  take(NAMED_FILES, false);
  return out;
}

function toTarget(s: Span): LinkTarget | null {
  if (s.url) return parseHyperlink(s.text) ?? { kind: "url", url: s.text };
  const p = splitLine(s.text);
  // 숫자만, 버전 번호(1.2.3) 처럼 보이는 것은 뺀다
  if (!p.path || /^[\d.]+$/.test(p.path)) return null;
  return { kind: "path", ...p };
}

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

function rangesOf(m: Mapped, start: number, end: number): CellRange[] {
  const out: CellRange[] = [];
  for (let i = start; i < end; i++) {
    const [y, x] = m.at[i];
    // 넓은 글자(한글 등)는 두 칸이다
    const w = WIDE.test(m.text[i]) ? 2 : 1;
    const last = out[out.length - 1];
    if (last && last.y === y && x <= last.x1) last.x1 = Math.max(last.x1, x + w);
    else out.push({ y, x0: x, x1: x + w });
  }
  return out;
}

/** 그 칸이 든 글자 자리 */
function indexAt(m: Mapped, at: CellPoint): number {
  let best = -1;
  for (let i = 0; i < m.at.length; i++) {
    const [y, x] = m.at[i];
    if (y === at.y && x <= at.x) best = i;
    if (y > at.y) break;
  }
  return best;
}

/**
 * 그 칸에서 글자로 보이는 링크 후보. 앞의 것부터 시도한다.
 * 줄 끝에서 잘린 것 같으면 다음 줄(또는 앞 줄)을 이어 붙인 후보가 먼저 온다
 */
export function linkCandidatesAt(getLine: (y: number) => LineText | null, rows: number, cols: number, at: CellPoint): FoundLink[] {
  const base = softLine(getLine, rows, at.y);
  const found = (m: Mapped): FoundLink | null => {
    const i = indexAt(m, at);
    if (i < 0 || /\s/.test(m.text[i] ?? " ")) return null;
    const s = spans(m.text).find((sp) => i >= sp.start && i < sp.end);
    if (!s) return null;
    const target = toTarget(s);
    return target ? { target, ranges: rangesOf(m, s.start, s.end), text: s.text } : null;
  };
  const plain = found(base.m);
  const out: FoundLink[] = [];

  // 프로그램이 자른 줄 잇기: 링크가 줄 끝에 닿았으면 다음 줄, 줄 앞에서 시작하면 앞 줄
  const joined: Mapped = { text: "", at: [] };
  const prev = base.first > 0 ? getLine(base.first - 1) : null;
  const lastLine = getLine(base.last);
  const next = base.last < rows - 1 ? getLine(base.last + 1) : null;
  const touchesEnd = !!plain && plain.ranges[plain.ranges.length - 1].y === base.last && lastLine && plain.ranges[plain.ranges.length - 1].x1 - 1 >= lastInk(lastLine);
  const touchesStart = !!plain && plain.ranges[0].y === base.first && base.m.text.slice(0, indexAt(base.m, { y: plain.ranges[0].y, x: plain.ranges[0].x0 })).trim() === "";
  let usedJoin = false;
  if ((touchesStart || !plain) && prev && reachesEdge(prev, cols)) {
    const t = prev.text.trimEnd();
    const word = t.length - (/\S+$/.exec(t)?.[0].length ?? 0);
    push(joined, { text: t, cols: prev.cols, wrapped: false }, base.first - 1, word);
    usedJoin = true;
  }
  // 이어 붙일 때는 이 줄의 들여쓰기를 뗀다
  const lead = usedJoin ? (/^\s*/.exec(base.m.text)?.[0].length ?? 0) : 0;
  for (let i = lead; i < base.m.text.length; i++) {
    joined.text += base.m.text[i];
    joined.at.push(base.m.at[i]);
  }
  if ((touchesEnd || !plain) && next && lastLine && reachesEdge(lastLine, cols)) {
    while (joined.text.endsWith(" ")) {
      joined.text = joined.text.slice(0, -1);
      joined.at.pop();
    }
    const nt = next.text;
    const nlead = /^\s*/.exec(nt)?.[0].length ?? 0;
    push(joined, next, base.last + 1, nlead);
    usedJoin = true;
  }
  if (usedJoin) {
    const j = found(joined);
    if (j && (!plain || j.text !== plain.text)) out.push(j);
  }
  if (plain) out.push(plain);
  return out;
}
