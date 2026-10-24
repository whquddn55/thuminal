// 테마를 엔진 · 데몬이 받는 숫자 꼴로 바꾼다.

import { isLight, parseHex } from "./color";
import type { ColorScheme, TerminalTheme } from "./types";

/** 데몬 SetTerminalColors 의 `colors` (contract §3 TerminalColors). 색은 0xRRGGBB */
export interface DaemonTerminalColors {
  foreground: number;
  background: number;
  cursor: number | null;
  /** ANSI 0~15. 16~255 는 데몬 엔진 기본값을 쓴다 */
  palette: number[];
  scheme: ColorScheme;
}

export function toDaemonColors(theme: TerminalTheme): DaemonTerminalColors {
  return {
    foreground: parseHex(theme.foreground),
    background: parseHex(theme.background),
    cursor: parseHex(theme.cursor),
    palette: theme.palette.map(parseHex),
    scheme: theme.scheme,
  };
}

/** 어두운 배경 3, 밝은 배경 4.5 (Orca 의 minimumContrastRatio 자동값) */
export function minimumContrastFor(theme: TerminalTheme): number {
  return isLight(parseHex(theme.background)) ? 4.5 : 3;
}

/**
 * 앱 엔진(term-core EngineColors) 에 넣는 색. 이 패키지는 다른 패키지에 기대지 않으므로
 * 같은 모양의 타입을 따로 둔다 (EngineColors 에 그대로 넘길 수 있다).
 */
export interface ThemeEngineColors {
  fg: number;
  bg: number;
  cursor: number;
  cursorText: number;
  selectionBg: number;
  selectionFg: number;
  palette: number[];
  minimumContrast: number;
}

export function toEngineColors(theme: TerminalTheme): ThemeEngineColors {
  return {
    fg: parseHex(theme.foreground),
    bg: parseHex(theme.background),
    cursor: parseHex(theme.cursor),
    cursorText: parseHex(theme.cursorText),
    selectionBg: parseHex(theme.selectionBackground),
    selectionFg: parseHex(theme.selectionForeground),
    palette: theme.palette.map(parseHex),
    minimumContrast: minimumContrastFor(theme),
  };
}
