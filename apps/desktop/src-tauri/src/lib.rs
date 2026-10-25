//! thuminal 데스크톱 앱의 Tauri 껍데기.
//!
//! 화면(웹뷰)과 데몬 사이를 잇기만 한다. 화면 쪽 `TauriHostApi` 가 이 명령들을 부른다.
//! 세션 출력은 바이너리 채널로 흘린다 (JSON 이벤트는 바이트를 5~7배로 부풀린다).

mod browser;
mod notify;

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};
use thuminal_client::{Client, ClientError, default_daemon_bin};
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, RepoInfo, Request, Response, SessionId, SessionInfo, SnapshotFormat, WorktreeInfo};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Default)]
struct AppState {
    client: Mutex<Option<Arc<Client>>>,
    /// 붙어 있는 세션마다 출력을 채널로 옮기는 작업
    attachments: Mutex<HashMap<SessionId, JoinHandle<()>>>,
    /// 화면으로 이벤트를 보내는 채널. 데몬에 다시 붙으면 새 연결의 이벤트를 여기로 잇는다
    events: Mutex<Option<Channel<serde_json::Value>>>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: ClientError) -> String {
    e.to_string()
}

impl AppState {
    /// 데몬 연결. 끊겼으면 다시 붙고(없으면 띄우고), 화면에 다시 붙었다고 알린다
    async fn client(&self) -> CmdResult<Arc<Client>> {
        let mut slot = self.client.lock().await;
        if let Some(c) = slot.as_ref().filter(|c| !c.is_closed()) {
            return Ok(c.clone());
        }
        let reconnect = slot.is_some();
        let c = Arc::new(Client::connect_or_spawn(&Paths::default_home(), "desktop", &default_daemon_bin()).await.map_err(err)?);
        *slot = Some(c.clone());
        drop(slot);
        if reconnect {
            tracing::info!("데몬에 다시 붙었다");
            for (_, t) in self.attachments.lock().await.drain() {
                t.abort();
            }
            if let Some(ch) = self.events.lock().await.clone() {
                forward_events(&c, ch.clone());
                let _ = ch.send(serde_json::json!({ "type": "daemon_reconnected" }));
            }
        }
        Ok(c)
    }
}

fn forward_events(c: &Client, channel: Channel<serde_json::Value>) {
    let mut events = c.events();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(e) => {
                    if channel.send(serde_json::to_value(e).unwrap_or_default()).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

#[derive(Serialize)]
struct DaemonInfo {
    engine: String,
    version: String,
}

#[tauri::command]
async fn daemon_info(state: State<'_, AppState>) -> CmdResult<DaemonInfo> {
    let c = state.client().await?;
    match &c.daemon {
        Response::Hello { engine, daemon_version, .. } => Ok(DaemonInfo { engine: engine.clone(), version: daemon_version.clone() }),
        other => Err(format!("예상하지 못한 hello 응답: {other:?}")),
    }
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>) -> CmdResult<Vec<SessionInfo>> {
    state.client().await?.list().await.map_err(err)
}

#[tauri::command]
async fn create_session(state: State<'_, AppState>, req: CreateSession) -> CmdResult<SessionInfo> {
    state.client().await?.create(req).await.map_err(err)
}

#[derive(Serialize)]
struct AttachResult {
    session: SessionInfo,
    format: SnapshotFormat,
}

/// 붙는다. 저장본을 채널의 첫 메시지로 보내고, 그 뒤 출력을 이어 보낸다.
#[tauri::command]
async fn attach(state: State<'_, AppState>, id: SessionId, format: SnapshotFormat, channel: Channel<InvokeResponseBody>) -> CmdResult<AttachResult> {
    let c = state.client().await?;
    let mut at = c.attach(id, format).await.map_err(err)?;
    channel.send(InvokeResponseBody::Raw(std::mem::take(&mut at.snapshot))).map_err(|e| e.to_string())?;
    let task = tokio::spawn(async move {
        while let Some(chunk) = at.output.recv().await {
            if channel.send(InvokeResponseBody::Raw(chunk)).is_err() {
                break;
            }
        }
    });
    if let Some(old) = state.attachments.lock().await.insert(id, task) {
        old.abort();
    }
    Ok(AttachResult { session: at.session, format: at.format })
}

#[tauri::command]
async fn detach(state: State<'_, AppState>, id: SessionId) -> CmdResult<()> {
    if let Some(t) = state.attachments.lock().await.remove(&id) {
        t.abort();
    }
    state.client().await?.detach(id).await.map_err(err)
}

#[tauri::command]
async fn input(state: State<'_, AppState>, id: SessionId, data: Vec<u8>) -> CmdResult<()> {
    state.client().await?.input(id, data).await.map_err(err)
}

#[tauri::command]
async fn resize(state: State<'_, AppState>, id: SessionId, cols: u16, rows: u16) -> CmdResult<()> {
    state.client().await?.resize(id, cols, rows).await.map(|_| ()).map_err(err)
}

#[tauri::command]
async fn set_labels(state: State<'_, AppState>, id: SessionId, labels: std::collections::BTreeMap<String, String>) -> CmdResult<()> {
    state
        .client()
        .await?
        .request(thuminal_protocol::Request::SetLabels { session: id, labels })
        .await
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
async fn kill(state: State<'_, AppState>, id: SessionId) -> CmdResult<()> {
    state.client().await?.kill(id).await.map_err(err)
}

#[tauri::command]
async fn remove(state: State<'_, AppState>, id: SessionId) -> CmdResult<()> {
    state.client().await?.remove(id).await.map_err(err)
}

#[tauri::command]
async fn list_repos(state: State<'_, AppState>) -> CmdResult<Vec<RepoInfo>> {
    state.client().await?.repos().await.map_err(err)
}

#[tauri::command]
async fn add_repo(state: State<'_, AppState>, path: String) -> CmdResult<RepoInfo> {
    state.client().await?.add_repo(path).await.map_err(err)
}

#[tauri::command]
async fn remove_repo(state: State<'_, AppState>, repo: String) -> CmdResult<()> {
    state.client().await?.request(Request::RemoveRepo { repo }).await.map(|_| ()).map_err(err)
}

#[tauri::command]
async fn list_worktrees(state: State<'_, AppState>) -> CmdResult<Vec<WorktreeInfo>> {
    state.client().await?.worktrees(None).await.map_err(err)
}

#[tauri::command]
async fn create_worktree(state: State<'_, AppState>, repo: String, branch: String, base: Option<String>) -> CmdResult<WorktreeInfo> {
    state.client().await?.create_worktree(repo, branch, base).await.map_err(err)
}

#[tauri::command]
/// 알릴 것(예: 합치지 않은 브랜치를 남겼다)이 있으면 그 글, 없으면 빈 글. `forceBranch` 를 빼면 합친 브랜치만 지운다
async fn remove_worktree(
    state: State<'_, AppState>,
    repo: String,
    path: String,
    force: bool,
    delete_branch: bool,
    force_branch: Option<bool>,
) -> CmdResult<String> {
    state.client().await?.remove_worktree(repo, path, force, delete_branch, force_branch.unwrap_or(false)).await.map_err(err)
}

/// 데몬 요청을 그대로 넘긴다 (git, 파일, 워크트리 정보 등). 화면 쪽이 프로토콜 모양대로 요청을 만든다.
/// 요청마다 명령을 따로 만들지 않아 껍데기가 얇게 남는다.
#[tauri::command]
async fn daemon_request(state: State<'_, AppState>, request: Request) -> CmdResult<Response> {
    state.client().await?.request(request).await.map_err(err)
}

/// 데몬 이벤트를 채널로 흘린다. 화면이 새로 고쳐지면 다시 부른다.
/// 데몬 이벤트 말고도 `{"type":"daemon_reconnected"}` 가 온다.
#[tauri::command]
async fn subscribe_events(state: State<'_, AppState>, channel: Channel<serde_json::Value>) -> CmdResult<()> {
    let c = state.client().await?;
    *state.events.lock().await = Some(channel.clone());
    forward_events(&c, channel);
    Ok(())
}

#[derive(Serialize)]
struct FontFaceInfo {
    /// font_face_data 로 바이트를 받을 때 쓰는 번호
    id: usize,
    weight: u16,
    italic: bool,
}

/// 설치된 글꼴 목록. WebKit 은 사용자가 설치한 글꼴(~/Library/Fonts)을 웹 콘텐츠에 보이지 않으므로
/// 화면이 이 파일들을 FontFace 로 직접 등록한다.
struct Fonts {
    db: fontdb::Database,
    faces: Vec<fontdb::ID>,
}

fn fonts() -> &'static std::sync::Mutex<Fonts> {
    static FONTS: std::sync::OnceLock<std::sync::Mutex<Fonts>> = std::sync::OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        std::sync::Mutex::new(Fonts { db, faces: Vec::new() })
    })
}

#[tauri::command]
async fn font_faces(family: String) -> CmdResult<Vec<FontFaceInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut f = fonts().lock().unwrap();
        let ids: Vec<_> = f
            .db
            .faces()
            .filter(|face| face.families.iter().any(|(name, _)| name.eq_ignore_ascii_case(&family)))
            .map(|face| (face.id, face.weight.0, face.style != fontdb::Style::Normal))
            .collect();
        ids.into_iter()
            .map(|(id, weight, italic)| {
                f.faces.push(id);
                FontFaceInfo { id: f.faces.len() - 1, weight, italic }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn font_face_data(id: usize) -> CmdResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let f = fonts().lock().unwrap();
        let face = *f.faces.get(id).ok_or("글꼴 번호가 없다")?;
        f.db.with_face_data(face, |data, _| data.to_vec())
            .map(tauri::ipc::Response::new)
            .ok_or_else(|| "글꼴 파일을 읽지 못했다".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 앱 메뉴. Tauri 기본 메뉴에는 "윈도우 닫기 ⌘W" 가 있어 웹뷰보다 먼저 ⌘W 를 받아 앱 창을 닫아 버린다.
/// ⌘W 는 칸 닫기(화면 단축키)이므로 그 항목만 빼고 기본 메뉴와 같게 만든다
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let name = app.package_info().name.clone();
    let main = SubmenuBuilder::new(app, &name).about(None).separator().services().separator().hide().hide_others().show_all().separator().quit().build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    MenuBuilder::new(app).items(&[&main, &edit, &view, &window]).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState::default());
            app.set_menu(app_menu(app.handle())?)?;
            // 데몬이 내려가거나 다시 뜨면 2초 안에 다시 붙는다
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let state = handle.state::<AppState>();
                    let closed = state.client.lock().await.as_ref().is_some_and(|c| c.is_closed());
                    if closed {
                        let _ = state.client().await;
                    }
                }
            });
            // 터미널 데몬 밑에서 띄우면 창이 저절로 올라오지 않을 때가 있어 직접 띄운다
            if let Some(w) = app.get_webview_window("main") {
                w.show()?;
                w.set_focus()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_info,
            list_sessions,
            create_session,
            attach,
            detach,
            input,
            resize,
            set_labels,
            kill,
            remove,
            subscribe_events,
            font_faces,
            font_face_data,
            list_repos,
            add_repo,
            remove_repo,
            list_worktrees,
            create_worktree,
            remove_worktree,
            daemon_request,
            notify::notify,
            notify::set_badge,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_visible,
            browser::browser_navigate,
            browser::browser_go,
            browser::browser_reload,
            browser::browser_focus,
            browser::browser_devtools,
            browser::browser_close
        ])
        .run(tauri::generate_context!())
        .expect("thuminal 앱을 띄우지 못했다");
}
