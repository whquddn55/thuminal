//! 앱 업데이트 (tauri-plugin-updater).
//!
//! GitHub Release 의 `latest.json` 을 보고 새 버전이 있으면 화면에 알린다. 설치는 사용자가 고를 때만 한다.
//! 내려받은 파일은 설치본을 만들 때 쓴 키(`TAURI_SIGNING_PRIVATE_KEY`)의 서명을 `tauri.conf.json` 의 공개 키로 확인한다.
//!
//! 내려받는 동안 진행(받은 바이트 · 전체 크기)을 화면에 채널로 보낸다. 화면은 앱이 다시 시작될 때까지 오른쪽 아래에 진행을 띄운다.
//!
//! 데몬은 건드리지 않는다. 데몬은 설치본 밖 복사본(`runtime/<데몬 빌드 id>/`, thuminal-client `runtime`)으로 돌아
//! 설치본을 바꿔도 그대로 산다 (Windows 도 덮어쓸 파일이 잠겨 있지 않고, Linux AppImage 도 마운트가 사라져도 산다).
//! 다시 시작한 앱이 떠 있는 데몬의 빌드 id 를 보고 다를 때만 세션을 남긴 채 다시 시작한다 (`replace_stale_daemon`).
//! 그때는 세션이 화면 저장본으로 되살아나고 claude 는 `--resume` 으로 이어지지만, 터미널 안에서 돌던 프로세스는 다시 시작해야 한다.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

use crate::CmdResult;

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

/// 설치 진행. 내려받는 동안 `download` 를 여러 번, 다 받으면 `install` 을 한 번 보낸다
#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case", tag = "phase")]
pub enum UpdateProgress {
    /// total: 전체 바이트 (서버가 알려 주지 않으면 null)
    Download { downloaded: u64, total: Option<u64> },
    Install,
}

/// 진행을 이 간격에 한 번까지만 보낸다 (조각마다 보내면 화면이 바쁘다)
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

/// 확인해 둔 업데이트를 내려받아 설치하고 앱을 다시 시작한다
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>, progress: Channel<UpdateProgress>) -> CmdResult<()> {
    let update = pending.0.lock().await.take().ok_or("확인한 업데이트가 없어요")?;
    let mut downloaded = 0u64;
    let mut last: Option<Instant> = None;
    let on_chunk = |len: usize, total: Option<u64>| {
        downloaded += len as u64;
        let done = total.is_some_and(|t| downloaded >= t);
        if done || last.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
            last = Some(Instant::now());
            let _ = progress.send(UpdateProgress::Download { downloaded, total });
        }
    };
    let bytes = update.download(on_chunk, || {}).await.map_err(|e| format!("업데이트를 내려받지 못했어요: {e}"))?;
    let _ = progress.send(UpdateProgress::Install);
    tracing::info!(event = "update_install", version = %update.version);
    // Windows 는 설치 프로그램을 띄우고 앱이 끝난다. 설치 프로그램이 끝나면 앱을 다시 띄운다
    update.install(bytes).map_err(|e| format!("업데이트를 설치하지 못했어요: {e}"))?;
    app.restart();
}

pub fn manage(app: &AppHandle) {
    app.manage(Pending::default());
}
