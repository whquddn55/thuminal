// 알림: 에이전트가 일을 마치거나, 묻거나, 오류로 끝나거나, 터미널 벨·알림(OSC 9/777)이 오면 운영체제 알림을 띄운다.
//
// 데몬이 보내는 세션 정보가 바뀔 때 앞뒤를 견줘 정한다. 지금 보고 있는 칸(앱이 앞에 있고 그 칸이 보이는 탭에 있다)이면 띄우지 않는다.
// 에이전트 팀원은 리더가 알려 주므로 띄우지 않는다.

import type { SessionInfo } from "@thuminal/term-core";

export interface NotifySettings {
  /** 모두 끄기 */
  enabled: boolean;
  /** 에이전트가 일을 마쳤다 */
  done: boolean;
  /** 에이전트가 묻고 있다, 턴이 오류로 끝났다 */
  attention: boolean;
  /** 터미널 벨, 터미널이 보낸 알림 */
  bell: boolean;
  sound: boolean;
}

const KEY = "thuminal.notify";
const DEFAULTS: NotifySettings = { enabled: true, done: true, attention: true, bell: true, sound: true };

export function loadNotifySettings(): NotifySettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function saveNotifySettings(n: NotifySettings) {
  localStorage.setItem(KEY, JSON.stringify(n));
}

export interface Notice {
  kind: "done" | "attention" | "bell";
  subtitle: string;
  body: string;
}

const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const agentName = (a: { kind: string }) => (a.kind === "claude" ? "claude" : a.kind);

/** 세션 정보가 prev → next 로 바뀌었을 때 띄울 알림 (없으면 null) */
export function noticeFor(prev: SessionInfo | undefined, next: SessionInfo): Notice | null {
  if (next.labels["team.leader"]) return null;
  const a = next.agent;
  const p = prev?.agent;
  if (a) {
    const name = agentName(a);
    if (a.state === "needs_attention" && p?.state !== "needs_attention") {
      const what = a.tool_name ? `${a.tool_name} 를 써도 되는지` : "입력을";
      return { kind: "attention", subtitle: `${name} 가 묻고 있다`, body: clip(`${what} 기다린다${a.prompt ? ` · ${a.prompt}` : ""}`) };
    }
    if (a.state === "failed" && a.turn_ended_at && a.turn_ended_at !== p?.turn_ended_at) {
      return { kind: "attention", subtitle: `${name} 턴이 오류로 끝났다`, body: clip(a.last_assistant_message || a.prompt || "") };
    }
    if (a.state === "idle" && a.turn_ended_at && a.turn_ended_at !== p?.turn_ended_at) {
      return { kind: "done", subtitle: `${name} 가 일을 마쳤다`, body: clip(a.last_assistant_message || a.prompt || "") };
    }
  }
  if ((next.bell_at ?? 0) > (prev?.bell_at ?? 0) && prev) {
    return { kind: "bell", subtitle: "벨이 울렸다", body: clip(next.title) };
  }
  return null;
}

/** 이 종류의 알림을 띄울지 */
export function allowed(s: NotifySettings, kind: Notice["kind"]): boolean {
  return s.enabled && s[kind];
}
