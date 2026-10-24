export type ColorScheme = "dark" | "light";

/** 터미널 테마 하나. 색은 모두 `#rrggbb` (소문자) */
export interface TerminalTheme {
  /** 설정에 저장하는 이름. 소문자와 `-` 만 쓴다 (예: "catppuccin-mocha") */
  id: string;
  /** 화면에 보이는 이름 */
  name: string;
  scheme: ColorScheme;
  foreground: string;
  background: string;
  cursor: string;
  /** 커서 아래 글자 색 */
  cursorText: string;
  selectionBackground: string;
  selectionForeground: string;
  /** ANSI 0~15 (16개). 16~255 는 엔진 기본값을 쓴다 */
  palette: readonly string[];
}
