// 세션 하나를 화면에 잇는 일을 맡는다. React 와 상관없이 쓸 수 있다.
//
// - open(): 데몬 세션에 붙어 앱 엔진을 만든다. 탭이 열려 있는 동안 엔진은 계속 출력을 받는다.
// - show(host): 렌더러에 그릴 대상으로 더하고 입력을 받는다. hide() 로 그리기만 멈춘다.
//   탭을 바꿀 때 데몬에서 떨어졌다 다시 붙지 않는다.
// - 분할한 칸이 여럿 보여도 키보드는 focus() 를 부른 칸 하나만 받는다.

import type { Attachment, CellPoint, EngineColors, Renderer, SessionId, SessionInfo, TerminalEngine } from "@thuminal/term-core";

import { HangulComposer, isJamo } from "./hangul";
import type { Services } from "./services";
import { type LinkHandler, LinkHover } from "./terminal-link-hover";

const enc = new TextEncoder();
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Process", "Unidentified"]);
/**
 * 마우스를 받는 프로그램에 마우스 휠 한 칸으로 보내는 휠 신호 수: 쉬었다 굴린 한 칸, 이어서 굴리는 동안 한 칸.
 * 빨리 굴릴 때의 가속은 프로그램이 한다 (claude 는 40ms 안에 이어 오는 신호를 최대 6배까지 키운다)
 */
const WHEEL_NOTCH_REPORTS = 5;
const WHEEL_NOTCH_RAPID_REPORTS = 3;

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
  /** 입력기가 붙지 않아 자모가 그대로 올 때 직접 묶는 조합기 (hangul.ts) */
  private hangul = new HangulComposer();

  private disposed = false;
  private wheelAcc = 0;
  /** 프로그램에 보낼 휠의 남은 줄 (xterm.js 의 _wheelPartialScroll) */
  private wheelPartial = 0;
  private lastWheelReport = 0;
  /** 프로그램에 누름을 보낸 버튼 (떼기·끌기도 프로그램에 보낸다) */
  private mouseButton: 0 | 1 | null = null;
  private lastMouseCell: CellPoint | null = null;
  private dragFrom: CellPoint | null = null;
  private dragged = false;
  private cleanup: (() => void)[] = [];
  /** 터미널 링크를 확인하고 여는 곳 (앱 상태가 넣는다) */
  links: LinkHandler | null = null;
  /** 이 세션에 에이전트(claude 등)가 떠 있다 (앱 상태가 넣는다) */
  isAgent: (() => boolean) | null = null;
  private linkHover: LinkHover | null = null;
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
    this.daemonSize = { cols, rows };
    void this.s.host.resize(this.id, cols, rows);
  }

  private send(bytes: Uint8Array | null) {
    if (!bytes || !bytes.length) return;
    // 입력하면 맨 아래(지금 화면)로 돌아간다
    this.engine?.scrollToBottom();
    this.claimSize();
    void this.s.host.input(this.id, bytes);
  }

  /** 데몬 세션 크기. 다른 화면(폰·다른 창)이 바꾸면 화면 모델이 알려 준다 */
  private daemonSize: { cols: number; rows: number } | null = null;

  noteSize(cols: number, rows: number) {
    this.daemonSize = { cols, rows };
  }

  /** 세션 크기를 다른 화면이 바꿔 두었으면 이 칸 크기로 되돌린다. 마지막으로 입력한 화면 크기를 따른다 (tmux window-size latest) */
  claimSize() {
    const e = this.engine;
    const d = this.daemonSize;
    if (!e || !d || !this.host || (d.cols === e.cols && d.rows === e.rows)) return;
    this.daemonSize = { cols: e.cols, rows: e.rows };
    void this.s.host.resize(this.id, e.cols, e.rows);
  }

  /** 다른 화면이 세션 크기를 바꿔 이 칸과 다르게 그려지고 있는지 */
  get sizeTaken(): boolean {
    const e = this.engine;
    const d = this.daemonSize;
    return !!e && !!d && (d.cols !== e.cols || d.rows !== e.rows);
  }

  /** 키 하나를 보낸다 (폰 키 줄). 커서 키 모드 등은 엔진이 맞춘다 */
  sendKey(key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
    // 엔진은 물리 키(code)로 바꾼다: 글자는 KeyA, 숫자는 Digit1, 나머지(ArrowUp, Escape, Tab …)는 이름 그대로
    const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
    const bytes = this.engine?.input.key({ key, code, ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift, meta: false });
    this.send(bytes ?? null);
  }

  /**
   * 마우스 휠 이벤트 하나. claude·vim·less 처럼 마우스를 받거나 대체 화면을 쓰는 프로그램은 스크롤백이 없어
   * 그 프로그램에 넘기고, 아니면 스크롤백을 픽셀만큼 움직인다.
   *
   * 프로그램에 넘길 때는 줄 수를 xterm.js 처럼 세되(작은 움직임은 0.3배) 이벤트 하나에 한 번만 움직인다.
   * 마우스 휠 한 칸은 휠 신호 여럿(WHEEL_NOTCH_REPORTS), 트랙패드 이벤트는 하나를 보낸다. 빨리 굴릴 때의 가속은
   * 프로그램에 맡긴다. 픽셀만큼 신호를 몰아 보내면 claude 가 신호마다 가속해 트랙패드로 한 번 쓸어도 천 줄씩 날아갔다
   */
  private onWheel(ev: WheelEvent) {
    if (!this.engine || !this.renderer) return;
    const h = this.renderer.metrics.height;
    const px = ev.deltaMode === 1 ? ev.deltaY * h : ev.deltaMode === 2 ? ev.deltaY * this.engine.rows * h : ev.deltaY;
    const at = this.cellAt(ev) ?? { x: 0, y: 0 };
    const one = px ? this.engine.input.wheel(px < 0, at) : null;
    if (!one) {
      this.wheelAcc += px;
      const lines = Math.trunc(this.wheelAcc / h);
      if (lines) {
        this.wheelAcc -= lines * h;
        this.engine.scroll(lines);
      }
      return;
    }
    // 마우스 휠 한 칸은 120px(줄 단위 휠도 있다), 트랙패드는 이벤트마다 수 px 로 촘촘히 온다
    const notch = ev.deltaMode !== 0 || Math.abs(ev.deltaY) >= 50;
    let l = px / h;
    if (!notch) l *= 0.3;
    if (Math.sign(l) !== Math.sign(this.wheelPartial)) this.wheelPartial = 0;
    this.wheelPartial += l;
    if (Math.abs(this.wheelPartial) < 1) return;
    this.wheelPartial %= 1;
    const now = performance.now();
    const rested = now - this.lastWheelReport > 40;
    const n = notch ? (rested ? WHEEL_NOTCH_REPORTS : WHEEL_NOTCH_RAPID_REPORTS) : 1;
    this.lastWheelReport = now;
    const out = new Uint8Array(one.length * n);
    for (let i = 0; i < n; i++) out.set(one, i * one.length);
    this.send(out);
  }

  /** 손가락으로 끈 줄 수. 프로그램에는 줄마다 휠 신호 하나(1줄)를 보내 손가락을 그대로 따라가게 한다 */
  private touchScroll(lines: number, at: CellPoint | null) {
    if (!this.engine) return;
    const one = this.engine.input.wheel(lines < 0, at ?? { x: 0, y: 0 });
    if (!one) {
      this.engine.scroll(lines);
      return;
    }
    const n = Math.min(Math.abs(lines), 50);
    const out = new Uint8Array(one.length * n);
    for (let i = 0; i < n; i++) out.set(one, i * one.length);
    this.send(out);
  }

  /** 프로그램이 마우스를 받으면 보고를 보낸다. 보냈으면 true */
  private reportMouse(action: "press" | "release" | "move", button: 0 | 1 | 2 | null, ev: MouseEvent): boolean {
    if (!this.engine) return false;
    const at = this.cellAt(ev);
    if (!at) return false;
    const bytes = this.engine.input.mouse({ action, button, at, shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey });
    if (!bytes) return false;
    this.lastMouseCell = at;
    this.send(bytes);
    return true;
  }

  private cellAt(ev: { clientX: number; clientY: number }): CellPoint | null {
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
      ev.preventDefault();
      this.onWheel(ev);
    });
    // ⌘ 를 누른 채 올린 링크 (⌘+클릭 기본 앱, ⌘⇧+클릭 thuminal 안)
    const links = new LinkHover(host, () => this.engine, () => this.links);
    this.linkHover = links;
    this.cleanup.push(() => {
      links.dispose();
      if (this.linkHover === links) this.linkHover = null;
    });
    let mouse: MouseEvent | null = null;
    const inside = (ev: MouseEvent) => {
      const r = host.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom;
    };
    const hover = (meta: boolean) => links.update(mouse && inside(mouse) ? this.cellAt(mouse) : null, meta);
    on(window, "mousemove", (ev) => {
      mouse = ev;
      hover(ev.metaKey);
    });
    on(host, "mouseleave", () => links.clear());
    on(window, "keydown", (ev) => ev.key === "Meta" && hover(true));
    on(window, "keyup", (ev) => ev.key === "Meta" && hover(false));
    on(window, "blur", () => links.clear());
    // 손가락으로 끌면 스크롤백을 보고, 그냥 누르면 키보드를 띄운다 (폰)
    let touchY: number | null = null;
    let touchMoved = false;
    on(host, "touchstart", (ev) => {
      if (ev.touches.length !== 1) return;
      touchY = ev.touches[0].clientY;
      touchMoved = false;
    });
    on(host, "touchmove", (ev) => {
      if (touchY === null || !this.engine || !this.renderer || ev.touches.length !== 1) return;
      ev.preventDefault();
      const t = ev.touches[0];
      this.wheelAcc += touchY - t.clientY;
      touchY = t.clientY;
      const lines = Math.trunc(this.wheelAcc / this.renderer.metrics.height);
      if (lines) {
        touchMoved = true;
        this.wheelAcc -= lines * this.renderer.metrics.height;
        this.touchScroll(lines, this.cellAt(t));
      }
    });
    on(host, "touchend", (ev) => {
      if (touchY === null) return;
      touchY = null;
      if (touchMoved) return;
      // 누른 것은 키보드를 띄우는 것으로 받는다 (뒤따르는 mousedown 은 고르기를 지운다)
      ev.preventDefault();
      this.claimSize();
      this.onActivate?.();
      this.focus();
    });
    // 마우스를 받는 프로그램(claude 등)에는 누르기·떼기·끌기를 넘긴다. Shift 나 ⌥ 를 누르고 끌면 앱이 글을 고른다 (xterm.js 와 같다)
    on(host, "mousedown", (ev) => {
      if ((ev.button !== 0 && ev.button !== 1) || !this.engine) return;
      const at = this.cellAt(ev);
      if (!at) return;
      if (links.click(at, ev)) {
        ev.preventDefault();
        return;
      }
      if (!ev.shiftKey && !ev.altKey && this.reportMouse("press", ev.button, ev)) {
        ev.preventDefault();
        this.mouseButton = ev.button;
        this.engine.clearSelection();
        this.dragFrom = null;
        this.onActivate?.();
        setTimeout(() => this.focus());
        return;
      }
      if (ev.button !== 0) return;
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
      this.claimSize();
      setTimeout(() => this.focus());
    });
    on(window, "mousemove", (ev) => {
      if (this.mouseButton !== null || host.contains(ev.target as Node)) {
        // 같은 칸 안에서 움직인 것은 보내지 않는다
        const at = this.cellAt(ev);
        const moved = at && (at.x !== this.lastMouseCell?.x || at.y !== this.lastMouseCell?.y);
        if (moved && this.dragFrom === null) {
          if (this.mouseButton !== null) this.reportMouse("move", this.mouseButton, ev);
          else if (!ev.buttons) this.reportMouse("move", null, ev);
        }
        if (this.mouseButton !== null) return;
      }
      if (!this.dragFrom || !this.engine || !(ev.buttons & 1)) return;
      const at = this.cellAt(ev);
      if (!at) return;
      this.dragged = true;
      this.engine.select(this.dragFrom, at);
    });
    on(window, "mouseup", (ev) => {
      if (this.mouseButton !== null) {
        this.reportMouse("release", this.mouseButton, ev);
        this.mouseButton = null;
        return;
      }
      if (this.dragFrom && !this.dragged) this.engine?.clearSelection();
      this.dragFrom = null;
    });
  }

  /** 직접 묶던 한글 글자를 확정해 보낸다 */
  private flushHangul() {
    const out = this.hangul.flush();
    if (!out) return;
    this.engine?.setPreedit(null);
    this.send(enc.encode(out));
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

    // 안드로이드 키보드는 빈 글 칸에서 지우기를 누르면 아무 이벤트도 내지 않는다 (지울 글이 없어서).
    // 글 칸에 늘 빈칸 몇 개를 깔아 두어 지우기가 deleteContentBackward 로 오게 하고, 올 때마다 다시 채운다
    const pad = SOFT_KEYBOARD_PAD;
    const refill = () => {
      ta.value = pad;
      ta.setSelectionRange(pad.length, pad.length);
    };
    if (pad) refill();
    // textarea 를 비운다. 조합 중이면 조합이 모두 끝난 뒤에 비운다
    const settle = () =>
      setTimeout(() => {
        if (this.composing > 0) return;
        this.engine?.setPreedit(null);
        if (pad) refill();
        else ta.value = "";
      });
    ta.addEventListener("keydown", (ev) => {
      const raw = !ev.isComposing && ev.keyCode !== 229 && !ev.metaKey && !ev.ctrlKey && !ev.altKey;
      // 입력 소스를 바꾼 직후 입력기가 이 글 칸에 붙지 않으면 한국어 자판 자모가 조합 없이 하나씩 온다 (ㅎㅏㄴㄱㅡㄹ).
      // 그때는 직접 글자로 묶는다
      if (raw && isJamo(ev.key)) {
        ev.preventDefault();
        const done = this.hangul.feed(ev.key);
        if (done) this.send(enc.encode(done));
        this.engine?.setPreedit(this.hangul.preedit || null);
        this.placeInput();
        return;
      }
      if (raw && ev.key === "Backspace" && !ev.shiftKey && this.hangul.backspace()) {
        ev.preventDefault();
        this.engine?.setPreedit(this.hangul.preedit || null);
        return;
      }
      // 수정키만 누른 것은 조합을 끝내지 않는다 (Shift 를 누르고 ㅆ 을 친다)
      if (!MODIFIER_KEYS.has(ev.key)) this.flushHangul();
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
      this.flushHangul();
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
      } else if (ie.inputType === "deleteContentBackward") {
        // 안드로이드 키보드는 모든 키를 keyCode 229 로 보내 지우기·Enter 가 keydown 으로 오지 않는다
        this.send(new Uint8Array([0x7f]));
      } else if (ie.inputType === "insertLineBreak" || ie.inputType === "insertParagraph") {
        this.send(enc.encode("\r"));
        settle();
      }
      // 한글 입력기는 조합 이벤트 없이 앞 글자를 바꿔 쓰기도 한다 (ㅇ → 아 → 안). 글이 들어올 때마다 비우면 입력기가
      // 앞 글자를 잃어 자모가 하나씩 따로 확정된다 (ㅇㅏㄴ). 그래서 글이 길어졌을 때만 비운다
      if (ta.value.length > 64) settle();
      // 깔아 둔 빈칸을 지웠으면 다시 깐다 (다음 지우기도 이벤트로 오게)
      else if (pad && !ta.value.startsWith(pad)) refill();
    });
    ta.addEventListener("paste", (ev) => {
      ev.preventDefault();
      this.flushHangul();
      const text = ev.clipboardData?.getData("text/plain");
      if (text) {
        if (this.engine) this.send(this.engine.input.paste(text));
        return;
      }
      // 그림만 있으면(스크린샷 등) 데몬 쪽 임시 파일로 써서 그 경로를 붙여 넣는다. claude 는 붙여 넣은 그림 경로를 그림으로 붙인다
      const images = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (images.length) void this.pasteImages(images);
      // 웹뷰가 그림을 넘기지 않았으면, 같은 맥의 claude 에는 ⌃V 를 보내 claude 가 클립보드 그림을 직접 읽게 한다
      else if (!this.s.host.isRemote && this.isAgent?.()) this.send(new Uint8Array([0x16]));
    });
    // Cmd+C: 고른 글자를 복사한다 (textarea 의 copy 이벤트로 받아 클립보드 권한이 필요 없다)
    ta.addEventListener("copy", (ev) => {
      const text = this.engine?.selectionText();
      if (!text) return;
      ev.preventDefault();
      ev.clipboardData?.setData("text/plain", text);
    });
    ta.addEventListener("focus", () => this.onActivate?.());
    ta.addEventListener("blur", () => this.flushHangul());
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
      fontSize: `${this.renderer.options.fontSize}px`,
      fontFamily: this.renderer.options.fontFamily,
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

  private async pasteImages(files: File[]) {
    const paths: string[] = [];
    for (const f of files) {
      const ext = f.type.slice("image/".length).replace("jpeg", "jpg").replace(/\+.*$/, "") || "png";
      try {
        paths.push(await this.s.host.savePasteImage(await toBase64(f), ext));
      } catch (e) {
        console.warn("붙여넣은 그림을 쓰지 못했다", e);
      }
    }
    if (paths.length) this.paste(paths.join(" "));
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

/** 안드로이드에서 글 칸에 깔아 두는 빈칸 (빈 칸에서 누른 지우기도 이벤트로 오게) */
const SOFT_KEYBOARD_PAD = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) ? "    " : "";

/** 파일 내용을 base64 로 (data: 주소의 앞머리를 뗀다) */
function toBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
