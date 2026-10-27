//! 브라우저 칸: 창 안에 자식 웹뷰(WKWebView)를 얹는다.
//!
//! 칸 자리(사각형)는 화면(메인 웹뷰)이 DOM 으로 잡고, 여기서는 그 자리에 네이티브 웹뷰를 옮기고 숨기기만 한다.
//! 웹뷰는 칸 번호(`browser-<칸>`)로 찾는다. 칸 번호는 데몬마다 1부터 세므로 원격 호스트 칸은 호스트 id 를 넣어
//! `browser-<호스트>-<칸>` 으로 가르고, 이벤트도 호스트마다 다른 이름(`thuminal://browser/<호스트>`)으로 보낸다.
//! 페이지에는 Tauri 명령 권한이 없다 (capabilities 는 메인 웹뷰만).
//!
//! 페이지가 키보드를 잡고 있으면 앱 단축키(⌘T, ⌘W 등)가 메인 웹뷰로 가지 않는다. 그래서 페이지마다 작은 스크립트를 넣어
//! ⌘ 조합을 `thuminal-key://` 주소로 바꿔 이동을 시도하게 하고, 이동을 가로채 메인 웹뷰에 이벤트로 넘긴다.

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, Window};

type CmdResult<T> = Result<T, String>;

/// 메인 웹뷰로 보내는 이벤트 이름. 원격 호스트 칸은 뒤에 `/<호스트>` 가 붙는다
const EVENT: &str = "thuminal://browser";

/// 원격 호스트 id 는 껍데기가 만든 16진수지만, 웹뷰 이름·이벤트 이름에 넣기 전에 글자를 한 번 거른다
fn host_tag(host: &Option<String>) -> CmdResult<Option<&str>> {
    match host.as_deref() {
        None => Ok(None),
        Some(h) if !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric()) => Ok(Some(h)),
        Some(h) => Err(format!("호스트 id 가 올바르지 않아요: {h}")),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case", tag = "type")]
enum BrowserEvent {
    Title { id: u64, title: String },
    Load { id: u64, url: String, loading: bool },
    /// 페이지 안에서 누른 앱 단축키
    Key { id: u64, key: String, code: String, alt: bool, shift: bool, ctrl: bool },
    /// 페이지가 키보드를 받기 시작했다
    Focus { id: u64 },
    /// 페이지가 새 창을 열려 했다 (앱이 새 브라우저 탭으로 연다)
    NewWindow { id: u64, url: String },
}

/// 페이지마다 넣는 스크립트: 앱 단축키를 메인 웹뷰로 넘기고, 키보드를 받기 시작하면 알린다.
/// 편집 키(⌘C ⌘V ⌘X ⌘A ⌘Z ⌘F)와 시스템 키(⌘Q ⌘H ⌘M)는 페이지가 그대로 쓴다
const BRIDGE: &str = r#"
(() => {
  if (window.top !== window || window.__thuminalBridge) return;
  window.__thuminalBridge = true;
  const send = (path, q) => { try { location.href = 'thuminal-key://' + path + '?' + new URLSearchParams(q); } catch (_) {} };
  const pageKeys = new Set(['c', 'v', 'x', 'a', 'z', 'f', 'q', 'h', 'm', 'g']);
  addEventListener('keydown', (e) => {
    if (!e.metaKey || e.isComposing) return;
    const k = (e.key || '').toLowerCase();
    if (!e.altKey && !e.ctrlKey && pageKeys.has(k)) return;
    if (k === 'meta' || k === 'shift' || k === 'alt' || k === 'control') return;
    e.preventDefault();
    e.stopPropagation();
    send('key', { key: e.key, code: e.code, alt: +e.altKey, shift: +e.shiftKey, ctrl: +e.ctrlKey });
  }, true);
  addEventListener('focus', () => send('focus', {}), true);
  addEventListener('pointerdown', () => { if (!document.hasFocus()) send('focus', {}); }, true);
})();
"#;

/// Safari 와 같은 User-Agent. WKWebView 기본값에는 `Version/… Safari/…` 가 빠져 있어
/// Google 로그인처럼 "앱에 박힌 웹뷰"를 막는 사이트에 걸린다. Safari 버전은 설치된 Safari 에서 읽는다.
/// Windows(WebView2)와 Linux(WebKitGTK)는 기본값이 이미 보통 브라우저 모양이라 그대로 둔다
#[cfg(target_os = "macos")]
fn user_agent() -> &'static str {
    static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    UA.get_or_init(|| {
        let version = std::process::Command::new("plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "/Applications/Safari.app/Contents/Info.plist"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "18.0".into());
        format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15")
    })
}

fn label(host: Option<&str>, id: u64) -> String {
    match host {
        Some(h) => format!("browser-{h}-{id}"),
        None => format!("browser-{id}"),
    }
}

fn event_name(host: Option<&str>) -> String {
    match host {
        Some(h) => format!("{EVENT}/{h}"),
        None => EVENT.to_string(),
    }
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

fn emit(app: &AppHandle, event: &str, e: BrowserEvent) {
    let _ = app.emit_to("main", event, e);
}

fn webview(app: &AppHandle, host: &Option<String>, id: u64) -> CmdResult<tauri::Webview> {
    app.get_webview(&label(host_tag(host)?, id)).ok_or_else(|| format!("브라우저 칸을 찾지 못했어요: {id}"))
}

/// 칸 자리에 웹뷰를 연다. 이미 있으면 자리만 옮기고 보인다
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_open(app: AppHandle, window: Window, host: Option<String>, id: u64, url: String, x: f64, y: f64, w: f64, h: f64) -> CmdResult<()> {
    let tag = host_tag(&host)?;
    if let Some(v) = app.get_webview(&label(tag, id)) {
        v.set_bounds(rect(x, y, w, h)).map_err(|e| e.to_string())?;
        return v.show().map_err(|e| e.to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("주소가 올바르지 않아요: {url} ({e})"))?;
    let (a1, a2, a3, a4) = (app.clone(), app.clone(), app.clone(), app.clone());
    let ev = event_name(tag);
    let (e1, e2, e3, e4) = (ev.clone(), ev.clone(), ev.clone(), ev);
    let builder = WebviewBuilder::new(label(tag, id), WebviewUrl::External(parsed));
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(user_agent());
    let builder = builder
        .initialization_script(BRIDGE)
        .on_navigation(move |u| {
            if u.scheme() != "thuminal-key" {
                return true;
            }
            let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
            let flag = |k: &str| q.get(k).is_some_and(|v| v == "1");
            match u.host_str() {
                Some("key") => emit(
                    &a1,
                    &e1,
                    BrowserEvent::Key {
                        id,
                        key: q.get("key").cloned().unwrap_or_default(),
                        code: q.get("code").cloned().unwrap_or_default(),
                        alt: flag("alt"),
                        shift: flag("shift"),
                        ctrl: flag("ctrl"),
                    },
                ),
                Some("focus") => emit(&a1, &e1, BrowserEvent::Focus { id }),
                _ => {}
            }
            false
        })
        .on_document_title_changed(move |_, title| emit(&a2, &e2, BrowserEvent::Title { id, title }))
        .on_page_load(move |_, p| {
            emit(&a3, &e3, BrowserEvent::Load { id, url: p.url().to_string(), loading: matches!(p.event(), PageLoadEvent::Started) })
        })
        .on_new_window(move |u, _| {
            emit(&a4, &e4, BrowserEvent::NewWindow { id, url: u.to_string() });
            NewWindowResponse::Deny
        });
    window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, host: Option<String>, id: u64, x: f64, y: f64, w: f64, h: f64) -> CmdResult<()> {
    webview(&app, &host, id)?.set_bounds(rect(x, y, w, h)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_visible(app: AppHandle, host: Option<String>, id: u64, visible: bool) -> CmdResult<()> {
    let v = webview(&app, &host, id)?;
    if visible { v.show() } else { v.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, host: Option<String>, id: u64, url: String) -> CmdResult<()> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("주소가 올바르지 않아요: {url} ({e})"))?;
    webview(&app, &host, id)?.navigate(parsed).map_err(|e| e.to_string())
}

/// 뒤로(-1) · 앞으로(+1)
#[tauri::command]
pub async fn browser_go(app: AppHandle, host: Option<String>, id: u64, delta: i32) -> CmdResult<()> {
    webview(&app, &host, id)?.eval(format!("history.go({delta})")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, host: Option<String>, id: u64) -> CmdResult<()> {
    webview(&app, &host, id)?.reload().map_err(|e| e.to_string())
}

/// 페이지에 키보드를 준다 (칸을 고르거나 주소를 연 뒤)
#[tauri::command]
pub async fn browser_focus(app: AppHandle, host: Option<String>, id: u64) -> CmdResult<()> {
    webview(&app, &host, id)?.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_devtools(app: AppHandle, host: Option<String>, id: u64) -> CmdResult<()> {
    webview(&app, &host, id)?.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, host: Option<String>, id: u64) -> CmdResult<()> {
    match app.get_webview(&label(host_tag(&host)?, id)) {
        Some(v) => v.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
