// 워크스페이스 한 곳을 그린다: 탭 줄 + 지금 탭의 칸 트리.
//
// - 터미널 그림판(렌더러)은 화면 면(메인, 플로팅 패널)마다 하나다. 면 안의 칸들이 그 그림판 하나에 그려진다.
// - 칸 트리는 데몬 배치를 그대로 그린다. 구분선을 끄는 동안만 크기를 여기서 들고 있다가 놓을 때 데몬에 보낸다.
// - 칸이 둘 이상이면 칸마다 머리 줄이 생긴다. 머리 줄을 끌어 칸을 옮기고, 탭을 끌어 칸으로 넣는다.

import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  FileTextIcon,
  GlobeIcon,
  GitDiffIcon,
  RobotIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  XIcon,
} from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import type { Pane, PaneNode, Renderer, SessionInfo, Tab, WorkspaceId } from "@thuminal/term-core";

import { type PageState, pageStore } from "./browser-state";
import { BrowserPane } from "./BrowserPane";
import { Button } from "./components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "./components/ui/context-menu";
import { beginDrag, useDrag } from "./dnd";
import { activeTab, dropRect, panesOf } from "./layout";
import { cn } from "./lib/utils";
import { NewTabMenu } from "./NewTabMenu";
import { FLOATING_WORKSPACE, useApp, useModel } from "./store";
import { StatusIndicator } from "./Sidebar";
import { type DocSpec, DocView } from "./viewers";

type Surface = "main" | "floating";

const RendererContext = createContext<{ renderer: Renderer | null; surface: Surface }>({ renderer: null, surface: "main" });

/** 터미널 그림판 하나를 띄우고 그 안에 children 을 그린다. children 의 칸 자리는 모두 이 면 안에 있어야 한다 */
export function TerminalSurface({ surface, className, children }: { surface: Surface; className?: string; children: React.ReactNode }) {
  const model = useModel();
  const ref = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  useEffect(() => {
    const { services } = model;
    const r = services.renderer(ref.current!, services.rendererOptions);
    setRenderer(r);
    let raf = 0;
    const loop = () => {
      r.frame();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      r.dispose();
    };
  }, [model]);
  return (
    <div ref={ref} className={cn("relative min-h-0 min-w-0", className)}>
      <RendererContext.Provider value={{ renderer, surface }}>{children}</RendererContext.Provider>
    </div>
  );
}

/** 탭 제목: 사용자가 붙인 이름 > 포커스 칸 내용 */
function tabTitle(tab: Tab, sessions: Record<number, SessionInfo>, pages: Record<number, PageState>): string {
  if (tab.title) return tab.title;
  const p = panesOf(tab.root).find((x) => x.id === tab.focused) ?? panesOf(tab.root)[0];
  return p ? paneTitle(p, sessions, pages) : "";
}

function paneTitle(p: Pane, sessions: Record<number, SessionInfo>, pages: Record<number, PageState> = pageStore.getState()): string {
  if (p.type === "doc" && p.doc.kind === "browser") {
    const page = pages[p.id];
    if (page?.title) return page.title;
    const url = page?.url || p.doc.url || "";
    try {
      return new URL(url).host || url || "새 탭";
    } catch {
      return url || "새 탭";
    }
  }
  if (p.type === "doc") return p.doc.file?.split("/").pop() ?? "문서";
  return sessions[p.session]?.title ?? `세션 ${p.session}`;
}

/** 탭에서 가장 급한 에이전트 상태 */
function tabAgent(tab: Tab, sessions: Record<number, SessionInfo>) {
  const states = panesOf(tab.root).flatMap((p) => (p.type === "terminal" && sessions[p.session]?.agent ? [sessions[p.session].agent!.state] : []));
  return states.includes("needs_attention") ? "needs_attention" : states.includes("working") ? "working" : states.includes("idle") ? "idle" : null;
}

/** 탭 줄. windowDrag 면 빈 곳을 끌어 앱 창을 옮긴다 (메인 제목 줄) */
export function TabBar({ ws, className, windowDrag, children }: { ws: WorkspaceId; className?: string; windowDrag?: boolean; children?: React.ReactNode }) {
  const drag = windowDrag ? { "data-tauri-drag-region": true } : {};
  const model = useModel();
  const layout = useApp((s) => s.layouts[ws]);
  const sessions = useApp((s) => s.sessions);
  const pages = useStore(pageStore);
  const drop = useDrag((d) => (d.target?.kind === "tabbar" && d.target.workspace === ws ? d.target.index : null));
  const [renaming, setRenaming] = useState<number | null>(null);
  const tabs = layout?.tabs ?? [];
  const active = activeTab(layout);

  return (
    <div className={cn("relative flex min-w-0 items-center gap-0.5", className)} data-drop-tabbar={ws} {...drag}>
      {tabs.map((t, i) => {
        const agent = tabAgent(t, sessions);
        const panes = panesOf(t.root);
        const exited = panes.every((p) => p.type === "terminal" && sessions[p.session]?.state.state === "exited");
        const isActive = t.id === active?.id;
        const title = tabTitle(t, sessions, pages);
        return (
          <ContextMenu key={t.id}>
            <ContextMenuTrigger asChild>
              <div
                data-tab-index={i}
                className={cn(
                  "group relative flex h-7 max-w-52 min-w-0 shrink cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs text-muted-foreground transition-colors",
                  isActive ? "bg-accent text-foreground shadow-xs" : "hover:bg-accent/50 hover:text-foreground",
                  exited && "opacity-60",
                )}
                title={title}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest("button,input")) return;
                  // 탭은 뗄 때 바꾼다. 누르자마자 바꾸면 지금 보이는 탭의 칸으로 끌어 넣을 수 없다
                  beginDrag(e, model, { kind: "tab", tab: t.id, workspace: ws, title, panes: panes.map((p) => p.id) }, () => model.selectTab(t.id));
                }}
                onDoubleClick={() => setRenaming(t.id)}
              >
                <span className="text-[10px] tabular-nums text-muted-foreground/70">{i + 1}</span>
                {agent ? (
                  <StatusIndicator status={agent} className="size-2.5" />
                ) : panes[0]?.type === "doc" ? (
                  panes[0].doc.kind === "browser" ? (
                    <GlobeIcon className="size-3.5 shrink-0" />
                  ) : panes[0].doc.kind === "diff" ? (
                    <GitDiffIcon className="size-3.5 shrink-0" />
                  ) : (
                    <FileTextIcon className="size-3.5 shrink-0" />
                  )
                ) : null}
                {renaming === t.id ? (
                  <input
                    autoFocus
                    className="h-5 w-28 rounded border bg-background px-1 text-xs outline-none"
                    defaultValue={t.title ?? ""}
                    placeholder={title}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        model.renameTab(t.id, e.currentTarget.value);
                        setRenaming(null);
                      } else if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => setRenaming(null)}
                  />
                ) : (
                  <span className="min-w-0 truncate">{title}</span>
                )}
                {panes.length > 1 && <span className="rounded bg-foreground/10 px-1 text-[10px] tabular-nums">{panes.length}</span>}
                <button
                  className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-foreground/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    model.closeTab(t.id);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
                {drop === i && <span className="absolute top-1 bottom-1 -left-[2px] w-0.5 rounded-full bg-drop" />}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              <ContextMenuItem onSelect={() => void model.split("right", { by: "id", value: t.focused })}>
                오른쪽에 나누기
                <ContextMenuShortcut>⌘D</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void model.split("down", { by: "id", value: t.focused })}>
                아래에 나누기
                <ContextMenuShortcut>⌘⇧D</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => void model.op({ op: "equalize", tab: { by: "id", value: t.id } })}
                disabled={panes.length < 2}
              >
                칸 크기 똑같이
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setRenaming(t.id)}>탭 이름 바꾸기</ContextMenuItem>
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(`t${t.id}`).catch(() => undefined)}>
                탭 id 복사 <span className="ml-auto font-mono text-xs text-muted-foreground">t{t.id}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => model.closeTab(t.id)}>
                탭 닫기
                <ContextMenuShortcut>{panes.length > 1 ? "" : "⌘W"}</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" disabled={tabs.length < 2} onSelect={() => model.closeOtherTabs(t.id)}>
                다른 탭 닫기
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {drop === tabs.length && <span className="h-5 w-0.5 rounded-full bg-drop" />}
      <NewTabMenu ws={ws} />
      <div className="h-full min-w-4 flex-1" {...drag} />
      {children}
    </div>
  );
}

/** 워크스페이스의 지금 탭 (칸 트리). 탭이 없으면 empty 를 그린다 */
export function WorkspaceView({ ws, empty }: { ws: WorkspaceId; empty: React.ReactNode }) {
  const tab = useApp((s) => activeTab(s.layouts[ws]));
  const { renderer } = useContext(RendererContext);
  // 칸이 옮겨지거나 맞바뀌면 크기는 그대로여도 그림판 자리를 다시 재야 한다
  const shape = tab ? JSON.stringify([tab.id, tab.root, tab.zoomed]) : "";
  useLayoutEffect(() => {
    renderer?.layout();
  }, [renderer, shape]);
  if (!tab) return <>{empty}</>;
  const zoomed = tab.zoomed !== null ? panesOf(tab.root).find((p) => p.id === tab.zoomed) : undefined;
  const multi = panesOf(tab.root).length > 1;
  return (
    <div className="absolute inset-0 flex">
      {zoomed ? (
        <PaneView ws={ws} tab={tab} pane={zoomed} header={multi} />
      ) : (
        <NodeView ws={ws} tab={tab} node={tab.root} path={[]} header={multi} />
      )}
    </div>
  );
}

function NodeView({ ws, tab, node, path, header }: { ws: WorkspaceId; tab: Tab; node: PaneNode; path: number[]; header: boolean }) {
  if (node.type === "pane") return <PaneView ws={ws} tab={tab} pane={node.pane} header={header} />;
  return <SplitView ws={ws} tab={tab} node={node} path={path} header={header} />;
}

function SplitView({
  ws,
  tab,
  node,
  path,
  header,
}: {
  ws: WorkspaceId;
  tab: Tab;
  node: Extract<PaneNode, { type: "split" }>;
  path: number[];
  header: boolean;
}) {
  const model = useModel();
  const { renderer } = useContext(RendererContext);
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? node.sizes;
  const row = node.axis === "row";
  // 데몬이 새 크기를 보내오면 끄는 동안 들고 있던 값을 버린다
  const key = node.sizes.join(",");
  useEffect(() => setLive(null), [key]);

  const startResize = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const total = row ? box.width : box.height;
    const start = row ? e.clientX : e.clientY;
    const base = [...sizes];
    // 칸이 50px 보다 작아지지 않게 한다
    const min = Math.min(0.45, 50 / total);
    let last = base;
    const move = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / total;
      const pair = base[i] + base[i + 1];
      const a = Math.min(pair - min, Math.max(min, base[i] + d));
      last = base.map((v, j) => (j === i ? a : j === i + 1 ? pair - a : v));
      setLive(last);
      renderer?.layout();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      void model.op({ op: "set_sizes", tab: tab.id, path, sizes: last });
    };
    document.body.style.cursor = row ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      {node.children.map((child, i) => (
        <div key={i} className="contents">
          {i > 0 && (
            <div
              className={cn(
                "group relative z-[7] shrink-0 bg-border",
                row ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
              )}
              onPointerDown={(e) => startResize(i - 1, e)}
              onDoubleClick={() => {
                const pair = sizes[i - 1] + sizes[i];
                void model.op({ op: "set_sizes", tab: tab.id, path, sizes: sizes.map((v, j) => (j === i - 1 || j === i ? pair / 2 : v)) });
              }}
            >
              {/* 잡기 쉬운 자리: 선 양쪽 3px */}
              <div className={cn("absolute", row ? "inset-y-0 -left-[3px] w-[7px]" : "inset-x-0 -top-[3px] h-[7px]")} />
              <div className={cn("absolute bg-ring/0 transition-colors group-hover:bg-ring/60", row ? "inset-y-0 -left-px w-[3px]" : "inset-x-0 -top-px h-[3px]")} />
            </div>
          )}
          <div className="flex min-h-0 min-w-0" style={{ flex: `${sizes[i]} 1 0` }}>
            <NodeView ws={ws} tab={tab} node={child} path={[...path, i]} header={header} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PaneView({ ws, tab, pane, header }: { ws: WorkspaceId; tab: Tab; pane: Pane; header: boolean }) {
  const model = useModel();
  const focused = tab.focused === pane.id;
  // 브라우저 칸 제목은 페이지 제목을 따라간다
  const pages = useStore(pageStore);
  const title = useApp((s) => paneTitle(pane, s.sessions, pages));
  const session = useApp((s) => (pane.type === "terminal" ? s.sessions[pane.session] : undefined));
  const drop = useDrag((d) => (d.target?.kind === "pane" && d.target.pane === pane.id ? d.target.side : null));
  const dragging = useDrag((d) => d.source?.kind === "pane" && d.source.pane === pane.id);
  const id = { by: "id" as const, value: pane.id };

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", dragging && "opacity-50")}>
      {header && (
        <div
          className={cn(
            "group flex h-6 shrink-0 cursor-grab items-center gap-1.5 border-b px-2 text-[11px] active:cursor-grabbing",
            focused ? "bg-accent text-foreground" : "bg-muted/40 text-muted-foreground",
          )}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            if (!focused) model.focusPane(pane.id);
            beginDrag(e, model, { kind: "pane", pane: pane.id, tab: tab.id, workspace: ws, title });
          }}
        >
          {session?.agent && (
            <>
              <StatusIndicator status={session.agent.state} className="size-2.5" />
              <RobotIcon className="size-3 shrink-0" />
            </>
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <PaneButton title="오른쪽에 나누기 (⌘D)" onClick={() => void model.split("right", id)}>
              <SquareSplitHorizontalIcon />
            </PaneButton>
            <PaneButton title="아래에 나누기 (⌘⇧D)" onClick={() => void model.split("down", id)}>
              <SquareSplitVerticalIcon />
            </PaneButton>
            <PaneButton title="펼치기 (⌘⇧Enter)" onClick={() => void model.op({ op: "zoom", target: id })}>
              {tab.zoomed === pane.id ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
            </PaneButton>
            <PaneButton title="칸 닫기 (⌘W)" onClick={() => model.closePane(pane.id)}>
              <XIcon />
            </PaneButton>
          </span>
        </div>
      )}
      <div className="relative min-h-0 min-w-0 flex-1 bg-terminal" data-drop-pane={pane.id}>
        {pane.type === "terminal" ? (
          <TerminalMenu tab={tab} paneId={pane.id} session={pane.session}>
            <TerminalPane ws={ws} paneId={pane.id} session={pane.session} focused={focused} />
          </TerminalMenu>
        ) : pane.doc.kind === "browser" ? (
          <BrowserPane paneId={pane.id} url={pane.doc.url ?? "about:blank"} focused={focused} inFloating={ws === FLOATING_WORKSPACE} />
        ) : (
          <DocPane ws={ws} doc={pane.doc as unknown as DocSpec} onFocus={() => !focused && model.focusPane(pane.id)} />
        )}
        {session?.state.state === "exited" && (
          <div className="absolute right-2 bottom-2 z-[8] flex items-center gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
            <span>
              끝났다{session.state.code !== null && ` (코드 ${session.state.code})`}
            </span>
            <Button size="xs" variant="outline" onClick={() => void model.op({ op: "close_pane", target: id })}>
              닫기
            </Button>
          </div>
        )}
        {header && !focused && <div className="pointer-events-none absolute inset-0 z-[6] bg-background/15" />}
        {drop && (
          <div className="pointer-events-none absolute inset-0 z-[9]">
            <div
              className="absolute flex items-center justify-center rounded border-2 border-drop/60 bg-drop/20 text-xs font-medium text-foreground transition-all duration-100"
              style={dropRect(drop)}
            >
              {drop === "center" ? "맞바꾸기" : "여기에 놓기"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 터미널 오른쪽 클릭 메뉴 (Orca 와 같은 항목) */
function TerminalMenu({ tab, paneId, session, children }: { tab: Tab; paneId: number; session: number; children: React.ReactNode }) {
  const model = useModel();
  const [selected, setSelected] = useState(false);
  const id = { by: "id" as const, value: paneId };
  const c = () => model.controller(session);
  const copyId = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);
  return (
    <ContextMenu onOpenChange={(o) => o && setSelected(c().hasSelection())}>
      <ContextMenuTrigger asChild>
        <div className="absolute inset-0">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => (e.preventDefault(), c().focus())}>
        <ContextMenuItem disabled={!selected} onSelect={() => c().copySelection()}>
          복사
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void navigator.clipboard.readText().then(
              (t) => c().paste(t),
              (e) => model.fail(`클립보드를 읽지 못했다: ${e}`),
            )
          }
        >
          붙여넣기
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => c().selectAll()}>모두 고르기</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void model.split("right", id)}>
          오른쪽에 나누기
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void model.split("down", id)}>
          아래에 나누기
          <ContextMenuShortcut>⌘⇧D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={panesOf(tab.root).length < 2} onSelect={() => void model.op({ op: "zoom", target: id })}>
          {tab.zoomed === paneId ? "펼친 칸 접기" : "칸 펼치기"}
          <ContextMenuShortcut>⌘⇧↩</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => c().sendText("\x0c")}>화면 지우기 (Ctrl+L)</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyId(`p${paneId}`)}>
          칸 id 복사 <span className="ml-auto font-mono text-xs text-muted-foreground">p{paneId}</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copyId(String(session))}>
          세션 번호 복사 <span className="ml-auto font-mono text-xs text-muted-foreground">{session}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => model.closePane(paneId)}>
          칸 닫기
          <ContextMenuShortcut>⌘W</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function PaneButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      className="flex size-[18px] items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&>svg]:size-3"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TerminalPane({ ws, paneId, session, focused }: { ws: WorkspaceId; paneId: number; session: number; focused: boolean }) {
  const model = useModel();
  const { renderer, surface } = useContext(RendererContext);
  const ref = useRef<HTMLDivElement>(null);
  const generation = useApp((s) => s.generation);
  // 키보드를 받을 칸: 이 면이 키보드를 받고, 이 칸이 포커스 칸이고, 창이 열려 있지 않을 때
  const keyboard = useApp((s) => focused && s.focusArea === surface && s.dialog === null);
  const state = useRef({ focused, surface, ws });
  state.current = { focused, surface, ws };

  useLayoutEffect(() => {
    if (!renderer || !ref.current) return;
    const c = model.controller(session);
    c.onActivate = () => {
      const cur = state.current;
      if (model.get().focusArea !== cur.surface) model.setFocusArea(cur.surface);
      if (!cur.focused) model.focusPane(paneId);
    };
    c.show(ref.current, renderer);
    return () => {
      c.onActivate = null;
      c.hide();
    };
  }, [model, renderer, session, paneId, generation]);

  useEffect(() => {
    const c = model.controller(session);
    if (keyboard) c.focus();
    else c.blur();
  }, [model, session, keyboard, generation]);

  return <div ref={ref} className="absolute inset-0" />;
}

function DocPane({ ws, doc, onFocus }: { ws: WorkspaceId; doc: DocSpec; onFocus: () => void }) {
  const model = useModel();
  const status = useApp((s) => s.status[ws]);
  // git 상태가 바뀔 때마다 다시 읽는다
  const generation = JSON.stringify(status ?? null).length + (status?.files.length ?? 0);
  if (ws === FLOATING_WORKSPACE) return null;
  return (
    <div className="absolute inset-0 z-[7]" onPointerDown={onFocus}>
      <DocView host={model.services.host} worktree={ws} doc={doc} generation={generation} />
    </div>
  );
}
