// 탭 줄의 "+": 바로 터미널을 만들지 않고 메뉴를 연다 (Orca 와 같은 모양·순서다). ⌘T 만 바로 새 터미널이다.
//
// 맨 위 찾기 칸에 글을 치면 아래 고정 항목은 숨기고 후보만 보인다: 주소, 열린 탭, 워크트리 파일, 메뉴 항목·에이전트,
// 맨 끝에 그 글을 새 탭에서 실행하기.
// 고정 항목은 구분선으로만 나눈다: 새 터미널 · 새 브라우저 탭 · Markdown 열기 | 설치된 에이전트(claude, codex 등) · 에이전트 설정.

import { FileIcon, FileTextIcon, GearSixIcon, GlobeIcon, MagnifyingGlassIcon, PlayIcon, PlusIcon, SquaresFourIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { isWorktreeWorkspace, type WorkspaceId } from "@thuminal/term-core";

import { AgentIcon } from "./agent-icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { AGENTS } from "./agents";
import { looksLikeUrl, toUrl } from "./BrowserPane";
import { baseName, dirName, matchFiles } from "./file-match";
import { panesOf } from "./layout";
import { cn } from "./lib/utils";
import { keyLabel } from "./platform";
import { type Dialog, useApp, useModel } from "./store";

interface Option {
  id: string;
  label: string;
  /** 찾기에만 쓰는 낱말 */
  hint?: string;
  /** 찾기 결과 오른쪽에 흐리게 보이는 글 */
  side?: string;
  icon: React.ReactNode;
  run: () => void;
}

const ITEM = "gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium";
const ICON = "size-4 text-muted-foreground";
/** 찾기 결과에 보일 파일 수 */
const FILE_RESULTS = 6;

export function NewTabMenu({ ws }: { ws: WorkspaceId }) {
  const model = useModel();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const agents = useApp((s) => s.agents);
  const layout = useApp((s) => s.layouts[ws]);
  const sessions = useApp((s) => s.sessions);
  const inWorktree = isWorktreeWorkspace(ws);
  const installed = AGENTS.filter((a) => agents.includes(a.cmd));
  // ⌘⌥T 가 띄우는 에이전트 (App.tsx 와 같다)
  const defaultAgent = agents[0] ?? "claude";

  const q = query.trim().toLowerCase();
  // 워크트리 파일 목록은 찾기 칸에 처음 글을 칠 때 한 번 읽는다
  const wantFiles = open && inWorktree && !!q && files === null;
  useEffect(() => {
    if (!wantFiles) return;
    let alive = true;
    void model.services.host.files.all(ws).then(
      (r) => alive && setFiles(r.files),
      () => alive && setFiles([]),
    );
    return () => {
      alive = false;
    };
  }, [model, ws, wantFiles]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setSel(0);
    setFiles(null);
  };
  const newTerminal = () => void model.newTab(ws);
  const launch = (input: string) => void model.newTab(ws, input);
  // 창은 메뉴가 닫히고 나서 연다. 메뉴가 닫히며 포커스를 정리하는 중에 열면 창의 찾기 칸이 포커스를 잃는다
  const openDialog = (d: Dialog) => window.setTimeout(() => model.setDialog(d));
  const openMarkdown = () => openDialog({ kind: "open-markdown" });
  const agentSettings = () => openDialog({ kind: "settings", section: "agent" });

  const browserOk = !!model.services.host.browser;
  const newBrowser = (url?: string) => void model.newBrowserTab(ws, url);
  const menu: Option[] = [
    { id: "terminal", label: "새 터미널", hint: "terminal shell", icon: <TerminalWindowIcon />, run: newTerminal },
    ...(browserOk ? [{ id: "browser", label: "새 브라우저 탭", hint: "browser web", icon: <GlobeIcon />, run: () => newBrowser() }] : []),
    ...(inWorktree ? [{ id: "markdown", label: "Markdown 열기…", hint: "markdown md 문서", icon: <FileTextIcon />, run: openMarkdown }] : []),
    ...installed.map((a) => ({ id: `agent:${a.cmd}`, label: a.name, hint: `${a.label} ${a.cmd} 에이전트 agent`, icon: <AgentIcon kind={a.cmd} />, run: () => launch(a.cmd) })),
    { id: "agent-settings", label: "에이전트 설정…", hint: "agent settings 옵션", icon: <GearSixIcon />, run: agentSettings },
  ];

  // 찾기 칸에 친 글로 거른 결과: 주소 → 열린 탭 → 파일 → 메뉴 항목 → 그 글을 새 탭에서 실행
  const results: Option[] = [];
  if (q) {
    // 주소처럼 보이면 브라우저로 여는 것을 맨 위에
    if (browserOk && looksLikeUrl(query)) results.push({ id: "open-url", label: toUrl(query), side: "브라우저로 열기", icon: <GlobeIcon />, run: () => newBrowser(toUrl(query)) });
    for (const t of layout?.tabs ?? []) {
      const p = panesOf(t.root).find((x) => x.id === t.focused) ?? panesOf(t.root)[0];
      const title = t.title ?? (p?.type === "terminal" ? sessions[p.session]?.title : p?.doc.file) ?? "";
      if (title.toLowerCase().includes(q))
        results.push({ id: `tab:${t.id}`, label: title, side: "열린 탭으로 가기", icon: <SquaresFourIcon />, run: () => model.selectTab(t.id) });
    }
    for (const f of files ? matchFiles(files, q, FILE_RESULTS) : [])
      results.push({ id: `file:${f}`, label: baseName(f), side: dirName(f), icon: <FileIcon />, run: () => model.openDoc({ kind: "file", file: f }) });
    for (const o of menu) if (`${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q)) results.push(o);
    results.push({ id: "run", label: query.trim(), side: "새 탭에서 실행", icon: <PlayIcon />, run: () => launch(query.trim()) });
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
              placeholder="열린 탭, 방문 기록, 파일, URL, 에이전트 검색…"
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
          {q && (
            <div className="mt-1 flex flex-col">
              {results.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12px] leading-5 font-medium outline-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
                    i === sel ? "bg-black/8 text-accent-foreground dark:bg-white/14" : "hover:bg-black/8 hover:text-accent-foreground dark:hover:bg-white/14",
                  )}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(o)}
                >
                  {o.icon}
                  <span className="min-w-0 shrink truncate">{o.label}</span>
                  {o.side ? <span className="ml-auto min-w-0 shrink-[2] truncate pl-2 text-[11px] font-normal text-muted-foreground">{o.side}</span> : null}
                </button>
              ))}
            </div>
          )}
        </form>
        {!q && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ITEM} onSelect={newTerminal}>
              <TerminalWindowIcon className={ICON} />
              새 터미널
              <DropdownMenuShortcut>{keyLabel("⌘T")}</DropdownMenuShortcut>
            </DropdownMenuItem>
            {browserOk && (
              <DropdownMenuItem className={ITEM} onSelect={() => newBrowser()}>
                <GlobeIcon className={ICON} />
                새 브라우저 탭
                <DropdownMenuShortcut>{keyLabel("⌘⇧B")}</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {inWorktree && (
              <DropdownMenuItem className={ITEM} onSelect={openMarkdown}>
                <FileTextIcon className={ICON} />
                Markdown 열기…
                <DropdownMenuShortcut>{keyLabel("⌘⇧O")}</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {installed.map((a) => (
              <DropdownMenuItem key={a.cmd} className={ITEM} onSelect={() => launch(a.cmd)}>
                <AgentIcon kind={a.cmd} className="size-3.5" />
                {a.name}
                {a.cmd === defaultAgent && <DropdownMenuShortcut>{keyLabel("⌥⌘T")}</DropdownMenuShortcut>}
              </DropdownMenuItem>
            ))}
            {installed.length === 0 && <div className="px-2 py-1.5 text-[12px] leading-5 text-muted-foreground">에이전트를 찾지 못했어요</div>}
            <DropdownMenuItem className={ITEM} onSelect={agentSettings}>
              <GearSixIcon className={ICON} />
              에이전트 설정…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
