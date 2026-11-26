// 대화 조각(ChatItem)을 화면 줄(Row)로 묶는다.
//
// - 도구 결과는 같은 id 의 도구 호출에 붙인다.
// - 이어지는 도구 호출은 한 묶음으로 그린다 (claude 화면처럼 한 줄씩).
// - 턴에 걸린 시간 알림은 줄로 그리지 않고 그 앞 답에 붙인다.

import type { ChatItem } from "@thuminal/term-core";

export interface ToolCall {
  id: string;
  at: number;
  name: string;
  input: Record<string, unknown>;
  /** 결과가 아직 없으면 null (도는 중이거나 사용자 답을 기다린다) */
  result: { text: string; isError: boolean; truncated: boolean; images: string[] } | null;
}

export type Row =
  | { kind: "user"; id: string; at: number; text: string; images: string[] }
  | { kind: "assistant"; id: string; at: number; text: string; turnMs?: number }
  | { kind: "thinking"; id: string; at: number; text: string }
  | { kind: "tools"; id: string; tools: ToolCall[] }
  | { kind: "notice"; id: string; at: number; type: string; text: string };

export interface Timeline {
  rows: Row[];
  /** 결과가 아직 없는 마지막 도구 호출 (묻는 창 · 권한 창을 그릴 때 본다) */
  open: ToolCall | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * 버려진 갈래를 뺀다. 막 보낸 글을 멈추면(또는 되감으면) claude 는 그 글을 대화에서 빼고 입력창에 되돌려 놓는다.
 * 기록에는 그 글이 남고, 다음 글이 같은 앞 줄(`parent`)에 다시 붙는다. 같은 앞 줄의 사용자 글이 또 나오면
 * 앞의 것부터 그 사이는 모두 버려진 갈래다 (claude 터미널 화면에서도 사라진다)
 */
export function dropAbandoned(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  const starts = new Map<string, number>();
  for (const it of items) {
    if (it.type === "user" && it.parent) {
      const from = starts.get(it.parent);
      if (from !== undefined) {
        out.length = from;
        for (const [k, v] of starts) if (v >= from) starts.delete(k);
      }
      starts.set(it.parent, out.length);
    }
    out.push(it);
  }
  return out;
}

export function buildTimeline(all: ChatItem[]): Timeline {
  const items = dropAbandoned(all);
  const rows: Row[] = [];
  const calls = new Map<string, ToolCall>();
  for (const it of items) {
    switch (it.type) {
      case "user":
        rows.push({ kind: "user", id: it.id, at: it.at, text: it.text, images: it.images ?? [] });
        break;
      case "assistant":
        rows.push({ kind: "assistant", id: it.id, at: it.at, text: it.text });
        break;
      case "thinking":
        rows.push({ kind: "thinking", id: it.id, at: it.at, text: it.text });
        break;
      case "tool_use": {
        const call: ToolCall = { id: it.id, at: it.at, name: it.name, input: obj(it.input), result: null };
        calls.set(it.id, call);
        const last = rows[rows.length - 1];
        if (last?.kind === "tools") last.tools.push(call);
        else rows.push({ kind: "tools", id: it.id, tools: [call] });
        break;
      }
      case "tool_result": {
        const call = calls.get(it.id);
        if (call) call.result = { text: it.text, isError: !!it.is_error, truncated: !!it.truncated, images: it.images ?? [] };
        break;
      }
      case "notice": {
        if (it.kind === "turn") {
          const last = [...rows].reverse().find((r) => r.kind === "assistant");
          if (last?.kind === "assistant") last.turnMs = Number(it.text) || undefined;
          break;
        }
        rows.push({ kind: "notice", id: it.id, at: it.at, type: it.kind, text: it.text });
        break;
      }
    }
  }
  // 멈추면 결과 없는 도구 호출이 남는다. 그 뒤에 다른 줄이 왔으면 기다리는 것이 아니다
  let open: ToolCall | null = null;
  const tail = rows[rows.length - 1];
  if (tail?.kind === "tools") open = [...tail.tools].reverse().find((t) => !t.result) ?? null;
  return { rows, open };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 도구 호출 한 줄 요약 (이름 옆에 쓸 글) */
export function toolSummary(t: ToolCall): string {
  const i = t.input;
  const first = (s: string) => s.split("\n")[0];
  switch (t.name) {
    case "Bash":
      return first(str(i.command));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str(i.file_path) || str(i.notebook_path);
    case "Grep":
    case "Glob":
      return [str(i.pattern), str(i.path)].filter(Boolean).join("  ");
    case "Agent":
    case "Task":
      return str(i.description) || first(str(i.prompt));
    case "WebFetch":
      return str(i.url);
    case "WebSearch":
      return str(i.query);
    case "Skill":
      return [str(i.skill), str(i.args)].filter(Boolean).join(" ");
    case "TodoWrite":
      return Array.isArray(i.todos) ? `할 일 ${i.todos.length}개` : "";
    case "AskUserQuestion": {
      // 질문이 여럿이면 첫 질문과 개수만 (한 줄에 다 늘어놓으면 읽히지 않는다)
      const qs = Array.isArray(i.questions) ? i.questions.map((x) => str(obj(x).question)) : [];
      const q = qs.length > 1 ? `${qs[0]} 외 ${qs.length - 1}개` : (qs[0] ?? "");
      // 답한 뒤에는 고른 답을 붙인다 (결과 글의 `"질문"="답"`)
      const answers = t.result && !t.result.isError ? [...t.result.text.matchAll(/"="([^"]*)"/g)].map((m) => m[1]) : [];
      return answers.length ? `${q} → ${answers.join(", ")}` : q;
    }
    default: {
      const v = Object.values(i).find((x) => typeof x === "string" && x);
      return first(str(v));
    }
  }
}

export interface Question {
  question: string;
  header: string;
  multi: boolean;
  options: { label: string; description: string }[];
}

/** 묻는 도구(AskUserQuestion)의 질문 목록. 다른 도구면 null */
export function questionsOf(t: ToolCall): Question[] | null {
  if (t.name !== "AskUserQuestion" || !Array.isArray(t.input.questions)) return null;
  const qs = t.input.questions.map((q) => {
    const o = obj(q);
    const options = Array.isArray(o.options) ? o.options.map((x) => ({ label: str(obj(x).label), description: str(obj(x).description) })) : [];
    return { question: str(o.question), header: str(o.header), multi: o.multiSelect === true, options };
  });
  return qs.length && qs.every((q) => q.options.length > 0 && q.options.length <= 8) ? qs : null;
}

export interface Answer {
  /** 고른 선택지 차례 */
  picks: number[];
  /** 직접 쓴 답 */
  other: string;
}

/**
 * 답을 claude 묻는 창에 넣을 키 차례 (묶음마다 틈을 두고 보낸다). Orca `buildAskAnswerKeys` 를 따르되,
 * 여러 개 고르기의 직접 쓴 답은 claude 2.1.332 에서 눌러 보고 맞췄다.
 * - 하나 고르기: 숫자 키가 고르고 다음 질문으로 넘어간다. 직접 쓴 답은 "Type something" 줄 번호(선택지 수 + 1), 글, Enter
 * - 여러 개 고르기: 숫자 키는 켜고 끄기만 한다 (커서는 첫 줄에 남는다). Tab 이 다음 탭으로 넘긴다.
 *   직접 쓴 답은 숫자로는 써지지 않아 ↓ 로 그 줄까지 내려가 쓰고, Tab(Submit 줄) · Enter 로 넘긴다
 * - 질문이 둘 이상이거나 여러 개 고르기 하나면 끝에 확인 화면이 나오고 Enter 가 보낸다
 */
export function answerKeys(qs: Question[], answers: Answer[]): string[] {
  const keys: string[] = [];
  qs.forEach((q, i) => {
    const a = answers[i] ?? { picks: [], other: "" };
    const other = a.other.trim();
    if (q.multi) {
      for (const n of a.picks) keys.push(String(n + 1));
      if (other) keys.push(...q.options.map(() => "\x1b[B"), other, "\t", "\r");
      else keys.push("\t");
    } else if (other) keys.push(String(q.options.length + 1), other, "\r");
    else if (a.picks.length) keys.push(String(a.picks[0] + 1));
    else if (qs.length > 1) keys.push("\x1b[C");
  });
  if ((qs.length > 1 || qs[0]?.multi) && keys.length) keys.push("\r");
  return keys;
}

/** 초를 "3초", "2분 5초" 로 */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/**
 * claude 터미널 화면 글에서 입력창에 든 글을 읽는다 (가로줄 두 개 사이, 첫 줄은 `❯ `, 이어지는 줄은 두 칸 들여 쓴다).
 * 입력창이 보이지 않으면 null
 */
export function tuiInputBox(screen: string): string | null {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (/^─{20,}$/.test(l) ? [i] : []));
  if (rules.length < 2) return null;
  const body = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]);
  if (!body.length || !body[0].startsWith("❯")) return null;
  return [body[0].slice(1).trimStart(), ...body.slice(1).map((l) => l.replace(/^ {1,2}/, ""))].join("\n").trim();
}
