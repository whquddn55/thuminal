//! 앱 업데이트 (tauri-plugin-updater).
//!
//! GitHub Release 의 `latest.json` 을 보고 새 버전이 있으면 화면에 알린다. 설치는 사용자가 고를 때만 한다.
//! 내려받은 파일은 설치본을 만들 때 쓴 키(`TAURI_SIGNING_PRIVATE_KEY`)의 서명을 `tauri.conf.json` 의 공개 키로 확인한다.
//!
//! 설치 전에 로컬 데몬을 세션을 남긴 채 내린다(`Request::Restart`). 앱만 새 버전이 되고 옛 데몬이 남으면 기능이 맞지 않고,
//! Windows 는 떠 있는 `thuminald.exe` 를 덮어쓰지 못한다. 다시 시작한 앱이 새 데몬을 띄우면 세션이 화면 저장본으로
//! 되살아나고 claude 는 `--resume` 으로 이어진다. 터미널 안에서 돌던 프로세스는 다시 시작해야 한다.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

use crate::{AppState, CmdResult};

/// 마지막으로 확인한 업데이트 (설치할 때 그대로 쓴다)
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    /// 새 버전
    version: String,
    /// 지금 버전
    current: String,
    /// 릴리스 설명
    notes: Option<String>,
}

/// 새 버전이 있는지 본다. 없으면 null
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> CmdResult<Option<UpdateInfo>> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("업데이트를 확인하지 못했어요: {e}"))?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), current: u.current_version.clone(), notes: u.body.clone() });
    *pending.0.lock().await = update;
    Ok(info)
}

/// 확인해 둔 업데이트를 내려받아 설치하고 앱을 다시 시작한다
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>, state: State<'_, AppState>) -> CmdResult<()> {
    let update = pending.0.lock().await.take().ok_or("확인한 업데이트가 없어요")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| format!("업데이트를 내려받지 못했어요: {e}"))?;
    state.stop_local_daemon().await;
    tracing::info!(event = "update_install", version = %update.version);
    // Windows 는 설치 프로그램을 띄우고 앱이 끝난다. 설치 프로그램이 끝나면 앱을 다시 띄운다
    update.install(bytes).map_err(|e| format!("업데이트를 설치하지 못했어요: {e}"))?;
    app.restart();
}

pub fn manage(app: &AppHandle) {
    app.manage(Pending::default());
}
