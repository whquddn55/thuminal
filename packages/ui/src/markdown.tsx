// Markdown 미리보기 (Orca 와 같은 모양). 파일 칸이 .md 를 열면 viewers.tsx 가 React.lazy 로 이 모듈을 부른다.
//
// remark-gfm(표, 체크박스, 취소선, 자동 링크, 각주) → remark-math → HTML 원문(rehype-raw) → 거르기(rehype-sanitize)
// → heading id(rehype-slug) → 수식(rehype-katex) → 코드 색(rehype-highlight) 차례로 지난다.
// 거르기 뒤에 붙는 것(heading id, katex·hljs 마크업)은 우리가 만든 것이라 거르지 않는다.
// ```mermaid 블록은 mermaid 를 처음 필요할 때 불러와 그린다.

import "katex/dist/katex.min.css";
import "./markdown.css";

import { ImageIcon } from "@phosphor-icons/react";
import type { HostApi } from "@thuminal/term-core";
import type { Element, ElementContent } from "hast";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { anchorCandidates, resolveImage, resolveLink } from "./markdown-links";

/** GitHub 거르기 규칙에 몇 가지를 더 허용한다 */
const schema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), "details", "summary", "kbd", "sub", "sup", "ins", "input"])],
  attributes: {
    ...defaultSchema.attributes,
    // remark-math 가 수식을 code.language-math 에 math-inline / math-display 를 붙여 넘긴다
    code: [["className", /^language-./, "math-inline", "math-display"]],
    details: ["open"],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
  },
};

export interface MarkdownPreviewProps {
  host: HostApi;
  worktree: string;
  /** 이 문서의 워크트리 기준 경로 (상대 링크·이미지를 이 폴더 기준으로 푼다) */
  file: string;
  text: string;
  /** 앵커로 옮겨 갈 때 스크롤하는 틀 */
  scroller: () => HTMLElement | null;
  openFile: (file: string, line?: number) => void;
  /** inApp: 앱 안 브라우저 칸으로 연다 (⌘⇧+클릭) */
  openUrl: (url: string, inApp: boolean) => void;
  notice: (text: string) => void;
}

function MarkdownPreview({ host, worktree, file, text, scroller, openFile, openUrl, notice }: MarkdownPreviewProps) {
  const root = useRef<HTMLDivElement>(null);

  const goAnchor = (id: string) => {
    const el = root.current;
    if (!el) return;
    for (const c of anchorCandidates(id)) {
      const hit = el.querySelector(`[id="${CSS.escape(c)}"], [name="${CSS.escape(c)}"]`);
      if (hit) {
        hit.scrollIntoView({ block: "start" });
        return;
      }
    }
    if (id === "top") scroller()?.scrollTo({ top: 0 });
  };

  // 링크 처리는 늘 마지막 props 를 본다. components 가 바뀌면 react-markdown 이 칸을 새로 만들어 mermaid 를 다시 그리므로 묶지 않는다
  const latest = useRef({ file, openFile, openUrl, notice, goAnchor });
  latest.current = { file, openFile, openUrl, notice, goAnchor };

  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, href, children, ...rest }) => (
        <a {...rest} href={href} onClick={(e) => onLink(latest.current, href, e)}>
          {children}
        </a>
      ),
      img: ({ src, alt, title }) => <MdImage host={host} worktree={worktree} docFile={file} src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
      pre: ({ node, children, ...rest }) => {
        const code = node?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
        const cls = code?.properties.className;
        if (code && Array.isArray(cls) && cls.includes("language-mermaid")) return <Mermaid code={textOf(code)} />;
        return <pre {...rest}>{children}</pre>;
      },
    }),
    [host, worktree, file],
  );

  return (
    <div ref={root} className="markdown-preview">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // 거르기가 id 앞에 user-content- 를 한 번 붙이도록 remark-rehype 는 붙이지 않는다
        remarkRehypeOptions={{ clobberPrefix: "", footnoteLabel: "각주", footnoteBackLabel: "본문으로" }}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], rehypeSlug, [rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { plainText: ["mermaid", "math"] }]]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

export default memo(MarkdownPreview);

interface LinkHandlers {
  file: string;
  openFile: MarkdownPreviewProps["openFile"];
  openUrl: MarkdownPreviewProps["openUrl"];
  notice: MarkdownPreviewProps["notice"];
  goAnchor: (id: string) => void;
}

/** 미리보기 안 링크를 누르면: 앵커는 문서 안에서, 주소는 기본 브라우저(⌘⇧ 면 앱 안 브라우저), 파일은 파일 칸으로 */
function onLink(h: LinkHandlers, href: string | undefined, e: React.MouseEvent) {
  e.preventDefault();
  const t = resolveLink(href, h.file);
  switch (t.type) {
    case "anchor":
      h.goAnchor(t.id);
      return;
    case "url":
      h.openUrl(t.url, e.metaKey && e.shiftKey && /^https?:/i.test(t.url));
      return;
    case "file":
      h.openFile(t.file, t.line);
      return;
    case "outside":
      h.notice(`워크트리 밖 파일은 열지 않는다: ${t.path}`);
      return;
  }
}

function textOf(n: Element | ElementContent): string {
  if (n.type === "text") return n.value;
  if (n.type === "element") return n.children.map(textOf).join("");
  return "";
}

// ---- 다크/라이트: <html> 의 .dark 를 따른다 (theme.ts 가 붙이고 뗀다) ----

function subscribeScheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}

function useDarkScheme(): boolean {
  return useSyncExternalStore(subscribeScheme, () => document.documentElement.classList.contains("dark"));
}

// ---- 이미지 ----

/** 원격 이미지는 그대로. 워크트리 안 이미지는 파일 읽기가 글자만 주므로 SVG 만 그리고, 나머지는 대체 글로 보인다 */
function MdImage({ host, worktree, docFile, src, alt, title }: { host: HostApi; worktree: string; docFile: string; src?: string; alt?: string; title?: string }) {
  const r = resolveImage(src, docFile);
  const local = r.type === "file" ? r.file : null;
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    setSvg(null);
    if (!local || !/\.svg$/i.test(local)) return;
    let alive = true;
    host.files
      .read(worktree, local)
      .then((f) => alive && !f.binary && f.text && setSvg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(f.text)}`))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [host, worktree, local]);

  if (r.type === "remote") return <img src={r.src} alt={alt} title={title} loading="lazy" />;
  if (svg) return <img src={svg} alt={alt} title={title} />;
  return (
    <span className="md-img-alt" title={local ?? src}>
      <ImageIcon />
      {alt || local || src || "이미지"}
    </span>
  );
}

// ---- mermaid ----

type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidLoad: Promise<MermaidApi> | null = null;
/** mermaid 는 전역 설정 하나로 그리므로 한 번에 하나씩 그린다 */
let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidSeq = 0;

function renderMermaid(code: string, dark: boolean): Promise<string> {
  mermaidLoad ??= import("mermaid").then((m) => m.default);
  const job = mermaidQueue.then(async () => {
    const mermaid = await mermaidLoad!;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif' });
    const id = `thm-mermaid-${++mermaidSeq}`;
    try {
      await mermaid.parse(code);
      return (await mermaid.render(id, code)).svg;
    } finally {
      // 그리다 실패하면 mermaid 가 body 에 임시 요소를 남긴다
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  mermaidQueue = job.catch(() => undefined);
  return job;
}

function Mermaid({ code }: { code: string }) {
  const dark = useDarkScheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    renderMermaid(code, dark).then(
      (s) => alive && setSvg(s),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [code, dark]);

  if (error)
    return (
      <div className="md-mermaid-error">
        <div>mermaid를 그리지 못했다: {error}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  if (svg === null) return <div className="md-mermaid md-mermaid-loading">그리는 중…</div>;
  // mermaid 가 securityLevel strict 로 만든 SVG 다
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
