// 앱 화면 색 (shadcn / Tailwind v4 토큰).
//
// - matchTerminal: 터미널 fg/bg 두 색으로 토큰 한 벌을 만든다. Orca 의 왼쪽 사이드바 "Match terminal" 과 같은 섞기
//   (`color-mix(in srgb, fg N%, bg)`) 이고, 값은 여기서 미리 계산해 `#rrggbb` 로 준다.
//   Orca 가 정하지 않은 토큰(primary, secondary, popover, input, ring, destructive)은 같은 방식으로 채운다.
// - 끄면: shadcn new-york-v4 neutral 의 dark / light 값. 테마의 scheme 으로 고른다.
// 둘 다 --terminal-background / --terminal-foreground 는 테마 색이고, 상태 색은 배경 위에서 읽히게 맞춘다.

import { ensureContrast, mix, parseHex, toHex } from "./color";
import type { ColorScheme, TerminalTheme } from "./types";

export interface UiTokenOptions {
  /** 앱 화면 색을 터미널 테마에서 만든다 (끄면 무채색) */
  matchTerminal: boolean;
}

const NEUTRAL: Record<ColorScheme, Record<string, string>> = {
  dark: {
    "--background": "#0a0a0a",
    "--foreground": "#fafafa",
    "--card": "#171717",
    "--card-foreground": "#fafafa",
    "--popover": "#171717",
    "--popover-foreground": "#fafafa",
    "--primary": "#e5e5e5",
    "--primary-foreground": "#171717",
    "--secondary": "#262626",
    "--secondary-foreground": "#fafafa",
    "--muted": "#262626",
    "--muted-foreground": "#a1a1a1",
    "--accent": "#262626",
    "--accent-foreground": "#fafafa",
    "--destructive": "#ff6467",
    "--border": "#ffffff1a",
    "--input": "#ffffff26",
    "--ring": "#737373",
    "--sidebar": "#171717",
    "--sidebar-foreground": "#fafafa",
    "--sidebar-primary": "#1447e6",
    "--sidebar-primary-foreground": "#fafafa",
    "--sidebar-accent": "#262626",
    "--sidebar-accent-foreground": "#fafafa",
    "--sidebar-border": "#ffffff1a",
    "--sidebar-ring": "#737373",
  },
  light: {
    "--background": "#ffffff",
    "--foreground": "#0a0a0a",
    "--card": "#ffffff",
    "--card-foreground": "#0a0a0a",
    "--popover": "#ffffff",
    "--popover-foreground": "#0a0a0a",
    "--primary": "#171717",
    "--primary-foreground": "#fafafa",
    "--secondary": "#f5f5f5",
    "--secondary-foreground": "#171717",
    "--muted": "#f5f5f5",
    "--muted-foreground": "#737373",
    "--accent": "#f5f5f5",
    "--accent-foreground": "#171717",
    "--destructive": "#e7000b",
    "--border": "#e5e5e5",
    "--input": "#e5e5e5",
    "--ring": "#a1a1a1",
    "--sidebar": "#fafafa",
    "--sidebar-foreground": "#0a0a0a",
    "--sidebar-primary": "#171717",
    "--sidebar-primary-foreground": "#fafafa",
    "--sidebar-accent": "#f5f5f5",
    "--sidebar-accent-foreground": "#171717",
    "--sidebar-border": "#e5e5e5",
    "--sidebar-ring": "#a1a1a1",
  },
};

/** 에이전트 상태 색 (Tailwind: dark 는 500, light 는 한 단계 진한 600) */
const AGENT: Record<ColorScheme, Record<string, number>> = {
  dark: {
    "--agent-working": 0xeab308, // yellow-500
    "--agent-attention": 0xf97316, // orange-500
    "--agent-done": 0x10b981, // emerald-500
    "--agent-failed": 0xef4444, // red-500
  },
  light: {
    "--agent-working": 0xca8a04, // yellow-600
    "--agent-attention": 0xea580c, // orange-600
    "--agent-done": 0x059669, // emerald-600
    "--agent-failed": 0xdc2626, // red-600
  },
};

/** 상태 점 · 아이콘이 배경 위에서 보이는 최소 대비 (WCAG 큰 글자 · 그림 기준) */
const STATUS_CONTRAST = 3;

/** 터미널 fg/bg 로 만든 토큰. 섞는 비율은 Orca left-sidebar-appearance.ts 의 값이다 */
function matched(fg: number, bg: number, red: number): Record<string, string> {
  const m = (p: number) => toHex(mix(fg, bg, p / 100));
  const f = toHex(fg);
  const b = toHex(bg);
  return {
    "--background": b,
    "--foreground": f,
    "--card": m(4),
    "--card-foreground": f,
    "--popover": m(4),
    "--popover-foreground": f,
    "--primary": m(90),
    "--primary-foreground": b,
    "--secondary": m(9),
    "--secondary-foreground": f,
    "--muted": m(7),
    "--muted-foreground": m(62),
    "--accent": m(9),
    "--accent-foreground": f,
    "--destructive": toHex(ensureContrast(red, bg, STATUS_CONTRAST)),
    // 7% 는 Orca 가 사이드바 구분선을 전역 --border 와 같은 세기로 맞춘 값이다
    "--border": m(7),
    "--input": m(15),
    "--ring": m(44),
    "--sidebar": b,
    "--sidebar-foreground": f,
    "--sidebar-primary": m(90),
    "--sidebar-primary-foreground": b,
    "--sidebar-accent": m(9),
    "--sidebar-accent-foreground": f,
    "--sidebar-border": m(7),
    "--sidebar-ring": m(44),
  };
}

/** 테마로 앱 화면의 CSS 변수(이름 → 값)를 만든다. 문서 루트에 그대로 넣으면 된다 */
export function uiTokens(theme: TerminalTheme, opts: UiTokenOptions): Record<string, string> {
  const fg = parseHex(theme.foreground);
  const bg = parseHex(theme.background);
  const out = opts.matchTerminal ? matched(fg, bg, parseHex(theme.palette[1])) : { ...NEUTRAL[theme.scheme] };
  out["--terminal-background"] = theme.background;
  out["--terminal-foreground"] = theme.foreground;
  // 상태 색은 실제로 깔리는 앱 배경 위에서 읽혀야 한다 (Solarized Light 처럼 물든 배경도 있다)
  const surface = parseHex(out["--background"]);
  for (const [name, c] of Object.entries(AGENT[theme.scheme])) {
    out[name] = toHex(ensureContrast(c, surface, STATUS_CONTRAST));
  }
  return out;
}
