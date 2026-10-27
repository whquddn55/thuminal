// 브라우저 칸: 주소 줄 + 진짜 웹뷰가 얹힐 자리.
//
// 웹뷰는 껍데기(Tauri)가 창 위에 얹는 네이티브 뷰라 HTML 보다 위에 그려진다. 그래서
// 메뉴·창이 열려 있거나, 끄는 중이거나, 플로팅 패널이 이 칸을 덮으면 웹뷰를 잠깐 숨긴다.
// 칸이 화면에서 빠지면(탭을 바꾸면) 숨기기만 하고, 칸이 배치에서 없어지면 모델이 닫는다.

import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, BugIcon, GlobeIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import { BROWSER_PROXY_PROTOCOL_MINOR, type Bounds, type HostApi } from "@thuminal/term-core";

import { pageKey, pageStore, setPage } from "./browser-state";
import { useDrag } from "./dnd";
import { useDaemonSupports } from "./file-features";
import { cn } from "./lib/utils";
import { keyLabel } from "./platform";
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
  const key = pageKey(model.hostKey, paneId);
  const page = useStore(pageStore, (s) => s[key]);
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
      (e) => model.fail(`브라우저 칸을 열지 못했어요: ${e}`),
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

  if (!browser) return <FramePane paneId={paneId} url={url} focused={focused} />;

  const go = (text: string) => {
    const next = toUrl(text);
    setEditing(null);
    setPage(key, { url: next, loading: true });
    void browser.navigate(paneId, next).catch(model.fail);
    void browser.focus(paneId).catch(() => undefined);
  };
  const btn = "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-3.5";

  return (
    <div className="absolute inset-0 flex flex-col bg-background" onPointerDown={() => !focused && model.focusPane(paneId)}>
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b bg-card px-1.5">
        <button className={btn} title={`뒤로 (${keyLabel("⌘[")})`} onClick={() => void browser.go(paneId, -1)}>
          <ArrowLeftIcon />
        </button>
        <button className={btn} title={`앞으로 (${keyLabel("⌘]")})`} onClick={() => void browser.go(paneId, 1)}>
          <ArrowRightIcon />
        </button>
        <button className={btn} title={`새로 고침 (${keyLabel("⌘R")})`} onClick={() => void browser.reload(paneId)}>
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
        <button className={btn} title="시스템 브라우저로 열기" onClick={() => void openOutside(model.services.host, shown).catch(model.fail)}>
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

/** 시스템 브라우저로 연다. 원격 컴퓨터 칸의 `localhost` 는 그 데몬의 대리 주소로 바꿔 연다 */
async function openOutside(host: HostApi, url: string) {
  const view = (await host.browserProxyUrl?.(url).catch(() => null)) ?? url;
  if (host.openUrl) await host.openUrl(view);
  else window.open(view, "_blank", "noopener");
}

/**
 * 진짜 웹뷰를 얹지 못하는 껍데기(원격 접속 웹 · 폰)의 브라우저 칸: 칸 자리에 iframe 으로 띄운다.
 * 데몬 컴퓨터의 `localhost` 개발 서버는 데몬이 대신 받아 넘기는 주소로 연다 (daemon `browser_proxy.rs`).
 * 다른 출처의 iframe 이라 안에서 옮겨 간 주소 · 뒤로 · 앞으로는 알 수 없다. 주소 칸에서 고친 주소는 배치에 남긴다
 */
export function FramePane({ paneId, url, focused }: { paneId: number; url: string; focused: boolean }) {
  const model = useModel();
  const host = model.services.host;
  const supported = useDaemonSupports(host, BROWSER_PROXY_PROTOCOL_MINOR);
  const [view, setView] = useState<{ for: string; src: string | null; error?: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const local = /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url);

  useEffect(() => {
    let alive = true;
    if (!/^https?:/i.test(url)) {
      setView({ for: url, src: null, error: "이 주소는 데스크톱 브라우저 칸에서만 열려요" });
      return;
    }
    if (!local) {
      setView({ for: url, src: url });
      return;
    }
    if (supported === null) return;
    if (!supported || !host.browserProxyUrl) {
      setView({ for: url, src: null, error: "데몬이 이전 버전이라 이 컴퓨터의 개발 서버를 대신 보여 줄 수 없어요. 데몬을 다시 시작하면 여기서 볼 수 있어요" });
      return;
    }
    host.browserProxyUrl(url).then(
      (p) => alive && setView(p ? { for: url, src: p } : { for: url, src: null, error: "데몬 원격 접속이 꺼져 있어서 대신 보여 줄 수 없어요" }),
      (e) => alive && setView({ for: url, src: null, error: String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [host, url, local, supported]);

  const go = (text: string) => {
    const next = toUrl(text);
    setEditing(null);
    if (next === url) setReloads((n) => n + 1);
    else void model.op({ op: "update_doc", pane: { by: "id", value: paneId }, doc: { kind: "browser", url: next } }).catch(model.fail);
  };
  const btn = "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-3.5";
  const ready = view?.for === url ? view : null;

  return (
    <div className="absolute inset-0 flex flex-col bg-background" onPointerDown={() => !focused && model.focusPane(paneId)}>
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b bg-card px-1.5">
        <button className={btn} title="새로 고침" onClick={() => setReloads((n) => n + 1)}>
          <ArrowClockwiseIcon />
        </button>
        <div className="mx-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2">
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
            value={editing ?? url}
            spellCheck={false}
            onFocus={(e) => {
              setEditing(url);
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
        <button className={btn} title="칸 안에 안 보이는 사이트를 새 탭으로 열기" onClick={() => void openOutside(host, url).catch(model.fail)}>
          <ArrowSquareOutIcon />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {ready?.src ? (
          <iframe key={`${ready.src}#${reloads}`} src={ready.src} title={url} className="absolute inset-0 size-full border-0" allow="clipboard-read; clipboard-write; fullscreen" />
        ) : (
          <div className="absolute inset-0 grid place-content-center gap-2 bg-muted p-4 text-center text-xs text-muted-foreground">
            {ready?.error ?? "여는 중…"}
          </div>
        )}
      </div>
    </div>
  );
}

