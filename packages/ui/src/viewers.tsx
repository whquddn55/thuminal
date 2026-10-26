// 문서 칸: diff 보기, 파일 보기. Markdown 파일은 미리보기를 기본으로 보인다 (markdown.tsx 는 처음 필요할 때 불러온다).

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import type { FileContent, HostApi } from "@thuminal/term-core";

import { cn } from "./lib/utils";
import { isMarkdownFile } from "./markdown-links";

const MarkdownPreview = lazy(() => import("./markdown"));

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  old?: number;
  new?: number;
}

/** unified diff 를 줄마다 옛 줄 번호, 새 줄 번호와 함께 나눈다 */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const line of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: "hunk", text: line });
    } else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) {
      out.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), new: n++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: o++ });
    else if (line.startsWith(" ")) out.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith("\\")) out.push({ kind: "meta", text: line });
  }
  return out;
}

/** 문서 칸이 담는 것 (데몬 배치에는 글자 맵으로 들어간다) */
export interface DocSpec {
  kind: "diff" | "file";
  file: string;
  /** diff 면 스테이지된 변경을 보는지 ("1") */
  staged?: string;
  /** 파일이면 이 줄(1 부터)로 스크롤하고 강조한다 (검색 결과에서 열 때) */
  line?: string;
  /** Markdown 파일을 미리보기("preview")로 볼지 원문("source")으로 볼지. 없으면 line 이 있을 때만 원문이다 */
  view?: string;
}

/** 문서 칸이 화면 밖에 부탁하는 것 (파일 · 주소 열기, 칸 상태 남기기) */
export interface DocActions {
  /** 칸의 doc 을 바꿔 남긴다 (데몬 배치의 update_doc) */
  update: (doc: DocSpec) => void;
  openFile: (file: string, line?: number) => void;
  /** inApp: 앱 안 브라우저 칸으로 연다 */
  openUrl: (url: string, inApp: boolean) => void;
  notice: (text: string) => void;
}

type MdView = "preview" | "source";

function Toggle({ value, onChange }: { value: MdView; onChange: (v: MdView) => void }) {
  const item = (v: MdView, label: string) => (
    <button
      className={cn("rounded-[5px] px-2 py-0.5 transition-colors", value === v ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
      aria-pressed={value === v}
      onClick={() => onChange(v)}
    >
      {label}
    </button>
  );
  return (
    <span className="flex shrink-0 items-center rounded-md bg-muted p-0.5 text-2xs">
      {item("preview", "미리보기")}
      {item("source", "원문")}
    </span>
  );
}

const ROW = "font-mono text-xs leading-[1.5]";
const LN = "w-px select-none whitespace-nowrap px-2 text-right align-top text-muted-foreground/60";

function Head({ children }: { children: React.ReactNode }) {
  return <div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b bg-card px-3 py-2 text-xs">{children}</div>;
}

export function DocView({ host, worktree, doc, generation, actions }: { host: HostApi; worktree: string; doc: DocSpec; generation: number; actions?: DocActions }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staged = doc.staged === "1";
  const line = Number(doc.line) || 0;
  const body = useRef<HTMLDivElement>(null);
  const markdown = doc.kind === "file" && isMarkdownFile(doc.file);
  // 줄로 가라는 요청(line)이 있으면 원문으로 연다 (Orca 와 같다). 고른 보기는 doc.view 로 칸에 남는다
  const savedView: MdView = doc.view === "preview" || doc.view === "source" ? doc.view : line ? "source" : "preview";
  const [view, setView] = useState<MdView>(savedView);
  useEffect(() => setView(savedView), [savedView]);
  const changeView = (v: MdView) => {
    setView(v);
    // 미리보기로 돌아가면 줄 강조를 지운다. 다음에 같은 줄로 가라는 요청이 와도 줄이 바뀐 것으로 보여야 한다
    const { line: _line, ...rest } = doc;
    actions?.update(v === "preview" ? { ...rest, view: v } : { ...doc, view: v });
  };
  const showPreview = markdown && view === "preview";
  const scroller = useCallback(() => body.current, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    const p =
      doc.kind === "diff"
        ? host.git.diff(worktree, doc.file, staged).then((d) => alive && setDiff(d))
        : host.files.read(worktree, doc.file).then((f) => alive && setFile(f));
    p.catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // generation: git 상태가 바뀔 때마다 다시 읽는다
  }, [host, worktree, doc.kind, doc.file, staged, generation]);

  // 검색 결과에서 열었으면 그 줄을 가운데로
  useEffect(() => {
    if (!line || !file || showPreview) return;
    body.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, [line, file, showPreview]);

  const frame = (children: React.ReactNode) => (
    <div ref={body} className="absolute inset-0 overflow-auto bg-background select-text thm-scroll">
      {children}
    </div>
  );
  if (error) return frame(<div className="p-4 text-destructive">{error}</div>);

  if (doc.kind === "diff") {
    if (diff === null) return frame(<div className="p-4 text-muted-foreground">불러오는 중…</div>);
    const lines = parseDiff(diff).filter((l) => l.kind !== "meta");
    const adds = lines.filter((l) => l.kind === "add").length;
    const dels = lines.filter((l) => l.kind === "del").length;
    return frame(
      <>
        <Head>
          <span className="flex-1 truncate font-mono">{doc.file}</span>
          <span className="text-muted-foreground">{staged ? "스테이지됨" : "작업 폴더"}</span>
          <span className="text-emerald-500">+{adds}</span>
          <span className="text-red-500">−{dels}</span>
        </Head>
        {lines.length === 0 ? (
          <div className="p-4 text-muted-foreground">바뀐 내용이 없다 (이미 스테이지했거나 되돌렸다)</div>
        ) : (
          <table className={cn("w-full border-collapse", ROW)}>
            <tbody>
              {lines.map((l, i) =>
                l.kind === "hunk" ? (
                  <tr key={i}>
                    <td colSpan={4} className="bg-sky-500/10 px-2 py-1 text-sky-500">
                      {l.text}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={cn(l.kind === "add" && "bg-emerald-500/12", l.kind === "del" && "bg-red-500/12")}>
                    <td className={LN}>{l.old ?? ""}</td>
                    <td className={LN}>{l.new ?? ""}</td>
                    <td className={cn("w-px select-none px-1", l.kind === "add" ? "text-emerald-500" : "text-red-500")}>
                      {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                    </td>
                    <td className="whitespace-pre px-2">{l.text}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </>,
    );
  }

  if (file === null) return frame(<div className="p-4 text-muted-foreground">불러오는 중…</div>);
  return frame(
    <>
      <Head>
        <span className="flex-1 truncate font-mono">{doc.file}</span>
        <span className="text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
        {file.truncated && <span className="text-amber-500">앞 2MB 만 보인다</span>}
        {markdown && !file.binary && <Toggle value={view} onChange={changeView} />}
      </Head>
      {file.binary ? (
        <div className="p-4 text-muted-foreground">글자 파일이 아니다</div>
      ) : showPreview ? (
        <Suspense fallback={<div className="p-4 text-muted-foreground">불러오는 중…</div>}>
          <MarkdownPreview
            host={host}
            worktree={worktree}
            file={doc.file}
            text={file.text ?? ""}
            scroller={scroller}
            openFile={actions?.openFile ?? noop}
            openUrl={actions?.openUrl ?? openUrlFallback(host)}
            notice={actions?.notice ?? noop}
          />
        </Suspense>
      ) : (
        <table className={cn("w-full border-collapse", ROW)}>
          <tbody>
            {(file.text ?? "").split("\n").map((t, i) => (
              <tr key={i} data-line={i + 1} className={cn(i + 1 === line && "bg-amber-500/15")}>
                <td className={LN}>{i + 1}</td>
                <td className="whitespace-pre px-2">{t}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
}

const noop = () => undefined;

function openUrlFallback(host: HostApi) {
  return (url: string) => void host.openUrl?.(url);
}
