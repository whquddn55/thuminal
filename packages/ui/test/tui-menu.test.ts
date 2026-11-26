import { describe, expect, it } from "vitest";

import { ansiPieces, parseTuiMenu, rewindKeys } from "../src/chat/tui-menu";

// claude 2.1.332 터미널 화면에서 찍은 글 그대로다
const PERMISSION = `  ⎿  $ touch b2.txt
──────────────────────────────────────────────────
 Bash command
 Create empty file b2.txt with touch
 touch b2.txt
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/work from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;

const EDIT = ` Do you want to make this edit to a.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session
      (shift+tab)
   3. No
 Esc to cancel · Tab to amend`;

const PLAN = `   계획
   1. a.txt 의 끝 줄바꿈 여부를 확인한다 (현재 내용: hi).
   2. 기존 hi 는 그대로 두고, 맨 끝에 새 줄 하나를 덧붙인다.
   3. 파일을 다시 읽어 마지막 줄이 의도대로 들어갔는지 확인한다.
  ──────────────────────────────────────────────
   Claude has written up a plan and is ready to execute. Would you like to proceed?
   ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback
   ctrl+g to edit in Vim ·`;

const REWIND = `▔▔▔▔▔▔▔▔▔▔
  Rewind
  Restore the code and/or conversation to the point before…
    한 낱말로만 답해: 하나
    No code changes
    한 낱말로만 답해: 둘
    No code changes
  ❯ (current)
  Enter to continue · Esc to cancel`;

const REWIND_GAP = `  Rewind

  Restore the code and/or conversation to the point before…

    Bash 로 touch c3.txt 를 실행해
    Code changes unknown
  ❯ (current)
  Enter to continue · Esc to cancel`;

const REWIND_CONFIRM = `  Rewind
  Restore to the point before you sent this message:
  │ 한 낱말로만 답해: 둘
  The conversation goes back to before this message.
  ❯ 1. Restore conversation
    2. Summarize from here
    3. Summarize up to here
    4. Never mind`;

describe("claude 고르기 창 읽기", () => {
  it("권한 묻기 창: 질문과 번호 항목", () => {
    const m = parseTuiMenu(PERMISSION)!;
    expect(m.kind).toBe("numbered");
    expect(m.title).toBe("Do you want to proceed?");
    expect(m.options.map((o) => o.key)).toEqual(["1", "2", "3", "4"]);
    expect(m.options[1].label).toBe("Yes, and always allow access to /tmp/work from this project");
    expect(m.cursor).toBe(0);
  });

  it("이어지는 줄은 앞 항목에 붙이고, 키 안내 줄은 뺀다", () => {
    const m = parseTuiMenu(EDIT)!;
    expect(m.options.map((o) => o.label)).toEqual(["Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session", "No"]);
  });

  it("계획 승인 창: 계획 속 번호 목록이 아니라 커서가 있는 창을 읽는다", () => {
    const m = parseTuiMenu(PLAN)!;
    expect(m.title).toBe("Claude has written up a plan and is ready to execute. Would you like to proceed?");
    expect(m.options.map((o) => o.label)).toEqual(["Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session", "Yes, manually approve edits", "Tell Claude what to change"]);
  });

  it("커서가 없는 번호 목록(답 속 목록)은 창이 아니다", () => {
    expect(parseTuiMenu("1. 하나\n2. 둘\n3. 셋")).toBeNull();
  });

  it("되감기 목록: 사용자 글과 코드 변경을 짝짓고, 고를 줄로 옮기는 키를 만든다", () => {
    const m = parseTuiMenu(REWIND)!;
    expect(m.kind).toBe("rewind");
    expect(m.options).toEqual([
      { label: "한 낱말로만 답해: 하나", detail: "No code changes" },
      { label: "한 낱말로만 답해: 둘", detail: "No code changes" },
      { label: "(지금)" },
    ]);
    expect(m.cursor).toBe(2);
    expect(rewindKeys(m, 0)).toEqual(["\x1b[A", "\x1b[A", "\r"]);
  });

  it("되감기 목록 사이에 빈 줄이 있어도 설명 줄을 건너뛴다", () => {
    expect(parseTuiMenu(REWIND_GAP)!.options).toEqual([{ label: "Bash 로 touch c3.txt 를 실행해", detail: "Code changes unknown" }, { label: "(지금)" }]);
  });

  it("되감기 확인 창은 번호 창이다", () => {
    const m = parseTuiMenu(REWIND_CONFIRM)!;
    expect(m.kind).toBe("numbered");
    expect(m.options[0]).toEqual({ key: "1", label: "Restore conversation" });
  });
});

describe("터미널 색 코드", () => {
  it("색 · 굵게를 조각으로 나누고 다른 제어 문자열은 뺀다", () => {
    expect(ansiPieces("\x1b[31m빨강\x1b[0m 보통 \x1b[1;92m굵은 초록\x1b[m\x1b[?25l끝")).toEqual([
      { text: "빨강", fg: 1, bold: false },
      { text: " 보통 ", fg: undefined, bold: false },
      { text: "굵은 초록", fg: 10, bold: true },
      { text: "끝", fg: undefined, bold: false },
    ]);
  });
});
