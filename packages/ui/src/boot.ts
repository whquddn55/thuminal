// 시작 화면: 엔진 · 글꼴 · 데몬 목록을 받는 동안 화면 전체를 덮고 진행 막대를 보인다.
// 덮지 않으면 프로젝트가 하나도 없는 빈 화면이 보이다가 목록이 한꺼번에 들어온다.
// 테마는 이 브라우저(localStorage)에 남은 설정으로 맨 먼저 입힌다 (안 그러면 데몬 답을 받을 때까지 기본 검은 색이다).

import { applyTheme, loadThemeSettings } from "./theme";

/** 시작할 때 기다리는 일 수: 엔진, 글꼴, 데몬 목록 다섯 (세션 · 저장소 · 워크스페이스 · 워크트리 · 배치) */
const EXPECTED = 7;

let root: HTMLDivElement | null = null;
let fill: HTMLDivElement | null = null;
let text: HTMLDivElement | null = null;
let total = 0;
let done = 0;
let shown = 0;
const pending: string[] = [];

function render() {
  if (!fill || !text) return;
  // 일이 늘어나도 막대는 뒤로 가지 않는다
  shown = Math.max(shown, done / Math.max(total, EXPECTED));
  fill.style.width = `${Math.round(shown * 100)}%`;
  // 다음 일이 아직 시작하지 않았으면 앞 글을 그대로 둔다
  if (pending[0]) text.textContent = pending[0];
}

/** 테마를 입히고 시작 화면을 띄운다. 화면 코드에서 가장 먼저 부른다 */
export function bootStart() {
  applyTheme(loadThemeSettings(), window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (root) return;
  root = document.createElement("div");
  root.id = "thuminal-boot";
  root.className = "fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-3 bg-background transition-opacity duration-150";
  const track = document.createElement("div");
  track.className = "h-0.5 w-44 overflow-hidden rounded-full bg-border";
  fill = document.createElement("div");
  fill.className = "h-full w-0 bg-foreground/70 transition-[width] duration-200";
  text = document.createElement("div");
  text.className = "h-4 text-xs text-muted-foreground";
  track.append(fill);
  root.append(track, text);
  document.body.append(root);
}

/** 시작 화면이 기다리는 일 하나. 끝나면(실패해도) 막대가 그만큼 찬다 */
export function bootTrack<T>(label: string, work: Promise<T>): Promise<T> {
  if (!root) return work;
  total++;
  pending.push(label);
  render();
  const end = () => {
    done++;
    pending.splice(pending.indexOf(label), 1);
    render();
  };
  work.then(end, end);
  return work;
}

/** 다 읽었다: 막대를 채우고 시작 화면을 걷는다 */
export function bootFinish() {
  if (!root || !fill) return;
  const el = root;
  root = null;
  fill.style.width = "100%";
  el.style.opacity = "0";
  window.setTimeout(() => el.remove(), 200);
}

/** 시작하지 못했다: 시작 화면에 이유를 남긴다 */
export function bootFail(e: unknown) {
  console.error("[thuminal] 시작하지 못했다", e);
  if (text) {
    text.className = "max-w-[80vw] text-center text-xs text-destructive";
    text.textContent = `시작하지 못했어요: ${e}`;
  }
}
