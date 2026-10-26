import type { LineText } from "@thuminal/term-core";
import { describe, expect, it } from "vitest";

import { linkCandidatesAt, parseHyperlink, splitLine } from "../src/links";

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣]/;

/** 화면 줄 흉내: 넓은 글자는 두 칸 */
function screen(rows: string[], wrapped: number[] = []) {
  const lines: LineText[] = rows.map((text, y) => {
    const cols: number[] = [];
    let x = 0;
    for (const ch of text) {
      for (let k = 0; k < ch.length; k++) cols.push(x);
      x += WIDE.test(ch) ? 2 : 1;
    }
    return { text, cols, wrapped: wrapped.includes(y) };
  });
  return (y: number) => lines[y] ?? null;
}

/** 줄 y 에서 글자 needle 이 시작하는 칸 */
function colOf(get: (y: number) => LineText | null, y: number, needle: string) {
  const l = get(y)!;
  return l.cols[l.text.indexOf(needle)];
}

describe("터미널 링크 찾기", () => {
  it("URL 끝의 문장부호는 뗀다", () => {
    const get = screen(["see https://example.com/a?b=1. ok"]);
    const [l] = linkCandidatesAt(get, 1, 40, { y: 0, x: colOf(get, 0, "example") });
    expect(l.target).toEqual({ kind: "url", url: "https://example.com/a?b=1" });
  });

  it("경로:줄:열 을 나누고, 한글 뒤에서도 칸을 맞춘다", () => {
    const get = screen(["오류 src/main.rs:12:5 에서"]);
    const [l] = linkCandidatesAt(get, 1, 40, { y: 0, x: colOf(get, 0, "main") });
    expect(l.target).toEqual({ kind: "path", path: "src/main.rs", line: 12, col: 5 });
    expect(l.ranges).toEqual([{ y: 0, x0: 5, x1: 21 }]);
  });

  it("슬래시 없는 파일 이름도 잡고, 버전 번호는 뺀다", () => {
    const get = screen(["README.md 와 v1.2.3"]);
    expect(linkCandidatesAt(get, 1, 40, { y: 0, x: 2 })[0].target).toEqual({ kind: "path", path: "README.md" });
    expect(linkCandidatesAt(get, 1, 40, { y: 0, x: colOf(get, 0, "1.2") })).toEqual([]);
  });

  it("자동 줄바꿈으로 이어진 줄은 하나로 본다", () => {
    const get = screen(["x /tmp/aaaa", "/bbb.rs y"], [0]);
    const [l] = linkCandidatesAt(get, 2, 11, { y: 1, x: 2 });
    expect(l.target).toEqual({ kind: "path", path: "/tmp/aaaa/bbb.rs" });
    expect(l.ranges).toEqual([
      { y: 0, x0: 2, x1: 11 },
      { y: 1, x0: 0, x1: 7 },
    ]);
  });

  it("프로그램이 줄 끝에서 자른 경로는 다음 줄 들여쓰기를 떼고 이어 붙인 후보가 먼저 온다", () => {
    // claude 처럼: 줄 끝까지 채우고, 다음 줄은 두 칸 들여 이어 쓴다
    const cols = 30;
    const get = screen(["⏺ 파일은 /tmp/thm-link/src/lon", "  g/main.rs 입니다."]);
    const fromTop = linkCandidatesAt(get, 2, cols, { y: 0, x: colOf(get, 0, "thm") });
    expect(fromTop.map((l) => l.text)).toEqual(["/tmp/thm-link/src/long/main.rs", "/tmp/thm-link/src/lon"]);
    const fromBottom = linkCandidatesAt(get, 2, cols, { y: 1, x: colOf(get, 1, "main") });
    expect(fromBottom[0].text).toBe("/tmp/thm-link/src/long/main.rs");
    expect(fromBottom[0].ranges[1]).toEqual({ y: 1, x0: 2, x1: 11 });
  });

  it("줄 끝에 닿지 않은 링크는 잇지 않는다", () => {
    const get = screen(["/tmp/a.rs", "  b.rs"]);
    expect(linkCandidatesAt(get, 2, 40, { y: 0, x: 2 }).map((l) => l.text)).toEqual(["/tmp/a.rs"]);
  });

  it("OSC 8 주소와 줄 표시", () => {
    expect(parseHyperlink("https://a.b/c")).toEqual({ kind: "url", url: "https://a.b/c" });
    expect(parseHyperlink("file:///tmp/a%20b.md#L3")).toEqual({ kind: "path", path: "/tmp/a b.md", line: 3, col: undefined });
    expect(parseHyperlink("mailto:x@y")).toBeNull();
    expect(splitLine("a/b.ts#L4C2")).toEqual({ path: "a/b.ts", line: 4, col: 2 });
  });
});
