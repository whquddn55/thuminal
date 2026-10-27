import { SidebarSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo } from "react";

import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { hostAt, useDrag } from "./dnd";
import { panesOf } from "./layout";
import { FloatingPanel, FloatingTrigger } from "./FloatingPanel";
import { cn } from "./lib/utils";
import { appMods, keyLabel } from "./platform";
import { Dialogs } from "./overlays";
import { RightPanel } from "./RightPanel";
import type { Services } from "./services";
import { SettingsDialog } from "./Settings";
import { Sidebar } from "./Sidebar";
import { AppModel, HOST_STATE_LABEL, hostStateIsError, ModelContext, OTHER_WORKSPACE, useApp, useModel } from "./store";
import { EmptyWorkspace, TabBar, TerminalSurface, WorkspaceView } from "./Workspace";
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

/**
 * 앱 단축키. 터미널 입력보다 먼저 받는다 (Cmd 조합은 터미널로 가지 않는다).
 * `model` 은 root 다. 칸·탭을 다루는 것은 키보드가 가 있는 호스트 모델(`focusedModel`)로, 창 전체 일은 root 로 보낸다
 */
function useShortcuts(root: AppModel) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Windows · Linux 키는 macOS 단축키 자리로 읽는다 (platform.ts)
      const k = appMods(e);
      const model = root.focusedModel();
      const run = (f: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      };
      // 단축키는 Orca 와 같다. thuminal 에만 있는 칸 방향 이동은 ⌃⌘방향키, 칸 크기는 ⌃⌘⇧방향키
      // ⌃` 와 ⌘⌥A : 플로팅 워크스페이스 (⌘⌥⇧A 는 최대화한 채로)
      if (k.ctrl && !k.meta && (e.code === "Backquote" || e.key === "`")) return run(() => void root.toggleFloating());
      if (k.meta && k.alt && e.code === "KeyA") return run(() => void root.toggleFloating(k.shift));
      // ⌃1~9 : 지금 워크스페이스의 탭
      if (k.ctrl && !k.meta && !k.alt && /^Digit[1-9]$/.test(e.code)) return run(() => model.selectTabIndex(Number(e.code.slice(5)) - 1));
      if (!k.meta) return;
      // ⌘+ ⌘- ⌘0 : 터미널에 포커스가 있으면 터미널 글자 크기, 아니면 앱 화면 배율 (웹은 브라우저 확대에 맡긴다)
      if (!k.alt && !k.ctrl && (e.code === "Equal" || e.code === "Minus" || e.code === "Digit0")) {
        const dir = e.code === "Minus" ? -1 : e.code === "Digit0" ? 0 : 1;
        if (document.activeElement?.classList.contains("thm-input")) return run(() => root.zoomTerminal(dir));
        if (root.zoomUi(dir)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const s = model.get();
      if (s.dialog) return;
      const key = e.key.toLowerCase();
      const arrow = ARROWS[e.key];
      if (arrow && k.ctrl && k.shift) {
        const axis = arrow === "left" || arrow === "right" ? "row" : "column";
        return run(() => model.resizeBy(arrow === "right" || arrow === "down" ? 0.05 : -0.05, axis));
      }
      if (arrow && k.ctrl) return run(() => model.focusDir(arrow));
      // ⌘⌥← → : 워크트리 방문 기록 뒤로·앞으로
      if (arrow && k.alt && (arrow === "left" || arrow === "right")) return run(() => root.goHistory(arrow === "left" ? -1 : 1));
      // 브라우저 칸이 포커스면 Orca 와 같이 ⌘[ ] 뒤로·앞으로, ⌘R 새로 고침, ⌘L 주소 칸
      if (!k.shift && !k.alt && !k.ctrl && model.currentBrowser() !== null) {
        const cmd = e.key === "[" ? "back" : e.key === "]" ? "forward" : key === "r" ? "reload" : key === "l" ? "address" : null;
        if (cmd) return run(() => model.browserCommand(cmd));
      }
      if (k.shift && key === "b") return run(() => void model.newBrowserTab());
      if (key === "j") return run(() => root.setDialog({ kind: "jump" }));
      if (key === ",") return run(() => root.setDialog({ kind: "settings" }));
      if (k.shift && key === "n") {
        const repo = s.worktrees.find((w) => w.path === s.active)?.repo ?? s.repos[0]?.id;
        if (repo) run(() => model.setDialog({ kind: "new-worktree", repo }));
        return;
      }
      if (k.shift && key === "e") return run(() => model.setPanel("files"));
      if (k.shift && key === "g") return run(() => model.setPanel("changes"));
      if (k.shift && key === "f") return run(() => model.setPanel("search"));
      // ⌘⇧O : 지금 워크트리의 Markdown 파일 열기 (Orca 와 같다)
      if (k.shift && key === "o") {
        if (s.active.startsWith("/")) run(() => model.setDialog({ kind: "open-markdown" }));
        return;
      }
      // 브라우저 칸이면 위에서 주소 칸으로 갔다. 그 밖에는 오른쪽 사이드바 (Orca 와 같다)
      if (key === "l" && !k.shift && !k.alt) return run(() => model.toggleRight());
      if (k.shift && key === "enter") return run(() => model.zoom());
      if (key === "d") return run(() => void model.split(k.shift ? "down" : "right"));
      if (key === "t" && !k.shift) return run(() => void model.newTab());
      if (key === "w" && !k.shift) return run(() => void model.closeCurrent());
      // ⌘⇧[ ] 이전·다음 탭, ⌘[ ] 이전·다음 칸 (⇧ 가 눌리면 key 가 { } 로 오기도 한다)
      if (k.shift && (e.code === "BracketLeft" || e.code === "BracketRight")) return run(() => model.selectNearTab(e.code === "BracketRight" ? 1 : -1));
      if (e.key === "[" || e.key === "]") return run(() => model.focusCycle(e.key === "]" ? 1 : -1));
      if (k.shift && (e.key === "ArrowUp" || e.key === "ArrowDown") && !k.alt && !k.ctrl) return run(() => root.selectNearWorktree(e.key === "ArrowDown" ? 1 : -1));
      if (key === "b" && !k.shift) return run(() => root.toggleSidebar());
      if (k.alt && key === "=") return run(() => model.equalize());
      // ⌘⌥T : 새 에이전트 탭 (찾은 에이전트 중 첫째, 보통 claude)
      if (k.alt && e.code === "KeyT") return run(() => void model.newTab(undefined, s.agents[0] ?? "claude"));
      // ⌘1~9 : 사이드바 순서로 n 번째 워크트리 (원격 컴퓨터 것도)
      if (/^Digit[1-9]$/.test(e.code) && !k.shift && !k.alt) return run(() => root.selectWorktreeIndex(Number(e.code.slice(5)) - 1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [root]);
}

/** 운영체제에서 파일을 터미널 칸에 끌어 놓으면 경로를 셸에 맞게 감싸 붙여 넣는다. 원격 칸은 아직 막는다 (올리기는 다음 단계) */
function useFileDrop(root: AppModel) {
  useEffect(() => {
    const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
    return root.services.host.onFileDrop?.((paths, x, y) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-pane]");
      if (!el) return;
      const model = root.hostModel(hostAt(el));
      if (!model) return;
      if (model.services.host.isRemote) return model.notice("원격 컴퓨터 터미널에는 아직 파일을 끌어 놓을 수 없어요");
      const id = Number(el.dataset.dropPane);
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
  }, [root]);
}

function Shell() {
  const model = useModel();
  useShortcuts(model);
  useFileDrop(model);
  const floating = useApp((s) => s.floating.open);
  const error = useApp((s) => s.error);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const notice = useApp((s) => s.notice);
  // 메인 면과 오른쪽 사이드바는 고른 호스트 모델로 그린다 (지운 원격이면 로컬)
  const activeHost = useApp((s) => s.activeHost);
  useApp((s) => s.remoteHosts);
  const main = model.hostModel(activeHost) ?? model;

  return (
    <div className="flex h-full">
      {sidebarOpen && <Sidebar />}
      <ModelContext.Provider value={main}>
        <MainArea />
      </ModelContext.Provider>
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

/** 메인 면(탭 줄 + 칸) 과 오른쪽 사이드바. 고른 호스트 모델 안에서 그린다 */
function MainArea() {
  const model = useModel();
  const active = useApp((s) => s.active);
  const panel = useApp((s) => s.panel);
  const changes = useApp((s) => s.status[s.active]?.files.length ?? 0);
  const inWorktree = active !== OTHER_WORKSPACE;
  return (
    <>
      <main
        className="flex min-w-0 flex-1 flex-col bg-background"
        data-host={model.hostKey}
        onPointerDownCapture={() => model.get().focusArea !== "main" && model.setFocusArea("main")}
      >
        <div className="flex h-10 shrink-0 items-center border-b pr-2 pl-2" data-tauri-drag-region>
          <TabBar ws={active} windowDrag className="h-full flex-1">
            {inWorktree && (
              <PanelButton on={!!panel} label={`오른쪽 사이드바: 파일, 변경, 검색 (${keyLabel("⌘L")})`} onClick={() => model.toggleRight()}>
                {changes > 0 && <span className="text-[10px] tabular-nums">{changes}</span>}
                <SidebarSimpleIcon className="-scale-x-100" />
              </PanelButton>
            )}
          </TabBar>
        </div>
        {!model.isRoot && <HostBand />}
        <TerminalSurface surface="main" className="flex-1">
          <WorkspaceView ws={active} empty={<EmptyWorkspace ws={active} />} />
        </TerminalSurface>
      </main>
      {panel && inWorktree && <RightPanel />}
    </>
  );
}

/** 메인 면이 원격 컴퓨터인데 붙어 있지 않으면 위에 띠를 띄운다. 다시 붙으면 터미널은 저장본으로 다시 그린다 */
function HostBand() {
  const model = useModel();
  const host = useApp((s) => s.remoteHosts.find((h) => h.id === model.hostKey));
  if (!host || host.state === "connected") return null;
  const error = hostStateIsError(host.state);
  return (
    <div className={cn("flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs", error ? "bg-destructive/10 text-destructive" : "bg-muted/60 text-muted-foreground")}>
      <span className="min-w-0 flex-1 truncate">
        {host.name}: {HOST_STATE_LABEL[host.state]}
        {host.error && ` (${host.error})`}
        {host.state === "disconnected" && host.retryInMs !== null && ` · ${Math.ceil(host.retryInMs / 1000)}초 뒤 다시 연결`}
      </span>
      {error ? (
        <Button size="xs" variant="outline" onClick={() => model.setDialog({ kind: "settings", section: "hosts" })}>
          설정에서 다시 등록
        </Button>
      ) : (
        <Button size="xs" variant="outline" onClick={() => void model.root.services.host.hosts?.reconnect(model.hostKey).catch(model.fail)}>
          다시 연결
        </Button>
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
      {{ tab: "탭: ", pane: "칸: ", project: "프로젝트: " }[source.kind]}
      {source.title}
    </div>
  );
}
