import type { AgentInfo } from "./types";

export function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 팀원 색 이름 → 색 (데몬 teams.rs 가 claude 에게 받은 이름) */
const TEAM_COLORS: Record<string, string> = {
  blue: "#5aa9ff",
  green: "#3ddc97",
  yellow: "#ffd75e",
  purple: "#b48cff",
  orange: "#ff9f4a",
  pink: "#ff6fb5",
  red: "#ff5c6c",
  cyan: "#4fe3f0",
};

export function agentColor(a: AgentInfo): string {
  if (a.color && TEAM_COLORS[a.color]) return TEAM_COLORS[a.color];
  let h = 0;
  for (const c of a.key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  // 황금각으로 흩어 비슷한 key 도 색이 멀어지게 한다
  return `hsl(${Math.round((h % 1000) * 137.508) % 360} 85% 66%)`;
}
