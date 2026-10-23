import { useState } from "react";

import type { WorktreeInfo } from "@thuminal/term-core";

import type { MenuState } from "./overlays";
import { OTHER, type Snapshot, type Store, worktreeTitle } from "./store";

export interface SidebarActions {
  newWorktree: (repo: string) => void;
  deleteWorktree: (w: WorktreeInfo) => void;
  openMenu: (m: MenuState) => void;
  jump: () => void;
  reveal: (path: string) => void;
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

export function Sidebar({ store, snap, actions }: { store: Store; snap: Snapshot; actions: SidebarActions }) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  const terminals = (place: string) => store.tabsAt(place);
  // 점 색: 사용자를 부르는 에이전트 > 일하는 에이전트 > 입력을 기다리는 에이전트 > 출력 중 > 열린 터미널
  const dot = (place: string) => {
    const tabs = terminals(place);
    const agents = tabs.map((t) => t.agent?.state).filter(Boolean);
    if (agents.includes("needs_attention")) return "attention";
    if (agents.includes("working")) return "busy";
    if (agents.includes("idle")) return "waiting";
    if (tabs.some((s) => s.state.state === "running" && Date.now() - s.last_output_at < 3000)) return "busy";
    return tabs.length ? "on" : "";
  };
  const q = filter.trim().toLowerCase();
  const match = (w: WorktreeInfo) => !q || `${worktreeTitle(w)} ${w.branch ?? ""}`.toLowerCase().includes(q);
  const order = (list: WorktreeInfo[]) =>
    [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.is_main) - Number(a.is_main));

  const menuFor = (w: WorktreeInfo, x: number, y: number): MenuState => ({
    x,
    y,
    items: [
      { label: "이름 바꾸기", onClick: () => setRenaming(w.path) },
      { label: w.pinned ? "고정 풀기" : "맨 위에 고정", onClick: () => void store.togglePin(w) },
      "-",
      {
        label: "새 터미널",
        onClick: () => {
          store.select(w.path);
          void store.newTab();
        },
      },
      {
        label: "claude 띄우기",
        onClick: () => {
          store.select(w.path);
          void store.newTab(["claude"]);
        },
      },
      "-",
      { label: "이름 복사", onClick: () => copy(worktreeTitle(w)) },
      { label: "경로 복사", onClick: () => copy(w.path) },
      { label: "브랜치 이름 복사", disabled: !w.branch, onClick: () => copy(w.branch ?? "") },
      { label: "Finder 에서 보기", onClick: () => actions.reveal(w.path) },
      "-",
      { label: "워크트리 지우기…", hint: "⌘⇧⌫", danger: true, disabled: w.is_main, onClick: () => actions.deleteWorktree(w) },
    ],
  });

  const card = (w: WorktreeInfo) => {
    const st = snap.status.get(w.path);
    const changes = st?.files.length ?? 0;
    const tabs = terminals(w.path).length;
    const showBranch = w.branch && (w.name || w.is_main) ? w.branch : null;
    return (
      <div
        key={w.path}
        className={`thm-wt ${snap.active === w.path ? "active" : ""} ${store.unread(w.path) ? "unread" : ""}`}
        title={w.path}
        tabIndex={0}
        onClick={() => store.select(w.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          actions.openMenu(menuFor(w, e.clientX, e.clientY));
        }}
        onKeyDown={(e) => {
          if (e.metaKey && e.shiftKey && e.key === "Backspace" && !w.is_main) actions.deleteWorktree(w);
        }}
      >
        <span className={`dot ${dot(w.path)}`} />
        <div className="body">
          {renaming === w.path ? (
            <input
              className="thm-rename"
              autoFocus
              defaultValue={w.name ?? ""}
              placeholder={w.branch ?? ""}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void store.renameWorktree(w, e.currentTarget.value);
                  setRenaming(null);
                } else if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => setRenaming(null)}
            />
          ) : (
            <div
              className="title"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenaming(w.path);
              }}
            >
              {w.pinned && <span className="pin">📌</span>}
              {worktreeTitle(w)}
            </div>
          )}
          <div className="meta">
            {showBranch && <span className="branch">{showBranch}</span>}
            {w.is_main && <span className="badge">기본</span>}
            {changes > 0 && <span className="changes">±{changes}</span>}
            {!!st?.ahead && <span className="ahead">↑{st.ahead}</span>}
            {!!st?.behind && <span className="behind">↓{st.behind}</span>}
          </div>
        </div>
        {tabs > 0 && <span className="count">{tabs}</span>}
      </div>
    );
  };

  return (
    <aside className="thm-sidebar">
      <div className="thm-sidebar-head" data-tauri-drag-region>
        <button className="thm-icon" title="워크트리로 가기 (⌘J)" onClick={actions.jump}>
          ⌕
        </button>
        <button className="thm-icon" title="프로젝트 추가" onClick={() => void store.addProject()}>
          ＋
        </button>
      </div>
      <input className="thm-filter" placeholder="워크트리 거르기" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="thm-groups">
        {snap.repos.map((r) => {
          const list = order(snap.worktrees.filter((w) => w.repo === r.id && match(w)));
          const open = !collapsed.has(r.id);
          return (
            <div key={r.id} className="thm-repo">
              <div
                className="thm-repo-head"
                title={r.path}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (open) next.add(r.id);
                  else next.delete(r.id);
                  setCollapsed(next);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  actions.openMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: "새 워크트리…", onClick: () => actions.newWorktree(r.id) },
                      { label: "Finder 에서 보기", onClick: () => actions.reveal(r.path) },
                      { label: "경로 복사", onClick: () => copy(r.path) },
                      "-",
                      { label: "프로젝트 목록에서 빼기", danger: true, onClick: () => void store.removeProject(r.id) },
                    ],
                  });
                }}
              >
                <span className="caret">{open ? "▾" : "▸"}</span>
                <span className="name">{r.name}</span>
                <button
                  title="새 워크트리"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.newWorktree(r.id);
                  }}
                >
                  +
                </button>
              </div>
              {open && list.map(card)}
              {open &&
                snap.creating
                  .filter((c) => c.repo === r.id)
                  .map(({ branch: b }) => (
                  <div key={b} className="thm-wt creating">
                    <span className="dot busy" />
                    <div className="body">
                      <div className="title">{b}</div>
                      <div className="meta">만드는 중…</div>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
        {(terminals(OTHER).length > 0 || snap.repos.length === 0) && (
          <div className="thm-repo">
            <div className={`thm-wt ${snap.active === OTHER ? "active" : ""}`} onClick={() => store.select(OTHER)}>
              <span className={`dot ${dot(OTHER)}`} />
              <div className="body">
                <div className="title">기타</div>
                <div className="meta">워크트리 밖 터미널</div>
              </div>
              {terminals(OTHER).length > 0 && <span className="count">{terminals(OTHER).length}</span>}
            </div>
          </div>
        )}
        {snap.repos.length === 0 && (
          <button className="thm-add-project" onClick={() => void store.addProject()}>
            + 프로젝트 폴더 추가
            <small>git 저장소, 또는 저장소들이 든 폴더</small>
          </button>
        )}
      </div>
    </aside>
  );
}
