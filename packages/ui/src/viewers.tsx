// 문서 칸: diff 보기, 파일 보기.

import { useEffect, useRef, useState } from "react";

import type { FileContent, HostApi } from "@thuminal/term-core";

import { cn } from "./lib/utils";

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
}

const ROW = "font-mono text-xs leading-[1.5]";
const LN = "w-px select-none whitespace-nowrap px-2 text-right align-top text-muted-foreground/60";

function Head({ children }: { children: React.ReactNode }) {
  return <div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b bg-card px-3 py-2 text-xs">{children}</div>;
}

export function DocView({ host, worktree, doc, generation }: { host: HostApi; worktree: string; doc: DocSpec; generation: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staged = doc.staged === "1";
  const line = Number(doc.line) || 0;
  const body = useRef<HTMLDivElement>(null);

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
    if (!line || !file) return;
    body.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, [line, file]);

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
      </Head>
      {file.binary ? (
        <div className="p-4 text-muted-foreground">글자 파일이 아니다</div>
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
