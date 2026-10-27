//! thuminal 데스크톱 앱의 Tauri 껍데기.
//!
//! 화면(웹뷰)과 데몬 사이를 잇기만 한다. 화면 쪽 `TauriHostApi` 가 이 명령들을 부른다.
//! 세션 출력은 바이너리 채널로 흘린다 (JSON 이벤트는 바이트를 5~7배로 부풀린다).
//!
//! 데몬은 로컬 하나와 원격 호스트 여럿이다 (`hosts.rs`). 데몬에 닿는 명령은 `host`(원격 호스트 id)를 받고,
//! 없으면 로컬이다. 세션·칸 번호는 데몬마다 따로 세므로 붙기·이벤트 채널도 호스트마다 따로 둔다.

mod browser;
mod hosts;
mod media;
mod notify;

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use thuminal_client::link::{Link, LinkState};
use thuminal_client::{Client, ClientError, default_daemon_bin};
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, RepoInfo, Request, Response, SessionId, SessionInfo, SnapshotFormat, WorktreeInfo};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// 원격 호스트 id. None 이면 로컬 데몬
type HostKey = Option<String>;

/// 화면으로 이벤트를 보내는 채널과, 그 채널에 이벤트를 잇는 데 쓴 연결 번호
struct EventSink {
    channel: Channel<serde_json::Value>,
    /// 원격 호스트의 `LinkStatus.generation`. 새 연결이 생기면 다시 잇는다 (로컬은 쓰지 않는다)
    generation: u64,
}

/// 등록한 원격 호스트 하나
struct Remote {
    record: hosts::HostRecord,
    link: Arc<Link>,
    /// 연결 상태를 지켜보며 화면에 알리고, 다시 붙으면 이벤트를 다시 잇는 작업
    watcher: JoinHandle<()>,
}

impl Drop for Remote {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

#[derive(Default)]
struct AppState {
    client: Mutex<Option<Arc<Client>>>,
    remotes: std::sync::Mutex<HashMap<String, Remote>>,
    /// 붙어 있는 세션마다 출력을 채널로 옮기는 작업
    attachments: Mutex<HashMap<(HostKey, SessionId), JoinHandle<()>>>,
    /// 호스트마다 화면으로 이벤트를 보내는 채널. 데몬에 다시 붙으면 새 연결의 이벤트를 여기로 잇는다
    events: Mutex<HashMap<HostKey, EventSink>>,
    /// 원격 호스트 목록이 바뀌거나 연결 상태가 바뀌면 목록을 통째로 보내는 채널들
    host_watchers: std::sync::Mutex<Vec<Channel<Vec<hosts::HostView>>>>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: ClientError) -> String {
    e.to_string()
}

impl AppState {
    /// `host` 의 데몬 연결. 원격이 끊겨 있으면 오류
    async fn client(&self, host: Option<&str>) -> CmdResult<Arc<Client>> {
        let Some(id) = host else { return self.local().await };
        let remotes = self.remotes.lock().unwrap();
        let r = remotes.get(id).ok_or_else(|| format!("등록하지 않은 원격 컴퓨터예요: {id}"))?;
        r.link.client().ok_or_else(|| {
            let s = r.link.current();
            let why = s.error.map(|e| format!(" ({e})")).unwrap_or_default();
            format!("원격 컴퓨터에 연결돼 있지 않아요: {}{why}", r.record.name)
        })
    }

    /// 로컬 데몬 연결. 끊겼으면 다시 붙고(없으면 띄우고), 화면에 다시 붙었다고 알린다
    async fn local(&self) -> CmdResult<Arc<Client>> {
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
            self.reconnected(&None, &c, 0).await;
        }
        Ok(c)
    }

    /// 데몬에 새로 붙었다: 그 호스트의 옛 붙기를 걷고, 이벤트를 새 연결에서 잇고, 화면에 다시 붙으라고 알린다
    async fn reconnected(&self, host: &HostKey, c: &Client, generation: u64) {
        self.attachments.lock().await.retain(|(h, _), t| {
            let keep = h != host;
            if !keep {
                t.abort();
            }
            keep
        });
        if let Some(sink) = self.events.lock().await.get_mut(host) {
            sink.generation = generation;
            forward_events(c, sink.channel.clone());
            let _ = sink.channel.send(serde_json::json!({ "type": "daemon_reconnected" }));
        }
    }

    fn host_views(&self) -> Vec<hosts::HostView> {
        let remotes = self.remotes.lock().unwrap();
        let mut v: Vec<_> = remotes.values().map(|r| (r.record.added_at, hosts::view(&r.record, &r.link.current()))).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
        v.into_iter().map(|(_, h)| h).collect()
    }

    fn notify_hosts(&self) {
        let views = self.host_views();
        self.host_watchers.lock().unwrap().retain(|ch| ch.send(views.clone()).is_ok());
    }

    fn save_hosts(&self) -> CmdResult<()> {
        let mut records: Vec<_> = self.remotes.lock().unwrap().values().map(|r| r.record.clone()).collect();
        records.sort_by_key(|r| r.added_at);
        hosts::save(&hosts::file(&Paths::default_home().home), &records).map_err(|e| format!("hosts.json 을 쓰지 못했어요: {e}"))
    }
}

/// 원격 호스트 하나의 연결을 띄운다. 연결 상태가 바뀌면 화면에 알리고, 새로 붙으면 이벤트를 잇는다.
/// `replaced` 는 같은 호스트의 옛 연결을 갈아 끼운 것이라, 처음 붙어도 화면에 다시 붙으라고 알린다
fn start_remote(app: &AppHandle, record: hosts::HostRecord, replaced: bool) -> Remote {
    let (base, token) = (record.base.clone(), record.token.clone());
    let link = Arc::new(Link::spawn(move || {
        let (base, token) = (base.clone(), token.clone());
        async move { Client::connect_ws(&base, &token, "desktop").await }
    }));
    let (app, l, id) = (app.clone(), link.clone(), record.id.clone());
    let watcher = tokio::spawn(async move {
        let mut st = l.status();
        let mut seen = 0;
        loop {
            let (state, generation) = {
                let s = st.borrow_and_update();
                (s.state, s.generation)
            };
            let state_ref = app.state::<AppState>();
            if state == LinkState::Connected
                && generation > seen
                && let Some(c) = l.client()
            {
                if seen == 0 && !replaced {
                    // 처음 붙었다: 화면이 미리 구독해 두었으면 이벤트를 잇는다
                    if let Some(sink) = state_ref.events.lock().await.get_mut(&Some(id.clone())).filter(|s| s.generation < generation) {
                        sink.generation = generation;
                        forward_events(&c, sink.channel.clone());
                    }
                } else {
                    tracing::info!(host = %id, "원격 데몬에 다시 붙었다");
                    state_ref.reconnected(&Some(id.clone()), &c, generation).await;
                }
                seen = generation;
            }
            state_ref.notify_hosts();
            if st.changed().await.is_err() {
                break;
            }
        }
    });
    Remote { record, link, watcher }
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
    /// 프로토콜 [주 판, 부 판]. 화면이 새 요청을 보내도 되는지 본다
    protocol: [u32; 2],
}

#[tauri::command]
async fn daemon_info(state: State<'_, AppState>, host: Option<String>) -> CmdResult<DaemonInfo> {
    let c = state.client(host.as_deref()).await?;
    match &c.daemon {
        Response::Hello { engine, daemon_version, protocol_major, protocol_minor, .. } => {
            Ok(DaemonInfo { engine: engine.clone(), version: daemon_version.clone(), protocol: [*protocol_major, *protocol_minor] })
        }
        other => Err(format!("예상하지 못한 hello 응답: {other:?}")),
    }
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>, host: Option<String>) -> CmdResult<Vec<SessionInfo>> {
    state.client(host.as_deref()).await?.list().await.map_err(err)
}

#[tauri::command]
async fn create_session(state: State<'_, AppState>, host: Option<String>, req: CreateSession) -> CmdResult<SessionInfo> {
    state.client(host.as_deref()).await?.create(req).await.map_err(err)
}

#[derive(Serialize)]
struct AttachResult {
    session: SessionInfo,
    format: SnapshotFormat,
}

/// 붙는다. 저장본을 채널의 첫 메시지로 보내고, 그 뒤 출력을 이어 보낸다.
#[tauri::command]
async fn attach(
    state: State<'_, AppState>,
    host: Option<String>,
    id: SessionId,
    format: SnapshotFormat,
    channel: Channel<InvokeResponseBody>,
) -> CmdResult<AttachResult> {
    let c = state.client(host.as_deref()).await?;
    let mut at = c.attach(id, format).await.map_err(err)?;
    channel.send(InvokeResponseBody::Raw(std::mem::take(&mut at.snapshot))).map_err(|e| e.to_string())?;
    let task = tokio::spawn(async move {
        while let Some(chunk) = at.output.recv().await {
            if channel.send(InvokeResponseBody::Raw(chunk)).is_err() {
                break;
            }
        }
    });
    if let Some(old) = state.attachments.lock().await.insert((host, id), task) {
        old.abort();
    }
    Ok(AttachResult { session: at.session, format: at.format })
}

#[tauri::command]
async fn detach(state: State<'_, AppState>, host: Option<String>, id: SessionId) -> CmdResult<()> {
    if let Some(t) = state.attachments.lock().await.remove(&(host.clone(), id)) {
        t.abort();
    }
    state.client(host.as_deref()).await?.detach(id).await.map_err(err)
}

/// 앱 화면 전체 배율 (⌘+ ⌘- 를 터미널 밖에서 눌렀을 때)
#[tauri::command]
fn set_ui_zoom(app: tauri::AppHandle, scale: f64) -> CmdResult<()> {
    let w = app.get_webview("main").ok_or("메인 웹뷰를 찾지 못했어요")?;
    w.set_zoom(scale.clamp(0.3, 3.0)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn input(state: State<'_, AppState>, host: Option<String>, id: SessionId, data: Vec<u8>) -> CmdResult<()> {
    let c = state.client(host.as_deref()).await?;
    // 이 연결에서 붙지 않은 세션에는 넣지 않는다. 데몬이 다시 뜨면 세션 번호를 다시 쓰므로, 화면이 새로 붙기 전의
    // 입력(옛 프로그램이 켠 마우스 모드로 만든 보고 등)이 새로 뜬 셸에 글자로 들어갔다
    if !state.attachments.lock().await.contains_key(&(host, id)) {
        return Ok(());
    }
    c.input(id, data).await.map_err(err)
}

#[tauri::command]
async fn resize(state: State<'_, AppState>, host: Option<String>, id: SessionId, cols: u16, rows: u16) -> CmdResult<()> {
    state.client(host.as_deref()).await?.resize(id, cols, rows).await.map(|_| ()).map_err(err)
}

#[tauri::command]
async fn set_labels(
    state: State<'_, AppState>,
    host: Option<String>,
    id: SessionId,
    labels: std::collections::BTreeMap<String, String>,
) -> CmdResult<()> {
    state
        .client(host.as_deref())
        .await?
        .request(thuminal_protocol::Request::SetLabels { session: id, labels })
        .await
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
async fn kill(state: State<'_, AppState>, host: Option<String>, id: SessionId) -> CmdResult<()> {
    state.client(host.as_deref()).await?.kill(id).await.map_err(err)
}

#[tauri::command]
async fn remove(state: State<'_, AppState>, host: Option<String>, id: SessionId) -> CmdResult<()> {
    state.client(host.as_deref()).await?.remove(id).await.map_err(err)
}

#[tauri::command]
async fn list_repos(state: State<'_, AppState>, host: Option<String>) -> CmdResult<Vec<RepoInfo>> {
    state.client(host.as_deref()).await?.repos().await.map_err(err)
}

#[tauri::command]
async fn add_repo(state: State<'_, AppState>, host: Option<String>, path: String) -> CmdResult<RepoInfo> {
    state.client(host.as_deref()).await?.add_repo(path).await.map_err(err)
}

#[tauri::command]
async fn remove_repo(state: State<'_, AppState>, host: Option<String>, repo: String) -> CmdResult<()> {
    state.client(host.as_deref()).await?.request(Request::RemoveRepo { repo }).await.map(|_| ()).map_err(err)
}

#[tauri::command]
async fn list_worktrees(state: State<'_, AppState>, host: Option<String>) -> CmdResult<Vec<WorktreeInfo>> {
    state.client(host.as_deref()).await?.worktrees(None).await.map_err(err)
}

#[tauri::command]
async fn create_worktree(state: State<'_, AppState>, host: Option<String>, repo: String, branch: String, base: Option<String>) -> CmdResult<WorktreeInfo> {
    state.client(host.as_deref()).await?.create_worktree(repo, branch, base, None).await.map_err(err)
}

#[tauri::command]
/// 알릴 것(예: 합치지 않은 브랜치를 남겼다)이 있으면 그 글, 없으면 빈 글. `forceBranch` 를 빼면 합친 브랜치만 지운다
async fn remove_worktree(
    state: State<'_, AppState>,
    host: Option<String>,
    repo: String,
    path: String,
    force: bool,
    delete_branch: bool,
    force_branch: Option<bool>,
) -> CmdResult<String> {
    state
        .client(host.as_deref())
        .await?
        .remove_worktree(repo, path, force, delete_branch, force_branch.unwrap_or(false))
        .await
        .map_err(err)
}

/// 데몬 요청을 그대로 넘긴다 (git, 파일, 워크트리 정보 등). 화면 쪽이 프로토콜 모양대로 요청을 만든다.
/// 요청마다 명령을 따로 만들지 않아 껍데기가 얇게 남는다.
/// 원격 호스트의 브라우저 칸 주소를 이 컴퓨터에서 열 주소로 바꾼다. 원격 데몬이 `localhost` 개발 서버를 대리하면
/// `http://<원격 호스트>:<대리 포트><경로>?thuminal_proxy=<기기 토큰>` 을, 대리할 주소가 아니거나 데몬이 옛 판(부 판 6 미만)이면
/// None 을 준다 (옛 데몬은 모르는 요청을 받으면 연결을 끊으므로 보내지 않는다). 토큰은 화면에 주지 않고 주소에만 싣는다
#[tauri::command]
async fn browser_proxy_url(state: State<'_, AppState>, host: Option<String>, url: String) -> CmdResult<Option<String>> {
    let Some(id) = host else { return Ok(None) };
    let (link, record) = {
        let remotes = state.remotes.lock().unwrap();
        let r = remotes.get(&id).ok_or_else(|| format!("등록하지 않은 원격 컴퓨터예요: {id}"))?;
        (r.link.clone(), r.record.clone())
    };
    if link.current().protocol.is_none_or(|(_, minor)| minor < 6) {
        return Ok(None);
    }
    let c = state.client(Some(&id)).await?;
    let Response::BrowserProxy { port: Some(port) } = c.request(Request::BrowserProxy { url: url.clone() }).await.map_err(err)? else { return Ok(None) };
    let (Ok(mut view), Ok(orig)) = (tauri::Url::parse(&record.base), tauri::Url::parse(&url)) else { return Ok(None) };
    if view.set_port(Some(port)).is_err() {
        return Ok(None);
    }
    view.set_path(orig.path());
    view.set_query(orig.query());
    view.set_fragment(orig.fragment());
    view.query_pairs_mut().append_pair("thuminal_proxy", &record.token);
    Ok(Some(view.to_string()))
}

#[tauri::command]
async fn daemon_request(state: State<'_, AppState>, host: Option<String>, request: Request) -> CmdResult<Response> {
    state.client(host.as_deref()).await?.request(request).await.map_err(err)
}

/// 데몬 이벤트를 채널로 흘린다. 화면이 새로 고쳐지면 다시 부른다.
/// 데몬 이벤트 말고도 `{"type":"daemon_reconnected"}` 가 온다. 원격 호스트가 아직 붙지 않았으면 붙는 대로 잇는다
#[tauri::command]
async fn subscribe_events(state: State<'_, AppState>, host: Option<String>, channel: Channel<serde_json::Value>) -> CmdResult<()> {
    let Some(id) = host else {
        let c = state.local().await?;
        state.events.lock().await.insert(None, EventSink { channel: channel.clone(), generation: 0 });
        forward_events(&c, channel);
        return Ok(());
    };
    let (link, generation) = {
        let remotes = state.remotes.lock().unwrap();
        let r = remotes.get(&id).ok_or_else(|| format!("등록하지 않은 원격 컴퓨터예요: {id}"))?;
        (r.link.clone(), r.link.current().generation)
    };
    let mut events = state.events.lock().await;
    match link.client() {
        Some(c) => {
            events.insert(Some(id), EventSink { channel: channel.clone(), generation });
            forward_events(&c, channel);
        }
        None => {
            events.insert(Some(id), EventSink { channel, generation: 0 });
        }
    }
    Ok(())
}

/// 등록한 원격 호스트 목록과 연결 상태
#[tauri::command]
fn hosts_list(state: State<'_, AppState>) -> Vec<hosts::HostView> {
    state.host_views()
}

/// 원격 호스트 목록이 바뀔 때마다(연결 상태 포함) 목록을 통째로 채널로 보낸다. 부르자마자 지금 목록을 한 번 보낸다
#[tauri::command]
fn hosts_subscribe(state: State<'_, AppState>, channel: Channel<Vec<hosts::HostView>>) -> CmdResult<()> {
    channel.send(state.host_views()).map_err(|e| e.to_string())?;
    state.host_watchers.lock().unwrap().push(channel);
    Ok(())
}

/// 짝짓기 주소(`http://100.x.y.z:6780/#token=…`)로 원격 호스트를 등록한다. 붙어 보고 되면 남긴다.
/// 같은 주소가 이미 있으면 이름과 토큰을 바꾼다
#[tauri::command]
async fn hosts_add(app: AppHandle, state: State<'_, AppState>, url: String, name: Option<String>) -> CmdResult<hosts::HostView> {
    let pair = thuminal_client::ws::parse_pair_url(&url)?;
    // 붙어 본다 (토큰, 판). 확인용 연결은 바로 놓고, 남긴 뒤 Link 가 새로 붙는다
    let probe = Client::connect_ws(&pair.base, &pair.token, "desktop").await.map_err(err)?;
    drop(probe);
    let name = name.map(|n| n.trim().chars().take(60).collect::<String>()).filter(|n| !n.is_empty()).unwrap_or_else(|| pair.ip.to_string());
    let mut events = state.events.lock().await;
    let id = {
        let mut remotes = state.remotes.lock().unwrap();
        let old = remotes.values().find(|r| r.record.base == pair.base).map(|r| r.record.clone());
        let replaced = old.is_some();
        let record = match old {
            Some(o) => hosts::HostRecord { name, token: pair.token, ..o },
            None => hosts::HostRecord { id: hosts::new_id(), name, base: pair.base, token: pair.token, added_at: hosts::now_ms() },
        };
        let id = record.id.clone();
        // 옛 연결(토큰이 바뀌었을 수 있다)을 놓고 새로 붙는다. 그 호스트를 구독한 화면은 새 연결에서 다시 잇는다
        if let Some(sink) = events.get_mut(&Some(id.clone())) {
            sink.generation = 0;
        }
        remotes.insert(id.clone(), start_remote(&app, record, replaced));
        id
    };
    drop(events);
    state.save_hosts()?;
    state.notify_hosts();
    state.host_views().into_iter().find(|h| h.id == id).ok_or_else(|| "등록한 호스트를 찾지 못했어요".into())
}

/// 원격 호스트를 지운다. 원격 컴퓨터에 남은 기기 토큰은 그 컴퓨터의 설정 → 원격 접속에서 지운다
#[tauri::command]
async fn hosts_remove(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let removed = state.remotes.lock().unwrap().remove(&id);
    if removed.is_none() {
        return Err(format!("등록하지 않은 원격 컴퓨터예요: {id}"));
    }
    let key = Some(id);
    state.attachments.lock().await.retain(|(h, _), t| {
        let keep = *h != key;
        if !keep {
            t.abort();
        }
        keep
    });
    state.events.lock().await.remove(&key);
    state.save_hosts()?;
    state.notify_hosts();
    Ok(())
}

/// 기다리는 중이면 바로 다시 붙어 본다 (토큰이 틀려 멈췄어도)
#[tauri::command]
fn hosts_reconnect(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let remotes = state.remotes.lock().unwrap();
    remotes.get(&id).ok_or_else(|| format!("등록하지 않은 원격 컴퓨터예요: {id}"))?.link.reconnect_now();
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
        let face = *f.faces.get(id).ok_or("글꼴 번호를 찾지 못했어요")?;
        f.db.with_face_data(face, |data, _| data.to_vec())
            .map(tauri::ipc::Response::new)
            .ok_or_else(|| "글꼴 파일을 읽지 못했어요".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 앱 메뉴 (macOS). Tauri 기본 메뉴에는 "윈도우 닫기 ⌘W" 가 있어 웹뷰보다 먼저 ⌘W 를 받아 앱 창을 닫아 버린다.
/// ⌘W 는 칸 닫기(화면 단축키)이므로 그 항목만 빼고 기본 메뉴와 같게 만든다.
/// Windows · Linux 는 메뉴를 달지 않는다. 창 안 메뉴 막대가 생기고, Edit 항목의 Ctrl+C · Ctrl+V · Ctrl+A · Ctrl+Z 가
/// 터미널보다 먼저 키를 가져가기 때문이다
#[cfg(target_os = "macos")]
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
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move { responder.respond(media::serve(app, req).await) });
        })
        .setup(|app| {
            app.manage(AppState::default());
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            notify::init(app.handle());
            // 등록한 원격 호스트마다 연결을 띄운다 (끊겨 있으면 스스로 다시 붙는다)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let records = hosts::load(&hosts::file(&Paths::default_home().home));
                let mut remotes = state.remotes.lock().unwrap();
                for r in records {
                    remotes.insert(r.id.clone(), start_remote(&handle, r, false));
                }
            });
            // 데몬이 내려가거나 다시 뜨면 0.5초 안에 다시 붙는다 (화면이 옛 세션 상태로 오래 남지 않게)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    let state = handle.state::<AppState>();
                    let closed = state.client.lock().await.as_ref().is_some_and(|c| c.is_closed());
                    if closed {
                        let _ = state.local().await;
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
            set_ui_zoom,
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
            browser_proxy_url,
            hosts_list,
            hosts_subscribe,
            hosts_add,
            hosts_remove,
            hosts_reconnect,
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
