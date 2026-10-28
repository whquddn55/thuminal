// 터미널 글꼴 설정과 확대·축소. 테마처럼 이 브라우저(localStorage)에 남긴다.
//
// 처음 값은 Orca 와 같다 (SF Mono 14px, 굵기 500, 굵게 700).
// WebKit 은 macOS 시스템 SF Mono 를 "SF Mono" 라는 이름으로 찾지 못하고 `ui-monospace` 로만 준다
// (Safari 에서 캔버스에 그려 확인했다. 시스템 글꼴 이름이 `.SF NS Mono` 로 숨겨져 있다). Chrome 은 "SF Mono" 로 찾는다.
// 프롬프트의 Nerd 아이콘은 SF Mono 에 없어서 Meslo Nerd Font 를 뒤에 둬 그 글자만 채운다.

import type { FontFaceInfo, HostApi, RendererOptions } from "@thuminal/term-core";

export interface TerminalFont {
  /** 글꼴 이름. "SF Mono" 면 시스템 고정폭 글꼴(ui-monospace)을 쓴다 */
  family: string;
  size: number;
  weight: number;
  weightBold: number;
}

export const DEFAULT_TERMINAL_FONT: TerminalFont = { family: "SF Mono", size: 14, weight: 500, weightBold: 700 };

/** 아이콘 글자를 채우는 글꼴 (사용자가 설치한 것. WebKit 은 사용자 글꼴을 숨기므로 앱이 직접 등록한다) */
export const NERD_FONT = "MesloLGLDZ Nerd Font Mono";

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 40;
export const UI_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const FONT_KEY = "thuminal.terminalFont";
const ZOOM_KEY = "thuminal.zoom";

export interface Zoom {
  /** 터미널 글자 크기에 더하는 px (⌘+ ⌘-) */
  terminal: number;
  /** 앱 화면 배율 */
  ui: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export const loadTerminalFont = (): TerminalFont => load(FONT_KEY, DEFAULT_TERMINAL_FONT);
export const saveTerminalFont = (f: TerminalFont) => localStorage.setItem(FONT_KEY, JSON.stringify(f));
export const loadZoom = (): Zoom => load(ZOOM_KEY, { terminal: 0, ui: 1 });
export const saveZoom = (z: Zoom) => localStorage.setItem(ZOOM_KEY, JSON.stringify(z));

const isSystemMono = (family: string) => /^(sf mono|ui-monospace)$/i.test(family.trim());

/** CSS font-family 목록 */
export function fontStack(family: string): string {
  const f = family.trim().replace(/['"]/g, "");
  const first = !f || isSystemMono(f) ? "ui-monospace, 'SF Mono'" : `'${f}'`;
  // macOS 밖에는 SF Mono · Menlo 가 없어 그 OS 기본 고정폭(Windows Cascadia Mono · Consolas, Linux DejaVu Sans Mono)으로 넘어간다.
  // 한글은 고정폭 글꼴에 없으면 각 OS 한글 글꼴로 채운다
  return `${first}, '${NERD_FONT}', Menlo, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans Mono CJK KR', monospace`;
}

export const clampFontSize = (n: number) => Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));

export function rendererOptions(font: TerminalFont, size = font.size): RendererOptions {
  return { fontFamily: fontStack(font.family), fontSize: clampFontSize(size), fontWeight: font.weight, fontWeightBold: font.weightBold };
}

/** 보통 굵기 면: 기울이지 않은 것 가운데 굵기가 400 에 가장 가까운 것 */
function regularFace(faces: FontFaceInfo[]): FontFaceInfo | undefined {
  const upright = faces.filter((f) => !f.italic);
  return (upright.length ? upright : faces).reduce<FontFaceInfo | undefined>((best, f) => (!best || Math.abs(f.weight - 400) < Math.abs(best.weight - 400) ? f : best), undefined);
}

async function addFace(host: HostApi, family: string, face: FontFaceInfo): Promise<void> {
  const src = await host.fontSource!(face);
  const ff = new FontFace(family, src, { weight: String(face.weight), style: face.italic ? "italic" : "normal" });
  document.fonts.add(await ff.load());
}

let rest: Promise<void> = Promise.resolve();

/**
 * 글꼴을 쓸 수 있게 등록한다 (아이콘 글꼴과 고른 글꼴). 시스템 고정폭 글꼴은 등록하지 않아도 된다.
 * 보통 굵기 면만 기다리고, 굵게 · 기울임 면은 뒤에서 받는다 ([`terminalFontsLoaded`]).
 * 한 벌이 3MB 쯤이라 폰은 네 벌을 다 기다리면 첫 화면이 몇 초 늦는다. 등록할 면 수를 돌려준다
 */
export async function registerTerminalFonts(host: HostApi, family: string): Promise<number> {
  if (!host.fontFaces || !host.fontSource) return 0;
  const families = [NERD_FONT, ...(isSystemMono(family) || family.trim() === NERD_FONT ? [] : [family.trim()])];
  const lists = await Promise.all(families.map((f) => host.fontFaces!(f).then((faces) => ({ f, faces }), () => ({ f, faces: [] as FontFaceInfo[] }))));
  const first = lists.flatMap(({ f, faces }) => {
    const r = regularFace(faces);
    return r ? [{ f, face: r }] : [];
  });
  const later = lists.flatMap(({ f, faces }) => faces.filter((x) => !first.some((p) => p.face === x)).map((face) => ({ f, face })));
  await Promise.all(first.map(({ f, face }) => addFace(host, f, face).catch(() => undefined)));
  rest = Promise.all(later.map(({ f, face }) => addFace(host, f, face).catch(() => undefined))).then(() => undefined);
  return first.length + later.length;
}

/** 마지막으로 등록한 글꼴의 나머지 면(굵게 · 기울임)을 다 받았을 때 */
export const terminalFontsLoaded = (): Promise<void> => rest;

/** 확대 단계에서 다음 배율 */
export function nextUiZoom(now: number, dir: 1 | -1): number {
  if (dir > 0) return UI_ZOOM_STEPS.find((z) => z > now + 0.001) ?? now;
  return [...UI_ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? now;
}
