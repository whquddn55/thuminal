// ghostty-vt.wasm 을 감싸는 얇은 층과 Canvas 2D 렌더러.
//
// 엔진 상태는 터미널마다 wasm 안에 있고, 화면에 보이는 터미널만 canvas 를 갖는다.
// 숨긴 터미널은 바이트를 엔진에 넣기만 하고 그리지 않는다.

import wasmUrl from "./assets/ghostty-vt.wasm?url";

// include/ghostty/vt/*.h 의 enum 값
const SUCCESS = 0;
const OPT_SCROLLBACK_MAX_BYTES = 27;
const OPT_SCROLLBACK_MAX_LINES = 28;
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
const CELL_STYLE = 2;
const CELL_GRAPHEMES_LEN = 3;
const CELL_GRAPHEMES_BUF = 4;
const CELL_BG = 5;
const CELL_FG = 6;
const CELL_HAS_STYLING = 8;
// GhosttyStyle (ghostty_type_json 으로 확인한 wasm32 배치)
const STYLE_SIZE = 72;
const STYLE_BOLD = 56;
const STYLE_FAINT = 58;
const STYLE_INVERSE = 60;

type Exports = { memory: WebAssembly.Memory } & Record<string, (...a: number[]) => number>;

const SCRATCH = 64 * 1024;

export class GhosttyVt {
  readonly ex: Exports;
  /** 바이트 쓰기용 임시 버퍼 */
  readonly scratch: number;
  /** 작은 값 읽기용 임시 칸 (64바이트) */
  readonly tmp: number;
  /** GhosttyStyle 읽기용 칸 */
  readonly style: number;
  /** 글자 묶음(grapheme) 코드포인트 읽기용 칸 (u32 64개) */
  readonly gbuf: number;

  private constructor(ex: Exports) {
    this.ex = ex;
    this.scratch = ex.ghostty_wasm_alloc(SCRATCH);
    this.tmp = ex.ghostty_wasm_alloc(64);
    this.style = ex.ghostty_wasm_alloc(STYLE_SIZE);
    this.gbuf = ex.ghostty_wasm_alloc(64 * 4);
  }

  static async load(): Promise<GhosttyVt> {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    return new GhosttyVt(instance.exports as unknown as Exports);
  }

  // wasm 메모리는 커질 수 있어 매번 새로 잡는다 (wasm.h 의 Memory growth 절)
  u8(): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer);
  }
  dv(): DataView {
    return new DataView(this.ex.memory.buffer);
  }

  /** 핸들을 돌려주는 생성 함수를 불러 핸들 값을 꺼낸다 */
  create(call: (outPtr: number) => number, what: string): number {
    const pp = this.ex.ghostty_wasm_alloc_opaque();
    const r = call(pp);
    if (r !== SUCCESS) throw new Error(`${what} 실패: ${r}`);
    const h = this.ex.ghostty_wasm_take_opaque(pp);
    this.ex.ghostty_wasm_free_opaque(pp);
    return h;
  }

  /** 핸들을 담아 둘 칸을 만들어 둔다 (render_state_get 이 칸 주소를 받는다) */
  createSlot(call: (outPtr: number) => number, what: string): number {
    const pp = this.ex.ghostty_wasm_alloc_opaque();
    const r = call(pp);
    if (r !== SUCCESS) throw new Error(`${what} 실패: ${r}`);
    return pp;
  }
}

const colorCache = new Map<number, string>();
function css(rgb: number): string {
  let s = colorCache.get(rgb);
  if (!s) {
    s = `#${rgb.toString(16).padStart(6, "0")}`;
    colorCache.set(rgb, s);
  }
  return s;
}

export interface CellMetrics {
  w: number;
  h: number;
  font: string;
  fontBold: string;
}

export function measureCell(fontSize: number, family: string): CellMetrics {
  const c = document.createElement("canvas").getContext("2d")!;
  const font = `${fontSize}px ${family}`;
  c.font = font;
  const w = c.measureText("M").width;
  return { w, h: Math.ceil(fontSize * 1.25), font, fontBold: `bold ${font}` };
}

/** 측정용: true 면 글자를 그리지 않고 배경만 그린다 (메모리 원인 가르기) */
export const drawOpts = { noText: false };

export class GhosttyPane {
  readonly term: number;
  private readonly rs: number;
  private readonly iterSlot: number;
  private readonly cellsSlot: number;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastCursorRow = -1;
  /** 이 터미널을 그리는 데 쓴 시간 합계 (ms) */
  renderMs = 0;
  parseMs = 0;

  constructor(
    private readonly vt: GhosttyVt,
    readonly cols: number,
    readonly rows: number,
    private readonly m: CellMetrics,
    scrollbackLines: number,
  ) {
    const ex = vt.ex;
    this.term = vt.create((pp) => ex.ghostty_terminal_new(0, pp, cols, rows), "terminal_new");
    // 바이트 한도를 풀고 줄 한도만 건다 (데몬 시제품에서 확인한 함정)
    ex.ghostty_terminal_set(this.term, OPT_SCROLLBACK_MAX_BYTES, 0);
    vt.dv().setUint32(vt.tmp, scrollbackLines, true);
    ex.ghostty_terminal_set(this.term, OPT_SCROLLBACK_MAX_LINES, vt.tmp);
    this.rs = vt.create((pp) => ex.ghostty_render_state_new(0, pp), "render_state_new");
    this.iterSlot = vt.createSlot((pp) => ex.ghostty_render_state_row_iterator_new(0, pp), "row_iterator_new");
    this.cellsSlot = vt.createSlot((pp) => ex.ghostty_render_state_row_cells_new(0, pp), "row_cells_new");
  }

  write(data: Uint8Array): void {
    const t0 = performance.now();
    const { ex } = this.vt;
    for (let off = 0; off < data.length; off += SCRATCH) {
      const chunk = data.subarray(off, Math.min(off + SCRATCH, data.length));
      this.vt.u8().set(chunk, this.vt.scratch);
      ex.ghostty_terminal_vt_write(this.term, this.vt.scratch, chunk.length);
    }
    this.parseMs += performance.now() - t0;
  }

  /** 보이게 할 때 canvas 를 붙이고, 숨길 때 떼어 낸다 */
  attach(host: HTMLElement | null): void {
    if (!host) {
      this.canvas?.remove();
      this.canvas = null;
      this.ctx = null;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.width = Math.ceil(this.cols * this.m.w * dpr);
    c.height = this.rows * this.m.h * dpr;
    c.style.width = `${this.cols * this.m.w}px`;
    c.style.height = `${this.rows * this.m.h}px`;
    host.appendChild(c);
    const ctx = c.getContext("2d", { alpha: false })!;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";
    this.canvas = c;
    this.ctx = ctx;
    this.lastCursorRow = -1;
  }

  /** 바뀐 줄만 다시 그린다. canvas 가 없으면(숨김) 아무것도 하지 않는다 */
  render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = performance.now();
    const { ex } = this.vt;
    const vt = this.vt;
    const { w, h } = this.m;

    ex.ghostty_render_state_update(this.rs, this.term);
    let dv = vt.dv();
    ex.ghostty_render_state_get(this.rs, RS_DIRTY, vt.tmp);
    const dirty = dv.getUint32(vt.tmp, true);
    if (dirty === 0) {
      this.renderMs += performance.now() - t0;
      return;
    }
    const full = dirty === DIRTY_FULL;

    ex.ghostty_render_state_get(this.rs, RS_COLOR_BACKGROUND, vt.tmp);
    ex.ghostty_render_state_get(this.rs, RS_COLOR_FOREGROUND, vt.tmp + 4);
    let u8 = vt.u8();
    const defBg = (u8[vt.tmp] << 16) | (u8[vt.tmp + 1] << 8) | u8[vt.tmp + 2];
    const defFg = (u8[vt.tmp + 4] << 16) | (u8[vt.tmp + 5] << 8) | u8[vt.tmp + 6];

    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VISIBLE, vt.tmp);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_HAS_VALUE, vt.tmp + 1);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_X, vt.tmp + 2);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_Y, vt.tmp + 4);
    dv = vt.dv();
    const cursorOn = dv.getUint8(vt.tmp) !== 0 && dv.getUint8(vt.tmp + 1) !== 0;
    const cursorX = dv.getUint16(vt.tmp + 2, true);
    const cursorY = cursorOn ? dv.getUint16(vt.tmp + 4, true) : -1;

    ex.ghostty_render_state_get(this.rs, RS_ROW_ITERATOR, this.iterSlot);
    const iter = dv.getUint32(this.iterSlot, true);

    let font = "";
    let fill = "";
    const setFont = (f: string) => {
      if (f !== font) ctx.font = font = f;
    };
    const setFill = (c: string) => {
      if (c !== fill) ctx.fillStyle = fill = c;
    };

    let y = -1;
    while (ex.ghostty_render_state_row_iterator_next(iter)) {
      y++;
      ex.ghostty_render_state_row_get(iter, ROW_DIRTY, vt.tmp);
      const rowDirty = vt.u8()[vt.tmp] !== 0;
      if (!full && !rowDirty && y !== this.lastCursorRow && y !== cursorY) continue;

      const py = y * h;
      setFill(css(defBg));
      ctx.fillRect(0, py, this.cols * w, h);

      ex.ghostty_render_state_row_get(iter, ROW_CELLS, this.cellsSlot);
      const cells = vt.dv().getUint32(this.cellsSlot, true);

      // 같은 색과 굵기의 ASCII 글자는 한 번에 그린다
      let run = "";
      let runX = 0;
      let runFg = -1;
      let runBold = false;
      const flush = () => {
        if (!run) return;
        setFont(runBold ? this.m.fontBold : this.m.font);
        setFill(css(runFg));
        if (!drawOpts.noText) ctx.fillText(run, runX * w, py + 1);
        run = "";
      };

      let x = -1;
      while (ex.ghostty_render_state_row_cells_next(cells)) {
        x++;
        ex.ghostty_render_state_row_cells_get(cells, CELL_GRAPHEMES_LEN, vt.tmp);
        const fgR = ex.ghostty_render_state_row_cells_get(cells, CELL_FG, vt.tmp + 8);
        const bgR = ex.ghostty_render_state_row_cells_get(cells, CELL_BG, vt.tmp + 12);
        u8 = vt.u8();
        const len = u8[vt.tmp] | (u8[vt.tmp + 1] << 8);
        let fg = fgR === SUCCESS ? (u8[vt.tmp + 8] << 16) | (u8[vt.tmp + 9] << 8) | u8[vt.tmp + 10] : defFg;
        let bg = bgR === SUCCESS ? (u8[vt.tmp + 12] << 16) | (u8[vt.tmp + 13] << 8) | u8[vt.tmp + 14] : -1;

        let bold = false;
        ex.ghostty_render_state_row_cells_get(cells, CELL_HAS_STYLING, vt.tmp + 16);
        if (vt.u8()[vt.tmp + 16]) {
          vt.dv().setUint32(vt.style, STYLE_SIZE, true);
          ex.ghostty_render_state_row_cells_get(cells, CELL_STYLE, vt.style);
          u8 = vt.u8();
          bold = u8[vt.style + STYLE_BOLD] !== 0;
          if (u8[vt.style + STYLE_INVERSE]) {
            const b = bg === -1 ? defBg : bg;
            bg = fg;
            fg = b;
          }
          if (u8[vt.style + STYLE_FAINT]) fg = (fg >> 1) & 0x7f7f7f;
        }
        if (x === cursorX && y === cursorY) {
          bg = defFg;
          fg = defBg;
        }

        if (bg !== -1) {
          flush();
          setFill(css(bg));
          ctx.fillRect(x * w, py, w, h);
        }
        if (len === 0 || len > 64) {
          flush();
          continue;
        }
        ex.ghostty_render_state_row_cells_get(cells, CELL_GRAPHEMES_BUF, vt.gbuf);
        const cp = vt.dv().getUint32(vt.gbuf, true);
        if (cp < 0x80 && len === 1) {
          if (run && (fg !== runFg || bold !== runBold || bg !== -1)) flush();
          if (!run) {
            runX = x;
            runFg = fg;
            runBold = bold;
          }
          run += String.fromCharCode(cp);
        } else {
          // 한글 같은 넓은 글자는 칸 위치에 하나씩 그린다
          flush();
          setFont(bold ? this.m.fontBold : this.m.font);
          setFill(css(fg));
          if (!drawOpts.noText) ctx.fillText(String.fromCodePoint(cp), x * w, py + 1);
        }
      }
      flush();
    }
    this.lastCursorRow = cursorY;
    ex.ghostty_render_state_clean(this.rs);
    this.renderMs += performance.now() - t0;
  }

  /**
   * WebGL 렌더러용: 바뀐 줄의 칸을 sink 에 넘긴다. 색은 기본색까지 풀어서 넘긴다.
   * 바뀐 것이 없으면 false.
   */
  scan(sink: CellSink): boolean {
    const t0 = performance.now();
    const { ex } = this.vt;
    const vt = this.vt;

    ex.ghostty_render_state_update(this.rs, this.term);
    ex.ghostty_render_state_get(this.rs, RS_DIRTY, vt.tmp);
    const dirty = vt.dv().getUint32(vt.tmp, true);
    if (dirty === 0) {
      this.renderMs += performance.now() - t0;
      return false;
    }
    const full = dirty === DIRTY_FULL;

    ex.ghostty_render_state_get(this.rs, RS_COLOR_BACKGROUND, vt.tmp);
    ex.ghostty_render_state_get(this.rs, RS_COLOR_FOREGROUND, vt.tmp + 4);
    let u8 = vt.u8();
    const defBg = (u8[vt.tmp] << 16) | (u8[vt.tmp + 1] << 8) | u8[vt.tmp + 2];
    const defFg = (u8[vt.tmp + 4] << 16) | (u8[vt.tmp + 5] << 8) | u8[vt.tmp + 6];
    sink.defaultBg = defBg;

    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VISIBLE, vt.tmp);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_HAS_VALUE, vt.tmp + 1);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_X, vt.tmp + 2);
    ex.ghostty_render_state_get(this.rs, RS_CURSOR_VIEWPORT_Y, vt.tmp + 4);
    let dv = vt.dv();
    const cursorOn = dv.getUint8(vt.tmp) !== 0 && dv.getUint8(vt.tmp + 1) !== 0;
    const cursorX = dv.getUint16(vt.tmp + 2, true);
    const cursorY = cursorOn ? dv.getUint16(vt.tmp + 4, true) : -1;

    ex.ghostty_render_state_get(this.rs, RS_ROW_ITERATOR, this.iterSlot);
    const iter = vt.dv().getUint32(this.iterSlot, true);

    let y = -1;
    while (ex.ghostty_render_state_row_iterator_next(iter)) {
      y++;
      ex.ghostty_render_state_row_get(iter, ROW_DIRTY, vt.tmp);
      const rowDirty = vt.u8()[vt.tmp] !== 0;
      if (!full && !rowDirty && y !== this.lastCursorRow && y !== cursorY) continue;

      ex.ghostty_render_state_row_get(iter, ROW_CELLS, this.cellsSlot);
      const cells = vt.dv().getUint32(this.cellsSlot, true);
      let x = -1;
      while (ex.ghostty_render_state_row_cells_next(cells)) {
        x++;
        ex.ghostty_render_state_row_cells_get(cells, CELL_GRAPHEMES_LEN, vt.tmp);
        const fgR = ex.ghostty_render_state_row_cells_get(cells, CELL_FG, vt.tmp + 8);
        const bgR = ex.ghostty_render_state_row_cells_get(cells, CELL_BG, vt.tmp + 12);
        ex.ghostty_render_state_row_cells_get(cells, CELL_HAS_STYLING, vt.tmp + 16);
        u8 = vt.u8();
        const len = u8[vt.tmp] | (u8[vt.tmp + 1] << 8);
        let fg = fgR === SUCCESS ? (u8[vt.tmp + 8] << 16) | (u8[vt.tmp + 9] << 8) | u8[vt.tmp + 10] : defFg;
        let bg = bgR === SUCCESS ? (u8[vt.tmp + 12] << 16) | (u8[vt.tmp + 13] << 8) | u8[vt.tmp + 14] : defBg;
        let bold = false;
        if (u8[vt.tmp + 16]) {
          dv = vt.dv();
          dv.setUint32(vt.style, STYLE_SIZE, true);
          ex.ghostty_render_state_row_cells_get(cells, CELL_STYLE, vt.style);
          u8 = vt.u8();
          bold = u8[vt.style + STYLE_BOLD] !== 0;
          if (u8[vt.style + STYLE_INVERSE]) {
            const b = bg;
            bg = fg;
            fg = b;
          }
          if (u8[vt.style + STYLE_FAINT]) fg = (fg >> 1) & 0x7f7f7f;
        }
        if (x === cursorX && y === cursorY) {
          bg = defFg;
          fg = defBg;
        }
        let cp = 0;
        if (len > 0 && len <= 64) {
          ex.ghostty_render_state_row_cells_get(cells, CELL_GRAPHEMES_BUF, vt.gbuf);
          cp = vt.dv().getUint32(vt.gbuf, true);
        }
        sink.cell(x, y, cp, fg, bg, bold);
      }
    }
    this.lastCursorRow = cursorY;
    ex.ghostty_render_state_clean(this.rs);
    this.renderMs += performance.now() - t0;
    return true;
  }
}

export interface CellSink {
  defaultBg: number;
  /** cp 가 0 이면 빈칸. 색은 0xRRGGBB */
  cell(x: number, y: number, cp: number, fg: number, bg: number, bold: boolean): void;
}
