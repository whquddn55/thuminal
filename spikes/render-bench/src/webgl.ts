// WebGL2 렌더러: 창 전체를 덮는 canvas 하나에 보이는 터미널을 모두 그린다.
//
// - 글자는 처음 나올 때 한 번만 글자 그림판(atlas) 텍스처에 그려 두고 다시 쓴다.
// - 칸 하나를 인스턴스 하나로 올리고, 터미널 하나를 배경 한 번 + 글자 한 번, 두 번의 draw 로 그린다.
// - 그린 결과를 남겨 두고(preserveDrawingBuffer) 바뀐 터미널만 다시 그린다.

import type { CellMetrics, CellSink, GhosttyPane } from "./ghostty";

const ATLAS = 2048;

const VS_BG = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in uvec4 inst;
uniform vec2 cell;
uniform vec2 view;
out vec4 vColor;
vec4 rgb(uint c) { return vec4(float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u), 255.0) / 255.0; }
void main() {
  vec2 p = (vec2(float(inst.x & 0xffffu), float(inst.x >> 16)) + corner) * cell;
  vec2 ndc = p / view * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vColor = rgb(inst.w);
}`;

const FS_BG = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 o;
void main() { o = vColor; }`;

const VS_FG = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in uvec4 inst;
uniform vec2 cell;
uniform vec2 view;
uniform vec2 slotSize;
uniform float atlasCols;
uniform float atlasSize;
out vec4 vColor;
out vec2 vUv;
vec4 rgb(uint c) { return vec4(float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u), 255.0) / 255.0; }
void main() {
  uint slot = inst.y & 0xffffffu;
  if (slot == 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float wide = float((inst.y >> 24) & 1u) + 1.0;
  vec2 c = corner * vec2(wide, 1.0);
  vec2 p = (vec2(float(inst.x & 0xffffu), float(inst.x >> 16)) + c) * cell;
  vec2 ndc = p / view * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  float s = float(slot);
  vec2 origin = vec2(mod(s, atlasCols), floor(s / atlasCols)) * slotSize;
  vUv = (origin + c * cell) / atlasSize;
  vColor = rgb(inst.z);
}`;

const FS_FG = `#version 300 es
precision mediump float;
uniform sampler2D atlas;
in vec4 vColor;
in vec2 vUv;
out vec4 o;
void main() { o = vec4(vColor.rgb, texture(atlas, vUv).a); }`;

// 한글, 한자, 전각, 이모지처럼 두 칸을 쓰는 글자 (시제품용 근사)
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}

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

interface GlPane {
  pane: GhosttyPane;
  host: HTMLElement;
  inst: Uint32Array;
  buf: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  sink: CellSink;
}

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly bg: WebGLProgram;
  private readonly fg: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly atlas: WebGLTexture;
  private readonly glyphCanvas: OffscreenCanvas;
  private readonly glyphCtx: OffscreenCanvasRenderingContext2D;
  private readonly glyphs = new Map<number, number>();
  private nextSlot = 1;
  private readonly cellW: number;
  private readonly cellH: number;
  private readonly slotW: number;
  private readonly atlasCols: number;
  private readonly dpr: number;
  private readonly panes: GlPane[] = [];

  constructor(
    over: HTMLElement,
    private readonly m: CellMetrics,
  ) {
    this.dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    const r = over.getBoundingClientRect();
    Object.assign(c.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      pointerEvents: "none",
    });
    c.width = Math.round(r.width * this.dpr);
    c.height = Math.round(r.height * this.dpr);
    document.body.appendChild(c);
    this.canvas = c;
    const gl = c.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true })!;
    this.gl = gl;

    this.cellW = m.w * this.dpr;
    this.cellH = m.h * this.dpr;
    this.slotW = Math.ceil(this.cellW * 2);
    this.atlasCols = Math.floor(ATLAS / this.slotW);

    this.bg = compile(gl, VS_BG, FS_BG);
    this.fg = compile(gl, VS_FG, FS_FG);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS, ATLAS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.glyphCanvas = new OffscreenCanvas(this.slotW, Math.ceil(this.cellH));
    this.glyphCtx = this.glyphCanvas.getContext("2d")!;
    this.glyphCtx.textBaseline = "top";
    this.glyphCtx.fillStyle = "#fff";

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** 글자 그림판에서 글자 자리를 찾고, 없으면 그려 넣는다 */
  private slot(cp: number, bold: boolean): number {
    const key = cp | (bold ? 1 << 21 : 0);
    let s = this.glyphs.get(key);
    if (s !== undefined) return s;
    s = this.nextSlot++;
    const g = this.glyphCtx;
    g.clearRect(0, 0, this.slotW, this.glyphCanvas.height);
    g.font = `${bold ? "bold " : ""}${this.m.font.replace(/^(\d+(?:\.\d+)?)px/, (_, n) => `${Number(n) * this.dpr}px`)}`;
    g.fillText(String.fromCodePoint(cp), 0, this.dpr);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      (s % this.atlasCols) * this.slotW,
      Math.floor(s / this.atlasCols) * Math.ceil(this.cellH),
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.glyphCanvas,
    );
    this.glyphs.set(key, s);
    return s;
  }

  add(pane: GhosttyPane, host: HTMLElement): void {
    const gl = this.gl;
    const inst = new Uint32Array(pane.cols * pane.rows * 4);
    // 칸 위치는 고정이라 처음에 한 번 채운다
    for (let y = 0; y < pane.rows; y++)
      for (let x = 0; x < pane.cols; x++) inst[(y * pane.cols + x) * 4] = x | (y << 16);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
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

    const cols = pane.cols;
    const sink: CellSink = {
      defaultBg: 0,
      cell: (x, y, cp, fg, bg, bold) => {
        const i = (y * cols + x) * 4;
        inst[i + 1] = cp && cp !== 0x20 ? this.slot(cp, bold) | (isWide(cp) ? 1 << 24 : 0) : 0;
        inst[i + 2] = fg;
        inst[i + 3] = bg;
      },
    };
    this.panes.push({ pane, host, inst, buf, vao, sink });
  }

  /** 바뀐 터미널만 다시 그린다 */
  frame(): void {
    const gl = this.gl;
    const base = this.canvas.getBoundingClientRect();
    for (const p of this.panes) {
      if (!p.pane.scan(p.sink)) continue;
      const r = p.host.getBoundingClientRect();
      const vw = p.pane.cols * this.cellW;
      const vh = p.pane.rows * this.cellH;
      const x = Math.round((r.left - base.left) * this.dpr);
      const y = this.canvas.height - Math.round((r.top - base.top) * this.dpr) - Math.round(vh);
      gl.viewport(x, y, Math.round(vw), Math.round(vh));
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.inst);
      gl.bindVertexArray(p.vao);
      const n = p.pane.cols * p.pane.rows;

      gl.disable(gl.BLEND);
      gl.useProgram(this.bg);
      gl.uniform2f(gl.getUniformLocation(this.bg, "cell"), this.cellW, this.cellH);
      gl.uniform2f(gl.getUniformLocation(this.bg, "view"), Math.round(vw), Math.round(vh));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.fg);
      gl.uniform2f(gl.getUniformLocation(this.fg, "cell"), this.cellW, this.cellH);
      gl.uniform2f(gl.getUniformLocation(this.fg, "view"), Math.round(vw), Math.round(vh));
      gl.uniform2f(gl.getUniformLocation(this.fg, "slotSize"), this.slotW, Math.ceil(this.cellH));
      gl.uniform1f(gl.getUniformLocation(this.fg, "atlasCols"), this.atlasCols);
      gl.uniform1f(gl.getUniformLocation(this.fg, "atlasSize"), ATLAS);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    }
  }
}
