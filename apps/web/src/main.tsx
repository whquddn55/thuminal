// 웹 화면 시작: 데몬 원격 접속에 붙는 어댑터를 골라 끼운다.
//
// 처음 여는 주소에는 `#token=…` 이 붙어 있다 (데스크톱 설정 → 원격 접속에서 기기를 등록하면 준다).
// 토큰은 이 브라우저에 남기고 주소에서 지운다. 화면이 좁으면(폰) 모바일 화면을, 넓으면 데스크톱과 같은 화면을 띄운다.

import { createRoot } from "react-dom/client";

import { ghosttyWasmEngineForBrowser } from "@thuminal/engine-ghostty-wasm/browser";
import { webglRenderer } from "@thuminal/renderer-webgl";
import { App, appBridge, loadTerminalFont, MobileApp, PairScreen, registerTerminalFonts, type Services } from "@thuminal/ui";

import { WebHostApi } from "./web-host";

const TOKEN_KEY = "thuminal.remoteToken";
const UI_KEY = "thuminal.remoteUi";

function takeToken(): string | null {
  const m = location.hash.match(/token=([0-9a-f]+)/);
  if (m) {
    localStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return localStorage.getItem(TOKEN_KEY);
}

/** `?ui=mobile|desktop` 로 고르면 그것을 이 브라우저에 남긴다. 아니면 화면 폭으로 정한다 */
function mobileUi(): boolean {
  const q = new URLSearchParams(location.search).get("ui");
  if (q === "mobile" || q === "desktop") localStorage.setItem(UI_KEY, q);
  const saved = localStorage.getItem(UI_KEY);
  if (saved) return saved === "mobile";
  return window.matchMedia("(max-width: 820px)").matches;
}

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  const token = takeToken();
  if (!token) {
    root.render(<PairScreen onToken={(t) => (localStorage.setItem(TOKEN_KEY, t), location.reload())} />);
    return;
  }
  const engines = ghosttyWasmEngineForBrowser();
  const host = new WebHostApi(location.origin, token);
  // 글꼴은 데몬이 있는 컴퓨터에서 받아 등록한다 (글꼴 · 크기는 설정창에서 바꾼다. 폰은 폰 화면의 글자 크기를 쓴다)
  await Promise.all([engines.load(), registerTerminalFonts(host, loadTerminalFont().family)]);
  const mobile = mobileUi();
  const services: Services = { host, engines, renderer: webglRenderer, scrollback: 10_000 };
  const forget = () => {
    localStorage.removeItem(TOKEN_KEY);
    // 안드로이드 앱이면 앱에 남긴 주소도 지우고 처음 화면으로 간다
    const app = appBridge();
    if (app) app.forget();
    else location.reload();
  };
  const switchUi = (ui: "mobile" | "desktop") => {
    localStorage.setItem(UI_KEY, ui);
    location.reload();
  };
  root.render(
    mobile ? (
      <MobileApp services={services} conn={host} onForget={forget} onDesktopUi={() => switchUi("desktop")} />
    ) : (
      <App services={services} onMobileUi={() => switchUi("mobile")} />
    ),
  );
}

void boot();
