// 앱 시작: 어댑터를 골라 끼우는 유일한 곳이다.
// 엔진, 렌더러, 앱 껍데기를 바꾸려면 여기서 다른 구현을 넣는다.

import { createRoot } from "react-dom/client";

import { ghosttyWasmEngineForBrowser } from "@thuminal/engine-ghostty-wasm/browser";
import { webglRenderer } from "@thuminal/renderer-webgl";
import { App, type Services } from "@thuminal/ui";

import { TauriHostApi } from "./tauri-host";

const FONT = "MesloLGLDZ Nerd Font Mono";

async function boot() {
  const engines = ghosttyWasmEngineForBrowser();
  const host = new TauriHostApi();
  // 글꼴은 렌더러가 글자 그림판을 만들기 전에 등록해 둔다
  const [, faces] = await Promise.all([engines.load(), host.registerFont(FONT).catch(() => 0)]);
  if (!faces) console.warn(`[thuminal] 글꼴 ${FONT} 을 찾지 못해 Menlo 로 그린다`);
  const services: Services = {
    host,
    engines,
    renderer: webglRenderer,
    rendererOptions: { fontFamily: `'${FONT}', Menlo, 'Apple SD Gothic Neo', monospace`, fontSize: 13 },
    scrollback: 10_000,
  };
  createRoot(document.getElementById("root")!).render(<App services={services} />);
}

void boot();
