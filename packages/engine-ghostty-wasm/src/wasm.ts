// ghostty-vt.wasm 을 불러오고 메모리를 다루는 얇은 층.
// wasm 메모리는 커질 수 있어, 메모리 보기(Uint8Array, DataView)는 쓸 때마다 새로 잡는다
// (include/ghostty/vt/wasm.h 의 Memory growth 절).

export type Exports = { memory: WebAssembly.Memory } & Record<string, (...a: number[]) => number>;

export const SUCCESS = 0;

export class Wasm {
  /** 작은 값을 주고받는 임시 칸 (512바이트) */
  readonly tmp: number;
  private scratch = 0;
  private scratchSize = 0;

  constructor(readonly ex: Exports) {
    this.tmp = ex.ghostty_wasm_alloc(512);
  }

  static async instantiate(bytes: BufferSource): Promise<Wasm> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Wasm(instance.exports as unknown as Exports);
  }

  u8(): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer);
  }

  dv(): DataView {
    return new DataView(this.ex.memory.buffer);
  }

  /** 바이트를 wasm 안으로 복사할 임시 버퍼. 모자라면 키운다 */
  scratchFor(n: number): number {
    if (n > this.scratchSize) {
      if (this.scratch) this.ex.ghostty_wasm_free(this.scratch, this.scratchSize);
      this.scratchSize = Math.max(n, 64 * 1024);
      this.scratch = this.ex.ghostty_wasm_alloc(this.scratchSize);
    }
    return this.scratch;
  }

  copyIn(bytes: Uint8Array): number {
    const p = this.scratchFor(bytes.length);
    this.u8().set(bytes, p);
    return p;
  }

  /** 핸들을 돌려주는 생성 함수를 불러 핸들 값을 꺼낸다 */
  create(call: (outPtr: number) => number, what: string): number {
    const pp = this.ex.ghostty_wasm_alloc_opaque();
    try {
      const r = call(pp);
      if (r !== SUCCESS) throw new Error(`${what} 실패 (${r})`);
      return this.ex.ghostty_wasm_take_opaque(pp);
    } finally {
      this.ex.ghostty_wasm_free_opaque(pp);
    }
  }

  /** 핸들을 담아 둘 칸. render_state_get 처럼 칸 주소를 받는 함수에 넘긴다 */
  slot(call: (outPtr: number) => number, what: string): number {
    const pp = this.ex.ghostty_wasm_alloc_opaque();
    const r = call(pp);
    if (r !== SUCCESS) throw new Error(`${what} 실패 (${r})`);
    return pp;
  }

  rgb(p: number): number {
    const u = this.u8();
    return (u[p] << 16) | (u[p + 1] << 8) | u[p + 2];
  }
}
