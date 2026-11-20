// thuminal 세션 → 헬스장 사람. 상태는 데몬이 claude 훅으로 정한 것(`SessionInfo.agent`)을 그대로 쓴다.
//
// - claude 가 도는 세션 하나 = 팀장(어른) 하나. 팀원 세션(꼬리표 `team.leader`)은 그 리더 포드의 어린이다.
// - working → 운동, needs_attention → 운동 자리에 둔 채 "응답 대기", idle · failed → 쉬기.
// - 도구 수(`tool_count`)가 머리 위 횟수이고, 최근 1분 동안 늘어난 만큼 빨리 든다.
// - `tool_failed_at` 이 새로 바뀌거나 턴이 실패로 끝나면 바벨을 발등에 떨어뜨린다 (`oops`).
// 포드 · 팀원 자리 번호는 sleep-monitor 수집기(collector.ts assignDesks)와 같은 줄 서기 규칙으로 여기서 정한다.

import type { SessionInfo } from "@thuminal/term-core";

import { agentLabel } from "../agent-title";
import type { AgentInfo } from "./types";

const TEAM_LEADER = "team.leader";
const TEAM_NAME = "team.name";
const TEAM_COLOR = "team.color";

/** 세션마다 앞 상태와 비교해 알아내는 것 */
interface Track {
  count: number;
  tool: string | null;
  toolSince: number;
  working: boolean;
  busySince: number;
  failedAt: number;
  state: string;
  /** 도구를 부른 때 (최근 1분) */
  tools: number[];
}

export interface FeedResult {
  agents: AgentInfo[];
  /** 이번에 도구가 실패한 사람 key */
  oops: string[];
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export class GymFeed {
  private track = new Map<string, Track>();
  private podSlots = new Map<string, number>();
  private mateSlots = new Map<string, Map<string, number>>();
  private first = true;

  /** names: 워크트리 경로 → 화면 이름 */
  build(sessions: SessionInfo[], names: Map<string, string>, now: number): FeedResult {
    const agents: AgentInfo[] = [];
    const oops: string[] = [];
    const seen = new Set<string>();
    for (const s of sessions) {
      const a = s.agent;
      if (!a || s.state.state !== "running") continue;
      const key = `s:${s.id}`;
      seen.add(key);
      const leader = s.labels[TEAM_LEADER];
      const working = a.state === "working" || a.state === "needs_attention";
      const count = a.tool_count ?? 0;
      const failedAt = a.tool_failed_at ?? 0;
      let t = this.track.get(key);
      if (!t) {
        t = { count, tool: a.tool_name, toolSince: now, working, busySince: working ? a.updated_at : now, failedAt, state: a.state, tools: [] };
        this.track.set(key, t);
      } else {
        if (count > t.count) for (let i = 0; i < Math.min(30, count - t.count); i++) t.tools.push(now);
        if (count !== t.count || a.tool_name !== t.tool) t.toolSince = now;
        if (working && !t.working) t.busySince = now;
        if (!this.first && (failedAt > t.failedAt || (a.state === "failed" && t.state !== "failed"))) oops.push(key);
        t.count = count;
        t.tool = a.tool_name;
        t.working = working;
        t.failedAt = failedAt;
        t.state = a.state;
      }
      t.tools = t.tools.filter((x) => now - x < 60_000);
      const wt = s.labels.worktree;
      const place = (wt && names.get(wt)) || (wt ? baseName(wt) : s.labels.floating ? "플로팅" : baseName(a.cwd || s.cwd) || "~");
      agents.push({
        key,
        kind: leader ? "teammate" : "session",
        sessionId: String(s.id),
        parent: leader ? `s:${leader}` : undefined,
        name: leader ? s.labels[TEAM_NAME] || `팀원 ${s.id}` : place,
        title: leader ? undefined : (agentLabel(s) ?? undefined),
        color: leader ? s.labels[TEAM_COLOR] : undefined,
        status: leader ? (working ? "active" : "waiting") : working ? "busy" : "idle",
        attention: a.state === "needs_attention",
        startedAt: s.created_at,
        busySince: working ? t.busySince : undefined,
        lastActivity: a.updated_at,
        pendingTool: working && a.tool_name ? a.tool_name : undefined,
        pendingSince: working && a.tool_name ? t.toolSince : undefined,
        toolCount: count,
      });
    }
    for (const k of [...this.track.keys()]) if (!seen.has(k)) this.track.delete(k);
    this.assignDesks(agents);
    this.first = false;
    return { agents, oops };
  }

  /** 운동 빠르기 (1초에 몇 번): 최근 1분 동안 부른 도구가 많을수록 빨라진다 (sleep-monitor 와 같다) */
  repSpeed(key: string): number {
    return Math.min(2.6, 0.5 + (this.track.get(key)?.tools.length ?? 0) / 10);
  }

  // 팀장 포드 번호 · 팀원 자리 번호. 줄 서기처럼 번호를 매긴다: 새로 오면 맨 뒤에 붙고, 앞사람이 떠나면 뒷사람이 모두 한 칸씩 앞으로 당긴다.
  // 아래 규칙은 그림(sim.ts) 의 rootOf · wantMode 와 같다
  private assignDesks(people: AgentInfo[]) {
    const byKey = new Map(people.map((i) => [i.key, i]));
    const rootOf = (i: AgentInfo): AgentInfo => {
      if (i.kind !== "teammate") return i;
      let pk = i.parent ?? `s:${i.sessionId}`;
      for (let n = 0; n < 10; n++) {
        const p = byKey.get(pk);
        if (!p || p === i) return i;
        if (p.kind !== "teammate") return p;
        pk = p.parent ?? "";
      }
      return i;
    };
    const working = (i: AgentInfo) => i.status === "busy" || i.status === "shell" || i.status === "active";
    const leads: AgentInfo[] = [];
    const mates = new Map<string, AgentInfo[]>();
    for (const i of people) {
      const r = rootOf(i);
      if (r === i) leads.push(i);
      else mates.set(r.key, [...(mates.get(r.key) ?? []), i]);
    }
    // 팀장이 쉬러 가도 팀원이 앉아 있으면 포드는 남겨 둔다
    const seated = leads.filter((i) => working(i) || mates.has(i.key));
    queueSlots(this.podSlots, seated, (i) => i.busySince ?? i.lastActivity);
    for (const k of this.mateSlots.keys()) if (!this.podSlots.has(k)) this.mateSlots.delete(k);
    for (const i of people) i.podSlot = this.podSlots.get(i.key);
    for (const [root, list] of mates) {
      if (!this.podSlots.has(root)) continue;
      const slots = this.mateSlots.get(root) ?? new Map<string, number>();
      this.mateSlots.set(root, slots);
      queueSlots(slots, list, (i) => i.startedAt ?? i.lastActivity);
      for (const i of list) i.mateSlot = slots.get(i.key);
    }
  }
}

// 줄 세우기: want 에 없는 key 는 빠지고, 남은 것은 순서를 지킨 채 0 번부터 빈틈없이 당기고, 새로 온 것은 order 순서로 맨 뒤에 붙는다
function queueSlots(slots: Map<string, number>, want: AgentInfo[], order: (i: AgentInfo) => number) {
  const keys = new Set(want.map((i) => i.key));
  const kept = [...slots]
    .filter(([k]) => keys.has(k))
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
  const fresh = want.filter((i) => !slots.has(i.key)).sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key));
  slots.clear();
  [...kept, ...fresh.map((i) => i.key)].forEach((k, n) => slots.set(k, n));
}
