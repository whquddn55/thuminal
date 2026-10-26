// 앱 쪽 터미널 엔진 인터페이스.
//
// 엔진은 데몬에서 온 바이트로 화면 상태를 만들고, 렌더러가 바뀐 칸만 읽어 가게 한다.
// 엔진은 그리지 않는다. 그리기는 Renderer 가 한다.

/** 칸 하나. 색은 0xRRGGBB. cp 가 0 이면 빈칸 */
export interface CellSink {
  cell(x: number, y: number, cp: number, fg: number, bg: number, flags: number): void;
}

export const CellFlags = {
  Bold: 1,
  Italic: 2,
  Underline: 4,
  Strikethrough: 8,
  /** 두 칸을 쓰는 글자 (한글, 한자, 이모지) */
  Wide: 16,
  /** 선택된 칸 (색은 엔진이 이미 선택 색으로 바꿔 넘긴다) */
  Selected: 32,
} as const;

/** 화면(뷰포트) 칸 좌표 */
export interface CellPoint {
  x: number;
  y: number;
}

/**
 * 터미널 기본색. 모두 0xRRGGBB.
 * 기본 fg/bg 와 팔레트 번호로 칠한 칸은 바꾸면 스크롤백까지 새 색으로 다시 그려진다 (24비트 색 칸은 그대로).
 * 프로그램이 OSC 4/10/11/12 로 바꾼 색은 엔진이 지킨다.
 */
export interface EngineColors {
  fg: number;
  bg: number;
  cursor: number;
  /** 커서 아래 글자 색 */
  cursorText: number;
  selectionBg: number;
  selectionFg: number;
  /** ANSI 0~15 (16개). 16~255 는 엔진 기본값을 쓴다 */
  palette: readonly number[];
  /** 글자와 배경의 최소 WCAG 대비 (1~21). 비우거나 1 이면 고치지 않는다. 글자색만 바꾼다 */
  minimumContrast?: number;
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
}

export interface TerminalEngine {
  readonly cols: number;
  readonly rows: number;
  /** 데몬 출력 바이트를 넣는다 */
  feed(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** 바뀐 줄의 칸을 sink 에 넘긴다. 바뀐 것이 없으면 false. 넘긴 뒤 바뀜 표시를 지운다 */
  scan(sink: CellSink): boolean;
  /** 바뀜 표시와 상관없이 다음 scan 에서 모든 칸을 다시 넘기게 한다 (새 렌더러에 붙을 때) */
  invalidate(): void;
  cursor(): CursorState;
  /** 뷰포트를 줄 단위로 움직인다. 음수면 스크롤백 쪽(위)으로 */
  scroll(lines: number): void;
  scrollToBottom(): void;
  /** 화면 칸 좌표로 선택한다 (from 과 to 순서는 상관없다) */
  select(from: CellPoint, to: CellPoint): void;
  /** 그 칸의 단어를 선택한다 */
  selectWord(at: CellPoint): void;
  /** 그 칸의 줄을 선택한다 (세 번 누르기) */
  selectLine(at: CellPoint): void;
  selectAll(): void;
  clearSelection(): void;
  /** 선택한 글자. 선택이 없으면 null */
  selectionText(): string | null;
  /** 지금 쓰는 기본 fg/bg (OSC 10/11 로 바뀌었으면 그 값). 렌더러는 bg 로 빈 자리를 칠한다 */
  defaultColors(): { fg: number; bg: number };
  /** 기본색을 바꾸고 다음 scan 에서 모든 칸을 다시 넘긴다 */
  setColors(colors: EngineColors): void;
  /**
   * 조합 중인 글자 (한글 등). 커서 자리부터 밑줄을 그어 다른 글자와 같은 칸으로 넘긴다.
   * 화면에는 아직 쓰지 않은 글자라 엔진 상태는 바뀌지 않는다. null 이나 빈 글이면 지운다
   */
  setPreedit(text: string | null): void;
  /** 키보드 입력을 터미널 모드(커서 키 모드 등)에 맞는 바이트로 바꾼다 */
  readonly input: InputEncoder;
  dispose(): void;
}

export interface KeyInput {
  /** KeyboardEvent.key */
  key: string;
  /** KeyboardEvent.code */
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface InputEncoder {
  /** 터미널로 보낼 바이트. 터미널이 처리하지 않을 키(예: Cmd 단축키)면 null */
  key(k: KeyInput): Uint8Array | null;
  /** 붙여넣기 (bracketed paste 모드면 감싼다) */
  paste(text: string): Uint8Array;
  /**
   * 휠 이벤트 하나. `at` 은 마우스가 있는 화면 칸.
   * 프로그램이 마우스를 받으면 휠 버튼 하나를, 대체 화면이면 방향키 하나를 낸다 (xterm.js 와 같다. 얼마나 움직일지는 프로그램이 정한다).
   * null 이면 프로그램이 휠을 받지 않으니 앱이 스크롤백을 움직인다
   */
  wheel(up: boolean, at: CellPoint): Uint8Array | null;
  /**
   * 마우스 버튼·움직임 보고. 프로그램이 켠 마우스 모드(9·1000·1002·1003)가 받는 것만 바이트로 바꾼다.
   * null 이면 프로그램이 받지 않으니 앱이 고르기 등을 한다
   */
  mouse(m: MouseInput): Uint8Array | null;
}

export interface MouseInput {
  action: "press" | "release" | "move";
  /** 0 왼쪽, 1 가운데, 2 오른쪽. 버튼 없이 움직이면 null */
  button: 0 | 1 | 2 | null;
  at: CellPoint;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface EngineFactory {
  /** 로그용 이름 */
  readonly name: string;
  /**
   * 데몬의 고유 저장본을 읽을 수 있으면 데몬 엔진 이름 (예: "ghostty").
   * 데몬 엔진과 같으면 native 저장본으로 붙고, 아니면 vt 저장본으로 붙는다.
   */
  readonly nativeSnapshotOf: string | null;
  /** 엔진을 쓸 준비 (wasm 내려받기 등) */
  load(): Promise<void>;
  /** 앞으로 create / restore 할 엔진의 기본색. 이미 만든 엔진은 각자 setColors 로 바꾼다 */
  setDefaultColors(colors: EngineColors): void;
  create(opts: { cols: number; rows: number; scrollback: number }): TerminalEngine;
  /** native 저장본으로 엔진을 되살린다. 지원하지 않으면 null */
  restore?(snapshot: Uint8Array, opts: { cols: number; rows: number; scrollback: number }): TerminalEngine | null;
}
