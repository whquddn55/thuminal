// term-core Renderer 의 WebGL2 구현.
//
// - root 를 덮는 canvas 하나에 보이는 터미널을 모두 그린다 (WebGL 화면 개수 한계를 피한다).
// - 글자는 처음 나올 때 한 번만 글자 그림판(atlas) 텍스처에 그려 두고 다시 쓴다.
// - 터미널 하나를 배경 한 번 + 글자 한 번, 두 번의 draw 로 그린다.
// - 그린 결과를 남겨 두고(preserveDrawingBuffer) 바뀐 터미널만 다시 그린다.

import {
  CellFlags,
  type CellMetrics,
  type CellSink,
  type RenderTarget,
  type Renderer,
  type RendererOptions,
} from "@thuminal/term-core";

import { FS_BG, FS_FG, VS_BG, VS_FG } from "./shaders";

const ATLAS = 2048;
const WIDE_BIT = 1 << 24;
const UNDERLINE_BIT = 1 << 25;
const STRIKE_BIT = 1 << 26;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}

interface Slot {
  target: RenderTarget;
  inst: Uint32Array;
  cols: number;
  rows: number;
  buf: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  /** canvas 안에서 이 터미널 자리 (기기 픽셀, 왼쪽 위 기준) */
  rect: { x: number; y: number; w: number; h: number } | null;
  sink: CellSink;
}

class Atlas {
  readonly tex: WebGLTexture;
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly glyphs = new Map<number, number>();
  private next = 1;
  readonly cols: number;
  private readonly rowsCap: number;
  /** 그림판이 가득 차 비웠다. 모든 터미널을 다시 그려야 한다 */
  overflowed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly slotW: number,
    readonly slotH: number,
    private readonly font: (bold: boolean, italic: boolean) => string,
    private readonly baseline: number,
  ) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS, ATLAS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.cols = Math.floor(ATLAS / slotW);
    this.rowsCap = Math.floor(ATLAS / slotH);
    this.canvas = new OffscreenCanvas(slotW, slotH);
    this.ctx = this.canvas.getContext("2d")!;
  }

  slot(cp: number, flags: number): number {
    const bold = (flags & CellFlags.Bold) !== 0;
    const italic = (flags & CellFlags.Italic) !== 0;
    const wide = (flags & CellFlags.Wide) !== 0;
    const key = cp | (bold ? 1 << 21 : 0) | (italic ? 1 << 22 : 0) | (wide ? 1 << 23 : 0);
    const hit = this.glyphs.get(key);
    if (hit !== undefined) return hit;
    if (this.next >= this.cols * this.rowsCap) {
      this.glyphs.clear();
      this.next = 1;
      this.overflowed = true;
    }
    const s = this.next++;
    const g = this.ctx;
    g.clearRect(0, 0, this.slotW, this.slotH);
    g.font = this.font(bold, italic);
    g.fillStyle = "#fff";
    g.textBaseline = "alphabetic";
    const ch = String.fromCodePoint(cp);
    // 두 칸 글자(한글 등)는 대체 글꼴 폭이 두 칸보다 좁다. 두 칸 가운데에 놓는다
    const x = wide ? Math.max(0, Math.round((this.slotW - g.measureText(ch).width) / 2)) : 0;
    g.fillText(ch, x, this.baseline);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, (s % this.cols) * this.slotW, Math.floor(s / this.cols) * this.slotH, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    this.glyphs.set(key, s);
    return s;
  }
}

function overlaps(a: NonNullable<Slot["rect"]>, b: NonNullable<Slot["rect"]>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export class WebglRenderer implements Renderer {
  readonly metrics: CellMetrics;
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly bg: WebGLProgram;
  private readonly fg: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private atlas: Atlas;
  private readonly slots = new Set<Slot>();
  private dpr: number;
  /** 기기 픽셀 칸 크기 (정수) */
  private cellW = 0;
  private cellH = 0;
  private needsLayout = true;
  private readonly resizeObserver: ResizeObserver;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly root: HTMLElement,
    private readonly options: RendererOptions,
  ) {
    this.dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    // 터미널 자리(DOM)는 비어 있는 자리표시고 글자는 이 canvas 가 그린다. 그래서 맨 위 층에 두고 마우스는 통과시킨다
    Object.assign(c.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "5" });
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
    root.appendChild(c);
    this.canvas = c;
    const gl = c.getContext("webgl2", { alpha: true, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 를 쓸 수 없다");
    this.gl = gl;
    this.bg = compile(gl, VS_BG, FS_BG);
    this.fg = compile(gl, VS_FG, FS_FG);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.atlas = this.makeAtlas();
    this.metrics = { width: this.cellW / this.dpr, height: this.cellH / this.dpr };
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(root);
  }

  private font(bold: boolean, italic: boolean): string {
    return `${italic ? "italic " : ""}${bold ? "bold " : ""}${this.options.fontSize * this.dpr}px ${this.options.fontFamily}`;
  }

  private makeAtlas(): Atlas {
    const probe = new OffscreenCanvas(8, 8).getContext("2d")!;
    probe.font = this.font(false, false);
    const m = probe.measureText("M");
    // 칸 크기를 기기 픽셀 정수로 맞춘다: 배경 칸 사이 틈과 글자 번짐을 없앤다
    this.cellW = Math.max(1, Math.round(m.width));
    this.cellH = Math.max(1, Math.ceil(this.options.fontSize * this.dpr * 1.3));
    const ascent = m.fontBoundingBoxAscent ?? this.options.fontSize * this.dpr * 0.8;
    const descent = m.fontBoundingBoxDescent ?? this.options.fontSize * this.dpr * 0.2;
    const baseline = Math.round((this.cellH - (ascent + descent)) / 2 + ascent);
    return new Atlas(this.gl, this.cellW * 2, this.cellH, (b, i) => this.font(b, i), baseline);
  }

  add(target: RenderTarget): () => void {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    const slot: Slot = { target, inst: new Uint32Array(0), cols: 0, rows: 0, buf, vao, rect: null, sink: { cell: () => {} } };
    slot.sink = {
      cell: (x, y, cp, fg, bg, flags) => {
        if (x >= slot.cols || y >= slot.rows) return;
        const i = (y * slot.cols + x) * 4;
        let v = cp > 32 ? this.atlas.slot(cp, flags) : 0;
        if (flags & CellFlags.Wide) v |= WIDE_BIT;
        if (flags & CellFlags.Underline) v |= UNDERLINE_BIT;
        if (flags & CellFlags.Strikethrough) v |= STRIKE_BIT;
        slot.inst[i + 1] = v;
        slot.inst[i + 2] = fg;
        slot.inst[i + 3] = bg;
      },
    };
    this.slots.add(slot);
    target.engine.invalidate();
    this.needsLayout = true;
    return () => {
      this.slots.delete(slot);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      this.needsLayout = true;
    };
  }

  layout(): void {
    this.needsLayout = true;
  }

  private doLayout(): void {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr) {
      // 다른 배율 화면으로 옮겼다: 글자 그림판을 새 배율로 다시 만든다
      this.dpr = dpr;
      this.gl.deleteTexture(this.atlas.tex);
      this.atlas = this.makeAtlas();
      (this.metrics as { width: number; height: number }).width = this.cellW / dpr;
      (this.metrics as { width: number; height: number }).height = this.cellH / dpr;
    }
    const r = this.root.getBoundingClientRect();
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const s of this.slots) {
      const hr = s.target.host.getBoundingClientRect();
      const visible = hr.width > 0 && hr.height > 0;
      s.rect = visible
        ? { x: Math.round((hr.left - r.left) * dpr), y: Math.round((hr.top - r.top) * dpr), w: Math.round(hr.width * dpr), h: Math.round(hr.height * dpr) }
        : null;
      s.target.engine.invalidate();
    }
    this.needsLayout = false;
  }

  frame(): void {
    if (this.needsLayout || this.atlas.overflowed) {
      this.atlas.overflowed = false;
      this.doLayout();
    }
    // 낮은 층부터 그린다. 아래층이 다시 그린 자리와 겹치는 위층은 바뀐 것이 없어도 다시 그려 덮는다
    const drawn: { layer: number; rect: NonNullable<Slot["rect"]> }[] = [];
    const ordered = [...this.slots].sort((a, b) => (a.target.layer ?? 0) - (b.target.layer ?? 0));
    for (const s of ordered) {
      if (!s.rect) continue;
      const layer = s.target.layer ?? 0;
      const e = s.target.engine;
      if (s.cols !== e.cols || s.rows !== e.rows) {
        s.cols = e.cols;
        s.rows = e.rows;
        s.inst = new Uint32Array(e.cols * e.rows * 4);
        for (let y = 0; y < e.rows; y++) for (let x = 0; x < e.cols; x++) s.inst[(y * e.cols + x) * 4] = x | (y << 16);
        e.invalidate();
      }
      const changed = e.scan(s.sink);
      const covered = drawn.some((d) => d.layer < layer && overlaps(d.rect, s.rect!));
      if (!changed && !covered) continue;
      this.draw(s);
      drawn.push({ layer, rect: s.rect });
    }
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${p === this.bg ? "bg" : "fg"}:${name}`;
    if (!this.uniforms.has(key)) this.uniforms.set(key, this.gl.getUniformLocation(p, name));
    return this.uniforms.get(key)!;
  }

  private draw(s: Slot): void {
    const gl = this.gl;
    const rect = s.rect!;
    const vw = s.cols * this.cellW;
    const vh = s.rows * this.cellH;
    // 터미널 자리 전체를 기본 배경으로 칠하고(남는 가장자리 포함) 칸을 그린다
    const y = this.canvas.height - rect.y - rect.h;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, y, rect.w, rect.h);
    const bg = s.target.engine.defaultColors().bg;
    gl.clearColor(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(rect.x, this.canvas.height - rect.y - vh, vw, vh);

    gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
    gl.bufferData(gl.ARRAY_BUFFER, s.inst, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(s.vao);
    const n = s.cols * s.rows;

    gl.disable(gl.BLEND);
    gl.useProgram(this.bg);
    gl.uniform2f(this.u(this.bg, "cell"), this.cellW, this.cellH);
    gl.uniform2f(this.u(this.bg, "view"), vw, vh);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.fg);
    gl.uniform2f(this.u(this.fg, "cell"), this.cellW, this.cellH);
    gl.uniform2f(this.u(this.fg, "view"), vw, vh);
    gl.uniform2f(this.u(this.fg, "slotSize"), this.atlas.slotW, this.atlas.slotH);
    gl.uniform1f(this.u(this.fg, "atlasCols"), this.atlas.cols);
    gl.uniform1f(this.u(this.fg, "atlasSize"), ATLAS);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex);
    gl.uniform1i(this.u(this.fg, "atlas"), 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.canvas.remove();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export const webglRenderer = (root: HTMLElement, options: RendererOptions): Renderer => new WebglRenderer(root, options);
