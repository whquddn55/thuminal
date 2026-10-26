// Markdown 미리보기 안 링크·이미지 주소 풀이. 화면과 떼어 둔 순수 함수다 (test/markdown-links.test.ts).

/** 링크를 누르면 할 일 */
export type LinkTarget =
  | { type: "anchor"; id: string }
  | { type: "url"; url: string }
  | { type: "file"; file: string; line?: number }
  /** 워크트리 밖을 가리킨다 (`..` 로 벗어났다) */
  | { type: "outside"; path: string }
  /** 다루지 않는 주소 (javascript: 같은 것, 빈 주소) */
  | { type: "ignore" };

/** Markdown 파일인지 (미리보기를 기본으로 보여 준다) */
export function isMarkdownFile(file: string): boolean {
  return /\.(md|markdown)$/i.test(file);
}

/** 워크트리 기준 경로를 정리한다. `..` 로 워크트리 밖으로 나가면 null */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** 문서(워크트리 기준 경로)에서 본 상대 경로를 워크트리 기준으로 푼다. `/` 로 시작하면 워크트리 맨 위 기준이다 (GitHub 와 같다) */
export function resolveFromDoc(docFile: string, rel: string): string | null {
  if (rel.startsWith("/")) return normalizePath(rel);
  const dir = docFile.includes("/") ? docFile.slice(0, docFile.lastIndexOf("/")) : "";
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 원격 주소인지 (http, https, mailto 처럼 바깥 앱이 여는 것) */
export function isRemote(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** 링크 주소를 풀어 할 일을 정한다. docFile 은 지금 문서의 워크트리 기준 경로다 */
export function resolveLink(href: string | undefined, docFile: string): LinkTarget {
  const h = (href ?? "").trim();
  if (!h) return { type: "ignore" };
  if (h.startsWith("#")) return h.length > 1 ? { type: "anchor", id: decode(h.slice(1)) } : { type: "ignore" };
  if (isRemote(h)) return { type: "url", url: h };
  // 다른 스킴(javascript:, file:, vscode: …)은 열지 않는다
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(h) || h.startsWith("//")) return { type: "ignore" };

  // 경로 · 쿼리 · 조각으로 나눈다
  const hashAt = h.indexOf("#");
  const frag = hashAt >= 0 ? h.slice(hashAt + 1) : "";
  let path = hashAt >= 0 ? h.slice(0, hashAt) : h;
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  path = decode(path);

  // 줄 표시: `#L12`, `#L12-L20`, `#L12C3`, 또는 경로 끝 `:12`, `:12:3`
  let line: number | undefined;
  const lf = /^L(\d+)/.exec(frag);
  if (lf) line = Number(lf[1]);
  const lc = /^(.*?):(\d+)(?::\d+)?$/.exec(path);
  if (lc && lc[1]) {
    path = lc[1];
    line ??= Number(lc[2]);
  }
  if (!path) return { type: "ignore" };

  const file = resolveFromDoc(docFile, path);
  if (file === null) return { type: "outside", path };
  if (!file) return { type: "ignore" };
  return line ? { type: "file", file, line } : { type: "file", file };
}

/** 이미지 주소: 원격이면 그대로, 상대 경로면 워크트리 기준 경로로 푼다 */
export function resolveImage(src: string | undefined, docFile: string): { type: "remote"; src: string } | { type: "file"; file: string } | { type: "ignore" } {
  const s = (src ?? "").trim();
  if (!s) return { type: "ignore" };
  if (/^https?:/i.test(s)) return { type: "remote", src: s };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return { type: "ignore" };
  const path = decode(s.replace(/[?#].*$/, ""));
  const file = resolveFromDoc(docFile, path);
  return file ? { type: "file", file } : { type: "ignore" };
}

/** 문서 안에서 앵커가 가리킬 수 있는 id 들. rehype-sanitize 가 붙이는 `user-content-` 를 뗀 것과 붙인 것 둘 다 본다 */
export function anchorCandidates(id: string): string[] {
  const prefix = "user-content-";
  return id.startsWith(prefix) ? [id, id.slice(prefix.length)] : [id, prefix + id];
}
