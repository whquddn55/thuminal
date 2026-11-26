// claude 터미널 화면에 뜬 고르기 창을 읽는다. 대화 보기는 이 창을 카드로 그리고, 고르면 같은 키를 PTY 에 넣는다.
//
// claude 는 권한 묻기 · 계획 승인 · 되감기 확인을 모두 번호 고르기 창으로 띄운다 (claude 2.1.332 에서 확인):
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and always allow access to … from this project
//     4. No
// 되감기(Esc 두 번)는 번호 없는 목록이다 ("Rewind" 머리 · 사용자 글과 코드 변경 줄이 짝 · 맨 끝 "(current)").
// 화면 글은 claude 버전마다 바뀌므로 모양으로만 찾는다. 커서(`❯`)가 든 덩이만 창으로 본다 (답 속 번호 목록과 가른다).

export interface TuiOption {
  label: string;
  /** 번호 창이면 그 번호 */
  key?: string;
  /** 되감기 목록: 그 줄의 코드 변경 ("No code changes" 등) */
  detail?: string;
}

export interface TuiMenu {
  kind: "numbered" | "rewind";
  /** 창 질문 ("Do you want to proceed?"). 모르면 빈 글 */
  title: string;
  options: TuiOption[];
  /** 커서가 있는 줄 */
  cursor: number;
}

const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
/** 고르기 창 밑 안내 줄 (창의 끝) */
const FOOTER = /^\s*(Esc to|Enter to|ctrl\+|Tab to|↑|\(current\)$)/i;
/** 키 안내만 든 이어지는 줄 ("(shift+tab)", "shift+tab to approve with this feedback") */
const KEY_HINT = /shift\+tab|ctrl\+|\btab to\b|\besc\b/i;

export function parseTuiMenu(screen: string): TuiMenu | null {
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  return rewindMenu(lines) ?? numberedMenu(lines);
}

function numberedMenu(lines: string[]): TuiMenu | null {
  // 맨 아래에서부터 `1.` 로 시작하는 덩이를 찾는다
  for (let start = lines.length - 1; start >= 0; start--) {
    const first = OPTION.exec(lines[start]);
    if (!first || first[2] !== "1") continue;
    const options: TuiOption[] = [];
    let cursor = -1;
    const indent = lines[start].search(/\S/);
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const m = OPTION.exec(l);
      if (m && Number(m[2]) === options.length + 1) {
        if (m[1]) cursor = options.length;
        options.push({ key: m[2], label: m[3] });
        continue;
      }
      if (m) {
        // 번호가 건너뛴 창도 있다 (항목을 감춘 창). 더 큰 번호면 받는다
        if (Number(m[2]) > Number(options[options.length - 1]?.key ?? 0)) {
          if (m[1]) cursor = options.length;
          options.push({ key: m[2], label: m[3] });
          continue;
        }
        break;
      }
      // 더 들여 쓴 줄은 앞 항목이 이어지는 줄이다
      if (l.search(/\S/) > indent && !FOOTER.test(l) && options.length) {
        if (!KEY_HINT.test(l)) options[options.length - 1].label += ` ${l.trim()}`;
        continue;
      }
      break;
    }
    if (options.length < 2 || cursor < 0) return null;
    // 질문은 창 바로 위 몇 줄 안의 `?` 로 끝나는 줄
    let title = "";
    for (let i = start - 1; i >= Math.max(0, start - 4); i--) {
      const t = lines[i].trim();
      if (t.endsWith("?")) {
        title = t;
        break;
      }
    }
    return { kind: "numbered", title, options, cursor };
  }
  return null;
}

function rewindMenu(lines: string[]): TuiMenu | null {
  let head = -1;
  for (let i = lines.length - 1; i >= 0 && head < 0; i--) if (lines[i].trim() === "Rewind") head = i;
  if (head < 0) return null;
  const end = lines.findIndex((l, i) => i > head && /^\s*Enter to continue/.test(l));
  if (end < 0) return null;
  // 머리 다음 설명 줄("Restore the code and/or conversation …")까지 건너뛴다
  const rest = lines.slice(head + 1, end).filter((l) => l.trim());
  const desc = rest.findIndex((l) => /^\s*Restore\b/.test(l));
  const body = rest.slice(desc + 1);
  const options: TuiOption[] = [];
  let cursor = -1;
  for (let i = 0; i < body.length; i++) {
    const raw = body[i];
    const mark = /^\s*❯/.test(raw);
    const text = raw.replace(/^\s*❯?\s*/, "");
    if (text === "(current)") {
      if (mark) cursor = options.length;
      options.push({ label: "(지금)" });
      continue;
    }
    if (mark) cursor = options.length;
    // 사용자 글 다음 줄은 그 지점의 코드 변경이다
    const detail = body[i + 1] && !/^\s*❯/.test(body[i + 1]) && body[i + 1].trim() !== "(current)" ? body[i + 1].trim() : undefined;
    options.push({ label: text, detail });
    if (detail !== undefined) i++;
  }
  if (!options.length || cursor < 0) return null;
  return { kind: "rewind", title: "", options, cursor };
}

/** 되감기 목록에서 target 줄로 가서 고르는 키 (위 · 아래 화살표 후 Enter) */
export function rewindKeys(menu: TuiMenu, target: number): string[] {
  const move = target - menu.cursor;
  return [...Array<string>(Math.abs(move)).fill(move < 0 ? "\x1b[A" : "\x1b[B"), "\r"];
}

/** 터미널 색 코드(SGR)를 조각으로 나눈다. 그 밖의 제어 문자열은 뺀다 (도구 결과 글) */
export interface AnsiPiece {
  text: string;
  /** 0~15 기본 색 번호 */
  fg?: number;
  bold?: boolean;
}

export function ansiPieces(s: string): AnsiPiece[] {
  // 색이 아닌 제어 문자열: CSI(색 말고), OSC, 문자 집합 고르기, 저장 · 되돌리기
  const clean = s.replace(/\x1b\[[\d;?<>=]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[78=>]|[\x0e\x0f]/g, "");
  const out: AnsiPiece[] = [];
  let fg: number | undefined;
  let bold = false;
  let last = 0;
  const re = /\x1b\[([\d;]*)m/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (m.index > last) out.push({ text: clean.slice(last, m.index), fg, bold });
    last = m.index + m[0].length;
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) (fg = undefined), (bold = false);
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) fg = c - 30;
      else if (c >= 90 && c <= 97) fg = c - 90 + 8;
      else if (c === 39) fg = undefined;
      else if (c === 38 && codes[i + 1] === 5) {
        const n = codes[i + 2];
        fg = n !== undefined && n < 16 ? n : undefined;
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) i += 4;
      else if (c === 48 && codes[i + 1] === 5) i += 2;
      else if (c === 48 && codes[i + 1] === 2) i += 4;
    }
  }
  if (last < clean.length) out.push({ text: clean.slice(last), fg, bold });
  return out;
}
