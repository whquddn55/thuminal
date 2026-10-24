// 테마 설정: 다크/라이트 고르기, 다크용·라이트용 터미널 테마, 화면 색을 터미널 테마에서 뽑을지.
//
// 고른 테마 하나로 세 곳을 맞춘다: 화면 토큰(<html> CSS 변수), 앱 엔진 색, 데몬 엔진 색.

import type { EngineColors, TerminalColors } from "@thuminal/term-core";
import { defaultThemeId, resolveTheme, type TerminalTheme, toDaemonColors, toEngineColors, uiTokens } from "@thuminal/themes";

export interface ThemeSettings {
  mode: "system" | "dark" | "light";
  dark: string;
  light: string;
  /** 화면 색(사이드바, 탭 줄)도 터미널 테마 색에서 뽑는다 */
  matchTerminal: boolean;
}

const KEY = "thuminal.theme";

export function loadThemeSettings(): ThemeSettings {
  const base: ThemeSettings = { mode: "system", dark: defaultThemeId("dark"), light: defaultThemeId("light"), matchTerminal: true };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return base;
  }
}

export function saveThemeSettings(t: ThemeSettings) {
  localStorage.setItem(KEY, JSON.stringify(t));
}

/** 지금 쓸 터미널 테마 */
export function currentTheme(t: ThemeSettings, systemDark: boolean): TerminalTheme {
  const dark = t.mode === "dark" || (t.mode === "system" && systemDark);
  return dark ? resolveTheme(t.dark, "dark") : resolveTheme(t.light, "light");
}

/** 화면 토큰을 <html> 에 넣고, 엔진에 넣을 색을 돌려준다 */
export function applyTheme(t: ThemeSettings, systemDark: boolean): { theme: TerminalTheme; engine: EngineColors; daemon: TerminalColors } {
  const theme = currentTheme(t, systemDark);
  const root = document.documentElement;
  root.classList.toggle("dark", theme.scheme === "dark");
  for (const [k, v] of Object.entries(uiTokens(theme, { matchTerminal: t.matchTerminal }))) root.style.setProperty(k, v);
  return { theme, engine: toEngineColors(theme), daemon: toDaemonColors(theme) };
}
