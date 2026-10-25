// 세션 하나를 화면에 잇는 일을 맡는다. React 와 상관없이 쓸 수 있다.
//
// - open(): 데몬 세션에 붙어 앱 엔진을 만든다. 탭이 열려 있는 동안 엔진은 계속 출력을 받는다.
// - show(host): 렌더러에 그릴 대상으로 더하고 입력을 받는다. hide() 로 그리기만 멈춘다.
//   탭을 바꿀 때 데몬에서 떨어졌다 다시 붙지 않는다.
// - 분할한 칸이 여럿 보여도 키보드는 focus() 를 부른 칸 하나만 받는다.

import type { Attachment, CellPoint, EngineColors, Renderer, SessionId, SessionInfo, TerminalEngine } from "@thuminal/term-core";

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
  /** 조합 시작 수 - 끝 수. WebKit 은 한글에서 다음 글자 조합 시작이 앞 글자 조합 끝보다 먼저 오기도 해서 수로 센다 */
  private composing = 0;

  private disposed = false;
  private wheelAcc = 0;
  private dragFrom: CellPoint | null = null;
  private dragged = false;
  private cleanup: (() => void)[] = [];
  private colors: EngineColors | null = null;
  /** 칸을 누르거나 입력을 받으면 부른다 (화면이 이 칸을 포커스 칸으로 삼는다) */
  onActivate: (() => void) | null = null;

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
      // 앞 글자가 확정되어 커서가 움직였다. IME 후보 창 자리도 옮긴다 (커서 자리는 다음 그리기 때 바뀐다)
      if (this.composing > 0) setTimeout(() => this.placeInput(), 34);
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
    if (this.colors) e.setColors(this.colors);
    for (const chunk of this.pending) e.feed(chunk);
    this.pending = [];
    this.engine = e;
    if (this.host) this.show(this.host, undefined, this.layer);
  }

  /** 화면에 보인다. 엔진이 아직 없으면 붙은 뒤 보인다 */
  show(host: HTMLElement, renderer?: Renderer, layer = 0): void {
    if (renderer) this.renderer = renderer;
    this.host = host;
    this.layer = layer;
    if (!this.engine || !this.renderer || this.unrender) return;
    this.unrender = this.renderer.add({ host, engine: this.engine, layer });
    this.mountInput(host);
    this.resizeObs = new ResizeObserver(() => this.scheduleFit());
    this.resizeObs.observe(host);
    this.fit();
  }

  private renderer: Renderer | null = null;
  /** 겹칠 때 그릴 차례 (팝업 안 터미널은 1) */
  private layer = 0;

  hide(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
    this.unrender?.();
    this.unrender = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.textarea?.remove();
    this.textarea = null;
    this.engine?.setPreedit(null);
    this.composing = 0;
    this.host = null;
  }

  focus(): void {
    this.wantFocus = true;
    this.textarea?.focus({ preventScroll: true });
  }

  blur(): void {
    this.wantFocus = false;
    this.textarea?.blur();
  }

  private wantFocus = false;

  /** 테마 색. 엔진이 아직 없으면 붙은 뒤 넣는다 */
  setColors(c: EngineColors | null): void {
    this.colors = c;
    if (c) this.engine?.setColors(c);
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
      if (ev.detail >= 3) {
        this.engine.selectLine(at);
        this.dragFrom = null;
      } else if (ev.detail === 2) {
        this.engine.selectWord(at);
        this.dragFrom = null;
      } else {
        this.dragFrom = at;
        this.dragged = false;
      }
      this.onActivate?.();
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

    // textarea 를 비운다. 조합 중이면 조합이 모두 끝난 뒤에 비운다
    const settle = () =>
      setTimeout(() => {
        if (this.composing > 0) return;
        this.engine?.setPreedit(null);
        ta.value = "";
      });
    ta.addEventListener("keydown", (ev) => {
      // 조합 중(한글 등)인 키는 IME 에 맡긴다
      if (ev.isComposing || ev.keyCode === 229) return;
      if (this.macEditKey(ev)) {
        ev.preventDefault();
        return;
      }
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
        // Enter·방향키 같은 키는 조합을 끝내므로 여기서 textarea 를 비운다
        settle();
      }
    });
    // 조합 중인 글자는 엔진에 넘겨 다른 글자와 같은 글꼴·색으로 커서 자리에 밑줄을 그어 그린다.
    // compositionend 때 textarea 를 바로 비우면 WebKit 에서는 막 시작한 다음 글자 조합까지 지워져
    // "가나다라" 를 치는 동안 앞 글자까지만 보였다. textarea 는 조합이 모두 끝난 뒤에 비운다
    ta.addEventListener("compositionstart", () => {
      this.composing++;
      this.placeInput();
    });
    ta.addEventListener("compositionupdate", (ev) => {
      this.engine?.setPreedit(ev.data);
      this.placeInput();
    });
    ta.addEventListener("compositionend", (ev) => {
      this.composing = Math.max(0, this.composing - 1);
      // 확정한 글자는 셸이 되돌려 보낼 때 그려진다. 그 사이 같은 글자가 두 번 보이지 않게 조합 글자를 먼저 지운다
      if (this.composing === 0) this.engine?.setPreedit(null);
      if (ev.data) this.send(enc.encode(ev.data));
      settle();
    });
    ta.addEventListener("input", (ev) => {
      const ie = ev as InputEvent;
      if (this.composing > 0 || ie.isComposing) return;
      // WKWebView 는 조합 이벤트 없이 앞 글자를 바꿔 쓰기도 한다 (xterm.js #5704).
      // 바뀐 글자 수만큼 지우고 새 글자를 보낸다
      if (ie.inputType === "insertReplacementText" && ie.data) {
        this.send(new Uint8Array([0x7f]));
        this.send(enc.encode(ie.data));
      } else if (ie.inputType === "insertText" && ie.data) {
        this.send(enc.encode(ie.data));
      }
      // 한글 입력기는 조합 이벤트 없이 앞 글자를 바꿔 쓰기도 한다 (ㅇ → 아 → 안). 글이 들어올 때마다 비우면 입력기가
      // 앞 글자를 잃어 자모가 하나씩 따로 확정된다 (ㅇㅏㄴ). 그래서 글이 길어졌을 때만 비운다
      if (ta.value.length > 64) settle();
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
    ta.addEventListener("focus", () => this.onActivate?.());
    this.mountMouse(host);
    if (this.wantFocus) this.focus();
  }

  /** IME 후보 창이 커서 옆에 뜨게 textarea 를 커서 자리로 옮긴다 */
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

  /**
   * macOS 편집 키를 셸이 아는 키로 바꿔 보낸다 (Orca 와 같다).
   * ⌘⌫ 줄 앞 지우기, ⌘⌦ 줄 뒤 지우기, ⌘← ⌘→ 줄 처음·끝, ⌘↑ ⌘↓ 스크롤 맨 위·아래,
   * ⌥← ⌥→ 단어 이동, ⌥⌫ 단어 지우기, ⌃⌫ 단어 지우기. 처리했으면 true
   */
  private macEditKey(ev: KeyboardEvent): boolean {
    const only = (m: "meta" | "alt" | "ctrl") =>
      ev.metaKey === (m === "meta") && ev.altKey === (m === "alt") && ev.ctrlKey === (m === "ctrl") && !ev.shiftKey;
    const map: [boolean, string, string | (() => void)][] = [
      [only("meta"), "Backspace", "\x15"],
      [only("meta"), "Delete", "\x0b"],
      [only("meta"), "ArrowLeft", "\x01"],
      [only("meta"), "ArrowRight", "\x05"],
      [only("meta"), "ArrowUp", () => this.engine?.scroll(-1_000_000)],
      [only("meta"), "ArrowDown", () => this.engine?.scrollToBottom()],
      [only("alt"), "ArrowLeft", "\x1bb"],
      [only("alt"), "ArrowRight", "\x1bf"],
      [only("alt"), "Backspace", "\x1b\x7f"],
      [only("ctrl"), "Backspace", "\x17"],
    ];
    const hit = map.find(([mods, key]) => mods && ev.key === key);
    if (!hit) return false;
    const act = hit[2];
    if (typeof act === "string") this.send(enc.encode(act));
    else act();
    return true;
  }

  /** 앱 쪽에서 글을 보낸다 (명령 팔레트 등) */
  sendText(text: string) {
    this.send(enc.encode(text));
  }

  /** 붙여넣기처럼 보낸다 (bracketed paste 모드면 감싼다) */
  paste(text: string) {
    if (text && this.engine) this.send(this.engine.input.paste(text));
  }

  hasSelection(): boolean {
    return !!this.engine?.selectionText();
  }

  copySelection(): void {
    const text = this.engine?.selectionText();
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  selectAll(): void {
    this.engine?.selectAll();
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
