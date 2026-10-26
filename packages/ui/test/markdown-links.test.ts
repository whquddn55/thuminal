import { describe, expect, it } from "vitest";

import { anchorCandidates, isMarkdownFile, normalizePath, resolveFromDoc, resolveImage, resolveLink } from "../src/markdown-links";

describe("경로 풀이", () => {
  it("문서 폴더 기준으로 푼다", () => {
    expect(resolveFromDoc("docs/guide/a.md", "b.md")).toBe("docs/guide/b.md");
    expect(resolveFromDoc("docs/guide/a.md", "./img/x.png")).toBe("docs/guide/img/x.png");
    expect(resolveFromDoc("docs/guide/a.md", "../README.md")).toBe("docs/README.md");
    expect(resolveFromDoc("README.md", "docs/a.md")).toBe("docs/a.md");
  });

  it("/ 로 시작하면 워크트리 맨 위 기준이다", () => {
    expect(resolveFromDoc("docs/a.md", "/src/main.rs")).toBe("src/main.rs");
  });

  it("워크트리 밖으로 나가면 null", () => {
    expect(resolveFromDoc("docs/a.md", "../../x.md")).toBeNull();
    expect(resolveFromDoc("README.md", "../x.md")).toBeNull();
    expect(normalizePath("a/../../b")).toBeNull();
    expect(normalizePath("a//./b/")).toBe("a/b");
  });
});

describe("링크 풀이", () => {
  it("앵커", () => {
    expect(resolveLink("#설치-방법", "README.md")).toEqual({ type: "anchor", id: "설치-방법" });
    expect(resolveLink("#%EC%84%A4%EC%B9%98", "README.md")).toEqual({ type: "anchor", id: "설치" });
    expect(resolveLink("#", "README.md")).toEqual({ type: "ignore" });
  });

  it("원격 주소", () => {
    expect(resolveLink("https://example.com/a?b#c", "README.md")).toEqual({ type: "url", url: "https://example.com/a?b#c" });
    expect(resolveLink("mailto:a@b.c", "README.md")).toEqual({ type: "url", url: "mailto:a@b.c" });
  });

  it("다른 스킴은 열지 않는다", () => {
    expect(resolveLink("javascript:alert(1)", "README.md")).toEqual({ type: "ignore" });
    expect(resolveLink("file:///etc/passwd", "README.md")).toEqual({ type: "ignore" });
    expect(resolveLink("//evil.com/x", "README.md")).toEqual({ type: "ignore" });
    expect(resolveLink(undefined, "README.md")).toEqual({ type: "ignore" });
  });

  it("상대 경로 파일과 줄 표시", () => {
    expect(resolveLink("docs/a.md", "README.md")).toEqual({ type: "file", file: "docs/a.md" });
    expect(resolveLink("../src/lib.rs#L12", "docs/a.md")).toEqual({ type: "file", file: "src/lib.rs", line: 12 });
    expect(resolveLink("lib.rs#L12-L20", "src/a.md")).toEqual({ type: "file", file: "src/lib.rs", line: 12 });
    expect(resolveLink("lib.rs:34", "src/a.md")).toEqual({ type: "file", file: "src/lib.rs", line: 34 });
    expect(resolveLink("lib.rs:34:5", "src/a.md")).toEqual({ type: "file", file: "src/lib.rs", line: 34 });
    expect(resolveLink("other.md#설치", "README.md")).toEqual({ type: "file", file: "other.md" });
    expect(resolveLink("my%20notes.md?raw=1", "README.md")).toEqual({ type: "file", file: "my notes.md" });
  });

  it("워크트리 밖", () => {
    expect(resolveLink("../../x.md", "docs/a.md")).toEqual({ type: "outside", path: "../../x.md" });
  });
});

describe("이미지 풀이", () => {
  it("원격은 그대로, 상대 경로는 워크트리 기준", () => {
    expect(resolveImage("https://x.dev/a.png", "README.md")).toEqual({ type: "remote", src: "https://x.dev/a.png" });
    expect(resolveImage("./img/a.svg?v=2", "docs/a.md")).toEqual({ type: "file", file: "docs/img/a.svg" });
    expect(resolveImage("data:image/png;base64,AAAA", "README.md")).toEqual({ type: "ignore" });
    expect(resolveImage("../../a.png", "docs/a.md")).toEqual({ type: "ignore" });
  });
});

describe("그 밖", () => {
  it("Markdown 파일", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("a/b.MARKDOWN")).toBe(true);
    expect(isMarkdownFile("a.mdx")).toBe(false);
    expect(isMarkdownFile("a.rs")).toBe(false);
  });

  it("앵커 후보", () => {
    expect(anchorCandidates("fn-1")).toEqual(["fn-1", "user-content-fn-1"]);
    expect(anchorCandidates("user-content-fn-1")).toEqual(["user-content-fn-1", "fn-1"]);
  });
});
