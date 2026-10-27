// 화면을 띄운 컴퓨터의 OS. 창 꾸밈과 단축키가 여기에 따라 갈린다
// (원격 웹 화면이면 데몬이 도는 컴퓨터가 아니라 브라우저를 띄운 기기다)
//
// 단축키는 macOS 키로 짜 두고, Windows · Linux 에서는 누른 키를 macOS 자리로 바꿔 읽는다 (`appMods`).
// ⌘ 는 Ctrl 이다. 겹치는 것은 이렇게 옮긴다:
// - ⌃1~9 (탭) → Alt+1~9. Ctrl+1~9 는 ⌘1~9 (워크트리)다
// - ⌃⌘방향키 (칸 이동) → Ctrl+Alt+방향키, ⌃⌘⇧방향키 (칸 크기) → Ctrl+Alt+Shift+방향키
// - ⌘⌥← → (방문 기록) → Alt+← →
// - ⌃` (플로팅) 은 Ctrl+` 그대로
// 터미널과 겹치는 Ctrl 키(Ctrl+D · W · L · J · B · T 등)도 앱 단축키가 먼저 가져간다.
// 터미널 안 단어 이동은 Ctrl+← → 다 (terminal-controller).

const ua = typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;

/** macOS · iPadOS · iOS. 창 단추(신호등)가 화면 위에 얹히고, 단축키는 ⌘ 를 쓴다 */
export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(ua);

/** 앱 단축키를 macOS 키로 읽은 수정키 */
export interface AppMods {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const isArrow = (key: string) => key.startsWith("Arrow");

/** 이 키 이벤트를 macOS 단축키 자리로 읽는다. macOS 는 그대로다 */
export function appMods(e: KeyboardEvent): AppMods {
  const shift = e.shiftKey;
  if (IS_MAC) return { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift };
  // Windows 키는 OS 몫이다. 앱 단축키로 읽지 않는다
  if (e.metaKey) return { meta: false, ctrl: false, alt: false, shift };
  const c = e.ctrlKey;
  const a = e.altKey;
  if (c && a && isArrow(e.key)) return { meta: true, ctrl: true, alt: false, shift };
  if (!c && a && !shift && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return { meta: true, ctrl: false, alt: true, shift };
  if (!c && a && !shift && /^Digit[1-9]$/.test(e.code)) return { meta: false, ctrl: true, alt: false, shift };
  if (c && (e.code === "Backquote" || e.key === "`")) return { meta: false, ctrl: true, alt: a, shift };
  return { meta: c, ctrl: false, alt: a, shift };
}

/** 링크 열기 같은 클릭에 쓰는 수정키 (macOS ⌘, 그 밖 Ctrl) */
export const primaryMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

/** 수정키를 누른 것만으로 링크를 보여 줄 때 보는 키 이름 */
export const PRIMARY_KEY = IS_MAC ? "Meta" : "Control";

const KEY_NAMES: Record<string, string> = { "↩": "Enter", "⌫": "Backspace" };

/**
 * macOS 단축키 글자(`⌘⇧D`, `⌃⌘→`, `⌘Enter`)를 이 OS 글자로 바꾼다. Windows · Linux 는 `Ctrl+Shift+D` 꼴이다.
 * 수정키 기호가 앞에 오고 그 뒤가 키다
 */
export function keyLabel(mac: string): string {
  if (IS_MAC) return mac;
  let i = 0;
  const m = { ctrl: false, alt: false, shift: false, cmd: false };
  for (; i < mac.length; i++) {
    const ch = mac[i];
    if (ch === "⌃") m.ctrl = true;
    else if (ch === "⌥") m.alt = true;
    else if (ch === "⇧") m.shift = true;
    else if (ch === "⌘") m.cmd = true;
    else break;
  }
  const key = KEY_NAMES[mac.slice(i)] ?? mac.slice(i);
  const arrow = /^[←→↑↓]|방향키/.test(key);
  let mods: string[];
  if (m.ctrl && m.cmd && arrow) mods = ["Ctrl", "Alt", ...(m.shift ? ["Shift"] : [])];
  else if (m.cmd && m.alt && !m.ctrl && arrow) mods = ["Alt", ...(m.shift ? ["Shift"] : [])];
  else if (m.ctrl && !m.cmd && /^[1-9]/.test(key)) mods = ["Alt"];
  else mods = [...(m.cmd || m.ctrl ? ["Ctrl"] : []), ...(m.alt ? ["Alt"] : []), ...(m.shift ? ["Shift"] : [])];
  return [...mods, key].join("+");
}
