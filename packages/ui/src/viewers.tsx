// 문서 탭: diff 보기, 파일 보기.

import { useEffect, useState } from "react";

import type { FileContent, HostApi } from "@thuminal/term-core";

import type { DocTab } from "./store";

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

export function DocView({ host, worktree, doc, generation }: { host: HostApi; worktree: string; doc: DocTab; generation: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    const p =
      doc.kind === "diff"
        ? host.git.diff(worktree, doc.file, !!doc.staged).then((d) => alive && setDiff(d))
        : host.files.read(worktree, doc.file).then((f) => alive && setFile(f));
    p.catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // generation: git 상태가 바뀔 때마다 다시 읽는다
  }, [host, worktree, doc, generation]);

  if (error) return <div className="thm-doc thm-doc-error">{error}</div>;

  if (doc.kind === "diff") {
    if (diff === null) return <div className="thm-doc">불러오는 중…</div>;
    const lines = parseDiff(diff).filter((l) => l.kind !== "meta");
    const adds = lines.filter((l) => l.kind === "add").length;
    const dels = lines.filter((l) => l.kind === "del").length;
    return (
      <div className="thm-doc">
        <div className="thm-doc-head">
          <span className="path">{doc.file}</span>
          <span className="tag">{doc.staged ? "스테이지됨" : "작업 폴더"}</span>
          <span className="add">+{adds}</span>
          <span className="del">−{dels}</span>
        </div>
        {lines.length === 0 ? (
          <div className="thm-empty-note">바뀐 내용이 없다 (이미 스테이지했거나 되돌렸다)</div>
        ) : (
          <table className="thm-diff">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className={l.kind}>
                  <td className="ln">{l.old ?? ""}</td>
                  <td className="ln">{l.new ?? ""}</td>
                  <td className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</td>
                  <td className="code">{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (file === null) return <div className="thm-doc">불러오는 중…</div>;
  return (
    <div className="thm-doc">
      <div className="thm-doc-head">
        <span className="path">{doc.file}</span>
        <span className="tag">{(file.size / 1024).toFixed(1)} KB</span>
        {file.truncated && <span className="tag warn">앞 2MB 만 보인다</span>}
      </div>
      {file.binary ? (
        <div className="thm-empty-note">글자 파일이 아니다</div>
      ) : (
        <table className="thm-diff">
          <tbody>
            {(file.text ?? "").split("\n").map((t, i) => (
              <tr key={i} className="ctx">
                <td className="ln">{i + 1}</td>
                <td className="code">{t}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
