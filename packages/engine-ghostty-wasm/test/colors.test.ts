import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CellFlags, type CellSink, type EngineColors, type TerminalEngine } from "@thuminal/term-core";
import { beforeAll, describe, expect, it } from "vitest";

// themes 패키지는 아직 시험 도구를 깔지 않아서 여기서 함께 시험한다
import {
  contrast,
  defaultThemeId,
  findTheme,
  parseHex,
  resolveTheme,
  themes,
  toDaemonColors,
  toEngineColors,
  uiTokens,
} from "../../themes/src";
import { contrast as engineContrast } from "../src/contrast";
import { ghosttyWasmEngine } from "../src";

const wasmPath = fileURLToPath(new URL("../src/assets/ghostty-vt.wasm", import.meta.url));
const enc = (s: string) => new TextEncoder().encode(s);

interface Cell {
  cp: number;
  fg: number;
  bg: number;
  flags: number;
}

function grab(e: TerminalEngine) {
  const cells = new Map<string, Cell>();
  const sink: CellSink = { cell: (x, y, cp, fg, bg, flags) => cells.set(`${x},${y}`, { cp, fg, bg, flags }) };
  const changed = e.scan(sink);
  return { changed, at: (x: number, y: number) => cells.get(`${x},${y}`)! };
}

const COLORS: EngineColors = {
  fg: 0x112233,
  bg: 0xf0e0d0,
  cursor: 0x00aa00,
  cursorText: 0x010203,
  selectionBg: 0x445566,
  selectionFg: 0xfefefe,
  palette: Array.from({ length: 16 }, (_, i) => 0x100000 * i + 0x000101 * i),
};

describe("엔진 색 바꾸기", () => {
  const factory = ghosttyWasmEngine({ wasm: async () => readFileSync(wasmPath) });
  beforeAll(async () => {
    await factory.load();
  });

  it("기본 fg/bg 와 ANSI 팔레트가 바로 새 색으로 다시 나온다", () => {
    const e = factory.create({ cols: 20, rows: 3, scrollback: 100 });
    e.feed(enc("ab \x1b[31mred\x1b[0m"));
    grab(e);
    e.setColors(COLORS);
    expect(e.defaultColors()).toEqual({ fg: COLORS.fg, bg: COLORS.bg });
    const g = grab(e);
    expect(g.changed).toBe(true);
    expect(g.at(0, 0)).toMatchObject({ fg: COLORS.fg, bg: COLORS.bg });
    expect(g.at(3, 0).fg).toBe(COLORS.palette[1]);
    // 빈칸도 새 배경
    expect(g.at(10, 1).bg).toBe(COLORS.bg);
    e.dispose();
  });

  it("선택과 커서는 테마 색으로 칠한다", () => {
    const e = factory.create({ cols: 20, rows: 3, scrollback: 100 });
    e.setColors(COLORS);
    e.feed(enc("hello world\r\n"));
    e.select({ x: 0, y: 0 }, { x: 4, y: 0 });
    const g = grab(e);
    expect(g.at(1, 0)).toMatchObject({ fg: COLORS.selectionFg, bg: COLORS.selectionBg });
    expect(g.at(1, 0).flags & CellFlags.Selected).toBeTruthy();
    expect(g.at(6, 0).bg).toBe(COLORS.bg);
    // 커서는 다음 줄 맨 앞에 있다
    expect(g.at(0, 1)).toMatchObject({ fg: COLORS.cursorText, bg: COLORS.cursor });
    // 프로그램이 OSC 12 로 바꾼 커서 색이 테마보다 앞선다
    e.feed(enc("\x1b]12;rgb:ab/cd/ef\x1b\\"));
    expect(grab(e).at(0, 1).bg).toBe(0xabcdef);
    e.dispose();
  });

  it("프로그램이 OSC 4 로 바꾼 번호는 테마를 바꿔도 지킨다 (OSC 10/11 도 반영)", () => {
    const e = factory.create({ cols: 20, rows: 2, scrollback: 100 });
    e.feed(enc("\x1b]4;1;rgb:12/34/56\x1b\\\x1b[31mA\x1b[32mB"));
    e.setColors(COLORS);
    const g = grab(e);
    expect(g.at(0, 0).fg).toBe(0x123456);
    expect(g.at(1, 0).fg).toBe(COLORS.palette[2]);
    // OSC 11 로 배경만 바꿔도 다시 그린다
    e.feed(enc("\x1b]11;#0a0b0c\x07"));
    const g2 = grab(e);
    expect(g2.changed).toBe(true);
    expect(g2.at(5, 1).bg).toBe(0x0a0b0c);
    expect(e.defaultColors().bg).toBe(0x0a0b0c);
    e.dispose();
  });

  it("공장 기본색이 뒤에 만든 엔진에 들어간다", () => {
    factory.setDefaultColors(COLORS);
    const e = factory.create({ cols: 10, rows: 2, scrollback: 10 });
    e.feed(enc("\x1b[34mx"));
    const g = grab(e);
    expect(g.at(0, 0)).toMatchObject({ fg: COLORS.palette[4], bg: COLORS.bg });
    expect(e.defaultColors().bg).toBe(COLORS.bg);
    e.dispose();
  });

  it("최소 대비를 켜면 안 보이는 글자색을 끌어올린다", () => {
    const e = factory.create({ cols: 10, rows: 2, scrollback: 10 });
    e.setColors({ ...COLORS, bg: 0xffffff, minimumContrast: 4.5 });
    e.feed(enc("\x1b[38;2;250;250;250mx\x1b[38;2;255;255;255my"));
    const g = grab(e);
    expect(engineContrast(g.at(0, 0).fg, 0xffffff)).toBeGreaterThanOrEqual(4.5);
    // 배경과 똑같은 색은 일부러 숨긴 글자로 보고 그대로 둔다
    expect(g.at(1, 0).fg).toBe(0xffffff);
    e.dispose();
  });

  it("흐린 글자는 배경 쪽으로 섞는다", () => {
    const e = factory.create({ cols: 10, rows: 2, scrollback: 10 });
    e.setColors({ ...COLORS, fg: 0x000000, bg: 0xffffff });
    e.feed(enc("\x1b[2mx"));
    expect(grab(e).at(0, 0).fg).toBe(0x808080);
    e.dispose();
  });
});

describe("테마 목록", () => {
  it("30종 안팎이고 id 가 겹치지 않으며 색이 모두 #rrggbb 다", () => {
    expect(themes.length).toBeGreaterThanOrEqual(30);
    expect(new Set(themes.map((t) => t.id)).size).toBe(themes.length);
    for (const t of themes) {
      const all = [t.foreground, t.background, t.cursor, t.cursorText, t.selectionBackground, t.selectionForeground, ...t.palette];
      expect(t.palette.length, t.name).toBe(16);
      for (const c of all) expect(c, t.name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("기본 테마와 찾기", () => {
    expect(findTheme(defaultThemeId("dark"))!.name).toBe("Ghostty Default Style Dark");
    expect(findTheme(defaultThemeId("light"))!.name).toBe("Builtin Tango Light");
    expect(findTheme("dracula")!.scheme).toBe("dark");
    expect(findTheme("없음")).toBeUndefined();
    expect(resolveTheme("없음", "light").id).toBe(defaultThemeId("light"));
  });

  it("밝은 테마의 yellow · white 는 배경 위에서 4.5 이상 대비가 난다", () => {
    for (const t of themes.filter((t) => t.scheme === "light")) {
      const bg = parseHex(t.background);
      for (const i of [3, 7, 11, 15]) expect(contrast(parseHex(t.palette[i]), bg), `${t.name} ${i}`).toBeGreaterThanOrEqual(4.5);
      for (const c of t.palette.slice(1)) expect(contrast(parseHex(c), bg), t.name).toBeGreaterThanOrEqual(3);
    }
    // 이미 읽히는 Orca 의 Tango Light 값은 그대로다
    expect(findTheme("builtin-tango-light")!.palette[7]).toBe("#6a6a6a");
  });
});

describe("화면 색 · 데몬 색", () => {
  const dracula = findTheme("dracula")!;
  const latte = findTheme("catppuccin-latte")!;

  it("터미널에 맞추면 fg/bg 를 섞어 만든다", () => {
    const t = uiTokens(dracula, { matchTerminal: true });
    expect(t["--background"]).toBe(dracula.background);
    expect(t["--foreground"]).toBe(dracula.foreground);
    expect(t["--sidebar"]).toBe(dracula.background);
    // color-mix(in srgb, #f8f8f2 9%, #282a36)
    expect(t["--accent"]).toBe("#3b3d47");
    expect(t["--terminal-background"]).toBe(dracula.background);
    for (const v of Object.values(t)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("끄면 무채색 shadcn 값이고 scheme 을 따른다", () => {
    expect(uiTokens(dracula, { matchTerminal: false })["--background"]).toBe("#0a0a0a");
    const light = uiTokens(latte, { matchTerminal: false });
    expect(light["--background"]).toBe("#ffffff");
    expect(light["--terminal-background"]).toBe(latte.background);
  });

  it("필요한 토큰이 모두 있고 상태 색이 배경 위에서 보인다", () => {
    const need = [
      "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary",
      "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent",
      "accent-foreground", "destructive", "border", "input", "ring", "sidebar", "sidebar-foreground",
      "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground",
      "sidebar-border", "sidebar-ring", "terminal-background", "terminal-foreground", "agent-working",
      "agent-attention", "agent-done", "agent-failed",
    ];
    for (const theme of themes) {
      for (const matchTerminal of [true, false]) {
        const t = uiTokens(theme, { matchTerminal });
        for (const n of need) expect(t[`--${n}`], `${theme.name} --${n}`).toBeTruthy();
        const bg = parseHex(t["--background"]);
        for (const n of ["agent-working", "agent-attention", "agent-done", "agent-failed"]) {
          expect(contrast(parseHex(t[`--${n}`]), bg), `${theme.name} ${n}`).toBeGreaterThanOrEqual(2.99);
        }
      }
    }
  });

  it("데몬 · 엔진 색은 0xRRGGBB 숫자다", () => {
    expect(toDaemonColors(dracula)).toEqual({
      foreground: 0xf8f8f2,
      background: 0x282a36,
      cursor: 0xf8f8f2,
      palette: dracula.palette.map(parseHex),
      scheme: "dark",
    });
    const ec: EngineColors = toEngineColors(latte);
    expect(ec.bg).toBe(0xeff1f5);
    expect(ec.minimumContrast).toBe(4.5);
    expect(toEngineColors(dracula).minimumContrast).toBe(3);
  });
});
