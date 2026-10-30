// 앱 단축키 표와 사용자가 바꾼 키. 터미널 글꼴처럼 이 브라우저(localStorage)에 남긴다.
//
// 키는 macOS 글자(`⇧⌘D`, `⌃⌘←`)로 적는다. 수정키 차례는 ⌃⌥⇧⌘ 이고, 키 이름은 누른 자리(`KeyboardEvent.code`)로 정한다
// (⌥ 를 누르면 `key` 가 다른 글자로 바뀌기 때문이다). Windows · Linux 는 `appMods` 로 macOS 자리로 읽은 뒤 같은 표를 쓴다.
// 1~9 로 고르는 동작(`digits`)은 수정키만 정하고 키는 `1~9` 로 적는다 (`⌘1~9`).

import { useSyncExternalStore } from "react";

import { appMods, keyLabel } from "./platform";

export type ShortcutGroup = "화면" | "탭 · 칸" | "글자 크기";

export interface ShortcutAction {
  id: string;
  label: string;
  group: ShortcutGroup;
  keys: string[];
  /** 1~9 를 같이 쓰는 동작 (키는 `1~9`) */
  digits?: boolean;
  /** 대화 상자가 열려 있어도 받는다 */
  inDialog?: boolean;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "worktreeN", label: "n 번째 워크트리", group: "화면", keys: ["⌘1~9"], digits: true },
  { id: "prevWorktree", label: "위 워크트리", group: "화면", keys: ["⇧⌘↑"] },
  { id: "nextWorktree", label: "아래 워크트리", group: "화면", keys: ["⇧⌘↓"] },
  { id: "historyBack", label: "방문 기록 뒤로", group: "화면", keys: ["⌥⌘←"] },
  { id: "historyForward", label: "방문 기록 앞으로", group: "화면", keys: ["⌥⌘→"] },
  { id: "jump", label: "워크트리로 가기", group: "화면", keys: ["⌘J"] },
  { id: "newWorktree", label: "새 워크트리", group: "화면", keys: ["⇧⌘N"] },
  { id: "toggleSidebar", label: "사이드바", group: "화면", keys: ["⌘B"] },
  { id: "toggleRight", label: "오른쪽 사이드바", group: "화면", keys: ["⌘L"] },
  { id: "filesPanel", label: "파일", group: "화면", keys: ["⇧⌘E"] },
  { id: "changesPanel", label: "변경", group: "화면", keys: ["⇧⌘G"] },
  { id: "searchPanel", label: "검색", group: "화면", keys: ["⇧⌘F"] },
  { id: "openMarkdown", label: "Markdown 파일 열기", group: "화면", keys: ["⇧⌘O"] },
  { id: "floating", label: "플로팅 워크스페이스", group: "화면", keys: ["⌥⌘A", "⌃`"], inDialog: true },
  { id: "floatingMax", label: "플로팅 워크스페이스 (최대화)", group: "화면", keys: ["⌥⇧⌘A"], inDialog: true },
  { id: "settings", label: "설정", group: "화면", keys: ["⌘,"] },
  { id: "tabN", label: "n 번째 탭", group: "탭 · 칸", keys: ["⌃1~9"], digits: true, inDialog: true },
  { id: "prevTab", label: "이전 탭", group: "탭 · 칸", keys: ["⇧⌘["] },
  { id: "nextTab", label: "다음 탭", group: "탭 · 칸", keys: ["⇧⌘]"] },
  { id: "newTab", label: "새 터미널", group: "탭 · 칸", keys: ["⌘T"] },
  { id: "newAgentTab", label: "새 에이전트", group: "탭 · 칸", keys: ["⌥⌘T"] },
  { id: "newBrowserTab", label: "새 브라우저", group: "탭 · 칸", keys: ["⇧⌘B"] },
  { id: "closeCurrent", label: "칸 · 탭 닫기", group: "탭 · 칸", keys: ["⌘W"] },
  { id: "splitRight", label: "오른쪽에 나누기", group: "탭 · 칸", keys: ["⌘D"] },
  { id: "splitDown", label: "아래에 나누기", group: "탭 · 칸", keys: ["⇧⌘D"] },
  { id: "zoomPane", label: "칸 펼치기", group: "탭 · 칸", keys: ["⇧⌘↩"] },
  { id: "equalize", label: "칸 크기 고르게", group: "탭 · 칸", keys: ["⌥⌘="] },
  { id: "prevPane", label: "이전 칸", group: "탭 · 칸", keys: ["⌘["] },
  { id: "nextPane", label: "다음 칸", group: "탭 · 칸", keys: ["⌘]"] },
  { id: "focusLeft", label: "왼쪽 칸으로", group: "탭 · 칸", keys: ["⌃⌘←"] },
  { id: "focusRight", label: "오른쪽 칸으로", group: "탭 · 칸", keys: ["⌃⌘→"] },
  { id: "focusUp", label: "위 칸으로", group: "탭 · 칸", keys: ["⌃⌘↑"] },
  { id: "focusDown", label: "아래 칸으로", group: "탭 · 칸", keys: ["⌃⌘↓"] },
  { id: "resizeLeft", label: "칸 크기 왼쪽으로", group: "탭 · 칸", keys: ["⌃⇧⌘←"] },
  { id: "resizeRight", label: "칸 크기 오른쪽으로", group: "탭 · 칸", keys: ["⌃⇧⌘→"] },
  { id: "resizeUp", label: "칸 크기 위로", group: "탭 · 칸", keys: ["⌃⇧⌘↑"] },
  { id: "resizeDown", label: "칸 크기 아래로", group: "탭 · 칸", keys: ["⌃⇧⌘↓"] },
  { id: "zoomIn", label: "크게", group: "글자 크기", keys: ["⌘=", "⇧⌘="], inDialog: true },
  { id: "zoomOut", label: "작게", group: "글자 크기", keys: ["⌘-"], inDialog: true },
  { id: "zoomReset", label: "원래대로", group: "글자 크기", keys: ["⌘0"], inDialog: true },
];

const BY_ID = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a]));

const KEY = "thuminal.shortcuts";

const CODE_NAMES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Space: "Space",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** 누른 자리의 키 이름. 수정키만 누른 것이면 null */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (/^(Meta|Control|Alt|Shift|CapsLock|Fn)/.test(code) || !code) return null;
  return code;
}

/** 키 이벤트를 단축키 글자로 읽는다. 1~9 는 `digits` 에 수정키만 따로 준다 */
export function comboOf(e: KeyboardEvent): { combo: string; mods: string; digit: boolean } | null {
  const name = keyName(e.code);
  if (!name) return null;
  const k = appMods(e);
  const mods = `${k.ctrl ? "⌃" : ""}${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${k.meta ? "⌘" : ""}`;
  return { combo: mods + name, mods, digit: /^[1-9]$/.test(name) };
}

type Overrides = Record<string, string[]>;

function load(): Overrides {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch {
    return {};
  }
}

let overrides: Overrides = typeof localStorage === "undefined" ? {} : load();
let table = build();
const listeners = new Set<() => void>();

/** 단축키 글자 → 동작 (1~9 동작은 `⌘1~9` 꼴로 든다) */
function build(): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of SHORTCUT_ACTIONS) for (const k of keysOf(a.id)) m.set(k, a.id);
  return m;
}

function save(next: Overrides) {
  overrides = next;
  table = build();
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못해도 이번 실행에는 쓴다
  }
  for (const f of listeners) f();
}

/** 이 동작의 지금 키 (사용자가 바꾼 것, 없으면 기본) */
export function keysOf(id: string): string[] {
  return overrides[id] ?? BY_ID.get(id)?.keys ?? [];
}

export function isCustomized(id: string): boolean {
  return id in overrides;
}

/** 이 키 이벤트에 걸린 동작 */
export function actionFor(e: KeyboardEvent): { action: ShortcutAction; digit: number } | null {
  const c = comboOf(e);
  if (!c) return null;
  // `⌘1` 처럼 하나로 건 키가 `⌘1~9` 묶음보다 먼저다
  const exact = BY_ID.get(table.get(c.combo) ?? "");
  if (exact) return { action: exact, digit: 0 };
  const group = c.digit ? BY_ID.get(table.get(`${c.mods}1~9`) ?? "") : undefined;
  return group ? { action: group, digit: Number(c.combo.slice(-1)) } : null;
}

/** 화면에 쓸 단축키 글자 (첫 키). 키가 없으면 빈 글 */
export function shortcutLabel(id: string): string {
  const k = keysOf(id)[0];
  return k ? keyLabel(k) : "";
}

/** 이 키를 쓰는 다른 동작 */
export function ownerOf(key: string, except: string): ShortcutAction | undefined {
  const id = table.get(key);
  return id && id !== except ? BY_ID.get(id) : undefined;
}

/** 동작의 키를 하나로 바꾼다. 같은 키를 쓰던 다른 동작에서는 뺀다 */
export function setShortcut(id: string, key: string) {
  const next: Overrides = { ...overrides };
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id === id) continue;
    const ks = keysOf(a.id);
    if (ks.includes(key)) next[a.id] = ks.filter((k) => k !== key);
  }
  next[id] = [key];
  save(next);
}

/** 동작의 키를 지운다 (그 키는 터미널로 간다) */
export function clearShortcut(id: string) {
  save({ ...overrides, [id]: [] });
}

export function resetShortcut(id: string) {
  const { [id]: _, ...rest } = overrides;
  save(rest);
}

export function resetAllShortcuts() {
  save({});
}

/** 설정창이 키를 받는 동안은 단축키를 쓰지 않는다 */
export let recordingShortcut = false;
export function setRecordingShortcut(on: boolean) {
  recordingShortcut = on;
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** 단축키가 바뀌면 다시 그린다 */
export function useShortcutOverrides(): Overrides {
  return useSyncExternalStore(subscribe, () => overrides);
}
