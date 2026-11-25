// 새 탭 메뉴에서 띄울 수 있는 에이전트 명령.

/** 새 탭 메뉴에 보일 수 있는 에이전트. 로그인 셸 PATH 에 있는 것만 보인다. name 은 새 탭 메뉴에 쓰는 짧은 이름이다 (Orca 와 같다) */
export const AGENTS: { cmd: string; label: string; name: string }[] = [
  { cmd: "claude", label: "Claude Code", name: "Claude" },
  { cmd: "codex", label: "Codex", name: "Codex" },
  // Gemini CLI 는 구글이 접었고 Antigravity CLI(`agy`)가 그 자리를 잇는다
  { cmd: "agy", label: "Antigravity", name: "Antigravity" },
  { cmd: "opencode", label: "OpenCode", name: "OpenCode" },
  { cmd: "cursor-agent", label: "Cursor Agent", name: "Cursor" },
];
