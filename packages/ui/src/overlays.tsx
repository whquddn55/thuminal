// 창: 워크트리 만들기·지우기, ⌘J 워크트리로 가기.

import { CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import type { BranchList, WorktreeInfo } from "@thuminal/term-core";

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
          <Checkbox checked={deleteBranch} onCheckedChange={(v) => setDeleteBranch(v === true)} />
          브랜치 <code className="font-mono">{worktree.branch}</code> 도 지운다
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
          강제로 지운다 (변경이 있거나 git 이 거절해도)
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={() => {
              void model.removeWorktree(worktree, { force, deleteBranch });
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
