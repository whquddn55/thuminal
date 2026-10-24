// 렌더러 인터페이스.
//
// 렌더러는 화면에 보이는 터미널들을 그린다. 터미널마다 그림판을 따로 만들지 않아도 되게,
// 렌더러 하나가 여러 터미널을 맡는다 (WebGL 화면 개수 한계를 피하려는 것).

import type { TerminalEngine } from "./engine";

export interface CellMetrics {
  /** CSS 픽셀 */
  width: number;
  height: number;
}

export interface RendererOptions {
  fontFamily: string;
  fontSize: number;
}

export interface RenderTarget {
  /** 이 터미널이 그려질 자리 (크기와 위치를 렌더러가 읽는다) */
  readonly host: HTMLElement;
  readonly engine: TerminalEngine;
  /** 자리가 겹칠 때 위에 그릴 차례. 큰 것이 위다 (기본 0). 팝업 안 터미널처럼 다른 터미널 위에 뜨는 것에 준다 */
  readonly layer?: number;
}

export interface Renderer {
  readonly metrics: CellMetrics;
  /** 그릴 터미널을 더한다. 돌려준 함수를 부르면 뺀다 */
  add(target: RenderTarget): () => void;
  /** 바뀐 터미널만 다시 그린다. 앱이 requestAnimationFrame 마다 부른다 */
  frame(): void;
  /** 창 크기나 배치가 바뀌었다 */
  layout(): void;
  dispose(): void;
}

export type RendererFactory = (root: HTMLElement, options: RendererOptions) => Renderer;
