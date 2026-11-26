// 대화 보기 입력창의 `/` 명령 목록.
//
// claude 는 명령 목록을 밖으로 내주지 않아 자주 쓰는 것을 손으로 적어 둔다 (Orca 도 같은 방식이다).
// 여기 없는 명령도 그대로 쳐서 보낼 수 있다.
// Orca 의 터미널 채팅 보기와 같은 방식이다:
// - 목록에는 대화 보기 안에서 끝나는 명령만 올린다. `args` 가 있는 명령(/model, /effort)은 고르면 값 목록이 이어 뜨고,
//   값을 붙여 보내면(`/model sonnet`) claude 가 고르는 창을 띄우지 않고 바로 바꾼다. 값 없이는 보내지 않는다.
//   `/resume` 의 값은 데몬이 읽어 준 지난 대화 목록이다 (받지 못했으면 목록에 올리지 않는다).
// - 스킬 · 사용자 명령은 데몬이 claude 에게 물어 받은 것을 그 뒤에 잇는다 (claude 의 `/` 목록과 같다).
//   줄마다 종류(`kind`: 스킬 · 명령 · 내장)와 정의된 범위(`scope`: 프로젝트 · 사용자 …)를 칸으로 보인다. 정의 파일(`where`)은 툴팁이다.
// - 목록에 없는 명령(/config …)은 쳐서 보낼 수 있지만 claude 가 터미널 화면에 창을 띄운다. 그때는 원본에서 잇는다.

export interface SlashChoice {
  value: string;
  desc: string;
  /** 목록에 값 대신 보일 이름 (지난 대화의 제목). 이것으로도 찾는다 */
  label?: string;
}

export interface SlashCommand {
  name: string;
  desc: string;
  /** 붙여 보낼 수 있는 값. 값을 붙이면 창 없이 바로 된다 */
  args?: SlashChoice[];
  /** 종류: "내장" · "스킬" · "명령" */
  kind?: string;
  /** 정의된 범위: "프로젝트" · "사용자" · "로컬" … (플러그인 것은 플러그인을 설치한 범위) */
  scope?: string;
  /** 정의 파일 경로 (스킬 · 사용자 명령) */
  where?: string;
}

/** 정의된 범위의 화면 이름 */
const SCOPES: Record<string, string> = { managed: "조직", project: "프로젝트", user: "사용자", local: "로컬", account: "계정", app: "앱" };

/**
 * 스킬 · 사용자 명령의 종류와 정의된 범위. 스킬 · 명령 파일의 범위는 조직 · 사용자 · 프로젝트이고,
 * 로컬은 플러그인을 그 폴더에서 나만 쓰게 설치했을 때만 있다. 플러그인 이름은 명령 이름(`플러그인:이름`)에 이미 있어 적지 않는다
 */
export function commandTags(c: { kind?: string; source?: string }): { kind: string; scope: string } {
  return { kind: c.kind === "skill" ? "스킬" : c.kind === "command" ? "명령" : "", scope: SCOPES[c.source ?? ""] ?? "" };
}

/** 모델 목록을 claude 에게서 받지 못했을 때 쓰는 이름 (claude 가 받는 줄임 이름) */
export const SEED_MODELS: SlashChoice[] = [
  { value: "default", desc: "계정 기본 모델" },
  { value: "opus", desc: "" },
  { value: "fable", desc: "" },
  { value: "sonnet", desc: "" },
  { value: "haiku", desc: "" },
];

/** 생각 강도 값은 이름(low … max)이 곧 순서라 설명을 붙이지 않는다 */
export const effortChoices = (levels: string[]): SlashChoice[] => levels.map((value) => ({ value, desc: "" }));
export const SEED_EFFORTS = effortChoices(["low", "medium", "high", "xhigh", "max"]);

/**
 * 대화 보기 안에서 끝나는 claude 명령. models · efforts 는 claude 에게서 받은 것 (없으면 손으로 적어 둔 것),
 * sessions 는 이어 갈 수 있는 지난 대화 (없으면 `/resume` 을 올리지 않는다), skills 는 claude 가 알려 준 스킬 · 사용자 명령
 */
export function claudeCommands(
  models: SlashChoice[] = SEED_MODELS,
  efforts: SlashChoice[] = SEED_EFFORTS,
  sessions: SlashChoice[] = [],
  skills: SlashCommand[] = [],
): SlashCommand[] {
  const builtin: SlashCommand[] = [
    { name: "clear", desc: "대화를 비우고 새로 시작" },
    { name: "compact", desc: "대화를 요약해 줄이기" },
    ...(sessions.length ? [{ name: "resume", desc: "지난 대화 이어 가기", args: sessions }] : []),
    { name: "model", desc: "모델 바꾸기", args: models },
    { name: "effort", desc: "생각 강도 바꾸기", args: efforts },
    { name: "context", desc: "컨텍스트 사용량 보기" },
    { name: "init", desc: "CLAUDE.md 만들기" },
    { name: "review", desc: "지금 변경을 리뷰" },
    { name: "exit", desc: "claude 를 끝내고 터미널로" },
  ];
  const own = builtin.map((c) => ({ ...c, kind: "내장" }));
  return [...own, ...skills.filter((s) => !own.some((c) => c.name === s.name))];
}

/** 목록의 한 줄: 고르면 `text` 가 입력창에 들어간다. `send` 면 바로 보낸다 */
export interface SlashItem {
  key: string;
  label: string;
  desc: string;
  text: string;
  send: boolean;
  /** 이름이 긴 글(대화 제목)이다: 이름에 자리를 넓게 주고 설명은 오른쪽 끝에 둔다 */
  wide?: boolean;
  /** 명령의 종류 · 범위 · 정의 파일 (`SlashCommand` 것 그대로) */
  kind?: string;
  scope?: string;
  where?: string;
}

/**
 * 입력에 맞는 목록. `/낱말` 이면 명령들, `/model 값` 처럼 값이 있는 명령 뒤면 그 값들. 그 밖이면 null (목록을 띄우지 않는다)
 */
export function slashItems(text: string, commands: SlashCommand[]): SlashItem[] | null {
  const arg = /^\/([\w:.-]+) (\S*)$/.exec(text);
  if (arg) {
    const cmd = commands.find((c) => c.name === arg[1]);
    if (!cmd?.args) return null;
    const q = arg[2].toLowerCase();
    return cmd.args
      .filter((a) => a.value.startsWith(q) || !!a.label?.toLowerCase().includes(q))
      .map((a) => ({ key: `${cmd.name} ${a.value}`, label: a.label ?? a.value, wide: !!a.label, desc: a.desc, text: `/${cmd.name} ${a.value}`, send: true }));
  }
  const m = /^\/([\w:.-]*)$/.exec(text);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const starts = commands.filter((c) => c.name.startsWith(q));
  const has = q ? commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q)) : [];
  return [...starts, ...has].map((c) => ({
    key: c.name,
    label: `/${c.name}`,
    desc: c.desc,
    // 값이 있는 명령은 값 목록으로 넘어간다
    text: c.args ? `/${c.name} ` : `/${c.name}`,
    send: !c.args,
    kind: c.kind,
    scope: c.scope,
    where: c.where,
  }));
}

/** 값이 있어야 하는 명령을 값 없이 쳤으면 그 명령 (보내지 않고 값 목록을 띄운다) */
export function needsArg(text: string, commands: SlashCommand[]): SlashCommand | null {
  const m = /^\/([\w:.-]+)\s*$/.exec(text);
  return (m && commands.find((c) => c.name === m[1] && c.args)) || null;
}

/** 보낸 글이 목록에 없는 슬래시 명령이면 그 이름. claude 가 터미널 화면에 창을 띄울 수 있다 */
export function unknownCommand(text: string, commands: SlashCommand[]): string | null {
  const m = /^\/([\w:.-]+)/.exec(text);
  return m && !commands.some((c) => c.name === m[1]) ? `/${m[1]}` : null;
}

/** 모델 id(`claude-sonnet-5-5`)를 화면 이름(`Sonnet 5.5`)으로. 이미 이름이면 그대로 */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** 토큰 수를 `43K` · `1M` 로 */
export function tokenLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
