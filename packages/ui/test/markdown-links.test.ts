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

describe("워크트리 밖 경로 풀이", () => {
  const doc = "/Users/me/scratch/plan.md";

  it("밖에서 연 문서의 상대 · 절대 경로는 절대 경로로 푼다", () => {
    expect(resolveFromDoc(doc, "./note.md")).toBe("/Users/me/scratch/note.md");
    expect(resolveFromDoc(doc, "note.md")).toBe("/Users/me/scratch/note.md");
    expect(resolveFromDoc(doc, "../a/b.json")).toBe("/Users/me/a/b.json");
    expect(resolveFromDoc(doc, "/Users/me/scratch/note.md")).toBe("/Users/me/scratch/note.md");
    expect(resolveFromDoc("/a.md", "../../x.md")).toBe("/x.md");
  });

  it("밖 문서가 워크트리 안을 가리키면 워크트리 기준 경로다", () => {
    expect(resolveFromDoc(doc, "../repo/src/a.rs", "/Users/me/repo")).toBe("src/a.rs");
  });

  it("워크트리 안 문서에서 밖으로 나가면 워크트리 경로로 절대 경로를 만든다", () => {
    expect(resolveFromDoc("docs/a.md", "../../x.md", "/Users/me/repo")).toBe("/Users/me/x.md");
    expect(resolveFromDoc("README.md", "../other/b.md", "/Users/me/repo/")).toBe("/Users/me/other/b.md");
  });

  it("워크트리 안 문서의 / 경로: 워크트리와 맨 위 칸이 같으면 파일 시스템 절대 경로다", () => {
    expect(resolveFromDoc("docs/a.md", "/src/main.rs", "/Users/me/repo")).toBe("src/main.rs");
    expect(resolveFromDoc("docs/a.md", "/Users/me/scratch/n.md", "/Users/me/repo")).toBe("/Users/me/scratch/n.md");
    expect(resolveFromDoc("docs/a.md", "/Users/me/repo/src/a.rs", "/Users/me/repo")).toBe("src/a.rs");
  });

  it("Windows 경로", () => {
    expect(resolveFromDoc("C:\\Users\\me\\plan.md", "img/a.png")).toBe("C:/Users/me/img/a.png");
    expect(resolveFromDoc("docs/a.md", "../../x.md", "C:\\Users\\me\\repo")).toBe("C:/Users/me/x.md");
    expect(resolveLink("C:/Users/me/x.md", "/Users/me/plan.md")).toEqual({ type: "file", file: "C:/Users/me/x.md" });
  });

  it("링크 · 이미지", () => {
    expect(resolveLink("./note.md#L3", doc)).toEqual({ type: "file", file: "/Users/me/scratch/note.md", line: 3 });
    expect(resolveLink("data.json", doc)).toEqual({ type: "file", file: "/Users/me/scratch/data.json" });
    expect(resolveLink("../../x.md", "docs/a.md", "/Users/me/repo")).toEqual({ type: "file", file: "/Users/me/x.md" });
    expect(resolveImage("./icon.png", doc)).toEqual({ type: "file", file: "/Users/me/scratch/icon.png" });
    expect(resolveImage("../../a.png", "docs/a.md", "/Users/me/repo")).toEqual({ type: "file", file: "/Users/me/a.png" });
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

  it("워크트리 경로를 모르면 밖으로 나가는 링크는 열지 않는다", () => {
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
