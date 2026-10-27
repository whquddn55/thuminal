// 문서 칸: diff 보기, 파일 보기. Markdown 파일은 미리보기를 기본으로 보이고, 원문 보기에서 바로 고친다
// (markdown.tsx · source-editor.tsx 는 처음 필요할 때 불러온다). 그림 · 영상 · 소리는 주소로 띄운다.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { type FileContent, FileConflictError, type HostApi } from "@thuminal/term-core";

import { type MediaKind, mediaKind, useFilesSupported } from "./file-features";
import { cn } from "./lib/utils";
import { isMarkdownFile } from "./markdown-links";

const MarkdownPreview = lazy(() => import("./markdown"));
const SourceEditor = lazy(() => import("./source-editor"));

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
  return doc.kind === "diff" ? (
    <DiffView host={host} worktree={worktree} doc={doc} generation={generation} />
  ) : (
    <FileView host={host} worktree={worktree} doc={doc} generation={generation} actions={actions} />
  );
}

function frameOf(ref: React.RefObject<HTMLDivElement | null>) {
  return (children: React.ReactNode) => (
    <div ref={ref} className="absolute inset-0 overflow-auto bg-background select-text thm-scroll">
      {children}
    </div>
  );
}

function DiffView({ host, worktree, doc, generation }: { host: HostApi; worktree: string; doc: DocSpec; generation: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staged = doc.staged === "1";
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    host.git
      .diff(worktree, doc.file, staged)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // generation: git 상태가 바뀔 때마다 다시 읽는다
  }, [host, worktree, doc.file, staged, generation]);

  const frame = frameOf(body);
  if (error) return frame(<div className="p-4 text-destructive">{error}</div>);
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
        <div className="p-4 text-muted-foreground">바뀐 내용이 없어요. 이미 스테이지했거나 되돌렸어요.</div>
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

/**
 * 저장하지 않은 고친 글. 칸이 탭을 옮기거나 닫혔다 다시 열려도 남게 칸 밖(호스트 · 워크트리 · 파일마다)에 둔다.
 * 앱을 끄면 사라진다
 */
const drafts = new Map<string, string>();
function draftKey(host: HostApi, worktree: string, file: string): string {
  return `${host.hostId ?? ""}\n${worktree}\n${file}`;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "conflict"; message: string } | { kind: "error"; message: string };

function FileView({ host, worktree, doc, generation, actions }: { host: HostApi; worktree: string; doc: DocSpec; generation: number; actions?: DocActions }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const line = Number(doc.line) || 0;
  const body = useRef<HTMLDivElement>(null);
  const supported = useFilesSupported(host);
  const media = mediaKind(doc.file);
  // 새 데몬이면 그림 · 영상 · 소리는 주소로 보인다 (옛 데몬은 SVG 만 글자로 본다)
  const asMedia = media !== null && supported === true;
  const markdown = isMarkdownFile(doc.file);
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

  // ---- 고친 글 · 저장 ----
  const key = draftKey(host, worktree, doc.file);
  const [draft, setDraftState] = useState<string | null>(() => drafts.get(key) ?? null);
  useEffect(() => setDraftState(drafts.get(key) ?? null), [key]);
  const setDraft = (t: string | null) => {
    if (t === null) drafts.delete(key);
    else drafts.set(key, t);
    setDraftState(t);
  };
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  /** 고치는 동안 다른 곳에서 파일이 바뀌었다 (다시 읽은 바뀐 때가 다르다) */
  const [outside, setOutside] = useState(false);
  const dirty = draft !== null && file !== null && draft !== file.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (asMedia) return;
    let alive = true;
    setError(null);
    host.files
      .read(worktree, doc.file)
      .then((f) => {
        if (!alive) return;
        // 고치는 중이면 편집기 글은 그대로 두고, 파일이 바뀌었는지만 알린다 (저장할 때 바뀐 때로 다시 막는다)
        setFile((old) => {
          if (dirtyRef.current && old) {
            if (f.modified != null && f.modified !== old.modified) setOutside(true);
            return old;
          }
          return f;
        });
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // generation: git 상태가 바뀔 때마다 다시 읽는다
  }, [host, worktree, doc.file, generation, asMedia]);

  const editable = markdown && supported === true && file !== null && !file.binary && !file.truncated;
  const doSave = (force = false) => {
    if (!file || draft === null || !editable || save.kind === "saving") return;
    const text = draft;
    setSave({ kind: "saving" });
    host.files.write(worktree, doc.file, text, force ? null : file.modified).then(
      (saved) => {
        setFile({ ...file, text, size: saved.size, modified: saved.modified ?? null });
        if (drafts.get(key) === text) setDraft(null);
        setSave({ kind: "idle" });
        setOutside(false);
      },
      (e) => setSave(e instanceof FileConflictError ? { kind: "conflict", message: e.message } : { kind: "error", message: String(e) }),
    );
  };
  /** 고친 것을 버리고 파일을 다시 읽는다 */
  const reload = () => {
    setDraft(null);
    setSave({ kind: "idle" });
    setOutside(false);
    host.files.read(worktree, doc.file).then(setFile, (e) => setError(String(e)));
  };

  // 검색 결과에서 열었으면 그 줄을 가운데로 (편집기가 아닌 표 보기)
  useEffect(() => {
    if (!line || !file || showPreview || markdown) return;
    body.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, [line, file, showPreview, markdown]);

  const frame = frameOf(body);
  if (asMedia) return <MediaView host={host} worktree={worktree} file={doc.file} kind={media} />;
  if (error) return frame(<div className="p-4 text-destructive">{error}</div>);
  if (file === null) return frame(<div className="p-4 text-muted-foreground">불러오는 중…</div>);
  const text = draft ?? file.text ?? "";

  const head = (
    <Head>
      <span className="flex-1 truncate font-mono">{doc.file}</span>
      {dirty && (
        <span className="shrink-0 text-amber-500" title="저장하지 않은 고친 내용이 있어요">
          ● 저장 안 됨
        </span>
      )}
      {!dirty && <span className="text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>}
      {file.truncated && <span className="text-amber-500">앞 2MB만 보여요</span>}
      {markdown && !file.binary && <Toggle value={view} onChange={changeView} />}
      {dirty && editable && (
        <button
          className="shrink-0 rounded-md bg-primary px-2 py-0.5 text-2xs text-primary-foreground disabled:opacity-50"
          disabled={save.kind === "saving"}
          onClick={() => doSave()}
          title="저장 (⌘S)"
        >
          {save.kind === "saving" ? "저장 중…" : "저장"}
        </button>
      )}
    </Head>
  );
  const banner = (() => {
    const bar = (tone: string, children: React.ReactNode) => <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs", tone)}>{children}</div>;
    const btn = (label: string, onClick: () => void) => (
      <button className="rounded border bg-background px-2 py-0.5 hover:bg-accent" onClick={onClick}>
        {label}
      </button>
    );
    if (save.kind === "conflict" || (outside && dirty))
      return bar(
        "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        <>
          <span className="flex-1">다른 곳에서 이 파일을 바꿨어요. 저장하면 그 내용을 덮어써요.</span>
          {btn("고친 것 버리고 다시 읽기", reload)}
          {btn("덮어쓰기", () => doSave(true))}
        </>,
      );
    if (save.kind === "error")
      return bar(
        "bg-destructive/10 text-destructive",
        <>
          <span className="flex-1">저장하지 못했어요: {save.message}</span>
          {btn("닫기", () => setSave({ kind: "idle" }))}
        </>,
      );
    return null;
  })();

  if (file.binary)
    return frame(
      <>
        {head}
        <div className="p-4 text-muted-foreground">
          {media && supported === false ? "데몬이 이전 버전이라 그림, 영상을 볼 수 없어요. 데몬을 다시 시작하면 볼 수 있어요." : "글자 파일이 아니에요"}
        </div>
      </>,
    );
  if (showPreview)
    return frame(
      <>
        {head}
        {banner}
        <Suspense fallback={<div className="p-4 text-muted-foreground">불러오는 중…</div>}>
          <MarkdownPreview
            host={host}
            worktree={worktree}
            file={doc.file}
            text={text}
            scroller={scroller}
            openFile={actions?.openFile ?? noop}
            openUrl={actions?.openUrl ?? openUrlFallback(host)}
            notice={actions?.notice ?? noop}
          />
        </Suspense>
      </>,
    );
  // Markdown 원문은 편집기에서 바로 고친다 (Orca 와 같다). 옛 데몬이거나 잘린 파일은 읽기만 된다
  if (markdown)
    return (
      <div className="absolute inset-0 flex flex-col bg-background">
        {head}
        {banner}
        {supported === false && (
          <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">데몬이 이전 버전이라 읽기만 할 수 있어요. 데몬을 다시 시작하면 여기서 고칠 수 있어요.</div>
        )}
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="p-4 text-muted-foreground">불러오는 중…</div>}>
            <SourceEditor value={text} readOnly={!editable} line={line} onChange={(t) => setDraft(t === file.text ? null : t)} onSave={() => doSave()} />
          </Suspense>
        </div>
      </div>
    );
  return frame(
    <>
      {head}
      <table className={cn("w-full border-collapse", ROW)}>
        <tbody>
          {text.split("\n").map((t, i) => (
            <tr key={i} data-line={i + 1} className={cn(i + 1 === line && "bg-amber-500/15")}>
              <td className={LN}>{i + 1}</td>
              <td className="whitespace-pre px-2">{t}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>,
  );
}

/** 그림 · 영상 · 소리. 주소는 껍데기가 정한다 (데스크톱 `thuminal-file://`, 웹 `/api/file`). 영상은 Range 로 받으며 재생한다 */
function MediaView({ host, worktree, file, kind }: { host: HostApi; worktree: string; file: string; kind: MediaKind }) {
  const url = host.files.mediaUrl(worktree, file);
  const [failed, setFailed] = useState(false);
  /** 그림: 칸에 맞추기(기본) · 원래 크기 */
  const [actual, setActual] = useState(false);
  const [size, setSize] = useState<string | null>(null);
  useEffect(() => {
    setFailed(false);
    setSize(null);
  }, [url]);
  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <Head>
        <span className="flex-1 truncate font-mono">{file}</span>
        {size && <span className="text-muted-foreground">{size}</span>}
        {kind === "image" && !failed && (
          <button className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-2xs hover:text-foreground" onClick={() => setActual((a) => !a)}>
            {actual ? "칸에 맞추기" : "원래 크기"}
          </button>
        )}
      </Head>
      <div className={cn("min-h-0 flex-1 thm-scroll", actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden p-3")}>
        {failed ? (
          <div className="p-4 text-muted-foreground">열지 못했어요. 이 앱이 재생하지 못하는 형식이거나 파일을 읽지 못했어요.</div>
        ) : kind === "image" ? (
          <img
            src={url}
            alt={file}
            className={cn(actual ? "max-w-none" : "max-h-full max-w-full object-contain", "cursor-zoom-in [image-rendering:auto]")}
            style={{ backgroundImage: "repeating-conic-gradient(var(--muted) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
            onClick={() => setActual((a) => !a)}
            onLoad={(e) => setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
            onError={() => setFailed(true)}
          />
        ) : kind === "video" ? (
          <video
            src={url}
            controls
            preload="metadata"
            className="max-h-full max-w-full"
            onLoadedMetadata={(e) => setSize(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight} · ${duration(e.currentTarget.duration)}`)}
            onError={() => setFailed(true)}
          />
        ) : (
          <audio
            src={url}
            controls
            preload="metadata"
            className="w-full max-w-xl"
            onLoadedMetadata={(e) => setSize(duration(e.currentTarget.duration))}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

function duration(sec: number): string {
  if (!Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const noop = () => undefined;

function openUrlFallback(host: HostApi) {
  return (url: string) => void host.openUrl?.(url);
}
