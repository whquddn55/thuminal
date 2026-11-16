import { describe, expect, it } from "vitest";

import { Osc52Scanner } from "../src/osc52";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => btoa(String.fromCharCode(...enc(s)));

describe("OSC 52", () => {
  it("BEL · ST 로 끝나는 클립보드 쓰기를 글로 푼다", () => {
    const s = new Osc52Scanner();
    expect(s.scan(enc(`a\x1b]52;c;${b64("한글 hello")}\x07b`))).toEqual(["한글 hello"]);
    expect(s.scan(enc(`\x1b]52;;${b64("두번째")}\x1b\\`))).toEqual(["두번째"]);
  });

  it("조각에 걸쳐 와도 잇는다", () => {
    const s = new Osc52Scanner();
    const all = enc(`xx\x1b]52;c;${b64("나뉜 글")}\x1b\\yy`);
    const got: string[] = [];
    for (let i = 0; i < all.length; i++) got.push(...s.scan(all.slice(i, i + 1)));
    expect(got).toEqual(["나뉜 글"]);
  });

  it("읽기 요청 · 지우기 · 다른 OSC 는 무시한다", () => {
    const s = new Osc52Scanner();
    expect(s.scan(enc("\x1b]52;c;?\x07\x1b]52;c;\x07\x1b]0;title\x07\x1b]8;;http://x\x07"))).toEqual([]);
  });
});
