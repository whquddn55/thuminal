// 브라우저 칸: 주소 줄 + 진짜 웹뷰가 얹힐 자리.
//
// 웹뷰는 껍데기(Tauri)가 창 위에 얹는 네이티브 뷰라 HTML 보다 위에 그려진다. 그래서
// 메뉴·창이 열려 있거나, 끄는 중이거나, 플로팅 패널이 이 칸을 덮으면 웹뷰를 잠깐 숨긴다.
// 칸이 화면에서 빠지면(탭을 바꾸면) 숨기기만 하고, 칸이 배치에서 없어지면 모델이 닫는다.

import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, BugIcon, GlobeIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import type { Bounds } from "@thuminal/term-core";

import { pageStore, setPage } from "./browser-state";
import { useDrag } from "./dnd";
import { cn } from "./lib/utils";
import { useApp, useModel } from "./store";

/** 주소 칸에 친 글을 주소로 바꾼다. 주소처럼 보이지 않으면 검색한다 */
export function toUrl(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^localhost:\d/i.test(t)) return t;
  if (looksLikeUrl(t)) return `${/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(t) ? "http" : "https"}://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/** localhost:3000, example.com/path, 192.168.0.1 같은 글인지 */
export function looksLikeUrl(t: string): boolean {
  const s = t.trim();
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s);
}

/** 화면 위에 메뉴·창이 떠 있는지 (Radix 가 body 에 붙인다). 툴팁은 치지 않는다 */
function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(!!document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]'));
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    check();
    return () => mo.disconnect();
  }, []);
  return open;
}

function intersects(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function BrowserPane({ paneId, url, focused, inFloating }: { paneId: number; url: string; focused: boolean; inFloating: boolean }) {
  const model = useModel();
  const browser = model.services.host.browser;
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const page = useStore(pageStore, (s) => s[paneId]);
  const [editing, setEditing] = useState<string | null>(null);
  const overlay = useOverlayOpen();
  const dragging = useDrag((d) => d.source !== null);
  const floatingOpen = useApp((s) => s.floating.open);
  const [covered, setCovered] = useState(false);
  const hidden = overlay || dragging || covered;
  const shown = page?.url || url;

  // 웹뷰를 열고, 칸 자리가 바뀔 때마다 따라간다. 칸이 화면에서 빠지면 숨긴다
  useLayoutEffect(() => {
    if (!browser || !host.current) return;
    let last = "";
    let raf = 0;
    let opened = false;
    const at = (): Bounds => {
      const r = host.current!.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const tick = () => {
      if (host.current) {
        const b = at();
        const key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
        if (opened && key !== last && b.width > 0) void browser.setBounds(paneId, b).catch(() => undefined);
        last = key;
        // 메인 면의 칸은 플로팅 패널에 덮이면 숨긴다 (네이티브 웹뷰가 패널 위로 올라오므로)
        const fp = !inFloating && floatingOpen ? document.querySelector("[data-floating-panel]") : null;
        setCovered(fp ? intersects(fp.getBoundingClientRect(), host.current.getBoundingClientRect()) : false);
      }
      raf = requestAnimationFrame(tick);
    };
    void browser.open(paneId, url, at()).then(
      () => {
        opened = true;
        model.browserOpened(paneId);
      },
      (e) => model.fail(`브라우저 칸을 열지 못했다: ${e}`),
    );
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void browser.setVisible(paneId, false).catch(() => undefined);
    };
    // url 은 처음 열 때만 쓴다. 그 뒤 이동은 웹뷰가 한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, paneId, inFloating, floatingOpen, model]);

  useEffect(() => {
    if (!browser) return;
    void browser.setVisible(paneId, !hidden).catch(() => undefined);
  }, [browser, paneId, hidden]);

  // ⌘L : 주소 칸으로
  useEffect(() => {
    if (!focused) return;
    return model.onBrowserCommand(paneId, (cmd) => {
      if (cmd === "address") {
        setEditing(shown);
        setTimeout(() => input.current?.select());
      }
    });
  }, [model, paneId, focused, shown]);

  if (!browser) return <div className="grid h-full place-content-center text-muted-foreground">이 껍데기는 브라우저 칸을 지원하지 않는다</div>;

  const go = (text: string) => {
    const next = toUrl(text);
    setEditing(null);
    setPage(paneId, { url: next, loading: true });
    void browser.navigate(paneId, next).catch(model.fail);
    void browser.focus(paneId).catch(() => undefined);
  };
  const btn = "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-3.5";

  return (
    <div className="absolute inset-0 flex flex-col bg-background" onPointerDown={() => !focused && model.focusPane(paneId)}>
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b bg-card px-1.5">
        <button className={btn} title="뒤로 (⌘[)" onClick={() => void browser.go(paneId, -1)}>
          <ArrowLeftIcon />
        </button>
        <button className={btn} title="앞으로 (⌘])" onClick={() => void browser.go(paneId, 1)}>
          <ArrowRightIcon />
        </button>
        <button className={btn} title="새로 고침 (⌘R)" onClick={() => void browser.reload(paneId)}>
          {page?.loading ? <XIcon /> : <ArrowClockwiseIcon />}
        </button>
        <div className="mx-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2">
          <GlobeIcon className={cn("size-3.5 shrink-0 text-muted-foreground", page?.loading && "animate-pulse")} />
          <input
            ref={input}
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
            value={editing ?? shown}
            spellCheck={false}
            onFocus={(e) => {
              setEditing(shown);
              e.currentTarget.select();
            }}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(e.currentTarget.value);
              else if (e.key === "Escape") {
                setEditing(null);
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        <button className={btn} title="개발자 도구" onClick={() => void browser.devtools(paneId)}>
          <BugIcon />
        </button>
        <button className={btn} title="시스템 브라우저로 열기" onClick={() => void model.services.host.openUrl?.(shown)}>
          <ArrowSquareOutIcon />
        </button>
      </div>
      <div ref={host} className="relative min-h-0 flex-1 bg-white" data-browser-host={hidden ? undefined : paneId}>
        {hidden && (
          <div className="absolute inset-0 grid place-content-center bg-muted text-xs text-muted-foreground">
            {page?.title || shown}
          </div>
        )}
      </div>
    </div>
  );
}
