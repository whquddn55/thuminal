// 터미널 글꼴 설정과 확대·축소. 테마처럼 이 브라우저(localStorage)에 남긴다.
//
// 처음 값은 Orca 와 같다 (SF Mono 14px, 굵기 500, 굵게 700).
// WebKit 은 macOS 시스템 SF Mono 를 "SF Mono" 라는 이름으로 찾지 못하고 `ui-monospace` 로만 준다
// (Safari 에서 캔버스에 그려 확인했다. 시스템 글꼴 이름이 `.SF NS Mono` 로 숨겨져 있다). Chrome 은 "SF Mono" 로 찾는다.
// 프롬프트의 Nerd 아이콘은 SF Mono 에 없어서 Meslo Nerd Font 를 뒤에 둬 그 글자만 채운다.

import type { HostApi, RendererOptions } from "@thuminal/term-core";

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
  return `${first}, '${NERD_FONT}', Menlo, 'Apple SD Gothic Neo', 'Noto Sans Mono CJK KR', monospace`;
}

export const clampFontSize = (n: number) => Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));

export function rendererOptions(font: TerminalFont, size = font.size): RendererOptions {
  return { fontFamily: fontStack(font.family), fontSize: clampFontSize(size), fontWeight: font.weight, fontWeightBold: font.weightBold };
}

/**
 * 글꼴을 쓸 수 있게 등록한다 (아이콘 글꼴과 고른 글꼴). 등록한 글꼴 면 수를 돌려준다.
 * 시스템 고정폭 글꼴은 등록하지 않아도 된다
 */
export async function registerTerminalFonts(host: HostApi, family: string): Promise<number> {
  if (!host.registerFont) return 0;
  const families = [NERD_FONT, ...(isSystemMono(family) || family.trim() === NERD_FONT ? [] : [family.trim()])];
  const counts = await Promise.all(families.map((f) => host.registerFont!(f).catch(() => 0)));
  return counts.reduce((a, b) => a + b, 0);
}

/** 확대 단계에서 다음 배율 */
export function nextUiZoom(now: number, dir: 1 | -1): number {
  if (dir > 0) return UI_ZOOM_STEPS.find((z) => z > now + 0.001) ?? now;
  return [...UI_ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? now;
}
