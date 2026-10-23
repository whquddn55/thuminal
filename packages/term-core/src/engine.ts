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
  clearSelection(): void;
  /** 선택한 글자. 선택이 없으면 null */
  selectionText(): string | null;
  defaultColors(): { fg: number; bg: number };
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
  create(opts: { cols: number; rows: number; scrollback: number }): TerminalEngine;
  /** native 저장본으로 엔진을 되살린다. 지원하지 않으면 null */
  restore?(snapshot: Uint8Array, opts: { cols: number; rows: number; scrollback: number }): TerminalEngine | null;
}
