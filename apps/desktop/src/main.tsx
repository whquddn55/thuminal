// 앱 시작: 어댑터를 골라 끼우는 유일한 곳이다.
// 엔진, 렌더러, 앱 껍데기를 바꾸려면 여기서 다른 구현을 넣는다.

import { createRoot } from "react-dom/client";

import { ghosttyWasmEngineForBrowser } from "@thuminal/engine-ghostty-wasm/browser";
import { webglRenderer } from "@thuminal/renderer-webgl";
import { App, loadTerminalFont, registerTerminalFonts, type Services } from "@thuminal/ui";

import { TauriHostApi } from "./tauri-host";

async function boot() {
  const engines = ghosttyWasmEngineForBrowser();
  const host = new TauriHostApi();
  // 글꼴은 렌더러가 글자 그림판을 만들기 전에 등록해 둔다 (글꼴 · 크기는 설정창에서 바꾼다)
  await Promise.all([engines.load(), registerTerminalFonts(host, loadTerminalFont().family)]);
  const services: Services = { host, engines, renderer: webglRenderer, scrollback: 10_000 };
  createRoot(document.getElementById("root")!).render(<App services={services} />);
}

void boot();
