// 우클릭 메뉴, 모달 창, 워크트리 만들기·지우기 창.

import { useEffect, useMemo, useRef, useState } from "react";

import type { BranchList, RepoInfo, WorktreeInfo } from "@thuminal/term-core";

import { type NewWorktree, worktreeTitle } from "./store";

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: (MenuItem | "-")[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="thm-menu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="sep" />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 460 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  return (
    <div className="thm-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="thm-modal" style={{ width }}>
        <div className="thm-modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** 이름에서 브랜치 이름을 만든다: 공백은 -, git 이 받지 않는 글자는 뺀다 */
export function branchFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\]\\@{}'"`!$&|;<>()#,]+/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function NewWorktreeDialog({
  repos,
  initialRepo,
  loadBranches,
  onSubmit,
  onClose,
}: {
  repos: RepoInfo[];
  initialRepo: string;
  loadBranches: (repo: string) => Promise<BranchList>;
  onSubmit: (req: NewWorktree) => void;
  onClose: () => void;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [base, setBase] = useState("");
  const [start, setStart] = useState<NewWorktree["start"]>("claude");
  const [advanced, setAdvanced] = useState(false);
  const [branches, setBranches] = useState<BranchList | null>(null);

  useEffect(() => {
    let alive = true;
    setBranches(null);
    void loadBranches(repo).then((b) => {
      if (!alive) return;
      setBranches(b);
      setBase(b.default ?? b.current ?? b.local[0] ?? "");
    });
    return () => {
      alive = false;
    };
  }, [repo, loadBranches]);

  const effectiveBranch = branchEdited ? branch : branchFromName(name);
  const taken = !!branches?.local.includes(effectiveBranch);
  const ok = effectiveBranch.length > 0 && !taken;
  const submit = () => {
    if (!ok) return;
    onSubmit({ repo, name: name.trim(), branch: effectiveBranch, base: base || undefined, start });
    onClose();
  };

  return (
    <Modal title="새 워크트리" onClose={onClose}>
      <label className="thm-field">
        <span>이름</span>
        <input
          autoFocus
          value={name}
          placeholder="예: 로그인 화면 고치기"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <label className="thm-field">
        <span>프로젝트</span>
        <select value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="thm-field">
        <span>시작 브랜치</span>
        <select value={base} onChange={(e) => setBase(e.target.value)} disabled={!branches}>
          {!branches && <option>불러오는 중…</option>}
          {branches && (
            <>
              <optgroup label="원격">
                {branches.remote.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === branches.default ? " (기본)" : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="로컬">
                {branches.local.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === branches.current ? " (지금)" : ""}
                  </option>
                ))}
              </optgroup>
            </>
          )}
        </select>
      </label>
      <div className="thm-field">
        <span>처음 띄울 것</span>
        <div className="thm-seg">
          {(
            [
              ["claude", "claude"],
              ["shell", "터미널"],
              ["none", "없음"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={start === v ? "on" : ""} onClick={() => setStart(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <button className="thm-link" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "▾" : "▸"} 고급
      </button>
      {advanced && (
        <label className="thm-field">
          <span>브랜치 이름</span>
          <input
            value={effectiveBranch}
            onChange={(e) => {
              setBranchEdited(true);
              setBranch(e.target.value);
            }}
          />
        </label>
      )}
      <div className="thm-modal-note">
        {effectiveBranch ? (
          taken ? (
            <span className="warn">이미 있는 브랜치다: {effectiveBranch}</span>
          ) : (
            <>
              브랜치 <code>{effectiveBranch}</code> 를 <code>{base || "HEAD"}</code> 에서 만든다
            </>
          )
        ) : (
          "이름을 적으면 브랜치 이름을 만든다"
        )}
      </div>
      <div className="thm-modal-actions">
        <button onClick={onClose}>취소</button>
        <button className="primary" disabled={!ok} onClick={submit}>
          만들기 (Enter)
        </button>
      </div>
    </Modal>
  );
}

export function DeleteWorktreeDialog({
  worktree,
  dirty,
  terminals,
  onSubmit,
  onClose,
}: {
  worktree: WorktreeInfo;
  dirty: number;
  terminals: number;
  onSubmit: (opts: { force: boolean; deleteBranch: boolean }) => void;
  onClose: () => void;
}) {
  const [force, setForce] = useState(dirty > 0);
  const [deleteBranch, setDeleteBranch] = useState(true);
  return (
    <Modal title={`워크트리 지우기: ${worktreeTitle(worktree)}`} onClose={onClose}>
      <div className="thm-modal-note">
        <code>{worktree.path}</code> 폴더를 지운다.
        {terminals > 0 && <> 이 워크트리의 터미널 {terminals}개도 닫는다.</>}
        {dirty > 0 && <div className="warn">커밋하지 않은 변경이 {dirty}개 있다. 지우면 사라진다.</div>}
      </div>
      <label className="thm-check">
        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
        브랜치 <code>{worktree.branch}</code> 도 지운다
      </label>
      <label className="thm-check">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        강제로 지운다 (변경이 있거나 git 이 거절해도)
      </label>
      <div className="thm-modal-actions">
        <button onClick={onClose}>취소</button>
        <button
          className="danger"
          autoFocus
          onClick={() => {
            onSubmit({ force, deleteBranch });
            onClose();
          }}
        >
          지우기
        </button>
      </div>
    </Modal>
  );
}

/** Cmd+J: 워크트리 이름, 브랜치, 프로젝트로 찾아 간다 */
export function JumpPalette({
  worktrees,
  repos,
  onPick,
  onClose,
}: {
  worktrees: WorktreeInfo[];
  repos: RepoInfo[];
  onPick: (w: WorktreeInfo) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? "";
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return worktrees.filter((w) => {
      const hay = `${worktreeTitle(w)} ${w.branch ?? ""} ${repoName(w.repo)}`.toLowerCase();
      return words.every((x) => hay.includes(x));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, worktrees]);
  const pick = (w?: WorktreeInfo) => {
    if (!w) return;
    onPick(w);
    onClose();
  };
  return (
    <Modal title="워크트리로 가기" onClose={onClose} width={520}>
      <input
        className="thm-palette-input"
        autoFocus
        value={q}
        placeholder="이름, 브랜치, 프로젝트"
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((s) => Math.min(list.length - 1, s + 1));
          else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
          else if (e.key === "Enter") pick(list[sel]);
          else return;
          e.preventDefault();
        }}
      />
      <div className="thm-palette-list">
        {list.map((w, i) => (
          <div key={w.path} className={`item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(w)}>
            <span className="name">{worktreeTitle(w)}</span>
            <span className="meta">
              {repoName(w.repo)} · {w.branch ?? "(detached)"}
            </span>
          </div>
        ))}
        {list.length === 0 && <div className="empty">맞는 워크트리가 없다</div>}
      </div>
    </Modal>
  );
}
