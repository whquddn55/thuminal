// 브라우저 칸 웹뷰를 메인 웹뷰 밑에 깔 때 화면이 하는 일: 칸 자리를 뚫고, 마우스를 넘길 자리를 껍데기에 알린다.
//
// 네이티브 웹뷰는 메인 웹뷰 밑에 있고 메인 웹뷰 바탕은 투명하다. 화면이 칸 자리에 아무것도 칠하지 않으면 웹뷰가 보이고,
// 그 위에 그린 메뉴 · 대화 상자 · 플로팅 패널 · 끄는 모양은 숨기지 않아도 웹뷰 위에 보인다.
// - 칸을 감싼 요소들은 바탕을 칠하지 않는다 (styles.css `[data-browser-under]`). 대신 층마다 바탕판이 바탕을 칠하고 칸 자리만 잘라 낸다.
//   층은 둘이다: 메인 층(사이드바 · 메인 면 · 오른쪽 사이드바)과 플로팅 패널. 플로팅 패널의 칸 자리는 메인 층 전체에서도 잘라 낸다.
// - 마우스를 메인 웹뷰가 받을지 밑으로 넘길지는 껍데기가 화면 그림을 보고 알 수 없어 화면이 사각형으로 알린다. 칸 위에 떠 있는 것
//   (`data-browser-cover`)은 빼고, 메뉴 · 대화 상자가 열렸거나 끄는 중이면 모두 메인 웹뷰가 받는다 (밖을 누르면 닫히고, 놓을 곳을 찾게).

import { useEffect } from "react";

import type { BrowserHost, BrowserLayerItem } from "@thuminal/term-core";

import { dragStore } from "./dnd";

/** 열려 있으면 칸 밖 누르기로 닫히는 것들 (Radix 가 body 에 붙인다). 툴팁은 치지 않는다 */
const MODAL = '[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]';
/** 잘라 낼 판 바깥 테두리. 요소 밖으로 나간 그림자 · 테두리가 잘리지 않게 넉넉히 잡는다 */
const OUTER = "M-100000 -100000H100000V100000H-100000Z";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 모서리 둥글기 (왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래) */
  r?: [number, number, number, number];
}

const box = (el: Element): Box => {
  const b = el.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height };
};

/** a 에서 b 를 뺀 나머지 사각형들 (위 · 아래 띠, 가운데 왼쪽 · 오른쪽) */
export function subtract(a: Box, b: Box): Box[] {
  const l = Math.max(a.x, b.x);
  const t = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  if (l >= r || t >= btm) return [a];
  const out: Box[] = [];
  if (t > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: t - a.y });
  if (btm < a.y + a.h) out.push({ x: a.x, y: btm, w: a.w, h: a.y + a.h - btm });
  if (l > a.x) out.push({ x: a.x, y: t, w: l - a.x, h: btm - t });
  if (r < a.x + a.w) out.push({ x: r, y: t, w: a.x + a.w - r, h: btm - t });
  return out;
}

/** 둥근 모서리 사각형 경로 */
function rounded({ x, y, w, h, r = [0, 0, 0, 0] }: Box): string {
  const [tl, tr, br, bl] = r;
  return (
    `M${x + tl} ${y}H${x + w - tr}A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}V${y + h - br}A${br} ${br} 0 0 1 ${x + w - br} ${y + h}` +
    `H${x + bl}A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}V${y + tl}A${tl} ${tl} 0 0 1 ${x + tl} ${y}Z`
  );
}

/** 요소 자리 기준으로 holes 를 뚫는 clip-path. 뚫을 곳이 없으면 none */
export function holePath(holes: Box[], ox: number, oy: number): string {
  if (!holes.length) return "none";
  const d = holes.map((b) => rounded({ ...b, x: b.x - ox, y: b.y - oy })).join("");
  return `path(evenodd, "${OUTER}${d}")`;
}

/**
 * 플로팅 패널 칸이 패널 둥근 모서리에 닿으면 그 모서리를 둥글게 뚫는다.
 * 네모로 뚫으면 메인 층이 패널 모서리 밖까지 비어 밑의 웹뷰 귀퉁이가 보인다
 */
function withCorners(b: Box, panel: Element): Box {
  const p = panel.getBoundingClientRect();
  const s = getComputedStyle(panel);
  const near = (u: number, v: number) => Math.abs(u - v) <= 2;
  const radius = (css: string, hit: boolean) => (hit ? Math.max(0, parseFloat(css) - 1) : 0);
  const [left, top, right, bottom] = [near(b.x, p.left), near(b.y, p.top), near(b.x + b.w, p.right), near(b.y + b.h, p.bottom)];
  return {
    ...b,
    r: [
      radius(s.borderTopLeftRadius, left && top),
      radius(s.borderTopRightRadius, right && top),
      radius(s.borderBottomRightRadius, right && bottom),
      radius(s.borderBottomLeftRadius, left && bottom),
    ],
  };
}

/** 같은 값이면 다시 넣지 않는다 (clip-path 를 매 프레임 넣으면 다시 그린다) */
const clips = new WeakMap<Element, string>();
function setClip(selector: string, holes: Box[]) {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const at = el.getBoundingClientRect();
    const path = holePath(holes, at.left, at.top);
    if (clips.get(el) === path) continue;
    clips.set(el, path);
    el.style.clipPath = path;
  }
}

const half = (n: number) => Math.round(n * 2) / 2;

/** 메인 층 바탕판. 메인 층(`data-browser-level="main"`) 맨 밑에 둔다 */
export function BrowserBase() {
  return <div data-browser-base className="pointer-events-none absolute inset-0 -z-10 bg-background" />;
}

/** 칸 자리를 매 프레임 재서 바탕판을 뚫고, 바뀌면 껍데기에 알린다. 창 하나에 하나만 둔다 (root 모델 껍데기) */
export function useBrowserLayer(browser: BrowserHost | undefined) {
  useEffect(() => {
    if (!browser) return;
    const root = document.documentElement;
    root.dataset.browserUnder = "";
    let last = "";
    let raf = 0;
    const tick = () => {
      const block = !!document.querySelector(MODAL) || dragStore.getState().source !== null;
      const covers = [...document.querySelectorAll("[data-browser-cover]")].map((el) => ({ el, b: box(el) }));
      const main: Box[] = [];
      const floating: Box[] = [];
      const items: (BrowserLayerItem & { top: boolean })[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-browser-host]")) {
        const b = box(el);
        if (b.w <= 0 || b.h <= 0) continue;
        const panel = el.closest("[data-floating-panel]");
        if (panel) floating.push(withCorners(b, panel));
        else main.push(b);
        let pass = block ? [] : [b];
        for (const c of covers) if (!c.el.contains(el)) pass = pass.flatMap((p) => subtract(p, c.b));
        items.push({
          host: el.dataset.browserOf || null,
          id: Number(el.dataset.browserHost),
          rects: pass.map((p) => ({ x: half(p.x), y: half(p.y), width: half(p.w), height: half(p.h) })),
          top: !!panel,
        });
      }
      setClip("[data-browser-base]", main);
      setClip('[data-browser-level="main"]', floating);
      setClip("[data-floating-base]", floating);
      // 아래에서 위 차례: 메인 층 칸 다음 플로팅 패널 칸
      const ordered = [...items.filter((i) => !i.top), ...items.filter((i) => i.top)].map(({ top: _, ...i }) => i);
      const key = JSON.stringify(ordered);
      if (key !== last) {
        last = key;
        void browser.layer(ordered).catch(() => undefined);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      delete root.dataset.browserUnder;
    };
  }, [browser]);
}
