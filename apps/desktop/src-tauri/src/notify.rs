//! macOS 알림과 Dock 배지.
//!
//! 앱이 macOS 알림 API(`UNUserNotificationCenter`)로 직접 보낸다. 이름 · 아이콘은 앱 번들 것이고, 누르면
//! `thuminal://notification-click` 으로 화면에 세션 번호를 넘겨 그 칸으로 간다. 이 API 는 `.app` 번들 안에서 도는
//! 프로세스만 쓸 수 있다. 개발 앱은 `scripts/dev-app-runner.sh` 가 `thuminal-dev.app` 번들 안에서 실행한다.
//! 번들 밖이면(실행 파일을 바로 실행했을 때) `osascript` 로 보낸다. 그 알림은 스크립트 편집기 이름으로 뜨고 눌러도 칸으로 가지 않는다.
//!
//! `mac-notification-sys`(Tauri 알림 플러그인도 속으로 쓴다)는 쓰지 않는다. 처음 알림을 보낼 때 `NSBundle` 의 번들 id 를
//! 바꿔치기(swizzle)해서, 그 뒤로 앱이 macOS 에 Finder 로 보이게 된다. 그러면 입력기(IMK)와의 통신이 키마다 막혀
//! 입력이 몇 초씩 늦고 창 끌기도 먹지 않았다 (2026-10-25 개발 앱에서 겪었다). 알림 API 를 직접 부르면 번들 id 를 건드리지 않는다.

use tauri::{AppHandle, Emitter, Manager};

type CmdResult<T> = Result<T, String>;

/// 알림을 누르면 화면이 받는 이벤트 (`tauri-host.ts` `onNotificationClick`)
const CLICK_EVENT: &str = "thuminal://notification-click";

/// 알림 위임자를 단다 (앱 setup 에서 한 번)
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        mac::init(Box::new(move |session| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit(CLICK_EVENT, serde_json::json!({ "session": session }));
        }));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// AppleScript 글자 따옴표
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 번들 밖에서 보낸다. 따로 띄운 프로세스가 알리므로 앱의 번들 정보는 건드리지 않는다
fn notify_osascript(title: &str, subtitle: Option<&str>, body: &str, sound: bool) -> CmdResult<()> {
    let mut script = format!("display notification {} with title {}", quote(body), quote(title));
    if let Some(s) = subtitle {
        script.push_str(&format!(" subtitle {}", quote(s)));
    }
    if sound {
        script.push_str(" sound name \"default\"");
    }
    std::process::Command::new("osascript").args(["-e", &script]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 알림을 띄운다. 누르면 `session` 이 화면으로 돌아온다
#[tauri::command]
pub async fn notify(title: String, subtitle: Option<String>, body: String, session: u64, sound: bool) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    if mac::bundled() {
        mac::post(&title, subtitle.as_deref(), &body, session, sound);
        return Ok(());
    }
    let _ = session;
    notify_osascript(&title, subtitle.as_deref(), &body, sound)
}

/// Dock 배지 숫자. 0 이면 지운다
#[tauri::command]
pub async fn set_badge(app: AppHandle, count: u32) -> CmdResult<()> {
    let w = app.get_webview_window("main").ok_or("메인 창을 찾지 못했어요")?;
    w.set_badge_count(if count == 0 { None } else { Some(count as i64) }).map_err(|e| e.to_string())
}

/// `UNUserNotificationCenter` 로 보내고, 누르면 세션 번호를 넘긴다
#[cfg(target_os = "macos")]
mod mac {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    type OnClick = Box<dyn Fn(u64) + Send + Sync>;

    /// 알림 요청 id 머리. 뒤에 `<세션>-<차례>` 가 붙는다
    const PREFIX: &str = "thuminal-";

    pub struct Ivars {
        on_click: OnClick,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// 앱이 앞에 있어도 띄운다 (보고 있는 칸이면 화면이 애초에 보내지 않는다)
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, _n: &UNNotification, handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, handler: &block2::DynBlock<dyn Fn()>) {
                let id = response.notification().request().identifier().to_string();
                if let Some(session) = id.strip_prefix(PREFIX).and_then(|r| r.split('-').next()).and_then(|s| s.parse().ok()) {
                    (self.ivars().on_click)(session);
                }
                handler.call(());
            }
        }
    );

    /// 이 프로세스가 `.app` 번들 안에서 도는지. 아니면 알림 센터를 부르는 순간 Objective-C 예외로 죽는다
    pub fn bundled() -> bool {
        let b = NSBundle::mainBundle();
        b.bundleIdentifier().is_some() && b.bundlePath().to_string().ends_with(".app")
    }

    /// 위임자를 단다. 알림 센터는 위임자를 약하게 들므로 프로세스가 끝날 때까지 놓지 않는다
    pub fn init(on_click: OnClick) {
        static DELEGATE: OnceLock<usize> = OnceLock::new();
        if !bundled() {
            return;
        }
        DELEGATE.get_or_init(|| {
            let d = Delegate::alloc().set_ivars(Ivars { on_click });
            let d: Retained<Delegate> = unsafe { msg_send![super(d), init] };
            UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*d)));
            Retained::into_raw(d) as usize
        });
    }

    /// 알림을 보낸다. 처음이면 허락을 묻고(이미 정했으면 바로 답이 온다) 허락됐을 때 보낸다
    pub fn post(title: &str, subtitle: Option<&str>, body: &str, session: u64, sound: bool) {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        if let Some(s) = subtitle {
            content.setSubtitle(&NSString::from_str(s));
        }
        content.setBody(&NSString::from_str(body));
        if sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        let id = format!("{PREFIX}{session}-{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let done = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            if !granted.as_bool() {
                let why = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_default();
                tracing::warn!(event = "notify_denied", "알림 허락이 없다 {why}");
                return;
            }
            UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
        });
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge, &done);
    }
}
