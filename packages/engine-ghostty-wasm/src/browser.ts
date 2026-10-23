// 브라우저(Vite) 에서 쓰는 기본 엔진: 함께 묶인 ghostty-vt.wasm 을 fetch 로 불러온다.
import wasmUrl from "./assets/ghostty-vt.wasm?url";

import { ghosttyWasmEngine } from "./engine";

export const ghosttyWasmEngineForBrowser = () =>
  ghosttyWasmEngine({ wasm: async () => (await fetch(wasmUrl)).arrayBuffer() });
