//! macOS 알림과 Dock 배지.
//!
//! `mac-notification-sys`(Tauri 알림 플러그인도 속으로 쓴다)는 쓰지 않는다. 처음 알림을 보낼 때 `NSBundle` 의 번들 id 를
//! 바꿔치기(swizzle)해서, 그 뒤로 앱이 macOS 에 Finder 로 보이게 된다. 그러면 입력기(IMK)와의 통신이 키마다 막혀
//! 입력이 몇 초씩 늦고 창 끌기도 먹지 않았다 (2026-10-25 개발 앱에서 겪었다).

use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, String>;

/// AppleScript 글자 따옴표
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 알림을 띄운다. 지금은 `osascript display notification` 이라 눌러도 그 칸으로 가지 않는다
#[tauri::command]
pub async fn notify(title: String, subtitle: Option<String>, body: String, session: u64, sound: bool) -> CmdResult<()> {
    let _ = session;
    let mut script = format!("display notification {} with title {}", quote(&body), quote(&title));
    if let Some(s) = subtitle.as_deref() {
        script.push_str(&format!(" subtitle {}", quote(s)));
    }
    if sound {
        script.push_str(" sound name \"default\"");
    }
    // 앱 프로세스가 아니라 따로 띄운 프로세스가 알리므로 앱의 번들 정보는 건드리지 않는다
    std::process::Command::new("osascript").args(["-e", &script]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Dock 배지 숫자. 0 이면 지운다
#[tauri::command]
pub async fn set_badge(app: AppHandle, count: u32) -> CmdResult<()> {
    let w = app.get_webview_window("main").ok_or("메인 창이 없다")?;
    w.set_badge_count(if count == 0 { None } else { Some(count as i64) }).map_err(|e| e.to_string())
}
