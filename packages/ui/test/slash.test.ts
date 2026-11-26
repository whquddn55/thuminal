import { describe, expect, it } from "vitest";

import { claudeCommands, needsArg, slashItems, unknownCommand } from "../src/chat/slash";

describe("대화 보기 / 명령", () => {
  const past = [
    { value: "aaaa-1111", label: "알림 개수 배지", desc: "3시간 전" },
    { value: "bbbb-2222", label: "Windows 브라우저 칸", desc: "2일 전" },
  ];

  it("지난 대화가 있으면 /resume 이 제목 목록으로 이어지고, 고르면 id 를 붙여 보낸다", () => {
    const cmds = claudeCommands(undefined, undefined, past);
    expect(needsArg("/resume", cmds)?.name).toBe("resume");
    expect(slashItems("/resume ", cmds)?.map((i) => [i.label, i.text, i.send])).toEqual([
      ["알림 개수 배지", "/resume aaaa-1111", true],
      ["Windows 브라우저 칸", "/resume bbbb-2222", true],
    ]);
    // 제목이나 id 앞머리로 찾는다
    expect(slashItems("/resume windows", cmds)?.map((i) => i.text)).toEqual(["/resume bbbb-2222"]);
    expect(slashItems("/resume aaaa", cmds)?.map((i) => i.text)).toEqual(["/resume aaaa-1111"]);
    expect(unknownCommand("/resume aaaa-1111", cmds)).toBeNull();
  });

  it("지난 대화를 받지 못했으면 /resume 은 목록에 없는 명령이다 (원본에서 잇는다)", () => {
    const cmds = claudeCommands();
    expect(needsArg("/resume", cmds)).toBeNull();
    expect(unknownCommand("/resume", cmds)).toBe("/resume");
  });

  it("claude 가 알려 준 스킬은 내장 명령 뒤에 잇고, 이름이 겹치면 내장 명령을 둔다", () => {
    const cmds = claudeCommands(undefined, undefined, [], [
      { name: "thuthi:setup", desc: "점검" },
      { name: "clear", desc: "겹치는 이름" },
    ]);
    expect(cmds.filter((c) => c.name === "clear").map((c) => c.desc)).toEqual(["대화를 비우고 새로 시작"]);
    expect(slashItems("/setup", cmds)?.map((i) => [i.text, i.send])).toEqual([["/thuthi:setup", true]]);
    expect(unknownCommand("/thuthi:setup", cmds)).toBeNull();
  });

  it("/exit 는 목록에 있고 바로 보낸다", () => {
    expect(slashItems("/exi", claudeCommands())?.map((i) => [i.text, i.send])).toEqual([["/exit", true]]);
  });
});

describe("claude 터미널 화면의 입력창 읽기", () => {
  const rule = "─".repeat(60);
  it("가로줄 사이의 글을 읽고, 접힌 줄의 들여쓰기를 뗀다", async () => {
    const { tuiInputBox } = await import("../src/chat/timeline");
    const screen = ["⏺ 답", "", rule, "❯ 첫 글이에요 길게 써서", "  다음 줄로 접혔어요", rule, "  5h – │ 7d 1%", "  ⏵⏵ bypass permissions on"].join("\n");
    expect(tuiInputBox(screen)).toBe("첫 글이에요 길게 써서\n다음 줄로 접혔어요");
    expect(tuiInputBox([rule, "❯ ", rule].join("\n"))).toBe("");
    // 입력창이 없는 화면(묻는 창 등)
    expect(tuiInputBox("Do you want to proceed?\n❯ 1. Yes")).toBeNull();
  });
});
