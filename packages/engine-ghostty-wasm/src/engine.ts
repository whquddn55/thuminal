// term-core TerminalEngine 의 ghostty-vt.wasm 구현.

import {
  CellFlags,
  type CellPoint,
  type CellSink,
  type CursorState,
  type EngineColors,
  type EngineFactory,
  type InputEncoder,
  type KeyInput,
  type TerminalEngine,
} from "@thuminal/term-core";

import { mix, readable } from "./contrast";
import { KEY_CODES } from "./keymap";
import { SUCCESS, Wasm } from "./wasm";

// include/ghostty/vt/*.h 의 enum 값
const OPT_COLOR_FOREGROUND = 11;
const OPT_COLOR_BACKGROUND = 12;
const OPT_COLOR_CURSOR = 13;
const OPT_COLOR_PALETTE = 14; // GhosttyColorRgb[256]. OSC 4 로 바뀐 번호는 엔진이 지킨다
const OPT_SELECTION = 21;
const OPT_SCROLLBACK_MAX_BYTES = 27;
const OPT_SCROLLBACK_MAX_LINES = 28;
const TERM_DATA_MODE = 37;
// DEC 모드라 ANSI 비트(15)는 0
const MODE_BRACKETED_PASTE = 2004;
const MODE_MOUSE_X10 = 9;
const MODE_MOUSE_NORMAL = 1000;
const MODE_MOUSE_BUTTON = 1002;
const MODE_MOUSE_ANY = 1003;
const MODE_MOUSE_SGR = 1006;
const MODE_MOUSE_URXVT = 1015;
const MODE_ALT_SCROLL = 1007;
const MODE_ALT_SCREEN_LEGACY = 47;
const MODE_ALT_SCREEN = 1047;
const MODE_ALT_SCREEN_SAVE = 1049;
const MODE_SYNC_OUTPUT = 2026;
/** 동기 출력이 끝나지 않아도 이만큼 지나면 그린다 (Ghostty 와 같다) */
const SYNC_OUTPUT_TIMEOUT_MS = 1000;
const RS_DIRTY = 3;
const RS_ROW_ITERATOR = 4;
const RS_COLOR_BACKGROUND = 5;
const RS_COLOR_FOREGROUND = 6;
const RS_COLOR_CURSOR = 7;
const RS_COLOR_CURSOR_HAS_VALUE = 8;
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
// setColors 를 받기 전 선택 배경
const FALLBACK_SELECTION_BG = 0x264f78;
const CELL_RAW = 1;
const CELL_STYLE = 2;
const CELL_GRAPHEMES_LEN = 3;
const CELL_GRAPHEMES_BUF = 4;
const CELL_BG = 5;
const CELL_FG = 6;
const CELL_HAS_STYLING = 8;
const KEY_ACTION_PRESS = 1;
// include/ghostty/vt/key/encoder.h
const KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT = 6;
const OPTION_AS_ALT_TRUE = 1;
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

/** 두 칸을 쓰는 글자인지 (한글, 한자, 가나, 전각, 이모지). 조합 중인 글자 자리를 셀 때만 쓴다 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export class GhosttyWasmEngine implements TerminalEngine {
  private readonly rs: number;
  private readonly iterSlot: number;
  private readonly cellsSlot: number;
  private readonly encoder: number;
  private forceFull = true;
  /** 동기 출력이 켜진 때 (꺼져 있으면 null) */
  private syncSince: number | null = null;
  private cursorState: CursorState = { x: 0, y: 0, visible: true };
  private lastCursorRow = -1;
  private lastCursorColor = -1;
  private colors = { fg: 0xd0d0d0, bg: 0x101010 };
  /** setColors 로 받은 색. 없으면 엔진 내장 기본색과 위의 대체 색을 쓴다 */
  private theme: EngineColors | null = null;
  /** 대비 보정 결과 (fg * 2^24 + bg → 고친 fg) */
  private readonly contrastCache = new Map<number, number>();
  /** 조합 중인 글자의 코드 포인트 */
  private preedit: number[] = [];
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
    this.input = { key: (k) => this.encodeKey(k), paste: (t) => this.encodePaste(t), wheel: (n, at) => this.encodeWheel(n, at) };
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

  setColors(c: EngineColors): void {
    const { w } = this;
    const ex = w.ex;
    const set = (opt: number, p: number) => {
      const r = ex.ghostty_terminal_set(this.term, opt, p);
      if (r !== SUCCESS) throw new Error(`terminal_set(${opt}) 실패 (${r})`);
    };
    const rgb = (opt: number, v: number) => {
      const p = w.tmp + T_A;
      const u = w.u8();
      u[p] = (v >> 16) & 255;
      u[p + 1] = (v >> 8) & 255;
      u[p + 2] = v & 255;
      set(opt, p);
    };
    rgb(OPT_COLOR_FOREGROUND, c.fg);
    rgb(OPT_COLOR_BACKGROUND, c.bg);
    rgb(OPT_COLOR_CURSOR, c.cursor);
    // 16~255 는 엔진 내장 기본값 (6x6x6 큐브와 회색 단계) 을 그대로 둔다
    const pal = w.scratchFor(256 * 3);
    ex.ghostty_color_palette_default(pal);
    const u = w.u8();
    c.palette.slice(0, 16).forEach((v, i) => {
      u[pal + i * 3] = (v >> 16) & 255;
      u[pal + i * 3 + 1] = (v >> 8) & 255;
      u[pal + i * 3 + 2] = v & 255;
    });
    set(OPT_COLOR_PALETTE, pal);
    this.theme = { ...c, palette: [...c.palette] };
    this.colors = { fg: c.fg, bg: c.bg };
    this.contrastCache.clear();
    this.forceFull = true;
  }

  setPreedit(text: string | null): void {
    const cps = text ? [...text].map((c) => c.codePointAt(0)!) : [];
    if (cps.length === this.preedit.length && cps.every((c, i) => c === this.preedit[i])) return;
    this.preedit = cps;
    this.forceFull = true;
  }

  /** 최소 대비를 맞춘 글자색 */
  private readableFg(fg: number, bg: number, ratio: number): number {
    const key = fg * 0x1000000 + bg;
    let out = this.contrastCache.get(key);
    if (out === undefined) {
      if (this.contrastCache.size > 4096) this.contrastCache.clear();
      out = readable(fg, bg, ratio);
      this.contrastCache.set(key, out);
    }
    return out;
  }

  scan(sink: CellSink): boolean {
    const { w } = this;
    const ex = w.ex;
    const tmp = w.tmp;
    // 동기 출력(모드 2026) 중에는 프로그램이 화면 하나를 다 쓰기 전이라 그리지 않는다. claude 는 화면마다 이것으로 감싸는데,
    // 출력이 여러 조각(macOS PTY 는 1KB씩)으로 오므로 중간에 그리면 위에서부터 줄줄이 바뀌는 반쪽 화면이 보인다
    if (this.mode(MODE_SYNC_OUTPUT)) {
      const now = performance.now();
      this.syncSince ??= now;
      if (now - this.syncSince < SYNC_OUTPUT_TIMEOUT_MS) return false;
    } else this.syncSince = null;
    ex.ghostty_render_state_update(this.rs, this.term);
    ex.ghostty_render_state_get(this.rs, RS_COLOR_BACKGROUND, tmp + T_BG);
    ex.ghostty_render_state_get(this.rs, RS_COLOR_FOREGROUND, tmp + T_FG);
    const defBg = w.rgb(tmp + T_BG);
    const defFg = w.rgb(tmp + T_FG);
    const theme = this.theme;
    // 커서: OSC 12 로 바뀐 색이 있으면 그 색, 아니면 테마 색. 테마가 없으면 기본 fg/bg 를 맞바꾼다
    ex.ghostty_render_state_get(this.rs, RS_COLOR_CURSOR_HAS_VALUE, tmp + T_A);
    const hasCursorColor = w.u8()[tmp + T_A] !== 0;
    if (hasCursorColor) ex.ghostty_render_state_get(this.rs, RS_COLOR_CURSOR, tmp + T_A + 4);
    const cursorBg = hasCursorColor ? w.rgb(tmp + T_A + 4) : (theme?.cursor ?? defFg);
    // OSC 10/11/12 로 색만 바뀌면 엔진이 바뀜 표시를 하지 않아서 직접 비교한다
    if (defFg !== this.colors.fg || defBg !== this.colors.bg || cursorBg !== this.lastCursorColor) this.forceFull = true;
    this.colors = { fg: defFg, bg: defBg };
    this.lastCursorColor = cursorBg;

    ex.ghostty_render_state_get(this.rs, RS_DIRTY, tmp + T_A);
    const dirty = w.dv().getUint32(tmp + T_A, true);
    if (dirty === 0 && !this.forceFull) return false;
    const full = dirty === DIRTY_FULL || this.forceFull;
    this.forceFull = false;

    const cursorFg = theme ? theme.cursorText : defBg;
    const selBg = theme ? theme.selectionBg : FALLBACK_SELECTION_BG;
    const minContrast = theme?.minimumContrast ?? 1;

    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VISIBLE, tmp + T_A);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_HAS_VALUE, tmp + T_A + 1);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_X, tmp + T_A + 2);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_Y, tmp + T_A + 4);
    let dv = w.dv();
    const inView = dv.getUint8(tmp + T_A + 1) !== 0;
    const visible = dv.getUint8(tmp + T_A) !== 0 && inView;
    this.cursorState = { x: dv.getUint16(tmp + T_A + 2, true), y: dv.getUint16(tmp + T_A + 4, true), visible };
    const cursorY = visible ? this.cursorState.y : -1;
    // 조합 중인 글자는 커서를 숨겨도 커서 자리에 그린다. claude 같은 TUI 는 커서를 숨기고 제 커서를 그리지만
    // 입력기를 위해 숨긴 커서를 입력 자리에 옮겨 둔다
    const preY = this.preedit.length && inView ? this.cursorState.y : -1;

    // 조합 중인 글자를 놓을 칸: 커서 자리부터, 두 칸 글자는 두 칸씩 (뒤 칸은 비운다)
    const pre = new Map<number, { cp: number; wide: boolean }>();
    if (preY >= 0) {
      let px = this.cursorState.x;
      for (const cp of this.preedit) {
        const wide = isWide(cp);
        pre.set(px, { cp, wide });
        if (wide) pre.set(px + 1, { cp: 0, wide: false });
        px += wide ? 2 : 1;
      }
    }

    ex.ghostty_render_state_get(this.rs, RS_ROW_ITERATOR, this.iterSlot);
    const iter = w.dv().getUint32(this.iterSlot, true);
    let y = -1;
    while (ex.ghostty_render_state_row_iterator_next(iter)) {
      y++;
      ex.ghostty_render_state_row_get(iter, ROW_DIRTY, tmp + T_A);
      const rowDirty = w.u8()[tmp + T_A] !== 0;
      // 커서가 떠난 줄과 들어온 줄도 다시 그린다 (렌더러가 커서를 칸 색으로 그린다)
      if (!full && !rowDirty && y !== this.lastCursorRow && y !== cursorY && y !== preY) continue;

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
        let faint = false;
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
          faint = u[s + STYLE_FAINT] !== 0;
        }
        if (x >= selFrom && x <= selTo) {
          bg = selBg;
          if (theme) fg = theme.selectionFg;
          flags |= CellFlags.Selected;
        }
        // 같은 색은 일부러 숨긴 글자로 보고 두고, 흐린 글자는 보정한 뒤 배경 쪽으로 반만 섞는다
        if (minContrast > 1 && fg !== bg) fg = this.readableFg(fg, bg, minContrast);
        if (faint) fg = mix(fg, bg, 0.5);
        const p = y === preY ? pre.get(x) : undefined;
        if (p) {
          // 조합 중인 글자는 기본색에 밑줄만 긋는다 (커서는 그리지 않는다)
          sink.cell(x, y, p.cp, minContrast > 1 ? this.readableFg(defFg, defBg, minContrast) : defFg, defBg, p.cp ? CellFlags.Underline | (p.wide ? CellFlags.Wide : 0) : 0);
          continue;
        }
        if (x === this.cursorState.x && y === cursorY && !pre.size) [fg, bg] = [cursorFg, cursorBg];
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

  selectLine(at: CellPoint): void {
    const { w } = this;
    const opts = w.tmp + T_OPTS;
    if (!this.gridRef(at, opts + 4)) return;
    const dv = w.dv();
    // GhosttyTerminalSelectLineOptions: size, ref(12), whitespace*, whitespace_len, semantic_prompt_boundary
    dv.setUint32(opts, 28, true);
    dv.setUint32(opts + 16, 0, true); // 기본 공백 자르기
    dv.setUint32(opts + 20, 0, true);
    dv.setUint32(opts + 24, 0, true);
    const sel = w.tmp + T_SEL;
    dv.setUint32(sel, 32, true);
    if (w.ex.ghostty_terminal_select_line(this.term, opts, sel) === SUCCESS) {
      w.ex.ghostty_terminal_set(this.term, OPT_SELECTION, sel);
    }
  }

  selectAll(): void {
    const { w } = this;
    const sel = w.tmp + T_SEL;
    w.dv().setUint32(sel, 32, true);
    if (w.ex.ghostty_terminal_select_all(this.term, sel) === SUCCESS) {
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
    // ⌥ 를 Meta 로 쓴다 (⌥b → ESC b). setopt_from_terminal 이 이 옵션을 끄므로 그 뒤에 다시 켠다
    w.dv().setUint32(w.tmp + T_STRUCT, OPTION_AS_ALT_TRUE, true);
    ex.ghostty_key_encoder_setopt(this.encoder, KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT, w.tmp + T_STRUCT);
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
      const unshifted = unshiftedCodepoint(k);
      // ⌥ 를 Meta 로 쓰므로 macOS 가 ⌥ 로 바꾼 글자(⌥b → ∫) 대신 ⌥ 를 뺀 원래 글자를 넘긴다
      let text = k.key;
      if (k.alt && !k.ctrl && unshifted && k.code.startsWith("Key")) text = String.fromCodePoint(unshifted)[k.shift ? "toUpperCase" : "toLowerCase"]();
      else if (k.alt && !k.ctrl && unshifted && !k.shift) text = String.fromCodePoint(unshifted);
      if ([...text].length === 1) {
        const utf8 = new TextEncoder().encode(text);
        const p = w.copyIn(utf8);
        ex.ghostty_key_event_set_utf8(ev, p, utf8.length);
      }
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

  private mode(mode: number): boolean {
    const { w } = this;
    const p = w.tmp + T_A;
    w.dv().setUint16(p, mode, true);
    w.dv().setUint8(p + 2, 0);
    if (w.ex.ghostty_terminal_get(this.term, TERM_DATA_MODE, p) !== SUCCESS) return false;
    return w.dv().getUint8(p + 2) !== 0;
  }

  /**
   * 휠을 프로그램에 넘길 바이트. 마우스를 받는 프로그램(claude, vim 등)에는 휠 버튼(위 64, 아래 65)을,
   * 마우스를 받지 않는 대체 화면 프로그램(less 등)에는 방향키를 줄 수만큼 보낸다 (alternate scroll, 모드 1007)
   */
  private encodeWheel(lines: number, at: CellPoint): Uint8Array | null {
    if (!lines) return null;
    const n = Math.min(Math.abs(lines), 50);
    const up = lines < 0;
    if ([MODE_MOUSE_X10, MODE_MOUSE_NORMAL, MODE_MOUSE_BUTTON, MODE_MOUSE_ANY].some((m) => this.mode(m))) {
      const b = up ? 64 : 65;
      const x = Math.max(0, Math.min(this.cols - 1, at.x)) + 1;
      const y = Math.max(0, Math.min(this.rows - 1, at.y)) + 1;
      let one: string;
      if (this.mode(MODE_MOUSE_SGR)) one = `\x1b[<${b};${x};${y}M`;
      else if (this.mode(MODE_MOUSE_URXVT)) one = `\x1b[${32 + b};${x};${y}M`;
      else one = `\x1b[M${String.fromCharCode(32 + b, 32 + Math.min(x, 223), 32 + Math.min(y, 223))}`;
      return new TextEncoder().encode(one.repeat(n));
    }
    const alt = this.mode(MODE_ALT_SCREEN_SAVE) || this.mode(MODE_ALT_SCREEN) || this.mode(MODE_ALT_SCREEN_LEGACY);
    if (alt && this.mode(MODE_ALT_SCROLL)) {
      const arrow = up ? "ArrowUp" : "ArrowDown";
      const one = this.encodeKey({ key: arrow, code: arrow, ctrl: false, alt: false, shift: false, meta: false });
      if (!one) return null;
      const out = new Uint8Array(one.length * n);
      for (let i = 0; i < n; i++) out.set(one, i * one.length);
      return out;
    }
    return null;
  }

  private encodePaste(text: string): Uint8Array {
    const { w } = this;
    const data = new TextEncoder().encode(text);
    const bracketed = this.mode(MODE_BRACKETED_PASTE);
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
  let defaults: EngineColors | null = null;
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
    setDefaultColors(c) {
      defaults = { ...c, palette: [...c.palette] };
    },
    create({ cols, rows, scrollback }) {
      const w = need();
      const term = w.create((pp) => w.ex.ghostty_terminal_new(0, pp, cols, rows), "terminal_new");
      configure(w, term, scrollback);
      const engine = new GhosttyWasmEngine(w, term, cols, rows);
      if (defaults) engine.setColors(defaults);
      return engine;
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
          if (defaults) engine.setColors(defaults);
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
