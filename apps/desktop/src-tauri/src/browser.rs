//! 브라우저 칸: 창 안에 자식 웹뷰(WKWebView)를 얹는다.
//!
//! 칸 자리(사각형)는 화면(메인 웹뷰)이 DOM 으로 잡고, 여기서는 그 자리에 네이티브 웹뷰를 옮기고 숨기기만 한다.
//! 웹뷰는 칸 번호(`browser-<칸>`)로 찾는다. 페이지에는 Tauri 명령 권한이 없다 (capabilities 는 메인 웹뷰만).
//!
//! 페이지가 키보드를 잡고 있으면 앱 단축키(⌘T, ⌘W 등)가 메인 웹뷰로 가지 않는다. 그래서 페이지마다 작은 스크립트를 넣어
//! ⌘ 조합을 `thuminal-key://` 주소로 바꿔 이동을 시도하게 하고, 이동을 가로채 메인 웹뷰에 이벤트로 넘긴다.

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, Window};

type CmdResult<T> = Result<T, String>;

/// 메인 웹뷰로 보내는 이벤트 이름
const EVENT: &str = "thuminal://browser";

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

fn label(id: u64) -> String {
    format!("browser-{id}")
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

fn emit(app: &AppHandle, e: BrowserEvent) {
    let _ = app.emit_to("main", EVENT, e);
}

fn webview(app: &AppHandle, id: u64) -> CmdResult<tauri::Webview> {
    app.get_webview(&label(id)).ok_or_else(|| format!("브라우저 칸 {id} 이 없다"))
}

/// 칸 자리에 웹뷰를 연다. 이미 있으면 자리만 옮기고 보인다
#[tauri::command]
pub async fn browser_open(app: AppHandle, window: Window, id: u64, url: String, x: f64, y: f64, w: f64, h: f64) -> CmdResult<()> {
    if let Some(v) = app.get_webview(&label(id)) {
        v.set_bounds(rect(x, y, w, h)).map_err(|e| e.to_string())?;
        return v.show().map_err(|e| e.to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("주소가 이상하다: {url} ({e})"))?;
    let (a1, a2, a3, a4) = (app.clone(), app.clone(), app.clone(), app.clone());
    let builder = WebviewBuilder::new(label(id), WebviewUrl::External(parsed))
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
                    BrowserEvent::Key {
                        id,
                        key: q.get("key").cloned().unwrap_or_default(),
                        code: q.get("code").cloned().unwrap_or_default(),
                        alt: flag("alt"),
                        shift: flag("shift"),
                        ctrl: flag("ctrl"),
                    },
                ),
                Some("focus") => emit(&a1, BrowserEvent::Focus { id }),
                _ => {}
            }
            false
        })
        .on_document_title_changed(move |_, title| emit(&a2, BrowserEvent::Title { id, title }))
        .on_page_load(move |_, p| {
            emit(&a3, BrowserEvent::Load { id, url: p.url().to_string(), loading: matches!(p.event(), PageLoadEvent::Started) })
        })
        .on_new_window(move |u, _| {
            emit(&a4, BrowserEvent::NewWindow { id, url: u.to_string() });
            NewWindowResponse::Deny
        });
    window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, id: u64, x: f64, y: f64, w: f64, h: f64) -> CmdResult<()> {
    webview(&app, id)?.set_bounds(rect(x, y, w, h)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_visible(app: AppHandle, id: u64, visible: bool) -> CmdResult<()> {
    let v = webview(&app, id)?;
    if visible { v.show() } else { v.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, id: u64, url: String) -> CmdResult<()> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("주소가 이상하다: {url} ({e})"))?;
    webview(&app, id)?.navigate(parsed).map_err(|e| e.to_string())
}

/// 뒤로(-1) · 앞으로(+1)
#[tauri::command]
pub async fn browser_go(app: AppHandle, id: u64, delta: i32) -> CmdResult<()> {
    webview(&app, id)?.eval(format!("history.go({delta})")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, id: u64) -> CmdResult<()> {
    webview(&app, id)?.reload().map_err(|e| e.to_string())
}

/// 페이지에 키보드를 준다 (칸을 고르거나 주소를 연 뒤)
#[tauri::command]
pub async fn browser_focus(app: AppHandle, id: u64) -> CmdResult<()> {
    webview(&app, id)?.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_devtools(app: AppHandle, id: u64) -> CmdResult<()> {
    webview(&app, id)?.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: u64) -> CmdResult<()> {
    match app.get_webview(&label(id)) {
        Some(v) => v.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
