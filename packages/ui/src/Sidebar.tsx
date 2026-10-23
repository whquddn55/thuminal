import { useState } from "react";

import type { WorktreeInfo } from "@thuminal/term-core";

import { OTHER, type Snapshot, type Store } from "./store";

/** 이름을 받는 한 줄 입력칸 (WKWebView 는 window.prompt 를 막는다) */
function InlineInput({ placeholder, onSubmit, onCancel }: { placeholder: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  return (
    <input
      className="thm-inline-input"
      autoFocus
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) onSubmit(v.trim());
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
    />
  );
}

export function Sidebar({ store, snap }: { store: Store; snap: Snapshot }) {
  const [adding, setAdding] = useState<"repo" | string | null>(null);
  // 지우기는 두 번 눌러 확인한다 (WKWebView 는 confirm 을 막는다)
  const [armed, setArmed] = useState<string | null>(null);
  const count = (place: string) => store.tabsAt(place).length;
  // 점 색: 사용자를 부르는 에이전트 > 일하는 에이전트 > 입력을 기다리는 에이전트 > 출력 중 > 열린 터미널
  const dot = (place: string) => {
    const tabs = store.tabsAt(place);
    const agents = tabs.map((t) => t.agent?.state).filter(Boolean);
    if (agents.includes("needs_attention")) return "attention";
    if (agents.includes("working")) return "busy";
    if (agents.includes("idle")) return "waiting";
    if (tabs.some((s) => s.state.state === "running" && Date.now() - s.last_output_at < 3000)) return "busy";
    return tabs.length ? "on" : "";
  };

  const item = (w: WorktreeInfo) => (
    <div key={w.path} className={`thm-wt ${snap.active === w.path ? "active" : ""}`} onClick={() => store.select(w.path)} title={w.path}>
      <span className={`dot ${dot(w.path)}`} />
      <span className="name">{w.is_main ? (w.branch ?? "main") : (w.branch ?? w.path.split("/").pop())}</span>
      <span className="count">{count(w.path) || ""}</span>
      {!w.is_main && (
        <button
          className={`rm ${armed === w.path ? "armed" : ""}`}
          title="워크트리 지우기 (터미널도 닫는다)"
          onMouseLeave={() => setArmed(null)}
          onClick={(e) => {
            e.stopPropagation();
            if (armed === w.path) {
              setArmed(null);
              void store.removeWorktree(w);
            } else setArmed(w.path);
          }}
        >
          {armed === w.path ? "지우기" : "×"}
        </button>
      )}
    </div>
  );

  return (
    <aside className="thm-sidebar">
      <div className="thm-sidebar-head" data-tauri-drag-region />
      <div className="thm-groups">
        {snap.repos.map((r) => (
          <div key={r.id} className="thm-repo">
            <div className="thm-repo-head" title={r.path}>
              <span>{r.name}</span>
              <button title="새 워크트리" onClick={() => setAdding(r.id)}>
                +
              </button>
            </div>
            {adding === r.id && (
              <InlineInput
                placeholder="새 브랜치 이름"
                onSubmit={(branch) => {
                  setAdding(null);
                  void store.newWorktree(r.id, branch);
                }}
                onCancel={() => setAdding(null)}
              />
            )}
            {snap.worktrees.filter((w) => w.repo === r.id).map(item)}
          </div>
        ))}
        {(count(OTHER) > 0 || snap.repos.length === 0) && (
          <div className="thm-repo">
            <div className={`thm-wt ${snap.active === OTHER ? "active" : ""}`} onClick={() => store.select(OTHER)}>
              <span className={`dot ${count(OTHER) ? "on" : ""}`} />
              <span className="name">기타</span>
              <span className="count">{count(OTHER) || ""}</span>
            </div>
          </div>
        )}
      </div>
      {adding === "repo" ? (
        <InlineInput
          placeholder="저장소 경로 (예: ~/workspace/proj)"
          onSubmit={(p) => {
            setAdding(null);
            void store.addRepo(p);
          }}
          onCancel={() => setAdding(null)}
        />
      ) : (
        <button className="thm-add-group" onClick={() => setAdding("repo")}>
          + 저장소
        </button>
      )}
    </aside>
  );
}
