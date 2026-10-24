// 새 탭 메뉴에서 띄울 수 있는 에이전트 명령.

/** 새 탭 메뉴에 보일 수 있는 에이전트. 로그인 셸 PATH 에 있는 것만 보인다 */
export const AGENTS: { cmd: string; label: string }[] = [
  { cmd: "claude", label: "Claude Code" },
  { cmd: "codex", label: "Codex" },
  { cmd: "gemini", label: "Gemini CLI" },
  { cmd: "opencode", label: "OpenCode" },
  { cmd: "cursor-agent", label: "Cursor Agent" },
];
