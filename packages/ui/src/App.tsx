import { FilesIcon, GitDiffIcon, TerminalWindowIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo } from "react";

import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { useDrag } from "./dnd";
import { panesOf } from "./layout";
import { FloatingPanel, FloatingTrigger } from "./FloatingPanel";
import { cn } from "./lib/utils";
import { Dialogs } from "./overlays";
import { RightPanel } from "./RightPanel";
import type { Services } from "./services";
import { SettingsDialog } from "./Settings";
import { Sidebar } from "./Sidebar";
import { AppModel, ModelContext, OTHER_WORKSPACE, useApp, useModel } from "./store";
import { TabBar, TerminalSurface, WorkspaceView } from "./Workspace";
import "./styles.css";

export function App({ services }: { services: Services }) {
  const model = useMemo(() => new AppModel(services), [services]);
  useEffect(() => {
    void model.start();
    return () => model.stop();
  }, [model]);
  return (
    <ModelContext.Provider value={model}>
      <TooltipProvider delayDuration={400}>
        <Shell />
      </TooltipProvider>
    </ModelContext.Provider>
  );
}

const ARROWS: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** 앱 단축키. 터미널 입력보다 먼저 받는다 (Cmd 조합은 터미널로 가지 않는다) */
function useShortcuts(model: AppModel) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = (f: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      };
      // Ctrl+` : 플로팅 워크스페이스
      if (e.ctrlKey && !e.metaKey && (e.code === "Backquote" || e.key === "`")) return run(() => void model.toggleFloating());
      if (!e.metaKey) return;
      const s = model.get();
      if (s.dialog) return;
      const key = e.key.toLowerCase();
      const arrow = ARROWS[e.key];
      if (arrow && e.altKey) return run(() => model.focusDir(arrow));
      if (arrow && e.ctrlKey) {
        const axis = arrow === "left" || arrow === "right" ? "row" : "column";
        return run(() => model.resizeBy(arrow === "right" || arrow === "down" ? 0.05 : -0.05, axis));
      }
      if (key === "j") return run(() => model.setDialog({ kind: "jump" }));
      if (key === ",") return run(() => model.setDialog({ kind: "settings" }));
      if (e.shiftKey && key === "n") {
        const repo = s.worktrees.find((w) => w.path === s.active)?.repo ?? s.repos[0]?.id;
        if (repo) run(() => model.setDialog({ kind: "new-worktree", repo }));
        return;
      }
      if (e.shiftKey && key === "e") return run(() => model.setPanel("files"));
      if (e.shiftKey && key === "g") return run(() => model.setPanel("changes"));
      if (e.shiftKey && key === "enter") return run(() => model.zoom());
      if (key === "d") return run(() => void model.split(e.shiftKey ? "down" : "right"));
      if (key === "t" && !e.shiftKey) return run(() => void model.newTab());
      if (key === "w" && !e.shiftKey) return run(() => void model.closeCurrent());
      // ⌘⇧[ ] 이전·다음 탭, ⌘[ ] 이전·다음 칸 (⇧ 가 눌리면 key 가 { } 로 오기도 한다)
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) return run(() => model.selectNearTab(e.code === "BracketRight" ? 1 : -1));
      if (e.key === "[" || e.key === "]") return run(() => model.focusCycle(e.key === "]" ? 1 : -1));
      if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey) return run(() => model.selectNearWorktree(e.key === "ArrowDown" ? 1 : -1));
      if (key === "b" && !e.shiftKey) return run(() => model.toggleSidebar());
      if (e.altKey && key === "=") return run(() => model.equalize());
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) return run(() => model.selectTabIndex(Number(e.key) - 1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [model]);
}

/** 운영체제에서 파일을 터미널 칸에 끌어 놓으면 경로를 셸에 맞게 감싸 붙여 넣는다 */
function useFileDrop(model: AppModel) {
  useEffect(() => {
    const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
    return model.services.host.onFileDrop?.((paths, x, y) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-pane]");
      const id = Number(el?.dataset.dropPane);
      const pane = Object.values(model.get().layouts)
        .flatMap((l) => l.tabs)
        .flatMap((t) => panesOf(t.root))
        .find((p) => p.id === id);
      if (pane?.type !== "terminal") return;
      const c = model.controller(pane.session);
      c.paste(`${paths.map(quote).join(" ")} `);
      model.focusPane(pane.id);
      c.focus();
    });
  }, [model]);
}

function Shell() {
  const model = useModel();
  useShortcuts(model);
  useFileDrop(model);
  const active = useApp((s) => s.active);
  const panel = useApp((s) => s.panel);
  const floating = useApp((s) => s.floating.open);
  const changes = useApp((s) => s.status[s.active]?.files.length ?? 0);
  const error = useApp((s) => s.error);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const notice = useApp((s) => s.notice);
  const inWorktree = active !== OTHER_WORKSPACE;

  return (
    <div className="flex h-full">
      {sidebarOpen && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col bg-background" onPointerDownCapture={() => model.get().focusArea !== "main" && model.setFocusArea("main")}>
        <div className="flex h-10 shrink-0 items-center border-b pr-2 pl-2" data-tauri-drag-region>
          <TabBar ws={active} windowDrag className="h-full flex-1">
            {inWorktree && (
              <div className="flex items-center gap-0.5">
                <PanelButton on={panel === "files"} label="파일 (⌘⇧E)" onClick={() => model.setPanel("files")}>
                  <FilesIcon />
                </PanelButton>
                <PanelButton on={panel === "changes"} label="변경 (⌘⇧G)" onClick={() => model.setPanel("changes")}>
                  <GitDiffIcon />
                  {changes > 0 && <span className="text-[10px] tabular-nums">{changes}</span>}
                </PanelButton>
              </div>
            )}
          </TabBar>
        </div>
        <TerminalSurface surface="main" className="flex-1">
          <WorkspaceView ws={active} empty={<Empty worktree={inWorktree} />} />
        </TerminalSurface>
      </main>
      {panel && inWorktree && <RightPanel />}
      {floating && <FloatingPanel />}
      <FloatingTrigger />
      <Dialogs />
      <SettingsDialog />
      <DragGhost />
      {notice && !error && (
        <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[70%] -translate-x-1/2 items-start gap-2 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
          <span className="min-w-0 break-words">{notice}</span>
          <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={model.clearError}>
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      {error && (
        <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[70%] -translate-x-1/2 items-start gap-2 rounded-lg border border-destructive/40 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
          <span className="min-w-0 break-words text-destructive">{error}</span>
          <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={model.clearError}>
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function PanelButton({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="xs" className={cn("h-7 gap-1 text-muted-foreground", on && "bg-accent text-foreground")} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Empty({ worktree }: { worktree: boolean }) {
  const model = useModel();
  return (
    <div className="grid h-full place-content-center gap-3 text-center text-muted-foreground">
      <TerminalWindowIcon className="mx-auto size-8 opacity-50" />
      <p>{worktree ? "이 워크트리에 열린 터미널이 없다." : "열린 터미널이 없다."}</p>
      <div className="flex justify-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void model.newTab()}>
          새 터미널 (⌘T)
        </Button>
        {worktree && (
          <Button size="sm" variant="outline" onClick={() => void model.newTab(undefined, "claude")}>
            claude 띄우기
          </Button>
        )}
      </div>
      <p className="text-2xs">
        ⌘D 오른쪽에 나누기 · ⌘⇧D 아래에 나누기 · Ctrl+` 플로팅
      </p>
    </div>
  );
}

/** 끄는 동안 손가락 옆에 따라다니는 이름표 */
function DragGhost() {
  const source = useDrag((d) => d.source);
  const x = useDrag((d) => d.x);
  const y = useDrag((d) => d.y);
  const hasTarget = useDrag((d) => d.target !== null);
  if (!source) return null;
  return (
    <div
      className={cn(
        "pointer-events-none fixed z-[60] max-w-60 truncate rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg",
        !hasTarget && "opacity-70",
      )}
      style={{ left: x + 12, top: y + 12 }}
    >
      {source.kind === "tab" ? "탭: " : "칸: "}
      {source.title}
    </div>
  );
}
