// 내장 테마 목록과 찾기.
//
// 목록은 Orca 내장 30종에 GitHub Dark 를 더한 31종이다. 순서는 Orca 의 묶음 순서
// (기본 2종 → 인기 dark → 인기 light → 클래식) 를 따르고, 화면에서 정렬은 쓰는 쪽이 한다.

import { contrast, ensureContrast, parseHex, toHex } from "./color";
import { RAW_THEMES } from "./data";
import type { ColorScheme, TerminalTheme } from "./types";

export const DEFAULT_DARK_THEME_ID = "ghostty-default-style-dark";
export const DEFAULT_LIGHT_THEME_ID = "builtin-tango-light";

/** 밝은 배경에서 글자로 쓰일 때 꼭 읽혀야 하는 번호: yellow, white, bright yellow, bright white */
const LIGHT_BODY = new Set([3, 7, 11, 15]);
const LIGHT_BODY_CONTRAST = 4.5;
const LIGHT_MIN_CONTRAST = 3;

/**
 * 밝은 테마의 ANSI 색을 흰 배경에서 읽히게 고친다 (Orca 가 Tango Light 에 한 보정을 모든 밝은 테마에 넓혔다).
 * 옛 테마들은 white · yellow 를 거의 흰색으로 두어, Claude 류 출력이 흰 배경에서 사라진다.
 * yellow · white 계열은 WCAG AA(4.5), 나머지는 큰 글자 기준(3) 까지 색조를 지키며 어둡게 한다.
 * 0번(black)은 밝은 테마가 일부러 배경색으로 두는 일이 많아(Gruvbox Light, Rose Pine Dawn) 두고,
 * 글자로 쓰일 때는 엔진의 최소 대비 보정에 맡긴다.
 */
function readableOnLight(t: TerminalTheme): TerminalTheme {
  if (t.scheme !== "light") return t;
  const bg = parseHex(t.background);
  const palette = t.palette.map((hex, i) => {
    if (i === 0) return hex;
    const ratio = LIGHT_BODY.has(i) ? LIGHT_BODY_CONTRAST : LIGHT_MIN_CONTRAST;
    const c = parseHex(hex);
    return contrast(c, bg) >= ratio ? hex : toHex(ensureContrast(c, bg, ratio));
  });
  return { ...t, palette };
}

/** 내장 테마 전부 */
export const themes: readonly TerminalTheme[] = RAW_THEMES.map(readableOnLight);

const byId = new Map(themes.map((t) => [t.id, t]));

export function defaultThemeId(scheme: ColorScheme): string {
  return scheme === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
}

export function findTheme(id: string): TerminalTheme | undefined {
  return byId.get(id);
}

/** 저장된 id 로 테마를 찾고, 없으면(지워졌거나 비었으면) 그 scheme 의 기본 테마를 준다 */
export function resolveTheme(id: string | null | undefined, scheme: ColorScheme): TerminalTheme {
  return (id ? byId.get(id) : undefined) ?? byId.get(defaultThemeId(scheme))!;
}
