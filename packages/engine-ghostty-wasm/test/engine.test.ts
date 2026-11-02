import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CellFlags, type CellSink, type TerminalEngine } from "@thuminal/term-core";
import { beforeAll, describe, expect, it } from "vitest";

import { ghosttyWasmEngine } from "../src";
import { composeHangul } from "../src/engine";

const wasmPath = fileURLToPath(new URL("../src/assets/ghostty-vt.wasm", import.meta.url));
const factory = ghosttyWasmEngine({ wasm: async () => readFileSync(wasmPath) });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

interface Cell {
  cp: number;
  fg: number;
  bg: number;
  flags: number;
}

/** scan 결과를 줄 글자와 칸 정보로 모은다 */
function grab(e: TerminalEngine) {
  const cells = new Map<string, Cell>();
  const sink: CellSink = { cell: (x, y, cp, fg, bg, flags) => cells.set(`${x},${y}`, { cp, fg, bg, flags }) };
  const changed = e.scan(sink);
  const line = (y: number) =>
    Array.from({ length: e.cols }, (_, x) => cells.get(`${x},${y}`)?.cp || 32)
      .map((c) => String.fromCodePoint(c))
      .join("")
      .trimEnd();
  return { changed, cells, line };
}

const key = (k: Partial<Parameters<TerminalEngine["input"]["key"]>[0]> & { key: string; code: string }) =>
  ({ ctrl: false, alt: false, shift: false, meta: false, ...k });

beforeAll(async () => {
  await factory.load();
});

describe("ghostty-vt.wasm 엔진", () => {
  it("넣은 글자와 색이 칸으로 나온다", () => {
    const e = factory.create({ cols: 20, rows: 4, scrollback: 100 });
    e.feed(enc("plain \x1b[1;31mred\x1b[0m"));
    const g = grab(e);
    expect(g.changed).toBe(true);
    expect(g.line(0)).toBe("plain red");
    const r = g.cells.get("6,0")!;
    expect(r.flags & CellFlags.Bold).toBeTruthy();
    expect(r.fg).not.toBe(e.defaultColors().fg);
    // 바뀐 것이 없으면 다시 넘기지 않는다
    expect(grab(e).changed).toBe(false);
    e.dispose();
  });

  it("한글은 두 칸 글자로 표시된다", () => {
    const e = factory.create({ cols: 20, rows: 2, scrollback: 100 });
    e.feed(enc("가a"));
    const g = grab(e);
    expect(g.cells.get("0,0")!.cp).toBe("가".codePointAt(0));
    expect(g.cells.get("0,0")!.flags & CellFlags.Wide).toBeTruthy();
    expect(g.cells.get("2,0")!.cp).toBe("a".codePointAt(0));
    e.dispose();
  });

  it("자모로 나뉜 한글(NFD, macOS 파일 이름)은 완성형 한 글자로 그린다", () => {
    const e = factory.create({ cols: 20, rows: 2, scrollback: 100 });
    e.feed(enc("@한글.md".normalize("NFD")));
    const g = grab(e);
    // 두 칸 글자의 뒤 칸은 빈칸으로 읽힌다
    expect(g.line(0)).toBe("@한 글 .md");
    expect(g.cells.get("1,0")!.cp).toBe("한".codePointAt(0));
    expect(g.cells.get("3,0")!.cp).toBe("글".codePointAt(0));
    e.dispose();
  });

  it("스크롤해도 바뀌지 않는 줄 번호로 고른다 (끌면서 스크롤)", () => {
    const e = factory.create({ cols: 20, rows: 5, scrollback: 100 });
    e.feed(enc(Array.from({ length: 30 }, (_, i) => `line${i}`).join("\r\n")));
    const bottom = e.viewportTop();
    expect(bottom).toBe(25);
    e.scroll(-10);
    expect(e.viewportTop()).toBe(15);
    // 화면 맨 위 줄(line15)에서 고르기 시작해 아래로 스크롤한 뒤 화면 둘째 줄(line27)까지 끈다
    const from = { x: 0, y: e.viewportTop() };
    e.scroll(10);
    e.select(from, { x: 5, y: e.viewportTop() + 2 }, true);
    expect(e.selectionText()?.split("\n")).toEqual(Array.from({ length: 13 }, (_, i) => `line${15 + i}`));
    e.dispose();
  });

  it("자모로 나뉜 한글은 완성형으로 복사한다 (다른 글자는 그대로)", () => {
    expect(composeHangul("@한글.md".normalize("NFD"))).toBe("@한글.md");
    expect(composeHangul("e\u0301 \uF900 ᄒ")).toBe("e\u0301 \uF900 ᄒ");
  });

  it("키를 터미널 모드에 맞게 바꾼다", () => {
    const e = factory.create({ cols: 20, rows: 2, scrollback: 100 });
    expect(dec(e.input.key(key({ key: "a", code: "KeyA" })))).toBe("a");
    expect(dec(e.input.key(key({ key: "Enter", code: "Enter" })))).toBe("\r");
    expect(dec(e.input.key(key({ key: "c", code: "KeyC", ctrl: true })))).toBe("\x03");
    expect(dec(e.input.key(key({ key: "ArrowUp", code: "ArrowUp" })))).toBe("\x1b[A");
    e.feed(enc("\x1b[?1h")); // 커서 키 응용 모드
    expect(dec(e.input.key(key({ key: "ArrowUp", code: "ArrowUp" })))).toBe("\x1bOA");
    expect(e.input.key(key({ key: "c", code: "KeyC", meta: true }))).toBeNull();
    e.dispose();
  });

  it("bracketed paste 모드면 붙여넣기를 감싼다", () => {
    const e = factory.create({ cols: 20, rows: 2, scrollback: 100 });
    expect(dec(e.input.paste("hi"))).toBe("hi");
    e.feed(enc("\x1b[?2004h"));
    expect(dec(e.input.paste("hi"))).toBe("\x1b[200~hi\x1b[201~");
    e.dispose();
  });

  it("크기를 바꾸고 다시 전체를 넘긴다", () => {
    const e = factory.create({ cols: 20, rows: 4, scrollback: 100 });
    e.feed(enc("x"));
    grab(e);
    e.resize(30, 5);
    const g = grab(e);
    expect(g.changed).toBe(true);
    expect(g.cells.size).toBe(30 * 5);
    e.dispose();
  });

  it("데몬(Rust) 엔진이 만든 고유 저장본을 되살린다", () => {
    const snap = readFileSync(fileURLToPath(new URL("./fixtures/native.snap", import.meta.url)));
    const e = factory.restore!(new Uint8Array(snap), { cols: 40, rows: 6, scrollback: 1000 });
    expect(e).not.toBeNull();
    const g = grab(e!);
    const text = Array.from({ length: 6 }, (_, y) => g.line(y)).join("\n");
    expect(text).toContain("line 19");
    expect(text).toContain("bold end");
    e!.dispose();
  });

  it("깨진 저장본이면 null 을 돌려준다", () => {
    expect(factory.restore!(new Uint8Array([1, 2, 3, 4]), { cols: 10, rows: 2, scrollback: 10 })).toBeNull();
  });
});

describe("스크롤과 선택", () => {
  it("스크롤백으로 올라갔다 내려온다", async () => {
    await factory.load();
    const e = factory.create({ cols: 20, rows: 3, scrollback: 100 });
    for (let i = 0; i < 10; i++) e.feed(enc(`line ${i}\r\n`));
    expect(grab(e).line(1)).toBe("line 9");
    e.scroll(-5);
    expect(grab(e).line(0)).toBe("line 3");
    e.scrollToBottom();
    expect(grab(e).line(1)).toBe("line 9");
    e.dispose();
  });

  it("끌어서 고른 글자와 단어를 돌려준다", () => {
    const e = factory.create({ cols: 30, rows: 3, scrollback: 100 });
    e.feed(enc("hello world foo\r\nsecond line"));
    e.select({ x: 6, y: 0 }, { x: 10, y: 0 });
    expect(e.selectionText()).toBe("world");
    const g = grab(e);
    expect(g.cells.get("6,0")!.flags & CellFlags.Selected).toBeTruthy();
    expect(g.cells.get("5,0")!.flags & CellFlags.Selected).toBeFalsy();
    e.selectWord({ x: 13, y: 0 });
    expect(e.selectionText()).toBe("foo");
    e.select({ x: 12, y: 0 }, { x: 5, y: 1 });
    expect(e.selectionText()).toBe("foo\nsecond");
    e.clearSelection();
    expect(e.selectionText()).toBeNull();
    e.dispose();
  });
});
