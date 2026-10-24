// 창: 워크트리 만들기·지우기, ⌘J 워크트리로 가기, Orca 에서 가져오기.

import { CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import type { BranchList, OrcaScan, OrcaSession, WorktreeInfo } from "@thuminal/term-core";

import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./components/ui/select";
import { cn } from "./lib/utils";
import { type NewWorktree, useApp, useModel, worktreeTitle } from "./store";

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

/** 지금 열린 창 하나를 그린다 */
export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const model = useModel();
  const close = () => model.setDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "new-worktree":
      return <NewWorktreeDialog initialRepo={dialog.repo} onClose={close} />;
    case "delete-worktree":
      return <DeleteWorktreeDialog worktree={dialog.worktree} onClose={close} />;
    case "jump":
      return <JumpPalette onClose={close} />;
    case "import-orca":
      return <ImportOrcaDialog onClose={close} />;
    case "confirm":
      return (
        <Dialog open onOpenChange={(o) => !o && close()}>
          <DialogContent className="sm:max-w-[420px]" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{dialog.title}</DialogTitle>
              <DialogDescription>{dialog.body}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                취소
              </Button>
              <Button
                variant="destructive"
                autoFocus
                onClick={() => {
                  close();
                  dialog.run();
                }}
              >
                {dialog.action}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    default:
      return null;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function NewWorktreeDialog({ initialRepo, onClose }: { initialRepo: string; onClose: () => void }) {
  const model = useModel();
  const repos = useApp((s) => s.repos);
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
    void model.services.host.git.branches(repo).then((b) => {
      if (!alive) return;
      setBranches(b);
      setBase(b.default ?? b.current ?? b.local[0] ?? "");
    });
    return () => {
      alive = false;
    };
  }, [repo, model]);

  const effectiveBranch = branchEdited ? branch : branchFromName(name);
  const taken = !!branches?.local.includes(effectiveBranch);
  const ok = effectiveBranch.length > 0 && !taken;
  const submit = () => {
    if (!ok) return;
    void model.newWorktree({ repo, name: name.trim(), branch: effectiveBranch, base: base || undefined, start });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>새 워크트리</DialogTitle>
          <DialogDescription>새 브랜치를 저장소 옆 폴더에 꺼내고 터미널을 띄운다.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="이름">
            <Input autoFocus value={name} placeholder="예: 로그인 화면 고치기" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </Field>
          <Field label="프로젝트">
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="시작 브랜치">
            <Select value={base} onValueChange={setBase} disabled={!branches}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="불러오는 중…" />
              </SelectTrigger>
              <SelectContent>
                {branches && branches.remote.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>원격</SelectLabel>
                    {branches.remote.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                        {b === branches.default ? " (기본)" : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {branches && (
                  <SelectGroup>
                    <SelectLabel>로컬</SelectLabel>
                    {branches.local.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                        {b === branches.current ? " (지금)" : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field label="처음 띄울 것">
            <div className="inline-flex w-fit rounded-md border p-0.5">
              {(
                [
                  ["claude", "claude"],
                  ["shell", "터미널"],
                  ["none", "없음"],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  className={cn("rounded px-3 py-1 text-xs", start === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                  onClick={() => setStart(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <button className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdvanced(!advanced)}>
            {advanced ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />} 고급
          </button>
          {advanced && (
            <Field label="브랜치 이름">
              <Input
                value={effectiveBranch}
                onChange={(e) => {
                  setBranchEdited(true);
                  setBranch(e.target.value);
                }}
              />
            </Field>
          )}
          <div className="text-xs text-muted-foreground">
            {effectiveBranch ? (
              taken ? (
                <span className="text-destructive">이미 있는 브랜치다: {effectiveBranch}</span>
              ) : (
                <>
                  브랜치 <code className="font-mono text-foreground">{effectiveBranch}</code> 를 <code className="font-mono text-foreground">{base || "HEAD"}</code> 에서
                  만든다
                </>
              )
            ) : (
              "이름을 적으면 브랜치 이름을 만든다"
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!ok} onClick={submit}>
            만들기 (Enter)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteWorktreeDialog({ worktree, onClose }: { worktree: WorktreeInfo; onClose: () => void }) {
  const model = useModel();
  const dirty = useApp((s) => s.status[worktree.path]?.files.length ?? 0);
  const terminals = useApp((s) => s.layouts[worktree.path]?.tabs.length ?? 0);
  const [force, setForce] = useState(dirty > 0);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [forceBranch, setForceBranch] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>워크트리 지우기: {worktreeTitle(worktree)}</DialogTitle>
          <DialogDescription className="break-all">
            <code className="font-mono">{worktree.path}</code> 폴더를 지운다.
            {terminals > 0 && <> 이 워크트리의 탭 {terminals}개도 닫는다.</>}
          </DialogDescription>
        </DialogHeader>
        {dirty > 0 && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">커밋하지 않은 변경이 {dirty}개 있다. 지우면 사라진다.</div>}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
          바뀐 파일이 있어도 지운다
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={deleteBranch} onCheckedChange={(v) => setDeleteBranch(v === true)} />
          브랜치 <code className="font-mono">{worktree.branch}</code> 도 지운다
        </label>
        {deleteBranch && (
          <label className="ml-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={forceBranch} onCheckedChange={(v) => setForceBranch(v === true)} />
            합치지 않은 커밋이 있어도 지운다 (없으면 브랜치는 남긴다)
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={() => {
              void model.removeWorktree(worktree, { force, deleteBranch, forceBranch: deleteBranch && forceBranch });
              onClose();
            }}
          >
            지우기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ⌘J: 워크트리 이름, 브랜치, 프로젝트로 찾아 간다 */
function JumpPalette({ onClose }: { onClose: () => void }) {
  const model = useModel();
  const worktrees = useApp((s) => s.worktrees);
  const repos = useApp((s) => s.repos);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? "";
  const recent = useApp((s) => s.recent);
  const active = useApp((s) => s.active);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      // 빈 검색: 지금 워크트리를 빼고 최근에 고른 순서. Enter 한 번이면 바로 전 워크트리로 돌아간다
      const rank = (w: WorktreeInfo) => {
        const i = recent.indexOf(w.path);
        return i < 0 ? recent.length : i;
      };
      return worktrees.filter((w) => w.path !== active).sort((a, b) => rank(a) - rank(b));
    }
    return worktrees.filter((w) => {
      const hay = `${worktreeTitle(w)} ${w.branch ?? ""} ${repoName(w.repo)}`.toLowerCase();
      return words.every((x) => hay.includes(x));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, worktrees, recent, active]);
  const pick = (w?: WorktreeInfo) => {
    if (!w) return;
    model.select(w.path);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-[520px]" showCloseButton={false}>
        <DialogTitle className="sr-only">워크트리로 가기</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <MagnifyingGlassIcon className="size-4 text-muted-foreground" />
          <input
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
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
        </div>
        <div className="max-h-80 overflow-y-auto p-1 thm-scroll">
          {list.map((w, i) => (
            <div
              key={w.path}
              className={cn("flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-2", i === sel && "bg-accent")}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(w)}
            >
              <span className="truncate">{worktreeTitle(w)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {repoName(w.repo)} · {w.branch ?? "(detached)"}
              </span>
            </div>
          ))}
          {list.length === 0 && <div className="px-3 py-6 text-center text-muted-foreground">맞는 워크트리가 없다</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "3분 전" 같은 지난 시간 */
function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

/** Orca 에 등록한 저장소·워크트리 이름·claude 세션을 골라 가져온다 */
function ImportOrcaDialog({ onClose }: { onClose: () => void }) {
  const model = useModel();
  const worktrees = useApp((s) => s.worktrees);
  const [scan, setScan] = useState<OrcaScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Set<string>>(new Set());
  const [names, setNames] = useState(true);
  const [sessions, setSessions] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    model.services.host.scanOrca().then(
      (s) => {
        setScan(s);
        setRepos(new Set(s.repos.filter((r) => r.exists && !r.registered).map((r) => r.path)));
      },
      (e) => setError(String(e)),
    );
  }, [model]);

  const named = (scan?.worktrees ?? []).filter((w) => w.name);
  const place = (s: OrcaSession) => {
    if (s.floating) return "떠 있는 터미널";
    const w = worktrees.find((x) => x.path === s.worktree);
    const o = scan?.worktrees.find((x) => x.path === s.worktree);
    return w ? worktreeTitle(w) : o?.name || s.worktree?.split("/").pop() || s.cwd;
  };
  const toggle = (set: Set<string>, v: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(v);
    else next.delete(v);
    return next;
  };
  const free = (scan?.sessions ?? []).filter((s) => !s.running);
  const run = async () => {
    if (!scan) return;
    setBusy(true);
    await model.importOrca({
      repos: [...repos],
      names: names ? named.map((w) => ({ path: w.path, name: w.name! })) : [],
      sessions: scan.sessions.filter((s) => sessions.has(s.session_id)),
    });
    setBusy(false);
    onClose();
  };
  const section = "text-xs font-medium text-muted-foreground";
  const row = "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent";

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Orca 에서 가져오기</DialogTitle>
          <DialogDescription>Orca 에 등록한 프로젝트, 워크트리 이름, 탭의 claude 세션을 골라 가져온다. Orca 쪽은 바꾸지 않는다.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !scan ? (
          <p className="text-sm text-muted-foreground">Orca 데이터를 읽는 중…</p>
        ) : (
          <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 thm-scroll">
            <div className="flex flex-col gap-0.5">
              <div className={section}>프로젝트 {scan.repos.length}</div>
              {scan.repos.map((r) => (
                <label key={r.path} className={cn(row, (!r.exists || r.registered) && "opacity-60")}>
                  <Checkbox
                    checked={r.registered || repos.has(r.path)}
                    disabled={!r.exists || r.registered}
                    onCheckedChange={(v) => setRepos((s) => toggle(s, r.path, v === true))}
                  />
                  <span className="font-medium">{r.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.path}</span>
                  {r.registered && <span className="text-muted-foreground">이미 있다</span>}
                  {!r.exists && <span className="text-muted-foreground">폴더 없음</span>}
                </label>
              ))}
            </div>
            {named.length > 0 && (
              <label className={row}>
                <Checkbox checked={names} onCheckedChange={(v) => setNames(v === true)} />
                <span>
                  워크트리 이름 {named.length}개 가져오기 <span className="text-muted-foreground">(thuminal 에서 이름을 붙이지 않은 워크트리만. Orca 메모는 아직 자리가 없어 가져오지 않는다)</span>
                </span>
              </label>
            )}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center">
                <span className={cn(section, "flex-1")}>claude 세션 {scan.sessions.length} · 고른 세션은 새 탭에서 claude --resume 으로 이어진다</span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={free.length === 0}
                  onClick={() => setSessions((s) => (s.size === free.length ? new Set() : new Set(free.map((x) => x.session_id))))}
                >
                  {free.length > 0 && sessions.size === free.length ? "모두 풀기" : "모두 고르기"}
                </Button>
              </div>
              {scan.sessions.map((x) => {
                return (
                  <label key={x.session_id} className={cn(row, x.running && "opacity-60")} title={x.running ? "이 세션으로 claude 가 지금 떠 있다 (Orca 등). 거기서 끈 뒤 가져온다" : undefined}>
                    <Checkbox
                      checked={sessions.has(x.session_id)}
                      disabled={x.running}
                      onCheckedChange={(v) => setSessions((s) => toggle(s, x.session_id, v === true))}
                    />
                    <span className="min-w-0 flex-1 truncate">{x.title || x.session_id}</span>
                    {x.running && <span className="shrink-0 rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400">지금 떠 있음</span>}
                    <span className="max-w-44 shrink-0 truncate text-muted-foreground">{place(x)}</span>
                    <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">{ago(x.updated_at)}</span>
                  </label>
                );
              })}
            </div>
            {scan.sessions.length > free.length && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                "지금 떠 있음" 세션은 claude 가 그 세션으로 아직 돌고 있다 (Orca 등). 또 띄우면 두 claude 가 한 세션을 같이 쓰게 되므로 고를 수 없다. 거기서
                claude 를 끈 뒤 이 창을 다시 연다.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button disabled={!scan || busy || (repos.size === 0 && sessions.size === 0 && !(names && named.length))} onClick={() => void run()}>
            {busy ? "가져오는 중…" : `가져오기 (프로젝트 ${repos.size} · 세션 ${sessions.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
