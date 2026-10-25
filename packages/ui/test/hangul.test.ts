import { describe, expect, it } from "vitest";

import { HangulComposer, isJamo } from "../src/hangul";

/** 자모 줄을 넣고 확정된 글 + 조합 중인 글을 돌려준다. "⌫" 는 지우기 */
function type(keys: string): { done: string; preedit: string } {
  const h = new HangulComposer();
  let done = "";
  for (const k of keys) {
    if (k === "⌫") {
      if (!h.backspace()) done = done.slice(0, -1);
    } else done += h.feed(k);
  }
  return { done, preedit: h.preedit };
}

describe("두벌식 조합", () => {
  it("글자를 묶는다", () => {
    expect(type("ㅎㅏㄴㄱㅡㄹ")).toEqual({ done: "한", preedit: "글" });
    expect(type("ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ")).toEqual({ done: "안녕하세", preedit: "요" });
  });
  it("받침 뒤 모음이 오면 받침이 다음 글자로 간다", () => {
    expect(type("ㄱㅏㄱㅏ")).toEqual({ done: "가", preedit: "가" });
    expect(type("ㅇㅣㄹㄱㅓ")).toEqual({ done: "일", preedit: "거" });
    expect(type("ㄷㅏㄹㄱ")).toEqual({ done: "", preedit: "닭" });
    expect(type("ㄷㅏㄹㄱㅇㅣ")).toEqual({ done: "닭", preedit: "이" });
    expect(type("ㄷㅏㄹㄱㅣ")).toEqual({ done: "달", preedit: "기" });
  });
  it("겹모음", () => {
    expect(type("ㄱㅗㅏ")).toEqual({ done: "", preedit: "과" });
    expect(type("ㅇㅜㅣ")).toEqual({ done: "", preedit: "위" });
    expect(type("ㅢ")).toEqual({ done: "", preedit: "ㅢ" });
  });
  it("같은 자음 두 번은 쌍자음이 되지 않는다, 쌍자음은 받침으로 쓸 수 있는 것만", () => {
    expect(type("ㄱㄱ")).toEqual({ done: "ㄱ", preedit: "ㄱ" });
    expect(type("ㅇㅣㅆ")).toEqual({ done: "", preedit: "있" });
    expect(type("ㄱㅏㄸ")).toEqual({ done: "가", preedit: "ㄸ" });
  });
  it("지우기는 자모 하나씩 되돌린다", () => {
    expect(type("ㅎㅏㄴ⌫")).toEqual({ done: "", preedit: "하" });
    expect(type("ㅎㅏㄴ⌫⌫⌫")).toEqual({ done: "", preedit: "" });
    expect(type("ㄷㅏㄹㄱㅣ⌫")).toEqual({ done: "달", preedit: "ㄱ" });
    expect(type("ㅎㅏ⌫⌫⌫")).toEqual({ done: "", preedit: "" });
    expect(type("ㄱㅏㄱㅏ⌫⌫⌫")).toEqual({ done: "", preedit: "" });
  });
  it("자모만 받는다", () => {
    expect(isJamo("ㅎ")).toBe(true);
    expect(isJamo("ㅢ")).toBe(true);
    expect(isJamo("a")).toBe(false);
    expect(isJamo("한")).toBe(false);
  });
});
