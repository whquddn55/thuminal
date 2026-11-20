// 헬스장 화면(sleep-monitor 에서 가져온 그림)이 받는 사람 정보. `feed.ts` 가 thuminal 세션에서 만든다.
// 그림 코드(sim.ts)가 sleep-monitor 와 같은 모양을 읽으므로 이름 · 뜻을 그대로 둔다.

export type AgentKind = "session" | "subagent" | "teammate";

export type AgentStatus =
  | "busy" // 세션이 일하는 중
  | "idle" // 세션이 입력을 기다리는 중
  | "shell" // 세션이 셸 명령을 돌리는 중 (thuminal 은 쓰지 않는다)
  | "active" // 팀원이 일하는 중
  | "waiting" // 팀원이 지시를 기다리는 중
  | "done"; // 서브에이전트가 끝남 (thuminal 은 쓰지 않는다)

export interface AgentInfo {
  key: string; // "s:<세션 번호>"
  kind: AgentKind;
  sessionId: string;
  parent?: string; // 팀원이면 리더 key
  name: string;
  title?: string; // 세션 주제 (claude 가 정한 제목 · 마지막 프롬프트)
  color?: string; // 팀원 색 이름 (blue, green, ...)
  status: AgentStatus;
  /** 권한 확인 등 사용자를 부르고 있다 (일하는 자리에 그대로 둔다) */
  attention?: boolean;
  startedAt?: number;
  busySince?: number;
  lastActivity: number;
  pendingTool?: string; // 지금 쓰는 도구
  pendingSince?: number;
  toolCount: number;
  podSlot?: number; // 팀장이 앉을 포드 번호 (0 이 화면 가운데)
  mateSlot?: number; // 팀원이 팀장 포드에서 앉을 자리 번호
}
