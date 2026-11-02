//! Windows 브라우저 칸: WebView2 를 Visual 로 띄워(CompositionController) 메인 웹뷰 밑에 깐다.
//!
//! WebView2 창(HWND)끼리는 투명하게 겹치지 못해서(airspace) wry 자식 웹뷰는 메인 웹뷰 밑에 둘 수 없다. wry 는 Visual 호스팅을
//! 하지 않으므로 브라우저 칸은 메인 웹뷰의 WebView2 environment 로 직접 만든다 (쿠키 · 로그인은 메인 웹뷰와 같은 프로필).
//! 창에 DirectComposition 타깃을 `topmost = FALSE` 로 걸면 그 시각 트리는 자식 창(메인 웹뷰)보다 밑에 합성된다. 칸마다 Visual
//! 하나를 이 트리에 넣어 WebView2 가 거기에 그리게 한다. 메인 웹뷰 바탕은 투명하고 화면이 칸 자리만 비워 두므로
//! (ui `browser-layer.tsx`) 칸이 비쳐 보이고, 그 위의 메뉴 · 대화 상자 · 플로팅 패널은 그대로 보인다.
//!
//! 마우스는 메인 웹뷰가 받는다 (메인 웹뷰 창은 WebView2 브라우저 프로세스의 것이라 가로챌 수 없다). 화면이 칸 자리에서 받은
//! pointer · wheel 을 [`input`] 으로 넘기면, 화면이 알린 사각형([`layer`]) 안일 때만 `SendMouseInput` 으로 페이지에 준다.
//! 키보드 · IME 는 누를 때 `MoveFocus` 로 포커스를 주면 WebView2 가 직접 받는다. 커서 모양은 화면이 칸 자리에 입힌다
//! (`BrowserEvent::Cursor`).
//!
//! COM 개체는 메인 스레드에서만 만지므로 thread_local 에 둔다. 명령은 메인 웹뷰의 `with_webview` 로 메인 스레드에 넘긴다

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, Manager, WindowEvent};
use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::*;
use windows::core::{HSTRING, Interface, PWSTR};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::DirectComposition::{DCompositionCreateDevice2, IDCompositionDesktopDevice, IDCompositionTarget, IDCompositionVisual, IDCompositionVisual2};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};

use super::{BRIDGE, BrowserEvent, CmdResult, bridge_event, emit};

/// 창 하나의 합성 트리. 처음 칸을 열 때 만든다
struct Comp {
    device: IDCompositionDesktopDevice,
    _target: IDCompositionTarget,
    root: IDCompositionVisual2,
    /// 창 (최상위 HWND). 브라우저 칸 WebView2 의 부모 창이기도 하다
    parent: HWND,
    /// 메인 웹뷰가 든 wry 그릇 창. 칸이 부모 창 밑에 만드는 창보다 늘 위에 둔다
    container: HWND,
    env: ICoreWebView2Environment3,
}

struct View {
    controller: ICoreWebView2Controller,
    comp: ICoreWebView2CompositionController,
    webview: ICoreWebView2,
    visual: IDCompositionVisual2,
    /// 칸 자리 (창 왼쪽 위 기준 논리 픽셀 x, y, 너비, 높이)
    bounds: [f64; 4],
    visible: bool,
    /// 마우스를 넘길 사각형 (browser_layer)
    rects: Vec<[f64; 4]>,
    /// 페이지에 누름을 넘긴 채 아직 떼지 않은 단추 (MK_* 비트). 칸 밖으로 끌어도 계속 넘긴다
    pressed: u32,
    /// 페이지가 마우스가 올라와 있다고 알고 있다 (나갈 때 LEAVE 를 보낸다)
    hover: bool,
}

#[derive(Default)]
struct State {
    comp: Option<Comp>,
    views: HashMap<String, View>,
    /// 아래에서 위 차례 (browser_layer)
    order: Vec<String>,
    /// 만드는 중인 칸과 그동안 바뀐 보이기. 만드는 중에 닫히면 빠진다
    pending: HashMap<String, bool>,
    /// 마지막 browser_layer 의 칸마다 사각형. 만드는 중인 칸 것도 들고 있다가 들일 때 넣는다
    rects: HashMap<String, Vec<[f64; 4]>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::default();
}

fn err(e: windows::core::Error) -> String {
    e.to_string()
}

/// 메인 스레드에서 돌리고 결과를 기다린다
async fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&tauri::webview::PlatformWebview) -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    let main = app.get_webview("main").ok_or("메인 웹뷰를 찾지 못했어요")?;
    let (tx, rx) = oneshot::channel();
    main.with_webview(move |pw| {
        let _ = tx.send(f(&pw));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "앱이 답하지 않았어요".to_string())?
}

/// 창 DPI 배율 (논리 → 물리 픽셀)
fn scale(hwnd: HWND) -> f64 {
    match unsafe { GetDpiForWindow(hwnd) } {
        0 => 1.0,
        dpi => dpi as f64 / 96.0,
    }
}

fn comp_for<'a>(s: &'a mut State, pw: &tauri::webview::PlatformWebview) -> CmdResult<&'a Comp> {
    if s.comp.is_none() {
        s.comp = Some(unsafe { make_comp(pw) }.map_err(err)?);
    }
    Ok(s.comp.as_ref().expect("방금 만들었다"))
}

unsafe fn make_comp(pw: &tauri::webview::PlatformWebview) -> windows::core::Result<Comp> {
    unsafe {
        let mut container = HWND::default();
        pw.controller().ParentWindow(&mut container)?;
        let parent = GetAncestor(container, GA_ROOT);
        let env: ICoreWebView2Environment3 = pw.environment().cast()?;
        let device: IDCompositionDesktopDevice = DCompositionCreateDevice2(None)?;
        // topmost = FALSE: 이 트리는 자식 창(메인 웹뷰)보다 밑에 합성된다
        let target = device.CreateTargetForHwnd(parent, false)?;
        let root = device.CreateVisual()?;
        target.SetRoot(&root)?;
        device.Commit()?;
        Ok(Comp { device, _target: target, root, parent, container, env })
    }
}

/// 칸 Visual 을 browser_layer 차례대로 쌓는다. 차례에 없는 칸(막 열린 칸)은 맨 밑에 둔다
fn restack(s: &State) {
    let Some(c) = &s.comp else { return };
    let mut shown: Vec<(&String, &View)> = s.views.iter().filter(|(_, v)| v.visible).collect();
    shown.sort_by_key(|(l, _)| s.order.iter().position(|o| o == *l).map_or(-1, |p| p as i64));
    unsafe {
        let _ = c.root.RemoveAllVisuals();
        for (_, v) in shown {
            let _ = c.root.AddVisual(&v.visual, true, None::<&IDCompositionVisual>);
        }
        let _ = c.device.Commit();
    }
}

fn place(c: &Comp, v: &mut View, b: [f64; 4]) {
    v.bounds = b;
    let s = scale(c.parent);
    let (l, t) = ((b[0] * s).round() as i32, (b[1] * s).round() as i32);
    let r = RECT { left: l, top: t, right: l + (b[2].max(1.0) * s).round() as i32, bottom: t + (b[3].max(1.0) * s).round() as i32 };
    unsafe {
        let _ = v.controller.SetBounds(r);
        let _ = v.visual.SetOffsetX2(l as f32);
        let _ = v.visual.SetOffsetY2(t as f32);
        let _ = c.device.Commit();
    }
}

/// 창이 옮겨지면 팝업(오른쪽 클릭 메뉴, select 목록) 자리를 다시 잡게 하고, 배율이 바뀌면 칸 자리를 다시 계산한다
fn watch_window(app: &AppHandle) {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    let Some(window) = app.get_window("main") else { return };
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    window.on_window_event(|e| match e {
        WindowEvent::Moved(_) => STATE.with_borrow(|s| {
            for v in s.views.values() {
                let _ = unsafe { v.controller.NotifyParentWindowPositionChanged() };
            }
        }),
        WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Resized(_) => STATE.with_borrow_mut(|s| {
            let State { comp, views, .. } = s;
            let Some(c) = comp.as_ref() else { return };
            for v in views.values_mut() {
                let b = v.bounds;
                place(c, v, b);
            }
        }),
        _ => {}
    });
}

/// 칸 자리에 웹뷰를 연다. 이미 있으면 자리만 옮기고 보인다
pub async fn open(app: AppHandle, label: String, id: u64, event: String, url: String, bounds: [f64; 4]) -> CmdResult<()> {
    if let Some(main) = app.get_webview("main") {
        main.set_background_color(Some(tauri::window::Color(0, 0, 0, 0))).map_err(|e| e.to_string())?;
    }
    watch_window(&app);
    let (tx, rx) = oneshot::channel::<CmdResult<()>>();
    let started = on_main(&app.clone(), move |pw| {
        STATE.with_borrow_mut(|s| {
            let c = comp_for(s, pw)?;
            let (env, parent) = (c.env.clone(), c.parent);
            if s.views.contains_key(&label) {
                let State { comp, views, .. } = &mut *s;
                let v = views.get_mut(&label).expect("있다");
                place(comp.as_ref().expect("있다"), v, bounds);
                v.visible = true;
                let _ = unsafe { v.controller.SetIsVisible(true) };
                restack(s);
                return Ok(false);
            }
            if s.pending.insert(label.clone(), true).is_some() {
                // 이미 만드는 중이다. 먼저 연 쪽이 끝을 기다린다
                return Ok(false);
            }
            let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(move |hr, comp| {
                let r = hr.map_err(err).and_then(|_| comp.ok_or_else(|| "브라우저 칸을 만들지 못했어요".to_string()));
                let r = r.and_then(|comp| adopt(app, label, id, event, url, bounds, comp));
                let _ = tx.send(r);
                Ok(())
            }));
            unsafe { env.CreateCoreWebView2CompositionController(parent, &handler) }.map_err(err)?;
            Ok(true)
        })
    })
    .await?;
    if started { rx.await.map_err(|_| "브라우저 칸을 만들지 못했어요".to_string())? } else { Ok(()) }
}

/// 다 만들어진 WebView2 를 칸으로 들인다 (메인 스레드, 만들기 완료 콜백 안)
fn adopt(app: AppHandle, label: String, id: u64, event: String, url: String, bounds: [f64; 4], comp: ICoreWebView2CompositionController) -> CmdResult<()> {
    let controller: ICoreWebView2Controller = comp.cast().map_err(err)?;
    let Some(visible) = STATE.with_borrow_mut(|s| s.pending.remove(&label)) else {
        // 만드는 동안 칸이 닫혔다
        let _ = unsafe { controller.Close() };
        return Ok(());
    };
    unsafe {
        let webview = controller.CoreWebView2().map_err(err)?;
        let visual = STATE.with_borrow(|s| s.comp.as_ref().map(|c| c.device.CreateVisual())).ok_or("합성 장치가 없어요")?.map_err(err)?;
        comp.SetRootVisualTarget(&visual).map_err(err)?;
        controller.SetIsVisible(visible).map_err(err)?;
        attach(&app, &webview, &comp, id, &event).map_err(err)?;
        // 단축키 스크립트가 들어간 뒤 첫 주소로 간다
        let first = webview.clone();
        let script = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |_, _| first.Navigate(&HSTRING::from(url.as_str()))));
        webview.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(BRIDGE), &script).map_err(err)?;
        STATE.with_borrow_mut(|s| {
            let rects = s.rects.get(&label).cloned().unwrap_or_default();
            let mut v = View { controller, comp, webview, visual, bounds, visible, rects, pressed: 0, hover: false };
            let c = s.comp.as_ref().expect("있다");
            place(c, &mut v, bounds);
            // 부모 창 밑에 WebView2 가 만든 창이 메인 웹뷰를 가리지 않게 메인 웹뷰 그릇을 맨 위로 올린다
            let _ = SetWindowPos(c.container, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            s.views.insert(label, v);
            restack(s);
        });
    }
    Ok(())
}

/// 페이지 일을 화면에 알리는 처리기들
unsafe fn attach(app: &AppHandle, webview: &ICoreWebView2, comp: &ICoreWebView2CompositionController, id: u64, event: &str) -> windows::core::Result<()> {
    let mut token = 0i64;
    let (a, e) = (app.clone(), event.to_string());
    let send = move |ev: BrowserEvent| emit(&a, &e, ev);
    let url_of = |w: &ICoreWebView2| -> String {
        let mut p = PWSTR::null();
        match unsafe { w.Source(&mut p) } {
            Ok(()) => take_pwstr(p),
            Err(_) => String::new(),
        }
    };
    unsafe {
        let s = send.clone();
        webview.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut p = PWSTR::null();
                args.Uri(&mut p)?;
                let uri = take_pwstr(p);
                // 페이지 스크립트가 넘긴 단축키 · 포커스 (thuminal-key://)
                if let Ok(u) = uri.parse::<tauri::Url>()
                    && u.scheme() == "thuminal-key"
                {
                    if let Some(ev) = bridge_event(id, &u) {
                        s(ev);
                    }
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        // Windows 는 브리지가 같은 주소를 chrome.webview.postMessage 로 보낸다 (WebView2 는 등록되지 않은
        // 스킴으로 가는 이동을 NavigationStarting 없이 버린다)
        let s = send.clone();
        webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut p = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut p).is_err() {
                    return Ok(());
                }
                if let Ok(u) = take_pwstr(p).parse::<tauri::Url>()
                    && u.scheme() == "thuminal-key"
                    && let Some(ev) = bridge_event(id, &u)
                {
                    s(ev);
                }
                Ok(())
            })),
            &mut token,
        )?;
        let s = send.clone();
        webview.add_ContentLoading(
            &ContentLoadingEventHandler::create(Box::new(move |w, _| {
                if let Some(w) = w {
                    s(BrowserEvent::Load { id, url: url_of(&w), loading: true });
                }
                Ok(())
            })),
            &mut token,
        )?;
        let s = send.clone();
        webview.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |w, _| {
                if let Some(w) = w {
                    s(BrowserEvent::Load { id, url: url_of(&w), loading: false });
                }
                Ok(())
            })),
            &mut token,
        )?;
        let s = send.clone();
        webview.add_DocumentTitleChanged(
            &DocumentTitleChangedEventHandler::create(Box::new(move |w, _| {
                let Some(w) = w else { return Ok(()) };
                let mut p = PWSTR::null();
                w.DocumentTitle(&mut p)?;
                s(BrowserEvent::Title { id, title: take_pwstr(p) });
                Ok(())
            })),
            &mut token,
        )?;
        let s = send.clone();
        webview.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut p = PWSTR::null();
                args.Uri(&mut p)?;
                args.SetHandled(true)?;
                s(BrowserEvent::NewWindow { id, url: take_pwstr(p) });
                Ok(())
            })),
            &mut token,
        )?;
        let s = send.clone();
        comp.add_CursorChanged(
            &CursorChangedEventHandler::create(Box::new(move |c, _| {
                let Some(c) = c else { return Ok(()) };
                let mut cursor = 0u32;
                c.SystemCursorId(&mut cursor)?;
                s(BrowserEvent::Cursor { id, cursor: css_cursor(cursor).to_string() });
                Ok(())
            })),
            &mut token,
        )?;
        // 앱 단축키는 페이지보다 먼저 받는다. WebView2 는 Ctrl+Alt+글자를 AltGr 로 보고 페이지 keydown 을
        // 내지 않아 페이지 스크립트(BRIDGE)로는 ⌘⌥A 같은 키를 넘기지 못한다
        let s = send;
        let controller: ICoreWebView2Controller = comp.cast()?;
        controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                    return Ok(());
                }
                let mut vk = 0u32;
                args.VirtualKey(&mut vk)?;
                // 키는 WebView2 의 다른 프로세스 창이 받으므로 이 스레드 키 상태가 아니라 지금 눌린 상태를 본다
                let held = |k: u16| GetAsyncKeyState(k as i32) < 0;
                let (ctrl, alt, shift) = (held(VK_CONTROL.0), held(VK_MENU.0), held(VK_SHIFT.0));
                if let Some((key, code)) = app_key(vk, ctrl, alt, shift) {
                    args.SetHandled(true)?;
                    s(BrowserEvent::Key { id, key, code, alt, shift, ctrl });
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

/// 앱 단축키로 넘길 키면 KeyboardEvent 의 (key, code). 규칙은 BRIDGE 와 같다: Ctrl 을 누른 키 가운데 편집 키
/// (Ctrl+C V X A Z Y F, Shift · Alt 없이)는 페이지 몫이다. 그 밖에 Alt+1~9(탭) · Alt+←→(방문 기록)도 넘긴다
fn app_key(vk: u32, ctrl: bool, alt: bool, shift: bool) -> Option<(String, String)> {
    let (key, code) = match vk {
        0x30..=0x39 => {
            let d = char::from_u32(vk)?.to_string();
            (d.clone(), format!("Digit{d}"))
        }
        0x41..=0x5A => {
            let c = char::from_u32(vk)?;
            let key = if shift { c } else { c.to_ascii_lowercase() };
            (key.to_string(), format!("Key{c}"))
        }
        0x70..=0x7B => (format!("F{}", vk - 0x6F), format!("F{}", vk - 0x6F)),
        0x25 => ("ArrowLeft".into(), "ArrowLeft".into()),
        0x26 => ("ArrowUp".into(), "ArrowUp".into()),
        0x27 => ("ArrowRight".into(), "ArrowRight".into()),
        0x28 => ("ArrowDown".into(), "ArrowDown".into()),
        0x0D => ("Enter".into(), "Enter".into()),
        0x08 => ("Backspace".into(), "Backspace".into()),
        0x09 => ("Tab".into(), "Tab".into()),
        0xBB => ("=".into(), "Equal".into()),
        0xBD => ("-".into(), "Minus".into()),
        0xBC => (",".into(), "Comma".into()),
        0xBE => (".".into(), "Period".into()),
        0xBF => ("/".into(), "Slash".into()),
        0xBA => (";".into(), "Semicolon".into()),
        0xDE => ("'".into(), "Quote".into()),
        0xC0 => ("`".into(), "Backquote".into()),
        0xDB => ("[".into(), "BracketLeft".into()),
        0xDD => ("]".into(), "BracketRight".into()),
        0xDC => ("\\".into(), "Backslash".into()),
        _ => return None,
    };
    if ctrl {
        let editing = !alt && !shift && matches!(vk, 0x43 | 0x56 | 0x58 | 0x41 | 0x5A | 0x59 | 0x46);
        return (!editing).then_some((key, code));
    }
    let tab = (0x31..=0x39).contains(&vk);
    let history = vk == 0x25 || vk == 0x27;
    (alt && !shift && (tab || history)).then_some((key, code))
}

/// 시스템 커서 번호(IDC_*) → CSS cursor
fn css_cursor(id: u32) -> &'static str {
    match id {
        32513 => "text",
        32514 => "wait",
        32515 => "crosshair",
        32642 => "nwse-resize",
        32643 => "nesw-resize",
        32644 => "ew-resize",
        32645 => "ns-resize",
        32646 => "move",
        32648 => "not-allowed",
        32649 => "pointer",
        32650 => "progress",
        32651 => "help",
        _ => "default",
    }
}

/// 칸 하나에 메인 스레드 일을 시킨다
async fn with_view<T: Send + 'static>(app: &AppHandle, label: String, f: impl FnOnce(&Comp, &mut View) -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    on_main(app, move |_| {
        STATE.with_borrow_mut(|s| {
            let State { comp, views, .. } = s;
            let c = comp.as_ref().ok_or("브라우저 칸을 찾지 못했어요")?;
            let v = views.get_mut(&label).ok_or_else(|| format!("브라우저 칸을 찾지 못했어요: {label}"))?;
            f(c, v)
        })
    })
    .await
}

pub async fn bounds(app: AppHandle, label: String, b: [f64; 4]) -> CmdResult<()> {
    with_view(&app, label, move |c, v| {
        place(c, v, b);
        Ok(())
    })
    .await
}

pub async fn visible(app: AppHandle, label: String, visible: bool) -> CmdResult<()> {
    on_main(&app, move |_| {
        STATE.with_borrow_mut(|s| {
            if let Some(p) = s.pending.get_mut(&label) {
                *p = visible;
                return Ok(());
            }
            let v = s.views.get_mut(&label).ok_or_else(|| format!("브라우저 칸을 찾지 못했어요: {label}"))?;
            v.visible = visible;
            unsafe { v.controller.SetIsVisible(visible) }.map_err(err)?;
            restack(s);
            Ok(())
        })
    })
    .await
}

pub async fn navigate(app: AppHandle, label: String, url: String) -> CmdResult<()> {
    with_view(&app, label, move |_, v| unsafe { v.webview.Navigate(&HSTRING::from(url.as_str())) }.map_err(err)).await
}

pub async fn go(app: AppHandle, label: String, delta: i32) -> CmdResult<()> {
    with_view(&app, label, move |_, v| {
        unsafe { v.webview.ExecuteScript(&HSTRING::from(format!("history.go({delta})")), None::<&ICoreWebView2ExecuteScriptCompletedHandler>) }.map_err(err)
    })
    .await
}

pub async fn reload(app: AppHandle, label: String) -> CmdResult<()> {
    with_view(&app, label, |_, v| unsafe { v.webview.Reload() }.map_err(err)).await
}

pub async fn focus(app: AppHandle, label: String) -> CmdResult<()> {
    with_view(&app, label, |_, v| unsafe { v.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) }.map_err(err)).await
}

pub async fn devtools(app: AppHandle, label: String) -> CmdResult<()> {
    with_view(&app, label, |_, v| unsafe { v.webview.OpenDevToolsWindow() }.map_err(err)).await
}

pub async fn close(app: AppHandle, label: String) -> CmdResult<()> {
    on_main(&app, move |_| {
        STATE.with_borrow_mut(|s| {
            s.pending.remove(&label);
            if let Some(v) = s.views.remove(&label) {
                let _ = unsafe { v.controller.Close() };
                restack(s);
            }
            Ok(())
        })
    })
    .await
}

/// 칸마다 마우스를 넘길 사각형과 쌓는 차례 (아래에서 위)
pub async fn layer(app: AppHandle, items: Vec<(String, Vec<[f64; 4]>)>) -> CmdResult<()> {
    on_main(&app, move |_| {
        STATE.with_borrow_mut(|s| {
            let order: Vec<String> = items.iter().map(|(l, _)| l.clone()).collect();
            let moved = order != s.order;
            s.rects = items.into_iter().collect();
            for (label, v) in s.views.iter_mut() {
                v.rects = s.rects.get(label).cloned().unwrap_or_default();
            }
            if moved {
                s.order = order;
                restack(s);
            }
            Ok(())
        })
    })
    .await
}

/// 화면이 칸 자리에서 받은 마우스 하나 (창 왼쪽 위 기준 논리 픽셀)
#[derive(Deserialize)]
pub struct Input {
    /// down, up, move, wheel, leave
    kind: String,
    x: f64,
    y: f64,
    /// 누르거나 뗀 단추 (DOM `button`: 0 왼쪽, 1 가운데, 2 오른쪽, 3 뒤로, 4 앞으로)
    #[serde(default)]
    button: i32,
    /// 눌려 있는 단추들 (DOM `buttons`)
    #[serde(default)]
    buttons: u32,
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    ctrl: bool,
    /// 휠 (CSS 픽셀, 아래 · 오른쪽이 +)
    #[serde(default)]
    dx: f64,
    #[serde(default)]
    dy: f64,
    /// 누른 횟수 (DOM `detail`). 2 면 두 번 누르기
    #[serde(default)]
    detail: u32,
}

const MK_LBUTTON: u32 = 0x1;
const MK_RBUTTON: u32 = 0x2;
const MK_SHIFT: u32 = 0x4;
const MK_CONTROL: u32 = 0x8;
const MK_MBUTTON: u32 = 0x10;
const MK_XBUTTON1: u32 = 0x20;
const MK_XBUTTON2: u32 = 0x40;

/// DOM `buttons` 비트 → MK_* 비트
fn keys(i: &Input) -> u32 {
    let b = i.buttons;
    let mut k = 0;
    for (dom, mk) in [(1, MK_LBUTTON), (2, MK_RBUTTON), (4, MK_MBUTTON), (8, MK_XBUTTON1), (16, MK_XBUTTON2)] {
        if b & dom != 0 {
            k |= mk;
        }
    }
    if i.shift {
        k |= MK_SHIFT;
    }
    if i.ctrl {
        k |= MK_CONTROL;
    }
    k
}

/// 단추 하나의 누르기 · 떼기 종류, 휠 자리 값(X 단추 번호), MK_* 비트
fn button_kind(button: i32, down: bool, double: bool) -> (COREWEBVIEW2_MOUSE_EVENT_KIND, u32, u32) {
    let pick = |d, dd, u| if !down { u } else if double { dd } else { d };
    match button {
        1 => (pick(COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK, COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP), 0, MK_MBUTTON),
        2 => (pick(COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP), 0, MK_RBUTTON),
        3 | 4 => (
            pick(COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOUBLE_CLICK, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP),
            if button == 3 { 1 } else { 2 },
            if button == 3 { MK_XBUTTON1 } else { MK_XBUTTON2 },
        ),
        _ => (pick(COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP), 0, MK_LBUTTON),
    }
}

/// 휠 CSS 픽셀 → WHEEL_DELTA 단위 (Chromium 은 한 칸을 100 픽셀로 준다)
fn wheel(px: f64) -> u32 {
    (px * 1.2).round() as i32 as u32
}

pub async fn input(app: AppHandle, label: String, i: Input) -> CmdResult<()> {
    with_view(&app, label, move |c, v| {
        let inside = v.rects.iter().any(|r| i.x >= r[0] && i.x < r[0] + r[2] && i.y >= r[1] && i.y < r[1] + r[3]);
        let s = scale(c.parent);
        let at = POINT { x: ((i.x - v.bounds[0]) * s).round() as i32, y: ((i.y - v.bounds[1]) * s).round() as i32 };
        let k = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(keys(&i) as i32);
        let comp = v.comp.clone();
        let send = |kind, data: u32, at: POINT| unsafe { comp.SendMouseInput(kind, k, data, at) }.map_err(err);
        match i.kind.as_str() {
            "down" if inside => {
                let (kind, data, bit) = button_kind(i.button, true, i.detail >= 2 && i.detail.is_multiple_of(2));
                send(kind, data, at)?;
                v.pressed |= bit;
                v.hover = true;
                unsafe { v.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) }.map_err(err)?;
            }
            "up" => {
                let (kind, data, bit) = button_kind(i.button, false, false);
                if v.pressed & bit != 0 || inside {
                    v.pressed &= !bit;
                    send(kind, data, at)?;
                }
            }
            "move" if inside || v.pressed != 0 => {
                v.hover = true;
                send(COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, 0, at)?;
            }
            "wheel" if inside => {
                if i.dy != 0.0 {
                    send(COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL, wheel(-i.dy), at)?;
                }
                if i.dx != 0.0 {
                    send(COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL, wheel(i.dx), at)?;
                }
            }
            "move" | "leave" if v.hover && v.pressed == 0 => {
                v.hover = false;
                unsafe { comp.SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE, 0, POINT::default()) }.map_err(err)?;
            }
            _ => {}
        }
        Ok(())
    })
    .await
}
