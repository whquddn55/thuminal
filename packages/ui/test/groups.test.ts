import { DEFAULT_GROUP, type RepoGroup, type RepoInfo } from "@thuminal/term-core";
import { describe, expect, it } from "vitest";

import { moveRepo, normalizeGroups, removeGroup, shiftGroup } from "../src/groups";

const repo = (id: string): RepoInfo => ({ id, name: id, path: `/w/${id}` });
const g = (id: string, repos: string[], name = id): RepoGroup => ({ id, name, repos });
const shape = (list: RepoGroup[] | null) => list?.map((x) => `${x.id}:${x.repos.join(",")}`);

describe("normalizeGroups", () => {
  it("목록이 없으면 기본 하나에 모든 프로젝트", () => {
    expect(normalizeGroups([], [repo("a"), repo("b")])).toEqual([{ id: DEFAULT_GROUP, name: "기본", repos: ["a", "b"] }]);
  });

  it("없는 저장소는 빼고, 두 곳에 든 것은 앞 것만, 어디에도 없는 것은 기본 끝에", () => {
    const got = normalizeGroups([g("x", ["c", "gone", "a"]), g(DEFAULT_GROUP, ["b"]), g("y", ["a"])], [repo("a"), repo("b"), repo("c"), repo("d")]);
    expect(shape(got)).toEqual(["x:c,a", "default:b,d", "y:"]);
  });
});

describe("moveRepo", () => {
  const groups = [g(DEFAULT_GROUP, ["a", "b", "c"]), g("x", ["d"])];

  it("다른 워크스페이스 끝이나 자리로", () => {
    expect(shape(moveRepo(groups, "b", "x"))).toEqual(["default:a,c", "x:d,b"]);
    expect(shape(moveRepo(groups, "b", "x", 0))).toEqual(["default:a,c", "x:b,d"]);
  });

  it("같은 워크스페이스 안에서 뒤로 옮기면 자기 자리만큼 당긴다", () => {
    // c 앞(2)에 놓기: a, b 차례 그대로라 바뀐 것이 없다
    expect(moveRepo(groups, "b", DEFAULT_GROUP, 2)).toBeNull();
    expect(shape(moveRepo(groups, "a", DEFAULT_GROUP, 3))).toEqual(["default:b,c,a", "x:d"]);
    expect(shape(moveRepo(groups, "c", DEFAULT_GROUP, 0))).toEqual(["default:c,a,b", "x:d"]);
  });

  it("없는 워크스페이스로는 옮기지 않는다", () => {
    expect(moveRepo(groups, "a", "nope")).toBeNull();
  });
});

describe("shiftGroup · removeGroup", () => {
  const groups = [g(DEFAULT_GROUP, ["a"]), g("x", ["b"]), g("y", [])];

  it("위아래로 옮기고, 끝에서는 못 옮긴다", () => {
    expect(shape(shiftGroup(groups, "y", -1))).toEqual(["default:a", "y:", "x:b"]);
    expect(shiftGroup(groups, DEFAULT_GROUP, -1)).toBeNull();
    expect(shiftGroup(groups, "y", 1)).toBeNull();
  });

  it("지우면 든 프로젝트는 기본 끝으로, 기본은 못 지운다", () => {
    expect(shape(removeGroup(groups, "x"))).toEqual(["default:a,b", "y:"]);
    expect(removeGroup(groups, DEFAULT_GROUP)).toBeNull();
  });
});
