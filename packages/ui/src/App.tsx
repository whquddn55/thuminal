import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Renderer, WorktreeInfo } from "@thuminal/term-core";

import { ContextMenu, DeleteWorktreeDialog, JumpPalette, type MenuState, NewWorktreeDialog } from "./overlays";
import { ChangesPanel, FilesPanel } from "./RightPanel";
import type { Services } from "./services";
import { Sidebar } from "./Sidebar";
import { OTHER, Store } from "./store";
import { DocView } from "./viewers";
import "./styles.css";

export function App({ services }: { services: Services }) {
  const store = useMemo(() => new Store(services), [services]);
  const snap = useSyncExternalStore(store.subscribe, store.get);
  const stageRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newWt, setNewWt] = useState<string | null>(null);
  const [delWt, setDelWt] = useState<WorktreeInfo | null>(null);
  const [jump, setJump] = useState(false);

  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, [store]);

  // 렌더러는 터미널 영역 하나에 하나만 둔다
  useEffect(() => {
    const r = services.renderer(stageRef.current!, services.rendererOptions);
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
  }, [services]);

  // 지금 터미널 탭(플로팅이 열려 있으면 플로팅)만 렌더러에 그린다. 다른 탭은 엔진만 출력을 받는다
  const termTab = typeof snap.activeTab === "number" ? snap.activeTab : null;
  const shown = snap.floating ?? termTab;
  useEffect(() => {
    const host = snap.floating !== null ? floatRef.current : paneRef.current;
    if (!renderer || shown === null || !host) return;
    const c = store.controller(shown);
    c.show(host, renderer);
    return () => c.hide();
  }, [renderer, shown, snap.floating, snap.generation, store]);

  // 패널을 열고 닫으면 터미널 자리 크기가 바뀐다
  useEffect(() => {
    renderer?.layout();
  }, [renderer, snap.panel]);

  const activeWorktree = snap.worktrees.find((w) => w.path === snap.active) ?? null;
  const activeRepo = activeWorktree?.repo ?? snap.repos[0]?.id ?? null;

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+` : 플로팅 터미널
      if (e.ctrlKey && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        void store.toggleFloating();
        return;
      }
      if (!e.metaKey) return;
      const cur = store.get();
      const key = e.key.toLowerCase();
      const run = (f: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      };
      if (key === "j") run(() => setJump(true));
      else if (e.shiftKey && key === "n" && activeRepo) run(() => setNewWt(activeRepo));
      else if (e.shiftKey && key === "e") run(() => store.setPanel("files"));
      else if (e.shiftKey && key === "g") run(() => store.setPanel("changes"));
      else if (key === "t" && !e.shiftKey) run(() => void store.newTab());
      else if (key === "w" && cur.activeTab !== null) run(() => void store.closeTab(cur.activeTab!));
      else if (/^[1-9]$/.test(e.key)) {
        const keys = [...store.tabsAt(cur.active).map((t) => t.id), ...cur.docs.map((d) => d.id)];
        const k = keys[Number(e.key) - 1];
        if (k !== undefined) run(() => store.selectTab(k));
      }
    },
    [store, activeRepo],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onKey]);

  const tabs = store.tabsAt(snap.active);
  const status = snap.status.get(snap.active);
  const changes = status?.files.length ?? 0;
  const activeDoc = typeof snap.activeTab === "string" ? snap.docs.find((d) => d.id === snap.activeTab) : undefined;
  const inWorktree = snap.active !== OTHER;

  return (
    <div className={`thm-app ${snap.panel && inWorktree ? "with-panel" : ""}`}>
      <Sidebar
        store={store}
        snap={snap}
        actions={{
          newWorktree: (repo) => setNewWt(repo),
          deleteWorktree: (w) => setDelWt(w),
          openMenu: setMenu,
          jump: () => setJump(true),
          reveal: (p) => void services.host.reveal(p).catch((e) => store.fail(e)),
        }}
      />
      <main className="thm-main">
        <div className="thm-tabs" data-tauri-drag-region>
          {tabs.map((t, i) => (
            <div
              key={t.id}
              className={`thm-tab ${t.id === snap.activeTab ? "active" : ""} ${t.state.state === "exited" ? "exited" : ""}`}
              onClick={() => store.selectTab(t.id)}
              title={t.cwd}
            >
              <span className="idx">{i + 1}</span>
              {t.agent && <span className={`agent ${t.agent.state}`} title={`${t.agent.kind}: ${t.agent.state}`} />}
              <span className="title">{t.title}</span>
              <button
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  void store.closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {snap.docs.map((d) => (
            <div key={d.id} className={`thm-tab doc ${d.id === snap.activeTab ? "active" : ""}`} onClick={() => store.selectTab(d.id)} title={d.file}>
              <span className="idx">{d.kind === "diff" ? "±" : "▤"}</span>
              <span className="title">{d.file.split("/").pop()}</span>
              <button
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  void store.closeTab(d.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="thm-new-tab" onClick={() => void store.newTab()} title="새 터미널 (⌘T)">
            +
          </button>
          <div className="thm-tabs-spacer" data-tauri-drag-region />
          {inWorktree && (
            <>
              <button className={`thm-panel-btn ${snap.panel === "files" ? "on" : ""}`} onClick={() => store.setPanel("files")} title="파일 (⌘⇧E)">
                파일
              </button>
              <button className={`thm-panel-btn ${snap.panel === "changes" ? "on" : ""}`} onClick={() => store.setPanel("changes")} title="변경 (⌘⇧G)">
                변경{changes > 0 && <span className="n">{changes}</span>}
              </button>
            </>
          )}
        </div>
        <div className="thm-stage" ref={stageRef}>
          {snap.floating !== null && (
            <div className="thm-floating">
              <div className="thm-floating-head">
                <span>플로팅 터미널</span>
                <span className="hint">Ctrl+` 로 닫기</span>
              </div>
              <div className="thm-floating-pane" ref={floatRef} />
            </div>
          )}
          {activeDoc ? (
            <DocView host={services.host} worktree={snap.active} doc={activeDoc} generation={JSON.stringify(status ?? null).length + (status?.files.length ?? 0)} />
          ) : termTab === null ? (
            <div className="thm-empty">
              <p>{inWorktree ? "이 워크트리에 열린 터미널이 없다." : "열린 터미널이 없다."}</p>
              <div className="row">
                <button onClick={() => void store.newTab()}>새 터미널 (⌘T)</button>
                {inWorktree && <button onClick={() => void store.newTab(["claude"])}>claude 띄우기</button>}
              </div>
            </div>
          ) : (
            <div className="thm-pane" ref={paneRef} style={{ visibility: snap.floating !== null ? "hidden" : "visible" }} />
          )}
        </div>
        {snap.error && (
          <div className="thm-error" onClick={() => store.clearError()} title="눌러서 닫기">
            {snap.error}
          </div>
        )}
      </main>
      {snap.panel && inWorktree && (
        <aside className="thm-right">
          {snap.panel === "changes" ? (
            <ChangesPanel store={store} host={services.host} worktree={snap.active} status={status} openMenu={setMenu} />
          ) : (
            <FilesPanel store={store} host={services.host} worktree={snap.active} status={status} />
          )}
        </aside>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {newWt && (
        <NewWorktreeDialog
          repos={snap.repos}
          initialRepo={newWt}
          loadBranches={services.host.git.branches}
          onSubmit={(req) => void store.newWorktree(req)}
          onClose={() => setNewWt(null)}
        />
      )}
      {delWt && (
        <DeleteWorktreeDialog
          worktree={delWt}
          dirty={snap.status.get(delWt.path)?.files.length ?? 0}
          terminals={store.tabsAt(delWt.path).length}
          onSubmit={(opts) => void store.removeWorktree(delWt, opts)}
          onClose={() => setDelWt(null)}
        />
      )}
      {jump && <JumpPalette worktrees={snap.worktrees} repos={snap.repos} onPick={(w) => store.select(w.path)} onClose={() => setJump(false)} />}
    </div>
  );
}
