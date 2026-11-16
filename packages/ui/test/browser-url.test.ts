import { describe, expect, it } from "vitest";

import { looksLikeUrl, toUrl } from "../src/browser-url";

describe("toUrl", () => {
  it("이 컴퓨터 주소는 http 로 연다", () => {
    expect(toUrl("localhost:2800")).toBe("http://localhost:2800");
    expect(toUrl("127.0.0.1/x")).toBe("http://127.0.0.1/x");
    expect(toUrl("wire-broker.localhost/?t=1")).toBe("http://wire-broker.localhost/?t=1");
    expect(toUrl("worky.localhost")).toBe("http://worky.localhost");
    expect(toUrl("a.b.localhost:2800/x")).toBe("http://a.b.localhost:2800/x");
  });

  it("다른 주소는 https 로 연다", () => {
    expect(toUrl("example.com")).toBe("https://example.com");
    expect(toUrl("localhost.example.com")).toBe("https://localhost.example.com");
    expect(toUrl("127.0.0.1.nip.io")).toBe("https://127.0.0.1.nip.io");
  });

  it("포트를 붙인 이름을 스킴으로 읽지 않는다", () => {
    expect(toUrl("worky.localhost:2800/x")).toBe("http://worky.localhost:2800/x");
    expect(toUrl("example.com:8080")).toBe("https://example.com:8080");
  });

  it("스킴이 있으면 그대로 둔다", () => {
    expect(toUrl("http://wire-broker.localhost/")).toBe("http://wire-broker.localhost/");
    expect(toUrl("about:blank")).toBe("about:blank");
    expect(toUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
  });

  it("주소가 아니면 검색한다", () => {
    expect(toUrl("hello world")).toBe("https://www.google.com/search?q=hello%20world");
    expect(looksLikeUrl("hello")).toBe(false);
  });
});
