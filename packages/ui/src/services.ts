// 화면이 쓰는 바깥 기능 묶음. 앱 시작 코드가 어댑터를 골라 넣는다.

import type { EngineFactory, HostApi, RendererFactory } from "@thuminal/term-core";

export interface Services {
  host: HostApi;
  engines: EngineFactory;
  renderer: RendererFactory;
  /** 앱 엔진이 들고 있을 스크롤백 줄 수 */
  scrollback: number;
}
