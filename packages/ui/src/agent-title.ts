// 에이전트 세션을 목록에 보일 이름 (데스크톱 사이드바 · 폰 첫 화면이 같이 쓴다).

import type { SessionInfo } from "@thuminal/term-core";

/**
 * claude 가 터미널 제목으로 정한 주제. 앞의 상태 표시(✳, 점자 스피너)를 떼고, 주제를 아직 못 정한 기본 제목이면 null.
 * claude 는 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 가 켜져 있으면 주제를 만들지 않아 기본 제목에 머문다
 */
export function agentTopic(title: string): string | null {
  const t = title.replace(/^[⠀-⣿✳✻✽✶✢·*\s]+/, "").trim();
  return t && !/^(claude code|claude)$/i.test(t) ? t : null;
}

/**
 * 에이전트 이름: claude 가 정한 주제, 없으면 마지막 프롬프트. 백그라운드 작업 알림(`<task-notification>…`)처럼
 * claude 가 스스로 넣은 프롬프트는 이름으로 쓰지 않는다
 */
export function agentLabel(s: SessionInfo): string | null {
  const prompt = s.agent?.prompt?.trim();
  return agentTopic(s.title) || (prompt && !prompt.startsWith("<") ? prompt : null);
}
