import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CellFlags, type CellSink, type TerminalEngine } from "@thuminal/term-core";
import { beforeAll, describe, expect, it } from "vitest";

import { ghosttyWasmEngine } from "../src";

const wasmPath = fileURLToPath(new URL("../src/assets/ghostty-vt.wasm", import.meta.url));
const factory = ghosttyWasmEngine({ wasm: async () => readFileSync(wasmPath) });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const key = (k: Partial<Parameters<TerminalEngine["input"]["key"]>[0]>) => ({ key: "", code: "", ctrl: false, alt: false, shift: false, meta: false, ...k });

function row(e: TerminalEngine, y: number, cols: number) {
  const cells: { cp: number; flags: number }[] = [];
  const sink: CellSink = { cell: (x, yy, cp, _fg, _bg, flags) => yy === y && (cells[x] = { cp, flags }) };
  e.invalidate();
  e.scan(sink);
  return cells.slice(0, cols);
}

describe("입력과 고르기", () => {
  beforeAll(() => factory.load());

  it("⌥ 를 Meta 로 보낸다 (⌥b → ESC b)", () => {
    const e = factory.create({ cols: 20, rows: 3, scrollback: 100 });
    expect(dec(e.input.key(key({ key: "∫", code: "KeyB", alt: true })))).toBe("\x1bb");
  });

  it("세 번 누르면 줄 전체를 고른다", () => {
    const e = factory.create({ cols: 20, rows: 3, scrollback: 100 });
    e.feed(enc("hello world\r\nnext"));
    e.selectLine({ x: 2, y: 0 });
    expect(e.selectionText()).toBe("hello world");
    e.selectAll();
    expect(e.selectionText()).toContain("next");
  });

  it("조합 중인 글자를 커서 자리에 밑줄로 넘기고, 지우면 원래 칸으로 돌아간다", () => {
    const e = factory.create({ cols: 10, rows: 2, scrollback: 100 });
    e.feed(enc("ab"));
    e.setPreedit("가");
    const r = row(e, 0, 5);
    expect(r[2].cp).toBe("가".codePointAt(0));
    expect(r[2].flags & CellFlags.Underline).toBeTruthy();
    expect(r[2].flags & CellFlags.Wide).toBeTruthy();
    expect(r[3].cp).toBe(0);
    e.setPreedit(null);
    expect(row(e, 0, 5)[2].cp).toBe(0);
  });

  it("휠: 마우스를 받으면 휠 버튼, 대체 화면이면 방향키를 하나씩, 아니면 앱이 스크롤백을 움직인다", () => {
    const e = factory.create({ cols: 20, rows: 5, scrollback: 100 });
    expect(e.input.wheel(true, { x: 0, y: 0 })).toBeNull();
    e.feed(enc("\x1b[?1049h"));
    expect(dec(e.input.wheel(true, { x: 0, y: 0 }))).toBe("\x1b[A");
    e.feed(enc("\x1b[?1h"));
    expect(dec(e.input.wheel(false, { x: 0, y: 0 }))).toBe("\x1bOB");
    e.feed(enc("\x1b[?1000h\x1b[?1006h"));
    expect(dec(e.input.wheel(true, { x: 3, y: 2 }))).toBe("\x1b[<64;4;3M");
    expect(dec(e.input.wheel(false, { x: 3, y: 2 }))).toBe("\x1b[<65;4;3M");
    e.feed(enc("\x1b[?1006l"));
    expect(dec(e.input.wheel(true, { x: 0, y: 0 }))).toBe("\x1b[M`!!");
  });

  it("마우스: 켠 모드가 받는 누르기·떼기·끌기만 보고한다", () => {
    const e = factory.create({ cols: 20, rows: 5, scrollback: 100 });
    const m = (action: "press" | "release" | "move", button: 0 | 1 | 2 | null, x = 2, y = 1, shift = false) =>
      dec(e.input.mouse({ action, button, at: { x, y }, shift, alt: false, ctrl: false }));
    expect(m("press", 0)).toBeNull();
    e.feed(enc("\x1b[?1000h\x1b[?1006h"));
    expect(m("press", 0)).toBe("\x1b[<0;3;2M");
    expect(m("release", 0)).toBe("\x1b[<0;3;2m");
    expect(m("move", 0, 4, 1)).toBeNull();
    e.feed(enc("\x1b[?1002h"));
    expect(m("move", 0, 4, 1)).toBe("\x1b[<32;5;2M");
    expect(m("move", null)).toBeNull();
    e.feed(enc("\x1b[?1003h"));
    expect(m("move", null)).toBe("\x1b[<35;3;2M");
    expect(m("press", 0, 2, 1, true)).toBe("\x1b[<4;3;2M");
    e.feed(enc("\x1b[?1006l"));
    expect(m("release", 0)).toBe("\x1b[M##\"");
  });

  it("동기 출력(모드 2026) 중에는 반쪽 화면을 넘기지 않고, 끝나면 넘긴다", () => {
    const e = factory.create({ cols: 10, rows: 2, scrollback: 100 });
    const sink: CellSink = { cell: () => {} };
    e.scan(sink);
    e.feed(enc("\x1b[?2026hab"));
    expect(e.scan(sink)).toBe(false);
    e.feed(enc("cd\x1b[?2026l"));
    expect(row(e, 0, 4).map((c) => String.fromCodePoint(c.cp))).toEqual(["a", "b", "c", "d"]);
  });

  it("커서를 숨긴 프로그램(claude 등)에서도 조합 중인 글자를 커서 자리에 그린다", () => {
    const e = factory.create({ cols: 10, rows: 2, scrollback: 100 });
    e.feed(enc("\x1b[?25l> "));
    e.setPreedit("ㅎ");
    const r = row(e, 0, 5);
    expect(r[2].cp).toBe("ㅎ".codePointAt(0));
    expect(r[2].flags & CellFlags.Underline).toBeTruthy();
  });
});

describe("⌥ 조합", () => {
  beforeAll(() => factory.load());
  it("⌥⇧b 는 ESC B, ⌥. 는 ESC .", () => {
    const e = factory.create({ cols: 20, rows: 3, scrollback: 100 });
    expect(dec(e.input.key(key({ key: "ı", code: "KeyB", alt: true, shift: true })))).toBe("\x1bB");
    expect(dec(e.input.key(key({ key: "≥", code: "Period", alt: true })))).toBe("\x1b.");
  });
});
