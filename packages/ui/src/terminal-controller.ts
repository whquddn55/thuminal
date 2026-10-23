// 세션 하나를 화면에 잇는 일을 맡는다. React 와 상관없이 쓸 수 있다.
//
// - open(): 데몬 세션에 붙어 앱 엔진을 만든다. 탭이 열려 있는 동안 엔진은 계속 출력을 받는다.
// - show(host): 렌더러에 그릴 대상으로 더하고 입력을 받는다. hide() 로 그리기만 멈춘다.
//   탭을 바꿀 때 데몬에서 떨어졌다 다시 붙지 않는다.

import type { Attachment, CellPoint, Renderer, SessionId, SessionInfo, TerminalEngine } from "@thuminal/term-core";

import type { Services } from "./services";

const enc = new TextEncoder();

export class TerminalController {
  engine: TerminalEngine | null = null;
  session: SessionInfo | null = null;
  private attachment: Attachment | null = null;
  private pending: Uint8Array[] = [];
  private unrender: (() => void) | null = null;
  private host: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private resizeTimer = 0;
  private composing = false;
  private disposed = false;
  private wheelAcc = 0;
  private dragFrom: CellPoint | null = null;
  private dragged = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly s: Services,
    readonly id: SessionId,
  ) {}

  /** 데몬 세션에 붙는다. 같은 엔진이면 고유 저장본으로, 아니면 VT 저장본으로 */
  async open(): Promise<void> {
    const { host, engines, scrollback } = this.s;
    const daemon = await host.daemon();
    const onOutput = (bytes: Uint8Array) => {
      if (this.engine) this.engine.feed(bytes);
      else this.pending.push(bytes);
    };
    const opts = (a: Attachment) => ({ cols: a.session.cols, rows: a.session.rows, scrollback });

    if (engines.restore && engines.nativeSnapshotOf === daemon.engine) {
      const a = await host.attach(this.id, "native", onOutput);
      const restored = engines.restore(a.snapshot, opts(a));
      if (restored) {
        this.attached(a, restored);
        return;
      }
      // 데몬과 앱의 엔진 버전이 달라 저장본을 못 읽었다. VT 로 다시 붙는다
      await a.detach();
      this.pending = [];
    }
    const a = await host.attach(this.id, "vt", onOutput);
    const e = engines.create(opts(a));
    e.feed(a.snapshot);
    this.attached(a, e);
  }

  private attached(a: Attachment, e: TerminalEngine) {
    if (this.disposed) {
      void a.detach();
      e.dispose();
      return;
    }
    this.attachment = a;
    this.session = a.session;
    for (const chunk of this.pending) e.feed(chunk);
    this.pending = [];
    this.engine = e;
    if (this.host) this.show(this.host);
  }

  /** 화면에 보인다. 엔진이 아직 없으면 붙은 뒤 보인다 */
  show(host: HTMLElement, renderer?: Renderer): void {
    if (renderer) this.renderer = renderer;
    this.host = host;
    if (!this.engine || !this.renderer || this.unrender) return;
    this.unrender = this.renderer.add({ host, engine: this.engine });
    this.mountInput(host);
    this.resizeObs = new ResizeObserver(() => this.scheduleFit());
    this.resizeObs.observe(host);
    this.fit();
  }

  private renderer: Renderer | null = null;

  hide(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
    this.unrender?.();
    this.unrender = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.textarea?.remove();
    this.textarea = null;
    this.host = null;
  }

  focus(): void {
    this.textarea?.focus({ preventScroll: true });
  }

  private scheduleFit() {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.fit(), 50);
  }

  /** 자리 크기에 맞춰 열과 줄 수를 정하고 엔진과 데몬 세션 크기를 바꾼다 */
  private fit(): void {
    if (!this.host || !this.engine || !this.renderer) return;
    const { width, height } = this.renderer.metrics;
    const r = this.host.getBoundingClientRect();
    const cols = Math.max(2, Math.floor(r.width / width));
    const rows = Math.max(2, Math.floor(r.height / height));
    if (cols === this.engine.cols && rows === this.engine.rows) return;
    this.engine.resize(cols, rows);
    this.renderer.layout();
    void this.s.host.resize(this.id, cols, rows);
  }

  private send(bytes: Uint8Array | null) {
    if (!bytes || !bytes.length) return;
    // 입력하면 맨 아래(지금 화면)로 돌아간다
    this.engine?.scrollToBottom();
    void this.s.host.input(this.id, bytes);
  }

  private cellAt(ev: MouseEvent): CellPoint | null {
    if (!this.host || !this.renderer) return null;
    const r = this.host.getBoundingClientRect();
    const { width, height } = this.renderer.metrics;
    return { x: Math.floor((ev.clientX - r.left) / width), y: Math.floor((ev.clientY - r.top) / height) };
  }

  /** 휠로 스크롤백을 보고, 끌어서 고르고, 두 번 눌러 단어를 고른다 */
  private mountMouse(host: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, k: K, f: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(k, f as EventListener);
      this.cleanup.push(() => t.removeEventListener(k, f as EventListener));
    };
    on(host, "wheel", (ev) => {
      if (!this.engine || !this.renderer) return;
      ev.preventDefault();
      this.wheelAcc += ev.deltaY;
      const lines = Math.trunc(this.wheelAcc / this.renderer.metrics.height);
      if (lines) {
        this.wheelAcc -= lines * this.renderer.metrics.height;
        this.engine.scroll(lines);
      }
    });
    on(host, "mousedown", (ev) => {
      if (ev.button !== 0 || !this.engine) return;
      const at = this.cellAt(ev);
      if (!at) return;
      if (ev.detail === 2) {
        this.engine.selectWord(at);
        this.dragFrom = null;
      } else {
        this.dragFrom = at;
        this.dragged = false;
      }
      setTimeout(() => this.focus());
    });
    on(window, "mousemove", (ev) => {
      if (!this.dragFrom || !this.engine || !(ev.buttons & 1)) return;
      const at = this.cellAt(ev);
      if (!at) return;
      this.dragged = true;
      this.engine.select(this.dragFrom, at);
    });
    on(window, "mouseup", () => {
      if (this.dragFrom && !this.dragged) this.engine?.clearSelection();
      this.dragFrom = null;
    });
  }

  /** 보이지 않는 textarea 로 키보드와 한글 조합 입력을 받는다 */
  private mountInput(host: HTMLElement) {
    const ta = document.createElement("textarea");
    ta.className = "thm-input";
    ta.autocapitalize = "off";
    ta.autocomplete = "off";
    ta.spellcheck = false;
    ta.setAttribute("autocorrect", "off");
    host.appendChild(ta);
    this.textarea = ta;

    ta.addEventListener("keydown", (ev) => {
      // 조합 중(한글 등)인 키는 IME 에 맡긴다
      if (ev.isComposing || ev.keyCode === 229) return;
      const bytes = this.engine?.input.key({
        key: ev.key,
        code: ev.code,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        meta: ev.metaKey,
      });
      if (bytes) {
        ev.preventDefault();
        this.send(bytes);
      }
    });
    ta.addEventListener("compositionstart", () => {
      this.composing = true;
      this.placeInput();
      ta.classList.add("composing");
    });
    ta.addEventListener("compositionend", (ev) => {
      this.composing = false;
      ta.classList.remove("composing");
      if (ev.data) this.send(enc.encode(ev.data));
      ta.value = "";
    });
    ta.addEventListener("input", (ev) => {
      const ie = ev as InputEvent;
      if (this.composing) return;
      // WKWebView 는 조합 이벤트 없이 앞 글자를 바꿔 쓰기도 한다 (xterm.js #5704).
      // 바뀐 글자 수만큼 지우고 새 글자를 보낸다
      if (ie.inputType === "insertReplacementText" && ie.data) {
        this.send(new Uint8Array([0x7f]));
        this.send(enc.encode(ie.data));
      } else if (ie.inputType === "insertText" && ie.data) {
        this.send(enc.encode(ie.data));
      }
      ta.value = "";
    });
    ta.addEventListener("paste", (ev) => {
      ev.preventDefault();
      const text = ev.clipboardData?.getData("text/plain");
      if (text && this.engine) this.send(this.engine.input.paste(text));
    });
    // Cmd+C: 고른 글자를 복사한다 (textarea 의 copy 이벤트로 받아 클립보드 권한이 필요 없다)
    ta.addEventListener("copy", (ev) => {
      const text = this.engine?.selectionText();
      if (!text) return;
      ev.preventDefault();
      ev.clipboardData?.setData("text/plain", text);
    });
    this.mountMouse(host);
    this.focus();
  }

  /** 조합 중인 글자가 커서 자리에 보이게 textarea 를 옮긴다 */
  private placeInput() {
    if (!this.textarea || !this.engine || !this.renderer) return;
    const c = this.engine.cursor();
    const { width, height } = this.renderer.metrics;
    Object.assign(this.textarea.style, {
      left: `${c.x * width}px`,
      top: `${c.y * height}px`,
      height: `${height}px`,
      lineHeight: `${height}px`,
      fontSize: `${this.s.rendererOptions.fontSize}px`,
      fontFamily: this.s.rendererOptions.fontFamily,
    });
  }

  /** 앱 쪽에서 글을 보낸다 (명령 팔레트 등) */
  sendText(text: string) {
    this.send(enc.encode(text));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.hide();
    // 데몬이 이미 내려갔으면 떨어지기가 실패한다. 상관없다
    await this.attachment?.detach().catch(() => {});
    this.engine?.dispose();
    this.engine = null;
  }
}
