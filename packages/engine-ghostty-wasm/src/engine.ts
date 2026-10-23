// term-core TerminalEngine 의 ghostty-vt.wasm 구현.

import {
  CellFlags,
  type CellPoint,
  type CellSink,
  type CursorState,
  type EngineFactory,
  type InputEncoder,
  type KeyInput,
  type TerminalEngine,
} from "@thuminal/term-core";

import { KEY_CODES } from "./keymap";
import { SUCCESS, Wasm } from "./wasm";

// include/ghostty/vt/*.h 의 enum 값
const OPT_SELECTION = 21;
const OPT_SCROLLBACK_MAX_BYTES = 27;
const OPT_SCROLLBACK_MAX_LINES = 28;
const TERM_DATA_MODE = 37;
const MODE_BRACKETED_PASTE = 2004; // DEC 모드라 ANSI 비트(15)는 0
const RS_DIRTY = 3;
const RS_ROW_ITERATOR = 4;
const RS_COLOR_BACKGROUND = 5;
const RS_COLOR_FOREGROUND = 6;
const RS_CURSOR_VISIBLE = 11;
const RS_CURSOR_VIEWPORT_HAS_VALUE = 14;
const RS_CURSOR_VIEWPORT_X = 15;
const RS_CURSOR_VIEWPORT_Y = 16;
const DIRTY_FULL = 2;
const ROW_DIRTY = 1;
const ROW_CELLS = 3;
const ROW_SELECTION = 4;
const POINT_VIEWPORT = 1;
const SCROLL_BOTTOM = 1;
const SCROLL_DELTA = 2;
const FORMAT_PLAIN = 0;
const SELECTION_BG = 0x264f78;
const CELL_RAW = 1;
const CELL_STYLE = 2;
const CELL_GRAPHEMES_LEN = 3;
const CELL_GRAPHEMES_BUF = 4;
const CELL_BG = 5;
const CELL_FG = 6;
const CELL_HAS_STYLING = 8;
const KEY_ACTION_PRESS = 1;
const MODS_SHIFT = 0x01;
const MODS_CTRL = 0x02;
const MODS_ALT = 0x04;
const MODS_SUPER = 0x08;
// GhosttyStyle 배치 (ghostty_type_json, wasm32)
const STYLE_SIZE = 72;
const STYLE_BOLD = 56;
const STYLE_ITALIC = 57;
const STYLE_FAINT = 58;
const STYLE_INVERSE = 60;
const STYLE_STRIKE = 62;
const STYLE_UNDERLINE = 64;
// GhosttyCell 은 u64 로 묶여 있고 wide 는 42~43 번째 비트다
const CELL_WIDE_SHIFT_HI = 42 - 32;
const CELL_WIDE_WIDE = 1;

// tmp 칸 안의 자리
const T_A = 0;
const T_FG = 16;
const T_BG = 20;
const T_FLAG = 24;
const T_RAW = 32; // 8바이트 정렬
const T_STYLE = 48; // 72바이트
const T_GRAPHEME = 128; // u32 32개
// 256 이후: 스크롤, 선택용 구조체 (scan 과 겹치지 않게)
const T_STRUCT = 256; // 24바이트 (GhosttyTerminalScrollViewport, GhosttyPoint)
const T_REF_A = 288; // GhosttyGridRef 12바이트
const T_REF_B = 304;
const T_SEL = 320; // GhosttySelection 32바이트
const T_OPTS = 360; // 24바이트
const T_OUT = 392; // 포인터, 길이

const UNSHIFTED: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
};

function unshiftedCodepoint(k: KeyInput): number {
  if (k.code.startsWith("Key")) return k.code.charCodeAt(3) + 32;
  if (k.code.startsWith("Digit")) return k.code.charCodeAt(5);
  const s = UNSHIFTED[k.code];
  if (s) return s.charCodeAt(0);
  return k.key.length === 1 ? (k.key.codePointAt(0) ?? 0) : 0;
}

export class GhosttyWasmEngine implements TerminalEngine {
  private readonly rs: number;
  private readonly iterSlot: number;
  private readonly cellsSlot: number;
  private readonly encoder: number;
  private forceFull = true;
  private cursorState: CursorState = { x: 0, y: 0, visible: true };
  private lastCursorRow = -1;
  private colors = { fg: 0xd0d0d0, bg: 0x101010 };
  readonly input: InputEncoder;

  constructor(
    private readonly w: Wasm,
    private readonly term: number,
    public cols: number,
    public rows: number,
  ) {
    const ex = w.ex;
    this.rs = w.create((pp) => ex.ghostty_render_state_new(0, pp), "render_state_new");
    this.iterSlot = w.slot((pp) => ex.ghostty_render_state_row_iterator_new(0, pp), "row_iterator_new");
    this.cellsSlot = w.slot((pp) => ex.ghostty_render_state_row_cells_new(0, pp), "row_cells_new");
    this.encoder = w.create((pp) => ex.ghostty_key_encoder_new(0, pp), "key_encoder_new");
    this.input = { key: (k) => this.encodeKey(k), paste: (t) => this.encodePaste(t) };
  }

  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const p = this.w.copyIn(bytes);
    this.w.ex.ghostty_terminal_vt_write(this.term, p, bytes.length);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    const r = this.w.ex.ghostty_terminal_resize(this.term, cols, rows, 1, 1);
    if (r !== SUCCESS) throw new Error(`terminal_resize 실패 (${r})`);
    this.cols = cols;
    this.rows = rows;
    this.forceFull = true;
  }

  invalidate(): void {
    this.forceFull = true;
  }

  cursor(): CursorState {
    return this.cursorState;
  }

  defaultColors() {
    return this.colors;
  }

  scan(sink: CellSink): boolean {
    const { w } = this;
    const ex = w.ex;
    const tmp = w.tmp;
    ex.ghostty_render_state_update(this.rs, this.term);
    ex.ghostty_render_state_get(this.rs, RS_DIRTY, tmp + T_A);
    const dirty = w.dv().getUint32(tmp + T_A, true);
    if (dirty === 0 && !this.forceFull) return false;
    const full = dirty === DIRTY_FULL || this.forceFull;
    this.forceFull = false;

    ex.ghostty_render_state_get(this.rs, RS_COLOR_BACKGROUND, tmp + T_BG);
    ex.ghostty_render_state_get(this.rs, RS_COLOR_FOREGROUND, tmp + T_FG);
    const defBg = w.rgb(tmp + T_BG);
    const defFg = w.rgb(tmp + T_FG);
    this.colors = { fg: defFg, bg: defBg };

    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VISIBLE, tmp + T_A);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_HAS_VALUE, tmp + T_A + 1);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_X, tmp + T_A + 2);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_Y, tmp + T_A + 4);
    let dv = w.dv();
    const visible = dv.getUint8(tmp + T_A) !== 0 && dv.getUint8(tmp + T_A + 1) !== 0;
    this.cursorState = { x: dv.getUint16(tmp + T_A + 2, true), y: dv.getUint16(tmp + T_A + 4, true), visible };
    const cursorY = visible ? this.cursorState.y : -1;

    ex.ghostty_render_state_get(this.rs, RS_ROW_ITERATOR, this.iterSlot);
    const iter = w.dv().getUint32(this.iterSlot, true);
    let y = -1;
    while (ex.ghostty_render_state_row_iterator_next(iter)) {
      y++;
      ex.ghostty_render_state_row_get(iter, ROW_DIRTY, tmp + T_A);
      const rowDirty = w.u8()[tmp + T_A] !== 0;
      // 커서가 떠난 줄과 들어온 줄도 다시 그린다 (렌더러가 커서를 칸 색으로 그린다)
      if (!full && !rowDirty && y !== this.lastCursorRow && y !== cursorY) continue;

      // 이 줄의 선택 구간 (없으면 NO_VALUE)
      w.dv().setUint32(tmp + T_A + 8, 8, true);
      const hasSel = ex.ghostty_render_state_row_get(iter, ROW_SELECTION, tmp + T_A + 8) === SUCCESS;
      const selFrom = hasSel ? w.dv().getUint16(tmp + T_A + 12, true) : -1;
      const selTo = hasSel ? w.dv().getUint16(tmp + T_A + 14, true) : -1;
      ex.ghostty_render_state_row_get(iter, ROW_CELLS, this.cellsSlot);
      const cells = w.dv().getUint32(this.cellsSlot, true);
      let x = -1;
      while (ex.ghostty_render_state_row_cells_next(cells)) {
        x++;
        ex.ghostty_render_state_row_cells_get(cells, CELL_GRAPHEMES_LEN, tmp + T_A);
        const fgR = ex.ghostty_render_state_row_cells_get(cells, CELL_FG, tmp + T_FG);
        const bgR = ex.ghostty_render_state_row_cells_get(cells, CELL_BG, tmp + T_BG);
        ex.ghostty_render_state_row_cells_get(cells, CELL_HAS_STYLING, tmp + T_FLAG);
        ex.ghostty_render_state_row_cells_get(cells, CELL_RAW, tmp + T_RAW);
        dv = w.dv();
        const len = dv.getUint32(tmp + T_A, true);
        let fg = fgR === SUCCESS ? w.rgb(tmp + T_FG) : defFg;
        let bg = bgR === SUCCESS ? w.rgb(tmp + T_BG) : defBg;
        let flags = 0;
        if (((dv.getUint32(tmp + T_RAW + 4, true) >>> CELL_WIDE_SHIFT_HI) & 3) === CELL_WIDE_WIDE) flags |= CellFlags.Wide;
        if (dv.getUint8(tmp + T_FLAG)) {
          dv.setUint32(tmp + T_STYLE, STYLE_SIZE, true);
          ex.ghostty_render_state_row_cells_get(cells, CELL_STYLE, tmp + T_STYLE);
          const u = w.u8();
          const s = tmp + T_STYLE;
          if (u[s + STYLE_BOLD]) flags |= CellFlags.Bold;
          if (u[s + STYLE_ITALIC]) flags |= CellFlags.Italic;
          if (u[s + STYLE_STRIKE]) flags |= CellFlags.Strikethrough;
          if (w.dv().getInt32(s + STYLE_UNDERLINE, true) !== 0) flags |= CellFlags.Underline;
          if (u[s + STYLE_INVERSE]) [fg, bg] = [bg, fg];
          if (u[s + STYLE_FAINT]) fg = (fg >> 1) & 0x7f7f7f;
        }
        if (x >= selFrom && x <= selTo) {
          bg = SELECTION_BG;
          flags |= CellFlags.Selected;
        }
        if (x === this.cursorState.x && y === cursorY) [fg, bg] = [defBg, defFg];
        let cp = 0;
        if (len > 0 && len <= 32) {
          ex.ghostty_render_state_row_cells_get(cells, CELL_GRAPHEMES_BUF, tmp + T_GRAPHEME);
          cp = w.dv().getUint32(tmp + T_GRAPHEME, true);
        }
        sink.cell(x, y, cp, fg, bg, flags);
      }
    }
    this.lastCursorRow = cursorY;
    ex.ghostty_render_state_clean(this.rs);
    return true;
  }

  scroll(lines: number): void {
    if (!lines) return;
    const { w } = this;
    const p = w.tmp + T_STRUCT;
    w.dv().setUint32(p, SCROLL_DELTA, true);
    w.dv().setInt32(p + 8, lines, true);
    w.ex.ghostty_terminal_scroll_viewport(this.term, p);
  }

  scrollToBottom(): void {
    const p = this.w.tmp + T_STRUCT;
    this.w.dv().setUint32(p, SCROLL_BOTTOM, true);
    this.w.ex.ghostty_terminal_scroll_viewport(this.term, p);
  }

  /** 화면 칸 좌표를 grid ref 로 바꿔 out 에 쓴다 */
  private gridRef(at: CellPoint, out: number): boolean {
    const { w } = this;
    const p = w.tmp + T_STRUCT;
    const dv = w.dv();
    dv.setUint32(p, POINT_VIEWPORT, true);
    dv.setUint16(p + 8, Math.max(0, Math.min(this.cols - 1, at.x)), true);
    dv.setUint32(p + 12, Math.max(0, Math.min(this.rows - 1, at.y)), true);
    dv.setUint32(out, 12, true);
    return w.ex.ghostty_terminal_grid_ref(this.term, p, out) === SUCCESS;
  }

  select(from: CellPoint, to: CellPoint): void {
    const { w } = this;
    const sel = w.tmp + T_SEL;
    if (!this.gridRef(from, w.tmp + T_REF_A) || !this.gridRef(to, w.tmp + T_REF_B)) return;
    const u = w.u8();
    u.copyWithin(sel + 4, w.tmp + T_REF_A, w.tmp + T_REF_A + 12);
    u.copyWithin(sel + 16, w.tmp + T_REF_B, w.tmp + T_REF_B + 12);
    const dv = w.dv();
    dv.setUint32(sel, 32, true);
    dv.setUint8(sel + 28, 0);
    w.ex.ghostty_terminal_set(this.term, OPT_SELECTION, sel);
  }

  selectWord(at: CellPoint): void {
    const { w } = this;
    const opts = w.tmp + T_OPTS;
    if (!this.gridRef(at, opts + 4)) return;
    const dv = w.dv();
    dv.setUint32(opts, 24, true);
    dv.setUint32(opts + 16, 0, true); // 기본 단어 경계
    dv.setUint32(opts + 20, 0, true);
    const sel = w.tmp + T_SEL;
    dv.setUint32(sel, 32, true);
    if (w.ex.ghostty_terminal_select_word(this.term, opts, sel) === SUCCESS) {
      w.ex.ghostty_terminal_set(this.term, OPT_SELECTION, sel);
    }
  }

  clearSelection(): void {
    this.w.ex.ghostty_terminal_set(this.term, OPT_SELECTION, 0);
  }

  selectionText(): string | null {
    const { w } = this;
    const opts = w.tmp + T_OPTS;
    const dv = w.dv();
    dv.setUint32(opts, 16, true);
    dv.setUint32(opts + 4, FORMAT_PLAIN, true);
    dv.setUint8(opts + 8, 1); // 줄바꿈으로 접힌 줄을 다시 잇는다
    dv.setUint8(opts + 9, 1); // 줄 끝 공백을 지운다
    dv.setUint32(opts + 12, 0, true); // 지금 선택
    const outPtr = w.tmp + T_OUT;
    const outLen = w.tmp + T_OUT + 4;
    if (w.ex.ghostty_terminal_selection_format_alloc(this.term, 0, opts, outPtr, outLen) !== SUCCESS) return null;
    const ptr = w.dv().getUint32(outPtr, true);
    const len = w.dv().getUint32(outLen, true);
    if (!ptr || !len) return null;
    const text = new TextDecoder().decode(w.u8().slice(ptr, ptr + len));
    w.ex.ghostty_free(0, ptr, len);
    return text;
  }

  private encodeKey(k: KeyInput): Uint8Array | null {
    const { w } = this;
    const ex = w.ex;
    // Cmd 조합은 앱 단축키로 둔다
    if (k.meta) return null;
    ex.ghostty_key_encoder_setopt_from_terminal(this.encoder, this.term);
    const ev = w.create((pp) => ex.ghostty_key_event_new(0, pp), "key_event_new");
    try {
      ex.ghostty_key_event_set_action(ev, KEY_ACTION_PRESS);
      ex.ghostty_key_event_set_key(ev, KEY_CODES[k.code] ?? 0);
      let mods = 0;
      if (k.shift) mods |= MODS_SHIFT;
      if (k.ctrl) mods |= MODS_CTRL;
      if (k.alt) mods |= MODS_ALT;
      if (k.meta) mods |= MODS_SUPER;
      ex.ghostty_key_event_set_mods(ev, mods);
      if ([...k.key].length === 1) {
        const utf8 = new TextEncoder().encode(k.key);
        const p = w.copyIn(utf8);
        ex.ghostty_key_event_set_utf8(ev, p, utf8.length);
      }
      const unshifted = unshiftedCodepoint(k);
      if (unshifted) ex.ghostty_key_event_set_unshifted_codepoint(ev, unshifted);
      const out = w.tmp + T_GRAPHEME;
      const outLen = w.tmp + T_A;
      const r = ex.ghostty_key_encoder_encode(this.encoder, ev, out, 128, outLen);
      if (r !== SUCCESS) return null;
      const n = w.dv().getUint32(outLen, true);
      return n > 0 ? w.u8().slice(out, out + n) : null;
    } finally {
      ex.ghostty_key_event_free(ev);
    }
  }

  private bracketedPaste(): boolean {
    const { w } = this;
    const p = w.tmp + T_A;
    w.dv().setUint16(p, MODE_BRACKETED_PASTE, true);
    w.dv().setUint8(p + 2, 0);
    if (w.ex.ghostty_terminal_get(this.term, TERM_DATA_MODE, p) !== SUCCESS) return false;
    return w.dv().getUint8(p + 2) !== 0;
  }

  private encodePaste(text: string): Uint8Array {
    const { w } = this;
    const data = new TextEncoder().encode(text);
    const bracketed = this.bracketedPaste();
    // data 와 결과를 한 덩어리에 둔다: [data][결과 버퍼]
    const cap = data.length + 16;
    const base = w.scratchFor(data.length + cap);
    w.u8().set(data, base);
    const out = base + data.length;
    const written = w.tmp + T_A + 8;
    const r = w.ex.ghostty_paste_encode(base, data.length, bracketed ? 1 : 0, out, cap, written);
    if (r !== SUCCESS) return data;
    const n = w.dv().getUint32(written, true);
    return w.u8().slice(out, out + n);
  }

  dispose(): void {
    const ex = this.w.ex;
    ex.ghostty_key_encoder_free(this.encoder);
    ex.ghostty_render_state_free(this.rs);
    ex.ghostty_terminal_free(this.term);
  }
}

export interface GhosttyWasmOptions {
  /** wasm 바이트를 가져오는 방법 (브라우저는 fetch, 시험은 파일 읽기) */
  wasm: () => Promise<BufferSource>;
}

export function ghosttyWasmEngine(opts: GhosttyWasmOptions): EngineFactory {
  let wasm: Wasm | null = null;
  const need = () => {
    if (!wasm) throw new Error("ghostty-vt.wasm 을 먼저 load() 해야 한다");
    return wasm;
  };
  const configure = (w: Wasm, term: number, scrollback: number) => {
    // 바이트 한도를 풀고 줄 한도만 건다 (데몬 엔진과 같은 설정)
    w.ex.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_BYTES, 0);
    w.dv().setUint32(w.tmp, scrollback, true);
    w.ex.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_LINES, w.tmp);
  };
  return {
    name: "ghostty-wasm",
    nativeSnapshotOf: "ghostty",
    async load() {
      if (!wasm) wasm = await Wasm.instantiate(await opts.wasm());
    },
    create({ cols, rows, scrollback }) {
      const w = need();
      const term = w.create((pp) => w.ex.ghostty_terminal_new(0, pp, cols, rows), "terminal_new");
      configure(w, term, scrollback);
      return new GhosttyWasmEngine(w, term, cols, rows);
    },
    restore(snapshot, { cols, rows, scrollback }) {
      const w = need();
      const ex = w.ex;
      // 저장본은 decoder 가 쓰는 동안 wasm 안에 있어야 해서 따로 잡는다
      const buf = ex.ghostty_wasm_alloc(snapshot.length);
      try {
        w.u8().set(snapshot, buf);
        const dec = w.create((pp) => ex.ghostty_snapshot_decoder_new_buf(0, pp, buf, snapshot.length), "snapshot_decoder_new_buf");
        try {
          const term = w.create((pp) => ex.ghostty_snapshot_decoder_decode(dec, pp), "snapshot_decoder_decode");
          configure(w, term, scrollback);
          const engine = new GhosttyWasmEngine(w, term, cols, rows);
          if (ex.ghostty_terminal_resize(term, cols, rows, 1, 1) !== SUCCESS) {
            engine.dispose();
            return null;
          }
          return engine;
        } finally {
          ex.ghostty_snapshot_decoder_free(dec);
        }
      } catch {
        // 데몬과 wasm 의 Ghostty 버전이 달라 저장본 형식이 맞지 않으면 vt 로 다시 붙는다
        return null;
      } finally {
        ex.ghostty_wasm_free(buf, snapshot.length);
      }
    },
  };
}
