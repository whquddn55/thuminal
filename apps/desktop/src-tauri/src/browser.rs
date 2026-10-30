//! 브라우저 칸: 창 안에 자식 웹뷰(WKWebView)를 띄운다.
//!
//! 칸 자리(사각형)는 화면(메인 웹뷰)이 DOM 으로 잡고, 여기서는 그 자리에 네이티브 웹뷰를 옮기고 숨기기만 한다.
//! macOS · Linux 는 브라우저 웹뷰를 메인 웹뷰 **밑**에 깔고 메인 웹뷰 바탕을 투명하게 한다. 화면은 칸 자리만 뚫어
//! 보이게 하고, 그 위에 메뉴 · 대화 상자 · 플로팅 패널을 그대로 그린다. 뚫린 자리의 마우스 입력은 화면이 알려 준
//! 사각형([`browser_layer`])대로 밑의 웹뷰로 넘긴다 (macOS [`mac_layer`], Linux [`gtk_layer`]).
//! Windows 는 아직 메인 웹뷰 위에 얹고, 화면이 겹칠 때 숨긴다.
//! 웹뷰는 칸 번호(`browser-<칸>`)로 찾는다. 칸 번호는 데몬마다 1부터 세므로 원격 호스트 칸은 호스트 id 를 넣어
//! `browser-<호스트>-<칸>` 으로 가르고, 이벤트도 호스트마다 다른 이름(`thuminal://browser/<호스트>`)으로 보낸다.
//! 페이지에는 Tauri 명령 권한이 없다 (capabilities 는 메인 웹뷰만).
//!
//! 페이지가 키보드를 잡고 있으면 앱 단축키(⌘T, ⌘W 등)가 메인 웹뷰로 가지 않는다. 그래서 페이지마다 작은 스크립트를 넣어
//! ⌘ 조합을 `thuminal-key://` 주소로 바꿔 이동을 시도하게 하고, 이동을 가로채 메인 웹뷰에 이벤트로 넘긴다.

use serde::{Deserialize, Serialize};
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
/// 편집 키(⌘C ⌘V ⌘X ⌘A ⌘Z ⌘F)와 시스템 키(⌘Q ⌘H ⌘M)는 페이지가 그대로 쓴다. Windows · Linux 는 Ctrl 이 같은 자리다
const BRIDGE: &str = r#"
(() => {
  if (window.top !== window || window.__thuminalBridge) return;
  window.__thuminalBridge = true;
  const send = (path, q) => { try { location.href = 'thuminal-key://' + path + '?' + new URLSearchParams(q); } catch (_) {} };
  // 앱 단축키 수정키는 macOS 는 ⌘, Windows · Linux 는 Ctrl 이다
  const mac = /Mac/.test(navigator.platform);
  const pageKeys = new Set(mac ? ['c', 'v', 'x', 'a', 'z', 'f', 'q', 'h', 'm', 'g'] : ['c', 'v', 'x', 'a', 'z', 'y', 'f']);
  addEventListener('keydown', (e) => {
    if (!(mac ? e.metaKey : e.ctrlKey) || e.isComposing) return;
    const k = (e.key || '').toLowerCase();
    if (!e.altKey && !(mac && e.ctrlKey) && !(!mac && e.shiftKey) && pageKeys.has(k)) return;
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

#[cfg_attr(target_os = "linux", allow(dead_code))]
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
        place(&v, x, y, w, h)?;
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
    let v = window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    put_under(&app, &v)?;
    if cfg!(target_os = "linux") {
        place(&v, x, y, w, h)?;
    }
    Ok(())
}

/// 새 브라우저 웹뷰를 메인 웹뷰 밑에 깔고, 메인 웹뷰 바탕을 투명하게 한다 (macOS · Linux). 화면은 이미 칸 자리만
/// 비워 두고 그 밖은 직접 바탕을 칠한다 (ui `browser-layer.tsx`)
fn put_under(app: &AppHandle, v: &tauri::Webview) -> CmdResult<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Some(main) = app.get_webview("main") {
            main.set_background_color(Some(tauri::window::Color(0, 0, 0, 0))).map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            let label = v.label().to_string();
            v.with_webview(move |pw| mac_layer::adopt(label, pw.inner())).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, v);
    Ok(())
}

/// 웹뷰를 칸 자리(창 왼쪽 위 기준 논리 픽셀)로 옮긴다. Linux 는 Tauri 의 set_bounds 가 먹지 않아 GTK 로 직접 옮긴다 ([`gtk_layer`])
fn place(v: &tauri::Webview, x: f64, y: f64, w: f64, h: f64) -> CmdResult<()> {
    #[cfg(target_os = "linux")]
    {
        let label = v.label().to_string();
        v.with_webview(move |pw| {
            use gtk::prelude::*;
            gtk_layer::place(label, pw.inner().upcast(), x, y, w, h);
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    v.set_bounds(rect(x, y, w, h)).map_err(|e| e.to_string())
}

/// macOS: 브라우저 웹뷰를 메인 웹뷰 밑에 깔고, 뚫린 자리의 마우스를 넘긴다.
///
/// wry 는 메인 웹뷰와 자식 웹뷰를 창의 내용 뷰(`WryWebViewParent`) 안에 형제로 붙이고, 자식은 나중에 붙어 위에 온다.
/// 새 브라우저 웹뷰는 메인 웹뷰 바로 밑으로 옮긴다. 마우스를 누를 자리는 AppKit 이 내용 뷰의 `hitTest:` 로 찾으므로,
/// 내용 뷰 하나만 그 메서드를 바꾼 하위 클래스로 갈아 끼우고 화면이 알려 준 사각형 안이면 밑의 웹뷰를 돌려준다.
/// 휠 · 커서도 같은 `hitTest:` 를 따른다. 상태는 모두 메인 스레드(`with_webview`)에서만 만진다
#[cfg(target_os = "macos")]
mod mac_layer {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use objc2_app_kit::{NSView, NSWindowOrderingMode};
    use objc2_foundation::NSPoint;

    #[derive(Default)]
    struct State {
        main: Option<Retained<NSView>>,
        /// 웹뷰 이름 → 브라우저 웹뷰
        views: HashMap<String, Retained<NSView>>,
        /// 화면이 마지막으로 알린 칸(아래에서 위 차례)과 마우스를 넘길 사각형(창 왼쪽 위 기준 논리 픽셀 x, y, 너비, 높이).
        /// 웹뷰가 아직 붙기 전에 올 수 있어 들고 있다가 붙으면 다시 맞춘다
        wanted: Vec<(String, Vec<[f64; 4]>)>,
        /// wanted 를 웹뷰로 바꾼 것. 뒤가 위다
        pass: Vec<([f64; 4], Retained<NSView>)>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::default();
    }

    /// 원래 내용 뷰 클래스(`WryWebViewParent`). 바꾼 `hitTest:` 가 넘기지 않을 때 이 클래스의 것을 부른다
    static ORIGINAL: OnceLock<&'static AnyClass> = OnceLock::new();

    /// 내용 뷰를 `hitTest:` 만 바꾼 하위 클래스로 갈아 끼운다. 하위 클래스는 처음 한 번 만든다
    fn install(parent: &NSView) {
        let current = parent.class();
        if current.name().to_bytes() == b"ThuminalWebViewParent" {
            return;
        }
        let original = *ORIGINAL.get_or_init(|| current);
        if !std::ptr::eq(original, current) {
            return;
        }
        static SUBCLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        let sub = *SUBCLASS.get_or_init(|| {
            let mut b = ClassBuilder::new(c"ThuminalWebViewParent", original).expect("ThuminalWebViewParent 클래스");
            // SAFETY: hitTest: 의 모양(NSPoint → NSView*)과 같은 함수다
            unsafe { b.add_method(sel!(hitTest:), hit_test as extern "C-unwind" fn(*mut AnyObject, Sel, NSPoint) -> *mut AnyObject) };
            b.register()
        });
        // SAFETY: 원래 클래스의 하위 클래스이고 인스턴스 변수를 더하지 않았다
        unsafe { AnyObject::set_class(parent, sub) };
    }

    extern "C-unwind" fn hit_test(this: *mut AnyObject, _: Sel, point: NSPoint) -> *mut AnyObject {
        // SAFETY: 이 메서드는 NSView 하위 클래스(내용 뷰)에만 붙이고, AppKit 이 살아 있는 뷰로 부른다
        let parent: &NSView = unsafe { &*this.cast::<NSView>() };
        if let Some(v) = pass_target(parent, point) {
            return Retained::autorelease_return(v).cast();
        }
        let original = *ORIGINAL.get().expect("install 이 먼저 돈다");
        unsafe { msg_send![super(this, original), hitTest: point] }
    }

    fn superview(v: &NSView) -> Option<Retained<NSView>> {
        // SAFETY: 메인 스레드에서만 부른다
        unsafe { v.superview() }
    }

    /// 점(내용 뷰의 상위 뷰 좌표)이 넘길 사각형 안이면 밑의 웹뷰에서 찾은 뷰
    fn pass_target(parent: &NSView, point: NSPoint) -> Option<Retained<NSView>> {
        let local = parent.convertPoint_fromView(point, superview(parent).as_deref());
        // 내용 뷰는 아래가 0 이다. 화면 사각형은 위가 0 이다
        let (x, y) = (local.x, parent.bounds().size.height - local.y);
        STATE.with(|s| {
            let s = s.borrow();
            let (_, view) = s.pass.iter().rev().find(|([rx, ry, rw, rh], _)| x >= *rx && x < rx + rw && y >= *ry && y < ry + rh)?;
            let attached = superview(view).is_some_and(|p| std::ptr::eq(&*p, parent));
            if !attached || view.isHidden() {
                return None;
            }
            view.hitTest(local)
        })
    }

    /// 새 브라우저 웹뷰를 메인 웹뷰 바로 밑으로 옮긴다
    pub fn adopt(label: String, webview: *mut c_void) {
        // SAFETY: with_webview 가 준 WKWebView 포인터다 (NSView 하위 클래스). 메인 스레드다
        let Some(view) = (unsafe { Retained::retain(webview.cast::<NSView>()) }) else { return };
        let Some(parent) = superview(&view) else { return };
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if s.main.as_ref().is_none_or(|m| superview(m).is_none_or(|p| !std::ptr::eq(&*p, &*parent))) {
                // 내용 뷰 안에서 브라우저 웹뷰가 아닌 것이 메인 웹뷰다
                let known: Vec<*const NSView> = s.views.values().map(Retained::as_ptr).collect();
                s.main = parent.subviews().iter().find(|v| !std::ptr::eq(&**v, &*view) && !known.contains(&Retained::as_ptr(v)));
            }
            install(&parent);
            if let Some(main) = &s.main {
                view.removeFromSuperview();
                parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(main));
            }
            s.views.insert(label, view);
            apply(&mut s);
        });
    }

    pub fn forget(label: &str) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if s.views.remove(label).is_some() {
                apply(&mut s);
            }
        });
    }

    /// 화면이 알려 준 브라우저 칸(아래에서 위 차례)과 마우스를 넘길 사각형
    pub fn layer(items: Vec<(String, Vec<[f64; 4]>)>) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.wanted = items;
            apply(&mut s);
        });
    }

    /// wanted 대로 웹뷰 순서와 넘길 사각형을 맞춘다. 칸끼리 겹치면 뒤의 것이 위에 보이게 한다
    fn apply(s: &mut State) {
        let views: Vec<Retained<NSView>> = s.wanted.iter().filter_map(|(l, _)| s.views.get(l).cloned()).collect();
        s.pass = s
            .wanted
            .iter()
            .filter_map(|(l, rects)| s.views.get(l).map(|v| (rects, v)))
            .flat_map(|(rects, v)| rects.iter().map(move |r| (*r, v.clone())))
            .collect();
        let Some(main) = s.main.clone() else { return };
        let Some(parent) = superview(&main) else { return };
        // 지금 순서(메인 밑, 아래에서 위)가 화면 차례와 다를 때만 옮긴다. 옮기면 키보드 포커스가 풀려 되돌린다
        let order: Vec<*const NSView> = parent.subviews().iter().map(|v| Retained::as_ptr(&v)).collect();
        let index = |v: &NSView| order.iter().position(|p| std::ptr::eq(*p, v));
        let main_at = index(&main);
        let mut prev = None;
        let sorted = views.iter().all(|v| {
            let i = index(v);
            let ok = i.is_some() && main_at.is_some() && i < main_at && (prev.is_none() || i > prev);
            prev = i;
            ok
        });
        if sorted {
            return;
        }
        let window = parent.window();
        let focused = window.as_ref().and_then(|w| w.firstResponder());
        for v in &views {
            v.removeFromSuperview();
            parent.addSubview_positioned_relativeTo(v, NSWindowOrderingMode::Below, Some(&main));
        }
        if let (Some(w), Some(f)) = (window, focused) {
            w.makeFirstResponder(Some(&f));
        }
    }
}

/// Linux 브라우저 칸 자리 잡기.
///
/// Tauri(tauri-runtime-wry 2.12)는 Linux 에서 자식 웹뷰를 창의 세로 상자(GtkBox)에 넣는다. 세로 상자는 메인 화면과
/// 브라우저 칸을 위아래로 나눠 쌓고, 자리를 정하는 set_bounds 는 GtkFixed 안에 있을 때만 먹어 아무 일도 하지 않는다.
/// 그래서 처음 브라우저 칸을 열 때 세로 상자에 GtkOverlay 를 넣고, 브라우저 웹뷰와 메인 웹뷰를 모두 겹침 층에 얹는다.
/// 메인 웹뷰는 늘 맨 위 층이고 창 전체를 덮는다 (바탕은 투명). 얹은 브라우저 웹뷰는 왼쪽 위 정렬 + 여백으로 칸 자리에,
/// 크기 요청으로 칸 크기에 맞춘다. 뚫린 자리의 마우스는 메인 웹뷰 창의 입력 영역(input shape)에서 빼서 밑으로 넘긴다.
/// 모두 GTK 메인 스레드(`with_webview`)에서 돈다
#[cfg(target_os = "linux")]
mod gtk_layer {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use gtk::prelude::*;

    #[derive(Default)]
    struct State {
        overlay: Option<gtk::Overlay>,
        main: Option<gtk::Widget>,
        /// 웹뷰 이름 → 브라우저 웹뷰
        views: HashMap<String, gtk::Widget>,
        /// 화면이 마지막으로 알린 칸(아래에서 위 차례)과 마우스를 넘길 사각형. 웹뷰가 붙기 전에 올 수 있어 들고 있는다
        wanted: Vec<(String, Vec<[f64; 4]>)>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::default();
    }

    /// 웹뷰를 겹침 층에 얹는다. 처음이면 층을 만들고 메인 웹뷰도 옮긴다. 메인 웹뷰는 맨 위에 둔다
    fn adopt(label: String, webview: &gtk::Widget) -> Option<()> {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let parent = webview.parent()?;
            if parent.clone().downcast::<gtk::Overlay>().is_err() {
                let vbox = parent.downcast::<gtk::Box>().ok()?;
                if s.overlay.is_none() {
                    // 세로 상자 안 다른 위젯이 메인 웹뷰다. 빼는 동안 이 함수의 참조가 살려 둔다
                    let main = vbox.children().into_iter().find(|c| c != webview)?;
                    let overlay = gtk::Overlay::new();
                    // 겹침 층의 바탕 자리는 빈 상자다. 겹친 위젯은 모두 그 위에 쌓인다
                    overlay.add(&gtk::Box::new(gtk::Orientation::Vertical, 0));
                    vbox.remove(&main);
                    overlay.add_overlay(&main);
                    vbox.pack_start(&overlay, true, true, 0);
                    overlay.show_all();
                    s.overlay = Some(overlay);
                    s.main = Some(main);
                }
                let overlay = s.overlay.as_ref()?;
                vbox.remove(webview);
                overlay.add_overlay(webview);
            }
            if s.views.insert(label, webview.clone()).is_none() {
                apply(&s);
            }
            Some(())
        })
    }

    pub fn place(label: String, webview: gtk::Widget, x: f64, y: f64, w: f64, h: f64) {
        if adopt(label, &webview).is_none() {
            return;
        }
        webview.set_halign(gtk::Align::Start);
        webview.set_valign(gtk::Align::Start);
        webview.set_margin_start(x.round().max(0.0) as i32);
        webview.set_margin_top(y.round().max(0.0) as i32);
        webview.set_size_request(w.round().max(1.0) as i32, h.round().max(1.0) as i32);
        webview.queue_resize();
    }

    pub fn forget(label: &str) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if s.views.remove(label).is_some() {
                apply(&s);
            }
        });
    }

    /// 화면이 알려 준 브라우저 칸(아래에서 위 차례)과 마우스를 넘길 사각형
    pub fn layer(items: Vec<(String, Vec<[f64; 4]>)>) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.wanted = items;
            apply(&s);
        });
    }

    /// wanted 대로 겹침 층 순서(메인 웹뷰는 맨 위)와 메인 웹뷰 입력 영역을 맞춘다
    fn apply(s: &State) {
        let (Some(overlay), Some(main)) = (&s.overlay, &s.main) else { return };
        for (i, (label, _)) in s.wanted.iter().enumerate() {
            if let Some(v) = s.views.get(label) {
                overlay.reorder_overlay(v, i as i32);
            }
        }
        overlay.reorder_overlay(main, -1);
        // 넉넉한 사각형에서 넘길 사각형을 뺀 곳만 입력을 받는다 (창을 키워도 새 자리가 빠지지 않게).
        // 메인 웹뷰 창과 겹침 층이 만든 그 위 창 모두에 건다
        let region = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(0, 0, 100_000, 100_000));
        let attached = s.wanted.iter().filter(|(l, _)| s.views.contains_key(l));
        for [x, y, w, h] in attached.flat_map(|(_, r)| r.iter()) {
            let r = gtk::cairo::RectangleInt::new(x.floor() as i32, y.floor() as i32, w.ceil() as i32, h.ceil() as i32);
            let _ = region.subtract_rectangle(&r);
        }
        let top = overlay.window();
        let mut win = main.window();
        while let Some(gw) = win {
            if top.as_ref() == Some(&gw) {
                break;
            }
            gw.input_shape_combine_region(&region, 0, 0);
            win = gw.parent();
        }
    }
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, host: Option<String>, id: u64, x: f64, y: f64, w: f64, h: f64) -> CmdResult<()> {
    place(&webview(&app, &host, id)?, x, y, w, h)
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
        Some(v) => {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                let name = v.label().to_string();
                v.with_webview(move |_| {
                    #[cfg(target_os = "macos")]
                    mac_layer::forget(&name);
                    #[cfg(target_os = "linux")]
                    gtk_layer::forget(&name);
                })
                .map_err(|e| e.to_string())?;
            }
            v.close().map_err(|e| e.to_string())
        }
        None => Ok(()),
    }
}

/// 브라우저 칸 하나의 마우스를 넘길 자리 (창 왼쪽 위 기준 논리 픽셀 x, y, 너비, 높이)
#[derive(Deserialize)]
pub struct LayerItem {
    host: Option<String>,
    id: u64,
    rects: Vec<[f64; 4]>,
}

/// 메인 웹뷰 밑에 깐 브라우저 칸들(아래에서 위 차례)과, 칸마다 메인 웹뷰가 마우스를 밑으로 넘길 사각형.
/// 화면이 칸 자리에서 그 위에 그린 것(플로팅 패널, 떠 있는 버튼 등)을 빼고 보낸다. 메뉴 · 대화 상자가 열려 있거나
/// 끄는 중이면 비워 보낸다. Windows 는 웹뷰가 위에 얹혀 있어 할 일이 없다
#[tauri::command]
pub async fn browser_layer(app: AppHandle, items: Vec<LayerItem>) -> CmdResult<()> {
    let list = items.into_iter().map(|i| Ok((label(host_tag(&i.host)?, i.id), i.rects))).collect::<CmdResult<Vec<_>>>()?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let main = app.get_webview("main").ok_or("메인 웹뷰를 찾지 못했어요")?;
        main.with_webview(move |_| {
            #[cfg(target_os = "macos")]
            mac_layer::layer(list);
            #[cfg(target_os = "linux")]
            gtk_layer::layer(list);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    let _ = (app, list);
    Ok(())
}
