import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Renderer } from "@thuminal/term-core";

import type { Services } from "./services";
import { Sidebar } from "./Sidebar";
import { Store } from "./store";
import "./styles.css";

export function App({ services }: { services: Services }) {
  const store = useMemo(() => new Store(services), [services]);
  const snap = useSyncExternalStore(store.subscribe, store.get);
  const stageRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);

  useEffect(() => {
    void store.start();
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

  // 지금 탭(플로팅이 열려 있으면 플로팅)만 렌더러에 그린다. 다른 탭은 엔진만 출력을 받는다
  const shown = snap.floating ?? snap.activeTab;
  useEffect(() => {
    const host = snap.floating !== null ? floatRef.current : paneRef.current;
    if (!renderer || shown === null || !host) return;
    const c = store.controller(shown);
    c.show(host, renderer);
    return () => c.hide();
  }, [renderer, shown, snap.floating, snap.generation, store]);

  // 앱 단축키: Cmd+T 새 탭, Cmd+W 탭 닫기, Cmd+1~9 탭 고르기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+` : 플로팅 터미널
      if (e.ctrlKey && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        void store.toggleFloating();
        return;
      }
      if (!e.metaKey) return;
      const cur = store.get();
      const tabs = store.tabsAt(cur.active);
      if (e.key === "t") {
        e.preventDefault();
        void store.newTab();
      } else if (e.key === "w" && cur.activeTab !== null) {
        e.preventDefault();
        void store.closeTab(cur.activeTab);
      } else if (/^[1-9]$/.test(e.key)) {
        const t = tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          store.selectTab(t.id);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store]);

  const tabs = store.tabsAt(snap.active);

  return (
    <div className="thm-app">
      <Sidebar store={store} snap={snap} />
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
          <button className="thm-new-tab" onClick={() => void store.newTab()} title="새 탭 (Cmd+T)">
            +
          </button>
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
          {snap.activeTab === null ? (
            <div className="thm-empty">
              <p>열린 터미널이 없다.</p>
              <button onClick={() => void store.newTab()}>새 터미널 (Cmd+T)</button>
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
    </div>
  );
}
