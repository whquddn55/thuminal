// 파일 원문 편집기 (CodeMirror 6). 파일 칸의 원문 보기가 쓴다. 처음 필요할 때 불러온다 (viewers.tsx 의 lazy).
//
// 글은 칸(DocView)이 들고, 편집기는 고친 글을 onChange 로 올린다. 밖에서 value 가 바뀌면(다시 읽기 · 저장 뒤 새 내용)
// 편집기 글을 통째로 바꾼다. ⌘S 는 onSave, ⌘F 는 CodeMirror 찾기 칸이다 (앱 단축키는 ⌘S · ⌘F 를 쓰지 않는다).

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace', lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "6px 0" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 8px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 45%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 28%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--primary) 14%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "rgb(245 158 11 / 0.25)" },
  ".cm-searchMatch-selected": { backgroundColor: "rgb(245 158 11 / 0.5)" },
  ".cm-thm-goto": { backgroundColor: "rgb(245 158 11 / 0.15)" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--background)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--accent)", border: "1px solid var(--border)", borderRadius: "4px" },
});

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--foreground)" },
  { tag: [tags.heading1, tags.heading2], fontWeight: "700", textDecoration: "underline", textDecorationColor: "var(--border)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "rgb(14 165 233)" },
  { tag: tags.monospace, color: "rgb(217 119 6)" },
  { tag: tags.quote, color: "var(--muted-foreground)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "color-mix(in oklab, var(--muted-foreground) 75%, transparent)" },
  { tag: tags.list, color: "var(--muted-foreground)" },
]);

/** 검색 결과 등에서 열 때 가라는 줄을 강조한다 */
const gotoLine = StateEffect.define<number>();
const gotoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(gotoLine)) {
        const line = tr.state.doc.line(Math.min(Math.max(e.value, 1), tr.state.doc.lines));
        return Decoration.set([Decoration.line({ class: "cm-thm-goto" }).range(line.from)]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export default function SourceEditor({
  value,
  readOnly,
  line,
  onChange,
  onSave,
}: {
  value: string;
  readOnly: boolean;
  /** 1 부터. 0 이면 가지 않는다 */
  line: number;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  // 콜백은 늘 최신 것을 부른다 (편집기는 한 번만 만든다)
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          search({ top: true }),
          highlightSelectionMatches(),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          gotoField,
          theme,
          editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && handlers.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // 편집기는 한 번만 만든다. value · readOnly 는 아래에서 맞춘다
  }, []);

  // 밖에서 바뀐 글 (다시 읽기, 저장 뒤 새 내용). 사용자가 친 글이면 이미 같다
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v || !line) return;
    const at = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
    v.dispatch({ selection: { anchor: at.from }, effects: [gotoLine.of(line), EditorView.scrollIntoView(at.from, { y: "center" })] });
  }, [line]);

  return <div ref={host} className="h-full min-h-0 select-text" />;
}
