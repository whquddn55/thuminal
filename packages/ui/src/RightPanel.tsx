// 오른쪽 사이드바: 위쪽 탭(파일 · 변경 · 검색) 하나로 묶는다 (Orca 와 같다).
// - 파일: 파일 트리, 이름으로 거르기
// - 변경: 소스 관리 (스테이지됨 · 변경 · 새 파일, 줄 수, 커밋, 푸시)
// - 검색: 워크트리 안 파일 내용 찾기. 결과를 누르면 그 파일의 그 줄을 연다
// 왼쪽 경계를 끌어 폭을 바꾼다.

import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  FilesIcon,
  GitBranchIcon,
  GitDiffIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ChangeKind, DirEntry, FileChange, GitStatus, LineCount, SearchHit } from "@thuminal/term-core";

import { Button } from "./components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "./components/ui/context-menu";
import { baseName as base, dirName as dirOf, matchFiles } from "./file-match";
import { cn } from "./lib/utils";
import { type Panel, useApp, useModel } from "./store";

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

const HEAD = "flex items-center justify-between px-3 pt-2.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground";

const TABS: { id: NonNullable<Panel>; label: string; key: string; icon: React.ReactNode }[] = [
  { id: "files", label: "파일", key: "⌘⇧E", icon: <FilesIcon /> },
  { id: "changes", label: "변경", key: "⌘⇧G", icon: <GitDiffIcon /> },
  { id: "search", label: "검색", key: "⌘⇧F", icon: <MagnifyingGlassIcon /> },
];

export function RightPanel() {
  const model = useModel();
  const panel = useApp((s) => s.panel);
  const worktree = useApp((s) => s.active);
  const status = useApp((s) => s.status[s.active]);
  const width = useApp((s) => s.rightWidth);
  const changes = status?.files.length ?? 0;
  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground" style={{ width }}>
      <RightResizer />
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            title={`${t.label} (${t.key})`}
            className={cn(
              "flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground [&>svg]:size-3.5",
              panel === t.id && "bg-sidebar-accent text-foreground",
            )}
            onClick={() => panel !== t.id && model.setPanel(t.id)}
          >
            {t.icon}
            {t.label}
            {t.id === "changes" && changes > 0 && <span className="rounded bg-foreground/10 px-1 text-[10px] tabular-nums">{changes}</span>}
          </button>
        ))}
        <button
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          title="오른쪽 사이드바 닫기 (⌘L)"
          onClick={() => model.toggleRight()}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto thm-scroll">
        {panel === "changes" ? (
          <ChangesPanel worktree={worktree} status={status} />
        ) : panel === "search" ? (
          <SearchPanel key={worktree} worktree={worktree} />
        ) : (
          <FilesPanel worktree={worktree} status={status} />
        )}
      </div>
    </aside>
  );
}

/** 오른쪽 사이드바 왼쪽 경계를 끌어 폭을 바꾼다 */
function RightResizer() {
  const model = useModel();
  return (
    <div
      className="group absolute top-0 -left-1.5 z-10 flex h-full w-3 cursor-col-resize justify-center"
      onPointerDown={(e) => {
        e.preventDefault();
        const x0 = e.clientX;
        const w0 = model.get().rightWidth;
        const move = (ev: PointerEvent) => model.setRightWidth(w0 - (ev.clientX - x0));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
        };
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      <div className="h-full w-px transition-colors group-hover:bg-ring/50 group-active:bg-ring" />
    </div>
  );
}

function ChangesPanel({ worktree, status }: { worktree: string; status: GitStatus | undefined }) {
  const model = useModel();
  const host = model.services.host;
  // 쓰다 만 메시지는 워크트리마다 store 에 둔다 (워크트리를 바꿔도 남는다)
  const message = useApp((s) => s.commitDrafts[worktree] ?? "");
  const setMessage = (t: string) => model.setCommitDraft(worktree, t);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => f.unstaged && f.unstaged !== "untracked");
  const untracked = files.filter((f) => f.unstaged === "untracked");
  // 파일마다 더하고 지운 줄 수. 바뀐 파일 목록이 바뀔 때마다 다시 묻는다
  const [counts, setCounts] = useState<Map<string, LineCount>>(new Map());
  const filesKey = JSON.stringify(files);
  useEffect(() => {
    let alive = true;
    void host.git.lineCounts(worktree).then(
      (list) => alive && setCounts(new Map(list.map((c) => [`${c.staged}:${c.path}`, c]))),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [host, worktree, filesKey]);

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setNote(null);
    try {
      const r = await f();
      if (typeof r === "string" && r) setNote(r.split("\n").slice(-2).join(" "));
      await model.refreshStatus(worktree);
    } catch (e) {
      model.fail(`${label}에 실패했어요: ${e}`);
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
      title: paths.length === 1 ? `${base(paths[0])}의 변경을 버릴까요?` : `변경 ${paths.length}개를 버릴까요?`,
      body: "되돌릴 수 없어요. 새로 만든 파일은 지워져요.",
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
            <LineCountBadge count={counts.get(`${isStaged}:${f.path}`)} />
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
        placeholder="커밋 메시지 (⌘Enter로 커밋)"
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
          title="지금 브랜치를 올려요"
        >
          {busy === "푸시" ? "올리는 중…" : status?.upstream ? `푸시${status.ahead ? ` ↑${status.ahead}` : ""}` : "푸시 (원격 만들기)"}
        </Button>
      </div>
      {note && <div className="mx-3 mb-1.5 break-all text-2xs text-muted-foreground">{note}</div>}
      {files.length === 0 && <div className="p-4 text-muted-foreground">바뀐 파일이 없어요</div>}
      {group("스테이지됨", staged, true)}
      {group("변경", unstaged, false)}
      {group("새 파일", untracked, false)}
    </div>
  );
}

/** +3 −1 (바이너리면 비운다) */
function LineCountBadge({ count }: { count: LineCount | undefined }) {
  if (!count || count.added === null) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums group-hover:hidden">
      {!!count.added && <span className="text-emerald-500">+{count.added}</span>}
      {!!count.removed && <span className="ml-0.5 text-red-500">−{count.removed}</span>}
    </span>
  );
}

/** 폴더를 열 때 그 안을 읽는 파일 트리. git 상태에 따라 색을 입힌다 */
function FilesPanel({ worktree, status }: { worktree: string; status: GitStatus | undefined }) {
  const model = useModel();
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map());
  const [filter, setFilter] = useState("");

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
      <div className="px-2 pb-1.5">
        <SearchInput value={filter} onChange={setFilter} placeholder="파일 이름으로 거르기" />
      </div>
      {filter.trim() ? <NameMatches worktree={worktree} query={filter.trim()} kindOf={kindOf} /> : render("", 0)}
    </div>
  );
}

/** 이름 거르기 결과: 파일 이름에 든 것 먼저, 그다음 경로에 든 것, 글자가 차례로 든 것 */
function NameMatches({ worktree, query, kindOf }: { worktree: string; query: string; kindOf: (path: string, isDir: boolean) => ChangeKind | null }) {
  const model = useModel();
  const [all, setAll] = useState<{ files: string[]; truncated: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void model.services.host.files.all(worktree).then((r) => alive && setAll(r), model.fail);
    return () => {
      alive = false;
    };
  }, [model, worktree]);
  const matches = useMemo(() => (all ? matchFiles(all.files, query, 300) : []), [all, query]);
  if (!all) return <div className="px-3 py-2 text-muted-foreground">파일 목록을 읽는 중…</div>;
  if (!matches.length) return <div className="px-3 py-2 text-muted-foreground">맞는 파일이 없어요</div>;
  return (
    <div>
      {matches.map((f) => {
        const kind = kindOf(f, false);
        return (
          <div
            key={f}
            className="flex h-[22px] cursor-pointer items-center gap-1.5 px-3 whitespace-nowrap hover:bg-sidebar-accent"
            title={f}
            onClick={() => model.openDoc({ kind: "file", file: f })}
          >
            <span className={cn(kind && TONE[kind])}>{base(f)}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground [direction:rtl] text-left">{dirOf(f)}</span>
          </div>
        );
      })}
      {(matches.length === 300 || all.truncated) && <div className="px-3 py-1.5 text-2xs text-muted-foreground">더 있어요. 더 길게 쳐서 좁혀 주세요</div>}
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 focus-within:border-ring">
      <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        autoFocus={autoFocus}
        className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
      />
      {value && (
        <button className="text-muted-foreground hover:text-foreground" title="지우기" onClick={() => onChange("")}>
          <XIcon className="size-3" />
        </button>
      )}
      {children}
    </div>
  );
}

/** 워크트리 안 파일 내용 찾기. 결과는 파일별로 묶고, 줄을 누르면 그 줄을 연다 */
function SearchPanel({ worktree }: { worktree: string }) {
  const model = useModel();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ hits: SearchHit[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      return;
    }
    // 치는 동안은 기다렸다가 멈추면 찾는다
    const n = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      void model.services.host.files.search(worktree, q, caseSensitive).then(
        (r) => n === seq.current && setResult(r),
        (e) => n === seq.current && model.fail(e),
      ).finally(() => n === seq.current && setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [model, worktree, query, caseSensitive]);

  const groups = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of result?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  }, [result]);

  /** 찾은 글을 칠한다 */
  const mark = (text: string) => {
    const q = query.trim();
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? q : q.toLowerCase();
    const i = hay.indexOf(needle);
    if (i < 0) return text;
    // 긴 줄은 찾은 자리 앞을 줄인다
    const from = Math.max(0, i - 24);
    return (
      <>
        {from > 0 && "…"}
        {text.slice(from, i)}
        <mark className="rounded-[2px] bg-amber-400/40 text-foreground">{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  };

  return (
    <div className="flex flex-col">
      <div className="px-2 pt-2.5 pb-1.5">
        <SearchInput value={query} onChange={setQuery} placeholder="파일 내용에서 찾기" autoFocus>
          <button
            className={cn("rounded px-1 font-mono text-[10px] text-muted-foreground hover:text-foreground", caseSensitive && "bg-accent text-foreground")}
            title="대소문자 구분"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
        </SearchInput>
      </div>
      {query.trim() && (
        <div className="px-3 pb-1 text-2xs text-muted-foreground">
          {busy && !result ? "찾는 중…" : result ? `${groups.length}개 파일 · ${result.hits.length}곳${result.truncated ? " (앞부분만)" : ""}` : ""}
        </div>
      )}
      {groups.map(([path, hits]) => (
        <div key={path} className="pb-1">
          <div className="flex h-[22px] items-center gap-1.5 px-3 whitespace-nowrap" title={path}>
            <span className="font-medium">{base(path)}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground [direction:rtl] text-left">{dirOf(path)}</span>
            <span className="rounded bg-foreground/10 px-1 text-[10px] tabular-nums">{hits.length}</span>
          </div>
          {hits.map((h) => (
            <div
              key={`${h.line}:${h.text}`}
              className="flex cursor-pointer items-baseline gap-2 py-px pr-2 pl-5 font-mono text-[11px] hover:bg-sidebar-accent"
              onClick={() => model.openDoc({ kind: "file", file: h.path, line: String(h.line) })}
            >
              <span className="w-8 shrink-0 text-right text-muted-foreground/60 tabular-nums">{h.line}</span>
              <span className="min-w-0 truncate whitespace-pre">{mark(h.text.trim())}</span>
            </div>
          ))}
        </div>
      ))}
      {query.trim() && result && result.hits.length === 0 && <div className="px-3 py-2 text-muted-foreground">찾은 것이 없어요</div>}
    </div>
  );
}
