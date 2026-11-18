import type { WorktreeGroup, WorktreeInfo } from "@thuminal/term-core";
import { describe, expect, it } from "vitest";

import { arrangeWorktrees, canGroup, effectiveGroup, groupColorVar, nextGroupColor, shiftWorktreeGroup } from "../src/worktree-groups";

function wt(path: string, opts: { parent?: string; group?: string; main?: boolean } = {}): WorktreeInfo {
  return { path, parent: opts.parent, group: opts.group, repo: "r", branch: path, is_main: !!opts.main } as unknown as WorktreeInfo;
}
const g = (id: string, color = "blue"): WorktreeGroup => ({ id, name: id, color });
const paths = (list: WorktreeInfo[]) => list.map((w) => w.path);

describe("effectiveGroup", () => {
  it("하위 워크트리는 자기 그룹 대신 맨 위 부모의 그룹을 따른다", () => {
    const all = [wt("/a", { group: "x" }), wt("/b", { parent: "/a", group: "y" }), wt("/c", { parent: "/b" })];
    const groups = [g("x"), g("y")];
    expect(effectiveGroup(all[1], all, groups)).toBe("x");
    expect(effectiveGroup(all[2], all, groups)).toBe("x");
  });

  it("메인 워크트리 밑과 지운 그룹은 그룹 밖이다", () => {
    const all = [wt("/m", { main: true, group: "x" }), wt("/a", { parent: "/m", group: "x" }), wt("/b", { group: "gone" })];
    expect(effectiveGroup(all[0], all, [g("x")])).toBeNull();
    expect(effectiveGroup(all[1], all, [g("x")])).toBeNull();
    expect(effectiveGroup(all[2], all, [g("x")])).toBeNull();
  });

  it("부모가 목록에 없으면 자기 그룹을 쓴다", () => {
    const w = wt("/a", { parent: "/gone", group: "x" });
    expect(effectiveGroup(w, [w], [g("x")])).toBe("x");
    expect(canGroup(w, [w])).toBe(true);
  });
});

describe("arrangeWorktrees", () => {
  it("main(과 그 밑) → 그룹 차례 → 그룹 밖. 비어 보이는 그룹은 뺀다", () => {
    const all = [
      wt("/m", { main: true }),
      wt("/m1", { parent: "/m" }),
      wt("/a", { group: "y" }),
      wt("/b"),
      wt("/c", { group: "x" }),
      wt("/c1", { parent: "/c" }),
      wt("/d", { group: "z" }),
    ];
    const list = all.filter((w) => w.path !== "/d");
    const r = arrangeWorktrees(list, all, [g("x"), g("y"), g("z")]);
    expect(paths(r.main)).toEqual(["/m", "/m1"]);
    expect(r.groups.map((x) => [x.group.id, paths(x.members)])).toEqual([
      ["x", ["/c", "/c1"]],
      ["y", ["/a"]],
    ]);
    expect(paths(r.loose)).toEqual(["/b"]);
  });
});

describe("그룹 색 · 차례", () => {
  it("아직 쓰지 않은 색을 먼저 고르고 회색은 맨 뒤다", () => {
    expect(nextGroupColor([])).toBe("blue");
    expect(nextGroupColor([g("a", "blue"), g("b", "red")])).toBe("yellow");
  });

  it("모르는 색은 회색으로 그린다", () => {
    expect(groupColorVar("green")).toBe("var(--wtg-green)");
    expect(groupColorVar("rainbow")).toBe("var(--wtg-grey)");
  });

  it("차례를 한 칸씩 옮기고 끝에서는 그대로 둔다", () => {
    const list = [g("a"), g("b"), g("c")];
    expect(shiftWorktreeGroup(list, "b", -1).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(shiftWorktreeGroup(list, "c", 1)).toBe(list);
  });
});
