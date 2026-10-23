// 오른쪽 패널: 파일 탐색기와 소스 관리(변경 파일, 커밋, 푸시).

import { useEffect, useState } from "react";

import type { ChangeKind, DirEntry, FileChange, GitStatus, HostApi } from "@thuminal/term-core";

import type { MenuState } from "./overlays";
import type { Store } from "./store";

const LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
  untracked: "U",
  conflicted: "!",
};

function base(path: string) {
  return path.split("/").pop() ?? path;
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function ChangesPanel({
  store,
  host,
  worktree,
  status,
  openMenu,
}: {
  store: Store;
  host: HostApi;
  worktree: string;
  status: GitStatus | undefined;
  openMenu: (m: MenuState) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => f.unstaged);

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setNote(null);
    try {
      const r = await f();
      if (typeof r === "string" && r) setNote(r.split("\n").slice(-2).join(" "));
      await store.refreshStatus(worktree);
    } catch (e) {
      store.fail(`${label} 실패: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const commit = () => {
    if (!message.trim()) return;
    // 스테이지한 것이 없으면 바뀐 파일을 모두 담는다 (새 파일은 먼저 스테이지한다)
    const all = staged.length === 0;
    void run("커밋", async () => {
      if (all) await host.git.stage(worktree, files.map((f) => f.path));
      const id = await host.git.commit(worktree, message, false);
      setMessage("");
      return `커밋 ${id}`;
    });
  };

  const row = (f: FileChange, isStaged: boolean) => {
    const kind = (isStaged ? f.staged : f.unstaged)!;
    return (
      <div
        key={`${isStaged}:${f.path}`}
        className={`thm-change k-${kind}`}
        title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}
        onClick={() => store.openDoc({ kind: "diff", file: f.path, staged: isStaged })}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: "diff 보기", onClick: () => store.openDoc({ kind: "diff", file: f.path, staged: isStaged }) },
              { label: "파일 열기", disabled: kind === "deleted", onClick: () => store.openDoc({ kind: "file", file: f.path }) },
              "-",
              isStaged
                ? { label: "스테이지에서 빼기", onClick: () => void run("언스테이지", () => host.git.unstage(worktree, [f.path])) }
                : { label: "스테이지", onClick: () => void run("스테이지", () => host.git.stage(worktree, [f.path])) },
              ...(!isStaged
                ? [
                    "-" as const,
                    {
                      label: kind === "untracked" ? "파일 지우기" : "변경 버리기",
                      danger: true,
                      onClick: () => void run("되돌리기", () => host.git.discard(worktree, [f.path])),
                    },
                  ]
                : []),
            ],
          });
        }}
      >
        <span className="name">{base(f.path)}</span>
        <span className="dir">{dirOf(f.path)}</span>
        <span className="acts">
          {isStaged ? (
            <button title="스테이지에서 빼기" onClick={(e) => (e.stopPropagation(), void run("언스테이지", () => host.git.unstage(worktree, [f.path])))}>
              −
            </button>
          ) : (
            <>
              <button
                title={kind === "untracked" ? "파일 지우기" : "변경 버리기"}
                onClick={(e) => (e.stopPropagation(), void run("되돌리기", () => host.git.discard(worktree, [f.path])))}
              >
                ↺
              </button>
              <button title="스테이지" onClick={(e) => (e.stopPropagation(), void run("스테이지", () => host.git.stage(worktree, [f.path])))}>
                +
              </button>
            </>
          )}
        </span>
        <span className="letter">{LETTER[kind]}</span>
      </div>
    );
  };

  return (
    <div className="thm-changes">
      <div className="thm-branchline">
        <span>⎇ {status?.branch ?? "(detached)"}</span>
        {status?.upstream ? (
          <span className="sync">
            {status.ahead > 0 && `↑${status.ahead} `}
            {status.behind > 0 && `↓${status.behind}`}
            {!status.ahead && !status.behind && "맞춤"}
          </span>
        ) : (
          <span className="sync">원격 없음</span>
        )}
      </div>
      <textarea
        className="thm-commit-msg"
        placeholder="커밋 메시지 (⌘Enter 로 커밋)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) commit();
        }}
      />
      <div className="thm-commit-actions">
        <button className="primary" disabled={!message.trim() || files.length === 0 || !!busy} onClick={commit}>
          {staged.length ? `커밋 (${staged.length})` : `모두 커밋 (${files.length})`}
        </button>
        <button disabled={!!busy || !status?.branch} onClick={() => void run("푸시", () => host.git.push(worktree))} title="지금 브랜치를 올린다">
          {busy === "푸시" ? "올리는 중…" : status?.upstream ? `푸시${status.ahead ? ` ↑${status.ahead}` : ""}` : "푸시 (원격 브랜치 만들기)"}
        </button>
      </div>
      {note && <div className="thm-note">{note}</div>}
      {files.length === 0 && <div className="thm-empty-note">바뀐 파일이 없다</div>}
      {staged.length > 0 && (
        <div className="thm-change-group">
          <div className="head">
            <span>스테이지됨 {staged.length}</span>
            <button onClick={() => void run("언스테이지", () => host.git.unstage(worktree, staged.map((f) => f.path)))}>모두 빼기</button>
          </div>
          {staged.map((f) => row(f, true))}
        </div>
      )}
      {unstaged.length > 0 && (
        <div className="thm-change-group">
          <div className="head">
            <span>변경 {unstaged.length}</span>
            <button onClick={() => void run("스테이지", () => host.git.stage(worktree, unstaged.map((f) => f.path)))}>모두 스테이지</button>
          </div>
          {unstaged.map((f) => row(f, false))}
        </div>
      )}
    </div>
  );
}

/** 폴더를 열 때 그 안을 읽는 파일 트리. git 상태에 따라 색을 입힌다 */
export function FilesPanel({ store, host, worktree, status }: { store: Store; host: HostApi; worktree: string; status: GitStatus | undefined }) {
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map());

  const load = async (dir: string) => {
    try {
      const list = await host.files.list(worktree, dir);
      setEntries((m) => new Map(m).set(dir, list));
    } catch (e) {
      store.fail(e);
    }
  };

  useEffect(() => {
    setEntries(new Map());
    setOpen(new Set([""]));
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree]);

  // 파일 상태 색: 그 파일 또는 그 아래 파일이 바뀌었으면 칠한다
  const kindOf = (path: string, isDir: boolean): ChangeKind | null => {
    for (const f of status?.files ?? []) {
      if (f.path === path || (isDir && f.path.startsWith(path + "/"))) return isDir ? "modified" : (f.unstaged ?? f.staged);
    }
    return null;
  };

  const toggle = (dir: string) => {
    const next = new Set(open);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!entries.has(dir)) void load(dir);
    }
    setOpen(next);
  };

  const render = (dir: string, depth: number): React.ReactNode =>
    (entries.get(dir) ?? []).map((e) => {
      const path = dir ? `${dir}/${e.name}` : e.name;
      const kind = kindOf(path, e.is_dir);
      return (
        <div key={path}>
          <div
            className={`thm-file ${kind ? `k-${kind}` : ""} ${e.ignored ? "ignored" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => (e.is_dir ? toggle(path) : store.openDoc({ kind: "file", file: path }))}
            title={path}
          >
            <span className="caret">{e.is_dir ? (open.has(path) ? "▾" : "▸") : ""}</span>
            <span className="name">{e.name}</span>
          </div>
          {e.is_dir && open.has(path) && render(path, depth + 1)}
        </div>
      );
    });

  return (
    <div className="thm-files">
      <div className="thm-files-head">
        <span>{base(worktree)}</span>
        <button title="새로 읽기" onClick={() => [...open].forEach((d) => void load(d))}>
          ↻
        </button>
      </div>
      {render("", 0)}
    </div>
  );
}
