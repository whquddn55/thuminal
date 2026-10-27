//! 원격 접속: 폰이나 다른 컴퓨터의 브라우저가 Tailscale 로 이 데몬에 붙는다 (Orca 의 웹 클라이언트·모바일 짝짓기와 같은 자리).
//!
//! HTTP 서버 하나가 웹 화면 파일과 웹소켓(`/ws`)을 같이 낸다. 웹소켓 메시지 하나는 프레임 하나(길이 머리를 뗀 종류 + 내용)다.
//! 데몬 안에서 파이프로 이어 유닉스 소켓 연결과 똑같이 처리한다 ([`Server::serve_stream`]).
//!
//! - 기기마다 토큰을 준다 (`remote.json`, 0600). 웹소켓과 `/api/*` 는 토큰이 맞아야 연다. 화면 파일은 토큰 없이 낸다.
//! - 기본은 Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)와 127.0.0.1 에서만 받는다. Tailscale 이 길을 암호화하므로
//!   따로 TLS 를 두지 않는다. LAN 을 허용하면 모든 주소(0.0.0.0)에서 받는데, 그때는 같은 망에서 내용이 그대로 보인다.
//! - Tailscale 이 나중에 켜지거나 주소가 바뀌어도 15초마다 다시 보고 받는 주소를 맞춘다.

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use thuminal_protocol::frame::MAX_FRAME;
use thuminal_protocol::{RemoteDevice, RemoteStatus};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::server::Server;
use crate::session::now_ms;

pub const DEFAULT_PORT: u16 = 6780;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    lan: bool,
    #[serde(default)]
    devices: Vec<StoredDevice>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Stored {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, lan: false, devices: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDevice {
    id: String,
    name: String,
    token: String,
    created_at: u64,
    #[serde(default)]
    last_seen: u64,
}

/// 웹 화면이 쓰는 설치 글꼴 (WebKit·폰에는 사용자 글꼴이 없다)
struct Fonts {
    db: fontdb::Database,
    faces: Vec<fontdb::ID>,
}

pub struct Remote {
    file: PathBuf,
    /// 웹 화면 파일 폴더 (`apps/web/dist` 빌드 결과, 앱 번들 `Resources/web`)
    web_root: Option<PathBuf>,
    state: Mutex<Stored>,
    listeners: Mutex<HashMap<SocketAddr, tokio::task::JoinHandle<()>>>,
    error: Mutex<Option<String>>,
    /// 기기마다 붙어 있는 연결: 연결 번호 → 끊기 신호
    live: Mutex<HashMap<String, HashMap<u64, oneshot::Sender<()>>>>,
    next_conn: AtomicU64,
    /// 받는 주소를 다시 맞춰 달라는 요청 (맞춘 뒤 답한다). [`watch`] 가 받는다
    reconcile_tx: mpsc::UnboundedSender<oneshot::Sender<()>>,
    reconcile_rx: Mutex<Option<mpsc::UnboundedReceiver<oneshot::Sender<()>>>>,
    fonts: Mutex<Option<Fonts>>,
}

impl Remote {
    pub fn load(home: &Path, web_root: Option<PathBuf>) -> Arc<Self> {
        let file = home.join("remote.json");
        let state = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let (reconcile_tx, rx) = mpsc::unbounded_channel();
        Arc::new(Self {
            file,
            web_root,
            state: Mutex::new(state),
            listeners: Default::default(),
            error: Default::default(),
            live: Default::default(),
            next_conn: AtomicU64::new(1),
            reconcile_tx,
            reconcile_rx: Mutex::new(Some(rx)),
            fonts: Mutex::new(None),
        })
    }

    fn save(&self, st: &Stored) {
        let Ok(bytes) = serde_json::to_vec_pretty(st) else { return };
        let tmp = self.file.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }

    pub fn status(&self) -> RemoteStatus {
        let st = self.state.lock().unwrap().clone();
        let live = self.live.lock().unwrap();
        let mut listening: Vec<String> = self.listeners.lock().unwrap().keys().map(|a| a.to_string()).collect();
        listening.sort();
        RemoteStatus {
            enabled: st.enabled,
            port: st.port,
            lan: st.lan,
            listening,
            tailnet: tailnet_addrs().iter().map(|a| a.to_string()).collect(),
            error: self.error.lock().unwrap().clone(),
            web: self.web_root.as_ref().is_some_and(|r| r.join("index.html").is_file()),
            apk: self.web_root.as_ref().is_some_and(|r| r.join("download/thuminal.apk").is_file()),
            devices: st
                .devices
                .iter()
                .map(|d| RemoteDevice {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    created_at: d.created_at,
                    last_seen: d.last_seen,
                    connected: live.get(&d.id).map_or(0, |c| c.len() as u32),
                })
                .collect(),
        }
    }

    /// 설정을 바꾸고 받는 주소를 다시 맞춘다
    pub async fn set(&self, enabled: Option<bool>, port: Option<u16>, lan: Option<bool>) -> Result<RemoteStatus, String> {
        if port == Some(0) {
            return Err("포트는 1 이상이어야 한다".into());
        }
        {
            let mut st = self.state.lock().unwrap();
            if let Some(v) = enabled {
                st.enabled = v;
            }
            if let Some(v) = port {
                st.port = v;
            }
            if let Some(v) = lan {
                st.lan = v;
            }
            self.save(&st);
        }
        if enabled == Some(false) {
            self.kick_all();
        }
        self.reconcile().await;
        Ok(self.status())
    }

    /// 새 기기를 등록하고 주소들을 돌려준다. 꺼져 있으면 켠다
    pub async fn pair(&self, name: &str) -> (RemoteDevice, Vec<String>) {
        let device = StoredDevice {
            id: random_hex(8),
            name: if name.trim().is_empty() { "기기".into() } else { name.trim().chars().take(60).collect() },
            token: random_hex(24),
            created_at: now_ms(),
            last_seen: 0,
        };
        let (port, lan) = {
            let mut st = self.state.lock().unwrap();
            st.enabled = true;
            st.devices.push(device.clone());
            self.save(&st);
            (st.port, st.lan)
        };
        self.reconcile().await;
        info!(event = "remote_paired", device = %device.id);
        let mut hosts: Vec<IpAddr> = tailnet_addrs();
        if lan {
            hosts.extend(lan_addrs());
        }
        let urls = hosts.iter().map(|h| format!("{}/#token={}", base_url(*h, port), device.token)).collect();
        let info = RemoteDevice { id: device.id, name: device.name, created_at: device.created_at, last_seen: 0, connected: 0 };
        (info, urls)
    }

    pub fn remove_device(&self, id: &str) -> Result<RemoteStatus, String> {
        {
            let mut st = self.state.lock().unwrap();
            let before = st.devices.len();
            st.devices.retain(|d| d.id != id);
            if st.devices.len() == before {
                return Err(format!("등록한 기기가 아니다: {id}"));
            }
            self.save(&st);
        }
        if let Some(conns) = self.live.lock().unwrap().remove(id) {
            for (_, kick) in conns {
                let _ = kick.send(());
            }
        }
        info!(event = "remote_device_removed", device = %id);
        Ok(self.status())
    }

    /// 토큰에 맞는 기기 id
    fn device_for(&self, token: &str) -> Option<String> {
        let st = self.state.lock().unwrap();
        st.devices.iter().find(|d| same(d.token.as_bytes(), token.as_bytes())).map(|d| d.id.clone())
    }

    fn join(&self, device: &str) -> (u64, oneshot::Receiver<()>) {
        let n = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.live.lock().unwrap().entry(device.to_string()).or_default().insert(n, tx);
        self.touch(device);
        (n, rx)
    }

    fn leave(&self, device: &str, n: u64) {
        let mut live = self.live.lock().unwrap();
        if let Some(c) = live.get_mut(device) {
            c.remove(&n);
            if c.is_empty() {
                live.remove(device);
            }
        }
        drop(live);
        self.touch(device);
    }

    fn touch(&self, device: &str) {
        let mut st = self.state.lock().unwrap();
        if let Some(d) = st.devices.iter_mut().find(|d| d.id == device) {
            d.last_seen = now_ms();
            let snapshot = st.clone();
            self.save(&snapshot);
        }
    }

    fn kick_all(&self) {
        for (_, conns) in self.live.lock().unwrap().drain() {
            for (_, kick) in conns {
                let _ = kick.send(());
            }
        }
    }

    async fn reconcile(&self) {
        let (tx, rx) = oneshot::channel();
        if self.reconcile_tx.send(tx).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
        }
    }

    /// 받아야 할 주소들
    fn wanted(&self) -> BTreeSet<SocketAddr> {
        let st = self.state.lock().unwrap();
        if !st.enabled {
            return BTreeSet::new();
        }
        if st.lan {
            return [SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), st.port)].into();
        }
        let mut out: BTreeSet<SocketAddr> = [SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), st.port)].into();
        out.extend(tailnet_addrs().into_iter().map(|ip| SocketAddr::new(ip, st.port)));
        out
    }

    fn apply(&self, server: &Arc<Server>) {
        let want = self.wanted();
        let mut listeners = self.listeners.lock().unwrap();
        listeners.retain(|addr, task| {
            let keep = want.contains(addr) && !task.is_finished();
            if !keep {
                task.abort();
                info!(event = "remote_unlisten", %addr);
            }
            keep
        });
        let mut errors = Vec::new();
        for addr in want {
            if listeners.contains_key(&addr) {
                continue;
            }
            match bind(addr) {
                Ok(l) => {
                    info!(event = "remote_listen", %addr);
                    let app = router(server.clone());
                    listeners.insert(
                        addr,
                        tokio::spawn(async move {
                            if let Err(e) = axum::serve(l, app).await {
                                warn!(event = "remote_serve_failed", %addr, error = %e);
                            }
                        }),
                    );
                }
                Err(e) => errors.push(format!("{addr} 에서 받지 못했다: {e}")),
            }
        }
        *self.error.lock().unwrap() = (!errors.is_empty()).then(|| errors.join("\n"));
    }

    fn font_faces(&self, family: &str) -> Vec<serde_json::Value> {
        let mut slot = self.fonts.lock().unwrap();
        let f = slot.get_or_insert_with(|| {
            let mut db = fontdb::Database::new();
            db.load_system_fonts();
            Fonts { db, faces: Vec::new() }
        });
        let found: Vec<_> = f
            .db
            .faces()
            .filter(|face| face.families.iter().any(|(name, _)| name.eq_ignore_ascii_case(family)))
            .map(|face| (face.id, face.weight.0, face.style != fontdb::Style::Normal))
            .collect();
        found
            .into_iter()
            .map(|(id, weight, italic)| {
                f.faces.push(id);
                serde_json::json!({ "id": f.faces.len() - 1, "weight": weight, "italic": italic })
            })
            .collect()
    }

    fn font_data(&self, id: usize) -> Option<Vec<u8>> {
        let slot = self.fonts.lock().unwrap();
        let f = slot.as_ref()?;
        let face = *f.faces.get(id)?;
        f.db.with_face_data(face, |data, _| data.to_vec())
    }
}

/// 처음에 받는 주소를 맞추고, 그 뒤로 15초마다(또는 설정이 바뀌면 바로) 다시 맞춘다
pub async fn watch(server: Arc<Server>) {
    let Some(mut rx) = server.remote.reconcile_rx.lock().unwrap().take() else { return };
    server.remote.apply(&server);
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            r = rx.recv() => {
                let Some(done) = r else { return };
                server.remote.apply(&server);
                let _ = done.send(());
            }
            _ = tick.tick() => server.remote.apply(&server),
        }
    }
}

fn bind(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let l = std::net::TcpListener::bind(addr)?;
    l.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(l)
}

fn base_url(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(v4) => format!("http://{v4}:{port}"),
        IpAddr::V6(v6) => format!("http://[{v6}]:{port}"),
    }
}

fn router(server: Arc<Server>) -> Router {
    Router::new()
        .route("/ws", get(ws))
        .route("/api/check", get(check))
        .route("/api/fonts", get(fonts))
        .route("/api/font/{id}", get(font))
        .route("/api/file", get(worktree_file))
        .fallback(get(static_file))
        .with_state(server)
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: String,
    #[serde(default)]
    family: String,
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "토큰이 맞지 않는다. 데스크톱 앱 설정 → 원격 접속에서 기기를 다시 등록한다").into_response()
}

/// 브라우저 웹소켓은 거절된 까닭(401)을 알려 주지 않는다. 붙기 전에 토큰이 맞는지 여기서 본다
async fn check(State(server): State<Arc<Server>>, Query(q): Query<TokenQuery>) -> Response {
    match server.remote.device_for(&q.token) {
        Some(_) => StatusCode::NO_CONTENT.into_response(),
        None => unauthorized(),
    }
}

async fn ws(State(server): State<Arc<Server>>, Query(q): Query<TokenQuery>, upgrade: WebSocketUpgrade) -> Response {
    let Some(device) = server.remote.device_for(&q.token) else { return unauthorized() };
    upgrade.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME).on_upgrade(move |socket| bridge(server, socket, device))
}

/// 웹소켓 하나를 데몬 연결 하나로 잇는다
async fn bridge(server: Arc<Server>, socket: WebSocket, device: String) {
    let (n, mut kicked) = server.remote.join(&device);
    info!(event = "remote_connected", device = %device, conn = n);
    let (near, far) = tokio::io::duplex(1 << 20);
    let (frd, fwr) = tokio::io::split(far);
    let serving = tokio::spawn(server.clone().serve_stream(frd, fwr, Some(device.clone())));
    let (mut nrd, mut nwr) = tokio::io::split(near);

    // 데몬이 쓴 프레임을 하나씩 떼어 웹소켓 메시지로 보낸다
    let (ftx, mut frx) = mpsc::channel::<Vec<u8>>(256);
    let reader = tokio::spawn(async move {
        loop {
            let mut len = [0u8; 4];
            if nrd.read_exact(&mut len).await.is_err() {
                break;
            }
            let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
            if nrd.read_exact(&mut body).await.is_err() || ftx.send(body).await.is_err() {
                break;
            }
        }
    });

    let (mut sink, mut stream) = socket.split();
    // 폰 브라우저·통신사 망은 조용한 연결을 끊는다. 25초마다 핑을 보낸다
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            f = frx.recv() => match f {
                Some(body) => if sink.send(Message::Binary(body.into())).await.is_err() { break },
                None => break,
            },
            m = stream.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if b.is_empty() || b.len() > MAX_FRAME {
                        break;
                    }
                    if nwr.write_all(&(b.len() as u32).to_be_bytes()).await.is_err() || nwr.write_all(&b).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break },
            _ = &mut kicked => {
                let _ = sink.send(Message::Close(None)).await;
                break;
            }
        }
    }
    reader.abort();
    drop(nwr);
    let _ = serving.await;
    server.remote.leave(&device, n);
    info!(event = "remote_disconnected", device = %device, conn = n);
}

async fn fonts(State(server): State<Arc<Server>>, Query(q): Query<TokenQuery>) -> Response {
    if server.remote.device_for(&q.token).is_none() {
        return unauthorized();
    }
    let remote = server.remote.clone();
    match tokio::task::spawn_blocking(move || remote.font_faces(&q.family)).await {
        Ok(faces) => axum::Json(faces).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn font(State(server): State<Arc<Server>>, UrlPath(id): UrlPath<usize>, Query(q): Query<TokenQuery>) -> Response {
    if server.remote.device_for(&q.token).is_none() {
        return unauthorized();
    }
    let remote = server.remote.clone();
    match tokio::task::spawn_blocking(move || remote.font_data(id)).await {
        Ok(Some(bytes)) => ([(header::CONTENT_TYPE, "font/ttf"), (header::CACHE_CONTROL, "max-age=86400")], bytes).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    token: String,
    worktree: String,
    file: String,
}

/// Range 없이 받을 때 한 번에 내는 최대 크기 (그림). 영상 플레이어는 늘 Range 로 받는다
const WHOLE_FILE_MAX: u64 = 64 * 1024 * 1024;

/// 워크트리 안 파일 내용 (웹 화면의 그림 · 영상 · 소리). `Range` 를 받으면 그 구간만 206 으로 낸다.
/// 경로 검사는 데몬 요청 `read_file_bytes` 와 같다 (워크트리 밖은 거절)
async fn worktree_file(State(server): State<Arc<Server>>, Query(q): Query<FileQuery>, headers: axum::http::HeaderMap) -> Response {
    if server.remote.device_for(&q.token).is_none() {
        return unauthorized();
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let ws = server.workspace.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<Response, String> {
        let kind = thuminal_protocol::media::content_type(&q.file);
        let (_, size, _) = ws.read_file_bytes(&q.worktree, &q.file, 0, 0).map_err(|e| e.to_string())?;
        let (start, end, partial) = match range {
            Some(r) => match thuminal_protocol::media::parse_range(&r, size) {
                Some((a, b)) => (a, b.min(a + thuminal_workspace::MAX_READ_BYTES - 1), true),
                None => {
                    return Ok((StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{size}"))]).into_response());
                }
            },
            None if size > WHOLE_FILE_MAX => return Ok((StatusCode::PAYLOAD_TOO_LARGE, "Range 로 나눠 받는다").into_response()),
            None => (0, size.saturating_sub(1), false),
        };
        let mut body = Vec::with_capacity((end + 1 - start) as usize);
        while size > 0 && (body.len() as u64) < end + 1 - start {
            let at = start + body.len() as u64;
            let (chunk, _, _) = ws.read_file_bytes(&q.worktree, &q.file, at, end + 1 - at).map_err(|e| e.to_string())?;
            if chunk.is_empty() {
                break;
            }
            body.extend_from_slice(&chunk);
        }
        // 파일이 그사이 줄었으면 받은 만큼만 낸다
        let last = start + (body.len() as u64).max(1) - 1;
        let mut res = if partial { (StatusCode::PARTIAL_CONTENT, body).into_response() } else { body.into_response() };
        let h = res.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
        h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        if partial && let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{last}/{size}")) {
            h.insert(header::CONTENT_RANGE, v);
        }
        Ok(res)
    })
    .await;
    match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => (StatusCode::NOT_FOUND, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// 웹 화면 파일. 없는 경로(확장자 없는 것)는 index.html 로 답한다
async fn static_file(State(server): State<Arc<Server>>, uri: Uri) -> Response {
    let Some(root) = server.remote.web_root.clone() else {
        return (StatusCode::NOT_FOUND, "웹 화면 파일을 찾지 못했다 (apps/web 을 빌드하거나 앱 번들 Resources/web)").into_response();
    };
    let rel = uri.path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split('/').any(|c| c.is_empty() || c == ".." || c.starts_with('.')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut file = root.join(rel);
    if !file.is_file() {
        if rel.rsplit('/').next().is_some_and(|name| name.contains('.')) {
            return StatusCode::NOT_FOUND.into_response();
        }
        file = root.join("index.html");
    }
    let Ok(Ok(bytes)) = tokio::task::spawn_blocking(move || std::fs::read(&file).map(|b| (b, file))).await else { return StatusCode::NOT_FOUND.into_response() };
    let (bytes, file) = bytes;
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(ext)));
    // 빌드 결과 assets/ 는 이름에 해시가 들어 있어 오래 둬도 된다. index.html 은 매번 새로 받는다
    let cache = if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "ttf" => "font/ttf",
        "woff2" => "font/woff2",
        "apk" => "application/vnd.android.package-archive",
        _ => "application/octet-stream",
    }
}

/// 길이가 같으면 끝까지 견준다 (토큰 비교 시간으로 앞부분이 새지 않게)
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_tailnet(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// 이 컴퓨터의 네트워크 주소들 (루프백·링크 로컬 빼고)
fn interface_addrs() -> Vec<IpAddr> {
    let mut out = Vec::new();
    // SAFETY: getifaddrs 가 돌려준 목록을 다 읽은 뒤 freeifaddrs 로 푼다
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            return out;
        }
        let mut p = ifap;
        while !p.is_null() {
            let ifa = &*p;
            if !ifa.ifa_addr.is_null() {
                match (*ifa.ifa_addr).sa_family as i32 {
                    libc::AF_INET => {
                        let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                        out.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr))));
                    }
                    libc::AF_INET6 => {
                        let sin6 = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                        out.push(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            p = ifa.ifa_next;
        }
        libc::freeifaddrs(ifap);
    }
    out.retain(|ip| !ip.is_loopback() && !matches!(ip, IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80));
    out.sort();
    out.dedup();
    out
}

/// Tailscale 주소들 (IPv4 먼저)
pub fn tailnet_addrs() -> Vec<IpAddr> {
    interface_addrs().into_iter().filter(is_tailnet).collect()
}

/// Tailscale 이 아닌 IPv4 주소들 (LAN 허용일 때 주소 안내에 쓴다)
fn lan_addrs() -> Vec<IpAddr> {
    interface_addrs().into_iter().filter(|ip| ip.is_ipv4() && !is_tailnet(ip)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailnet_ranges() {
        assert!(is_tailnet(&"100.101.102.103".parse().unwrap()));
        assert!(is_tailnet(&"100.127.0.1".parse().unwrap()));
        assert!(!is_tailnet(&"100.128.0.1".parse().unwrap()));
        assert!(!is_tailnet(&"100.63.0.1".parse().unwrap()));
        assert!(!is_tailnet(&"192.168.0.2".parse().unwrap()));
        assert!(is_tailnet(&"fd7a:115c:a1e0::1".parse().unwrap()));
        assert!(!is_tailnet(&"fd7a:115c:a1e1::1".parse().unwrap()));
    }

    #[test]
    fn token_compare() {
        assert!(same(b"abcd", b"abcd"));
        assert!(!same(b"abcd", b"abce"));
        assert!(!same(b"abcd", b"abc"));
        assert_eq!(random_hex(24).len(), 48);
        assert_ne!(random_hex(8), random_hex(8));
    }

    #[test]
    fn urls() {
        assert_eq!(base_url("100.1.2.3".parse().unwrap(), 6780), "http://100.1.2.3:6780");
        assert_eq!(base_url("fd7a:115c:a1e0::1".parse().unwrap(), 6780), "http://[fd7a:115c:a1e0::1]:6780");
    }
}
