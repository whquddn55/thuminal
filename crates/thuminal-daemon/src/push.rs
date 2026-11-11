//! 폰 알림 (FCM): 안드로이드 앱이 잠들어 있어도 에이전트가 묻거나 일을 마치면 알린다.
//!
//! - 폰 앱이 FCM 등록 토큰을 `/api/push` 로 맡긴다 (`push.json`). 데몬은 세션 변화를 보고 데스크톱 앱 알림과 같은 때
//!   (`packages/ui/src/notifications.ts` `noticeFor`) FCM HTTP v1 으로 데이터 메시지를 보낸다. 알림은 폰 앱이 그린다.
//! - 보내는 키는 FCM 보내기 권한만 있는 Firebase 서비스 계정 키다. 릴리스 빌드가 `THUMINAL_FCM_KEY`(CI secret
//!   `FCM_SERVICE_ACCOUNT`)를 데몬에 넣는다. 공개 릴리스에서 꺼낼 수 있지만 할 수 있는 일은 FCM 보내기뿐이고, 보낼 폰 토큰은
//!   데몬 · 폰에만 있다. 데몬 폴더에 `fcm-service-account.json` 이 있으면 그것을 먼저 쓴다 (개발 빌드). 둘 다 없으면 보내지 않는다.
//! - 2분 안에 이 컴퓨터 앞(웹 화면 밖의 데스크톱 앱 · CLI)에서 입력이 있었으면 보내지 않는다. 그때는 데스크톱 앱이 알린다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use thuminal_protocol::layout::{FLOATING_WORKSPACE, OTHER_WORKSPACE, WorkspaceLayout};
use thuminal_protocol::{AgentState, Event, SessionId, SessionInfo, SessionState};
use tracing::{info, warn};

use crate::server::Server;
use crate::session::now_ms;

/// 이 컴퓨터 앞에서 입력한 지 이만큼 안 됐으면 폰에 보내지 않는다
const DESK_QUIET_MS: u64 = 120_000;
/// 빌드에 넣은 서비스 계정 키 (JSON)
const BUILT_IN_KEY: Option<&str> = option_env!("THUMINAL_FCM_KEY");
const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// 웹 화면(폰 · 브라우저)이 hello 에 쓰는 이름. 이 연결의 입력은 "컴퓨터 앞" 으로 치지 않는다
const WEB_CLIENT: &str = "web";

/// 알림을 받는 폰 하나
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Phone {
    /// FCM 등록 토큰
    token: String,
    /// 폰 앱이 이 컴퓨터를 부르는 열쇠 (접속 주소의 origin). 알림에 그대로 돌려줘 폰이 어느 컴퓨터인지 안다
    #[serde(default)]
    host: String,
    #[serde(default)]
    added_at: u64,
}

#[derive(Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".into()
}

/// 폰에 띄울 알림 한 건 (데스크톱 `Notice` 와 같다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub kind: &'static str,
    pub subtitle: String,
    pub body: String,
}

pub struct Push {
    file: PathBuf,
    key_file: PathBuf,
    phones: Mutex<Vec<Phone>>,
    /// OAuth 접근 토큰과 끝나는 때 (초)
    access: tokio::sync::Mutex<Option<(String, u64)>>,
    /// 웹 화면 밖 연결에서 마지막으로 입력한 때 (ms)
    desk_input_at: AtomicU64,
    http: OnceLock<reqwest::Client>,
}

impl Push {
    pub fn load(home: &Path) -> Arc<Self> {
        let file = home.join("push.json");
        let phones = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Arc::new(Self {
            file,
            key_file: home.join("fcm-service-account.json"),
            phones: Mutex::new(phones),
            access: Default::default(),
            desk_input_at: AtomicU64::new(0),
            http: OnceLock::new(),
        })
    }

    /// 서비스 계정 키가 있어 보낼 수 있는지
    pub fn configured(&self) -> bool {
        self.account().is_some()
    }

    fn account(&self) -> Option<ServiceAccount> {
        match std::fs::read(&self.key_file) {
            Ok(b) => serde_json::from_slice(&b).ok(),
            Err(_) => serde_json::from_str(BUILT_IN_KEY?).ok(),
        }
    }

    /// 폰을 등록하거나(`on`) 뺀다. 같은 토큰이면 열쇠만 바꾼다
    pub fn register(&self, token: &str, host: &str, on: bool) {
        let mut phones = self.phones.lock().unwrap();
        phones.retain(|p| p.token != token);
        if on {
            phones.push(Phone {
                token: token.into(),
                host: host.into(),
                added_at: now_ms(),
            });
        }
        self.save(&phones);
        info!(event = "push_registered", on, phones = phones.len());
    }

    fn save(&self, phones: &[Phone]) {
        if let Ok(b) = serde_json::to_vec_pretty(phones)
            && let Err(e) = std::fs::write(&self.file, b)
        {
            warn!(event = "push_save_failed", error = %e);
        }
    }

    /// 연결이 세션에 입력했다. 웹 화면이 아니면 사용자가 컴퓨터 앞에 있다고 본다
    pub fn note_input(&self, client: &str) {
        if client != WEB_CLIENT {
            self.desk_input_at.store(now_ms(), Ordering::Relaxed);
        }
    }

    fn client(&self) -> &reqwest::Client {
        self.http.get_or_init(|| {
            // reqwest 는 rustls 암호 구현을 고르지 않고 받는다 (aws-lc 는 Windows 빌드에 cmake · nasm 이 든다)
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_default()
        })
    }

    /// 등록한 폰마다 보낸다
    async fn send_all(&self, session: SessionId, title: &str, n: &Notice) {
        let Some(sa) = self.account() else { return };
        let phones = self.phones.lock().unwrap().clone();
        if phones.is_empty() {
            return;
        }
        let access = match self.access_token(&sa).await {
            Ok(t) => t,
            Err(e) => {
                warn!(event = "push_auth_failed", error = %e);
                return;
            }
        };
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            sa.project_id
        );
        for p in phones {
            let msg = serde_json::json!({
                "message": {
                    "token": p.token,
                    "data": {
                        "host": p.host,
                        "session": session.to_string(),
                        "kind": n.kind,
                        "title": title,
                        "subtitle": n.subtitle,
                        "body": n.body,
                    },
                    "android": { "priority": "high", "ttl": "3600s" },
                }
            });
            let res = self
                .client()
                .post(&url)
                .bearer_auth(&access)
                .json(&msg)
                .send()
                .await;
            match res {
                Ok(r) if r.status().is_success() => {
                    info!(event = "push_sent", session = %session, kind = n.kind)
                }
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    warn!(event = "push_failed", %status, body = %text);
                    // 앱을 지웠거나 토큰이 바뀌었다
                    if status == reqwest::StatusCode::NOT_FOUND
                        || text.contains("UNREGISTERED")
                        || text.contains("not a valid FCM registration token")
                    {
                        self.register(&p.token, "", false);
                    }
                }
                Err(e) => warn!(event = "push_failed", error = %e),
            }
        }
    }

    /// 서비스 계정으로 서명한 JWT 를 OAuth 접근 토큰으로 바꾼다 (한 시간 쓴다)
    async fn access_token(&self, sa: &ServiceAccount) -> Result<String, String> {
        let mut cache = self.access.lock().await;
        let now = now_ms() / 1000;
        if let Some((t, exp)) = &*cache
            && now + 60 < *exp
        {
            return Ok(t.clone());
        }
        let jwt = sign_jwt(sa, now)?;
        let body = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={jwt}"
        );
        let r = self
            .client()
            .post(&sa.token_uri)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = r.status();
        let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
        let Some(token) = v["access_token"].as_str() else {
            return Err(format!("{status} {v}"));
        };
        let exp = now + v["expires_in"].as_u64().unwrap_or(3600);
        *cache = Some((token.to_string(), exp));
        Ok(token.to_string())
    }
}

fn sign_jwt(sa: &ServiceAccount, now: u64) -> Result<String, String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = serde_json::json!({ "iss": sa.client_email, "scope": SCOPE, "aud": sa.token_uri, "iat": now, "exp": now + 3600 });
    let input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
    let der = pem_body(&sa.private_key)?;
    let key = ring::signature::RsaKeyPair::from_pkcs8(&der)
        .map_err(|e| format!("서비스 계정 키를 읽지 못했어요: {e}"))?;
    let mut sig = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        input.as_bytes(),
        &mut sig,
    )
    .map_err(|e| e.to_string())?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig)))
}

/// PEM 의 `-----BEGIN …-----` 줄 사이 base64 를 푼다
fn pem_body(pem: &str) -> Result<Vec<u8>, String> {
    let b64: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("서비스 계정 키를 읽지 못했어요: {e}"))
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s.to_string()
    }
}

/// 세션 정보가 prev → next 로 바뀌었을 때 띄울 알림 (데스크톱 `noticeFor` 와 같은 규칙)
pub fn notice_for(prev: Option<&SessionInfo>, next: &SessionInfo) -> Option<Notice> {
    if next.labels.contains_key("team.leader") {
        return None;
    }
    if let Some(a) = &next.agent {
        let p = prev.and_then(|p| p.agent.as_ref());
        let name = &a.kind;
        let ended = a.turn_ended_at.is_some() && a.turn_ended_at != p.and_then(|p| p.turn_ended_at);
        if a.state == AgentState::NeedsAttention
            && p.map(|p| p.state) != Some(AgentState::NeedsAttention)
        {
            let what = match &a.tool_name {
                Some(t) => format!("{t} 도구를 써도 되는지 물어요"),
                None => "입력을 기다려요".into(),
            };
            let body = match &a.prompt {
                Some(pr) if !pr.is_empty() => format!("{what} · {pr}"),
                _ => what,
            };
            return Some(Notice {
                kind: "attention",
                subtitle: format!("{name}가 묻고 있어요"),
                body: clip(&body, 180),
            });
        }
        let said = || {
            clip(
                a.last_assistant_message
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .or(a.prompt.as_deref())
                    .unwrap_or(""),
                180,
            )
        };
        if a.state == AgentState::Failed && ended {
            return Some(Notice {
                kind: "attention",
                subtitle: format!("{name} 턴이 오류로 끝났어요"),
                body: said(),
            });
        }
        // 사용자가 멈춘 턴은 알리지 않는다
        if a.state == AgentState::Idle && !a.interrupted && ended {
            return Some(Notice {
                kind: "done",
                subtitle: format!("{name}가 일을 마쳤어요"),
                body: said(),
            });
        }
    }
    if let Some(p) = prev
        && next.bell_at > p.bell_at
    {
        return Some(Notice {
            kind: "bell",
            subtitle: "벨이 울렸어요".into(),
            body: clip(&next.title, 180),
        });
    }
    None
}

/// 세션이 든 워크스페이스와 탭 이름
pub fn place_of(
    layouts: &[WorkspaceLayout],
    session: SessionId,
) -> Option<(String, Option<String>)> {
    for l in layouts {
        for t in &l.tabs {
            if thuminal_layout::tree::panes(&t.root)
                .iter()
                .any(|p| p.session() == Some(session))
            {
                return Some((l.workspace.clone(), t.title.clone()));
            }
        }
    }
    None
}

/// 워크스페이스 이름 (데스크톱 알림 제목과 같다)
pub fn workspace_title(server: &Server, ws: &str) -> String {
    if ws == FLOATING_WORKSPACE {
        return "플로팅 터미널".into();
    }
    if ws == OTHER_WORKSPACE {
        return "워크트리 밖 터미널".into();
    }
    let base = || {
        Path::new(ws)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| ws.to_string())
    };
    match server.workspace.worktrees(None) {
        Ok(list) => list
            .into_iter()
            .find(|w| w.path == ws)
            .map(|w| w.name.or(w.branch).unwrap_or_else(base))
            .unwrap_or_else(base),
        Err(_) => base(),
    }
}

/// 세션 상태 한 낱말 (사이드바 `agentStatus` · `statusOf` 와 같은 이름)
pub fn status_of(s: &SessionInfo) -> &'static str {
    if let Some(a) = &s.agent {
        return match a.state {
            AgentState::NeedsAttention => "attention",
            AgentState::Working => "working",
            AgentState::Failed => "error",
            _ if a.interrupted => "interrupted",
            _ if a.turn_ended_at.is_some() => "done",
            _ => "ready",
        };
    }
    match s.state {
        SessionState::Running => "active",
        _ => "exited",
    }
}

/// 세션 변화를 지켜보다 폰에 알린다
pub async fn watch(server: Arc<Server>) {
    let push = server.remote.push.clone();
    let mut events = server.manager.events.subscribe();
    let mut prev: HashMap<SessionId, SessionInfo> = server
        .manager
        .list()
        .into_iter()
        .map(|s| (s.id, s))
        .collect();
    loop {
        let event = match events.recv().await {
            Ok(e) => e,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => return,
        };
        let (session, notice) = match event {
            Event::SessionCreated { session } => {
                prev.insert(session.id, session);
                continue;
            }
            Event::SessionUpdated { session } => {
                let n = notice_for(prev.get(&session.id), &session);
                let id = session.id;
                prev.insert(id, session);
                match n {
                    Some(n) => (id, n),
                    None => continue,
                }
            }
            Event::SessionRemoved { session } => {
                prev.remove(&session);
                continue;
            }
            Event::SessionNotification {
                session,
                title,
                body,
            } => (
                session,
                Notice {
                    kind: "bell",
                    subtitle: if title.is_empty() {
                        "터미널 알림".into()
                    } else {
                        title
                    },
                    body: clip(&body, 180),
                },
            ),
            _ => continue,
        };
        if push.phones.lock().unwrap().is_empty()
            || now_ms().saturating_sub(push.desk_input_at.load(Ordering::Relaxed)) < DESK_QUIET_MS
        {
            continue;
        }
        // 칸에 없는 세션(에이전트 팀원 등)은 데스크톱처럼 알리지 않는다
        let Some((ws, _)) = place_of(&server.layouts.get(None), session) else {
            continue;
        };
        let server = server.clone();
        let push = push.clone();
        tokio::spawn(async move {
            // 워크트리 이름은 git 을 읽는다
            let s = server.clone();
            let title = tokio::task::spawn_blocking(move || workspace_title(&s, &ws))
                .await
                .unwrap_or_default();
            push.send_all(session, &title, &notice).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use thuminal_protocol::AgentInfo;

    fn session(agent: Option<AgentInfo>) -> SessionInfo {
        serde_json::from_value(serde_json::json!({
            "id": 1, "title": "t", "cwd": "/", "command": [], "cols": 80, "rows": 24, "pid": null,
            "state": {"state": "running"}, "created_at": 0, "last_output_at": 0, "attached": 0,
            "agent": agent,
        }))
        .unwrap()
    }

    fn agent(state: AgentState, ended: Option<u64>) -> AgentInfo {
        serde_json::from_value(serde_json::json!({
            "kind": "claude", "session_id": null, "transcript": null, "state": state, "updated_at": 0,
            "turn_ended_at": ended, "last_assistant_message": "다 했어요",
        }))
        .unwrap()
    }

    #[test]
    fn notices() {
        let working = session(Some(agent(AgentState::Working, None)));
        let done = session(Some(agent(AgentState::Idle, Some(5))));
        let n = notice_for(Some(&working), &done).unwrap();
        assert_eq!((n.kind, n.body.as_str()), ("done", "다 했어요"));
        // 같은 턴 끝을 두 번 알리지 않는다
        assert_eq!(notice_for(Some(&done), &done), None);
        let ask = session(Some(agent(AgentState::NeedsAttention, None)));
        assert_eq!(notice_for(Some(&working), &ask).unwrap().kind, "attention");
        assert_eq!(notice_for(Some(&ask), &ask), None);
        // 막 뜬 에이전트(턴 끝 없음)는 알리지 않는다
        assert_eq!(
            notice_for(None, &session(Some(agent(AgentState::Idle, None)))),
            None
        );
    }

    #[test]
    fn pem() {
        let pem = "-----BEGIN PRIVATE KEY-----\nAAEC\nAw==\n-----END PRIVATE KEY-----\n";
        assert_eq!(pem_body(pem).unwrap(), vec![0, 1, 2, 3]);
    }
}
