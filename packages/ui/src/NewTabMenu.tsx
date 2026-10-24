// 탭 줄의 "+": 바로 터미널을 만들지 않고 메뉴를 연다 (Orca 와 같다). ⌘T 만 바로 새 터미널이다.
//
// 맨 위 찾기 칸에 글을 치면 열린 탭, 에이전트, 메뉴 항목을 거르고, 맞는 것이 없으면 그 글을 새 탭에서 실행한다.
// 그 아래 새 터미널과 패널 항목, 맨 아래 설치된 에이전트(claude, codex 등)를 띄우는 항목이 있다.

import { FilesIcon, GitDiffIcon, GlobeIcon, MagnifyingGlassIcon, PlayIcon, PlusIcon, RobotIcon, SquaresFourIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useState } from "react";

import type { WorkspaceId } from "@thuminal/term-core";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { AGENTS } from "./agents";
import { looksLikeUrl, toUrl } from "./BrowserPane";
import { panesOf } from "./layout";
import { cn } from "./lib/utils";
import { useApp, useModel } from "./store";

interface Option {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

const ITEM = "gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium";

export function NewTabMenu({ ws }: { ws: WorkspaceId }) {
  const model = useModel();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const agents = useApp((s) => s.agents);
  const layout = useApp((s) => s.layouts[ws]);
  const sessions = useApp((s) => s.sessions);
  const inWorktree = ws.startsWith("/");
  const installed = AGENTS.filter((a) => agents.includes(a.cmd));

  const close = () => {
    setOpen(false);
    setQuery("");
    setSel(0);
  };
  const newTerminal = () => void model.newTab(ws);
  const launch = (input: string) => void model.newTab(ws, input);

  const browserOk = !!model.services.host.browser;
  const newBrowser = (url?: string) => void model.newBrowserTab(ws, url);
  const menu: Option[] = [
    { id: "terminal", label: "새 터미널", hint: "terminal shell", icon: <TerminalWindowIcon />, run: newTerminal },
    ...(browserOk ? [{ id: "browser", label: "새 브라우저 탭", hint: "browser web", icon: <GlobeIcon />, run: () => newBrowser() }] : []),
    ...installed.map((a) => ({ id: `agent:${a.cmd}`, label: a.label, hint: a.cmd, icon: <RobotIcon />, run: () => launch(a.cmd) })),
    ...(inWorktree
      ? [
          { id: "files", label: "파일 패널", hint: "files explorer", icon: <FilesIcon />, run: () => model.setPanel("files") },
          { id: "changes", label: "변경 패널", hint: "changes git diff commit", icon: <GitDiffIcon />, run: () => model.setPanel("changes") },
        ]
      : []),
  ];

  // 찾기 칸에 친 글로 거른 결과: 열린 탭 → 메뉴 항목 → 그 글을 새 탭에서 실행
  const q = query.trim().toLowerCase();
  const results: Option[] = [];
  if (q) {
    // 주소처럼 보이면 브라우저로 여는 것을 맨 위에
    if (browserOk && looksLikeUrl(query)) results.push({ id: "open-url", label: toUrl(query), hint: "브라우저로 열기", icon: <GlobeIcon />, run: () => newBrowser(toUrl(query)) });
    for (const t of layout?.tabs ?? []) {
      const p = panesOf(t.root).find((x) => x.id === t.focused) ?? panesOf(t.root)[0];
      const title = t.title ?? (p?.type === "terminal" ? sessions[p.session]?.title : p?.doc.file) ?? "";
      if (title.toLowerCase().includes(q))
        results.push({ id: `tab:${t.id}`, label: title, hint: "열린 탭으로 가기", icon: <SquaresFourIcon />, run: () => model.selectTab(t.id) });
    }
    for (const o of menu) if (`${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q)) results.push(o);
    results.push({ id: "run", label: query.trim(), hint: "새 탭에서 실행", icon: <PlayIcon />, run: () => launch(query.trim()) });
  }
  const pick = (o?: Option) => {
    if (o) o.run();
    else if (!q) newTerminal();
    close();
  };

  return (
    <DropdownMenu open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent/50"
          title="새 탭"
          aria-label="새 탭"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-72 max-w-[calc(100vw-1rem)] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
        // 닫힌 뒤 "+" 로 포커스가 돌아가면 새 터미널이 키보드를 못 받는다
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <form
          className="pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            pick(results[sel]);
          }}
        >
          <div className="flex h-8 items-center gap-1.5 rounded-[7px] border bg-background px-2">
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
              placeholder="열린 탭, 에이전트, 명령, 주소…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                // 메뉴가 글자 키를 항목 찾기로 가져가지 않게 한다. 위아래는 결과 사이를 옮긴다
                if (e.key === "Escape") return;
                if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length) {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setSel((s) => (s + d + results.length) % results.length);
                }
                e.stopPropagation();
              }}
            />
          </div>
          <div className="mt-1 flex flex-col">
            {q ? (
              results.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={cn(
                    "flex h-6 w-full items-center gap-1.5 rounded-[7px] px-1 text-left text-[11px] leading-5 outline-none [&>svg]:size-3.5 [&>svg]:shrink-0",
                    i === sel ? "bg-black/8 text-accent-foreground dark:bg-white/14" : "text-muted-foreground hover:bg-black/8 hover:text-accent-foreground dark:hover:bg-white/14",
                  )}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(o)}
                >
                  {o.icon}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && (o.id.startsWith("tab:") || o.id === "run" || o.id === "open-url") ? <span className="shrink-0 text-muted-foreground/70">{o.hint}</span> : null}
                </button>
              ))
            ) : (
              <div className="flex min-h-6 items-center px-1 text-[11px] leading-5 text-muted-foreground">Enter 를 누르면 새 터미널을 연다</div>
            )}
          </div>
        </form>
        <DropdownMenuSeparator />
        <DropdownMenuItem className={ITEM} onSelect={newTerminal}>
          <TerminalWindowIcon className="size-4 text-muted-foreground" />
          새 터미널
          <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
        </DropdownMenuItem>
        {browserOk && (
          <DropdownMenuItem className={ITEM} onSelect={() => newBrowser()}>
            <GlobeIcon className="size-4 text-muted-foreground" />
            새 브라우저 탭
            <DropdownMenuShortcut>⌘⇧B</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {inWorktree && (
          <>
            <DropdownMenuItem className={ITEM} onSelect={() => model.setPanel("files")}>
              <FilesIcon className="size-4 text-muted-foreground" />
              파일 열기…
              <DropdownMenuShortcut>⌘⇧E</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className={ITEM} onSelect={() => model.setPanel("changes")}>
              <GitDiffIcon className="size-4 text-muted-foreground" />
              변경 보기
              <DropdownMenuShortcut>⌘⇧G</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
        {installed.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {installed.map((a) => (
              <DropdownMenuItem key={a.cmd} className={ITEM} onSelect={() => launch(a.cmd)}>
                <RobotIcon className="size-4 text-muted-foreground" />
                {a.label}
                <DropdownMenuShortcut className="font-mono tracking-normal">{a.cmd}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
