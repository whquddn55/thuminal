// 오른쪽 패널: 파일 탐색기와 소스 관리(변경 파일, 커밋, 푸시).

import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretDownIcon, CaretRightIcon, GitBranchIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { ChangeKind, DirEntry, FileChange, GitStatus } from "@thuminal/term-core";

import { Button } from "./components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "./components/ui/context-menu";
import { cn } from "./lib/utils";
import { useApp, useModel } from "./store";

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

/** 바뀐 종류의 글자색 */
const TONE: Record<ChangeKind, string> = {
  added: "text-emerald-500",
  untracked: "text-emerald-500",
  modified: "text-amber-500",
  renamed: "text-amber-500",
  copied: "text-amber-500",
  type_changed: "text-amber-500",
  deleted: "text-red-500",
  conflicted: "text-red-500",
};

function base(path: string) {
  return path.split("/").pop() ?? path;
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const HEAD = "flex items-center justify-between px-3 pt-2.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground";

export function RightPanel() {
  const panel = useApp((s) => s.panel);
  const worktree = useApp((s) => s.active);
  const status = useApp((s) => s.status[s.active]);
  return (
    <aside className="flex min-h-0 w-72 shrink-0 flex-col overflow-auto border-l bg-sidebar text-sidebar-foreground thm-scroll">
      {panel === "changes" ? <ChangesPanel worktree={worktree} status={status} /> : <FilesPanel worktree={worktree} status={status} />}
    </aside>
  );
}

function ChangesPanel({ worktree, status }: { worktree: string; status: GitStatus | undefined }) {
  const model = useModel();
  const host = model.services.host;
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
      await model.refreshStatus(worktree);
    } catch (e) {
      model.fail(`${label} 실패: ${e}`);
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

  const stage = (paths: string[]) => void run("스테이지", () => host.git.stage(worktree, paths));
  const unstage = (paths: string[]) => void run("언스테이지", () => host.git.unstage(worktree, paths));
  // 버리기는 되돌릴 수 없다 (새 파일은 지워진다). 에이전트 작업을 날리지 않게 먼저 묻는다
  const discard = (paths: string[]) =>
    model.setDialog({
      kind: "confirm",
      title: paths.length === 1 ? `${base(paths[0])} 의 변경을 버릴까?` : `변경 ${paths.length}개를 버릴까?`,
      body: "되돌릴 수 없다. 새로 만든 파일은 지워진다.",
      action: "버리기",
      run: () => void run("되돌리기", () => host.git.discard(worktree, paths)),
    });
  const diff = (f: FileChange, isStaged: boolean) => model.openDoc({ kind: "diff", file: f.path, staged: isStaged ? "1" : "0" });

  const row = (f: FileChange, isStaged: boolean) => {
    const kind = (isStaged ? f.staged : f.unstaged)!;
    return (
      <ContextMenu key={`${isStaged}:${f.path}`}>
        <ContextMenuTrigger asChild>
          <div
            className="group flex h-6 cursor-pointer items-center gap-1.5 px-3 hover:bg-sidebar-accent"
            title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}
            onClick={() => diff(f, isStaged)}
          >
            <span className="whitespace-nowrap">{base(f.path)}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground [direction:rtl] text-left">{dirOf(f.path)}</span>
            <span className="hidden gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
              {isStaged ? (
                <Button variant="ghost" size="icon-xs" title="스테이지에서 빼기" onClick={() => unstage([f.path])}>
                  <MinusIcon />
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="icon-xs" title={kind === "untracked" ? "파일 지우기" : "변경 버리기"} onClick={() => discard([f.path])}>
                    <ArrowCounterClockwiseIcon />
                  </Button>
                  <Button variant="ghost" size="icon-xs" title="스테이지" onClick={() => stage([f.path])}>
                    <PlusIcon />
                  </Button>
                </>
              )}
            </span>
            <span className={cn("w-3.5 text-center font-mono text-2xs", TONE[kind])}>{LETTER[kind]}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={() => diff(f, isStaged)}>diff 보기</ContextMenuItem>
          <ContextMenuItem disabled={kind === "deleted"} onSelect={() => model.openDoc({ kind: "file", file: f.path })}>
            파일 열기
          </ContextMenuItem>
          <ContextMenuSeparator />
          {isStaged ? (
            <ContextMenuItem onSelect={() => unstage([f.path])}>스테이지에서 빼기</ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem onSelect={() => stage([f.path])}>스테이지</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => discard([f.path])}>
                {kind === "untracked" ? "파일 지우기" : "변경 버리기"}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const group = (label: string, list: FileChange[], isStaged: boolean) =>
    list.length > 0 && (
      <div className="pb-1">
        <div className={HEAD}>
          <span>
            {label} {list.length}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="h-5 text-2xs text-muted-foreground"
            onClick={() => (isStaged ? unstage : stage)(list.map((f) => f.path))}
          >
            {isStaged ? "모두 빼기" : "모두 스테이지"}
          </Button>
        </div>
        {list.map((f) => row(f, isStaged))}
      </div>
    );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2 text-xs">
        <span className="flex min-w-0 items-center gap-1 truncate">
          <GitBranchIcon className="size-3.5 shrink-0" />
          {status?.branch ?? "(detached)"}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {status?.upstream ? (
            <>
              {status.ahead > 0 && `↑${status.ahead} `}
              {status.behind > 0 && `↓${status.behind}`}
              {!status.ahead && !status.behind && "맞춤"}
            </>
          ) : (
            "원격 없음"
          )}
        </span>
      </div>
      <textarea
        className="mx-3 min-h-16 resize-y rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder="커밋 메시지 (⌘Enter 로 커밋)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) commit();
        }}
      />
      <div className="flex gap-1.5 px-3 py-2">
        <Button size="sm" className="flex-1" disabled={!message.trim() || files.length === 0 || !!busy} onClick={commit}>
          {staged.length ? `커밋 (${staged.length})` : `모두 커밋 (${files.length})`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          disabled={!!busy || !status?.branch}
          onClick={() => void run("푸시", () => host.git.push(worktree))}
          title="지금 브랜치를 올린다"
        >
          {busy === "푸시" ? "올리는 중…" : status?.upstream ? `푸시${status.ahead ? ` ↑${status.ahead}` : ""}` : "푸시 (원격 만들기)"}
        </Button>
      </div>
      {note && <div className="mx-3 mb-1.5 break-all text-2xs text-muted-foreground">{note}</div>}
      {files.length === 0 && <div className="p-4 text-muted-foreground">바뀐 파일이 없다</div>}
      {group("스테이지됨", staged, true)}
      {group("변경", unstaged, false)}
    </div>
  );
}

/** 폴더를 열 때 그 안을 읽는 파일 트리. git 상태에 따라 색을 입힌다 */
function FilesPanel({ worktree, status }: { worktree: string; status: GitStatus | undefined }) {
  const model = useModel();
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map());

  const load = async (dir: string) => {
    try {
      const list = await model.services.host.files.list(worktree, dir);
      setEntries((m) => new Map(m).set(dir, list));
    } catch (e) {
      model.fail(e);
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
            className="flex h-[22px] cursor-pointer items-center gap-1 whitespace-nowrap pr-2 hover:bg-sidebar-accent"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => (e.is_dir ? toggle(path) : model.openDoc({ kind: "file", file: path }))}
            title={path}
          >
            <span className="flex w-3 justify-center text-muted-foreground">
              {e.is_dir && (open.has(path) ? <CaretDownIcon className="size-2.5" /> : <CaretRightIcon className="size-2.5" />)}
            </span>
            <span className={cn(kind ? TONE[kind] : e.ignored && "text-muted-foreground/60")}>{e.name}</span>
          </div>
          {e.is_dir && open.has(path) && render(path, depth + 1)}
        </div>
      );
    });

  return (
    <div>
      <div className={HEAD}>
        <span className="truncate">{base(worktree)}</span>
        <Button variant="ghost" size="icon-xs" title="새로 읽기" onClick={() => [...open].forEach((d) => void load(d))}>
          <ArrowClockwiseIcon />
        </Button>
      </div>
      {render("", 0)}
    </div>
  );
}
