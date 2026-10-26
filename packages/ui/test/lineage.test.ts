import type { WorktreeInfo } from "@thuminal/term-core";
import { describe, expect, it } from "vitest";

import { descendantsOf, lineageCounts, worktreeForest } from "../src/lineage";

function wt(path: string, parent?: string): WorktreeInfo {
  return { path, parent, repo: "r", branch: path, is_main: false } as unknown as WorktreeInfo;
}

const paths = (list: WorktreeInfo[]) => list.map((w) => w.path);

describe("worktreeForest", () => {
  it("자식은 부모 밑에, 목록 차례대로 든다", () => {
    const { roots, kids } = worktreeForest([wt("/a"), wt("/b", "/a"), wt("/c"), wt("/d", "/b"), wt("/e", "/a")]);
    expect(paths(roots)).toEqual(["/a", "/c"]);
    expect(paths(kids.get("/a") ?? [])).toEqual(["/b", "/e"]);
    expect(paths(kids.get("/b") ?? [])).toEqual(["/d"]);
    expect(paths(descendantsOf("/a", kids))).toEqual(["/b", "/d", "/e"]);
  });

  it("부모가 목록에 없거나 자기 자신이면 맨 위로 올린다", () => {
    const { roots, kids } = worktreeForest([wt("/a", "/gone"), wt("/b", "/b")]);
    expect(paths(roots)).toEqual(["/a", "/b"]);
    expect(kids.size).toBe(0);
  });

  it("부모 고리도 빠지지 않고 한 번씩만 나온다", () => {
    const { roots, kids } = worktreeForest([wt("/a", "/b"), wt("/b", "/a"), wt("/c")]);
    expect(paths(roots)).toEqual(["/c", "/a"]);
    expect(paths(descendantsOf("/a", kids))).toEqual(["/b"]);
  });
});

describe("lineageCounts", () => {
  it("보일 상태만 정해진 차례로 센다", () => {
    expect(lineageCounts(["done", "working", "inactive", "attention", "done", "ready"])).toEqual([
      ["attention", 1],
      ["working", 1],
      ["done", 2],
    ]);
    expect(lineageCounts(["inactive"])).toEqual([]);
  });
});
