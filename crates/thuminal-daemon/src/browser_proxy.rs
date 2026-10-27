//! 원격 기기에서 브라우저 칸 보기: 칸 주소가 이 컴퓨터의 `localhost` 개발 서버면 데몬이 대신 받아 넘긴다.
//!
//! - 대상(`localhost:3000` 처럼 호스트 · 포트)마다 대리 포트를 하나 연다. 받는 주소는 원격 접속과 같다
//!   (Tailscale 주소 · 127.0.0.1, LAN 을 켰으면 모든 주소). 경로를 붙여 가르지 않는 것은 페이지 안 절대 경로
//!   (`/@vite/client` 같은)가 깨지지 않게 하려는 것이다. 포트는 원격 접속 포트 다음부터 비어 있는 것을 쓴다.
//! - 요청의 `Host` 는 원래 주소로 바꿔 넘긴다 (Vite 의 허용 호스트 검사). `Origin` · `Referer` 도 원래 주소로 바꾼다.
//!   웹소켓(고친 코드를 바로 반영하는 HMR)은 업그레이드를 받아 양쪽을 그대로 잇는다.
//! - 등록한 기기만 연다: 처음 열 때 주소의 `thuminal_proxy=<기기 토큰>` 을 보고 같은 이름의 쿠키로 바꿔 둔 뒤
//!   토큰을 뺀 주소로 다시 보낸다. 쿠키는 대상 서버에 넘기지 않는다.
//! - 원격 기기의 칸 안(iframe)에 띄우므로 대상 응답의 `X-Frame-Options` 와 CSP `frame-ancestors` 는 뺀다.
//!   `Location` 이 원래 주소를 가리키면 경로만 남기고, `Set-Cookie` 의 `Domain` 은 뺀다.

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use hyper_util::rt::TokioIo;
use tracing::{info, warn};

use crate::remote::Remote;

/// 토큰을 담는 쿼리 이름이자 쿠키 이름
pub const TOKEN_NAME: &str = "thuminal_proxy";
/// 대리 포트를 찾아볼 범위 (원격 접속 포트 다음부터)
const PORT_SPAN: u16 = 200;
/// 한 번에 여는 대리 수 (칸 주소마다 하나, 너무 늘지 않게)
const MAX_PROXIES: usize = 32;

/// 대리할 대상
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// 원래 주소의 `호스트[:포트]` (요청 `Host` 머리에 그대로 넣는다)
    pub authority: String,
    /// 붙을 곳 (`localhost:3000`, `0.0.0.0` 은 `127.0.0.1`)
    pub connect: String,
}

/// 이 컴퓨터의 http 개발 서버 주소면 대상. `https` · 다른 컴퓨터 주소는 대리하지 않는다 (보는 기기가 바로 연다)
pub fn local_target(url: &str) -> Option<Target> {
    let rest = url.trim().strip_prefix("http://").or_else(|| url.trim().strip_prefix("HTTP://"))?;
    let authority = rest.split(['/', '?', '#']).next()?.to_string();
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !p.contains(']') => (h.to_string(), p.parse::<u16>().ok()?),
        _ => (authority.clone(), 80),
    };
    let connect_host = match host.to_ascii_lowercase().as_str() {
        "localhost" => "localhost",
        "127.0.0.1" | "0.0.0.0" => "127.0.0.1",
        "[::1]" => "[::1]",
        _ => return None,
    };
    Some(Target { authority, connect: format!("{connect_host}:{port}") })
}

struct Proxy {
    port: u16,
    addrs: BTreeSet<IpAddr>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct Proxies {
    map: Mutex<HashMap<String, Proxy>>,
}

impl Proxies {
    /// `target` 의 대리 포트. 받는 주소가 바뀌었거나 끝났으면 다시 연다. 열 수 없으면 None
    pub fn ensure(&self, remote: &Arc<Remote>, target: Target, ips: BTreeSet<IpAddr>, from_port: u16) -> Option<u16> {
        if ips.is_empty() {
            return None;
        }
        let mut map = self.map.lock().unwrap();
        if let Some(p) = map.get(&target.connect)
            && p.addrs == ips
            && p.tasks.iter().all(|t| !t.is_finished())
        {
            return Some(p.port);
        }
        if let Some(old) = map.remove(&target.connect) {
            old.tasks.iter().for_each(|t| t.abort());
        }
        if map.len() >= MAX_PROXIES {
            // 가장 오래된 것 하나를 닫는다 (어느 것이 오래됐는지 따로 적지 않으므로 아무거나)
            if let Some(k) = map.keys().next().cloned()
                && let Some(old) = map.remove(&k)
            {
                old.tasks.iter().for_each(|t| t.abort());
            }
        }
        let used: BTreeSet<u16> = map.values().map(|p| p.port).collect();
        for port in from_port.saturating_add(1)..from_port.saturating_add(PORT_SPAN) {
            if used.contains(&port) {
                continue;
            }
            let Some(listeners) = ips.iter().map(|ip| bind(SocketAddr::new(*ip, port)).ok()).collect::<Option<Vec<_>>>() else { continue };
            let ctx = Arc::new(Ctx { remote: remote.clone(), target: target.clone(), port });
            let tasks = listeners
                .into_iter()
                .map(|l| {
                    let app = Router::new().fallback(forward).with_state(ctx.clone());
                    tokio::spawn(async move {
                        if let Err(e) = axum::serve(l, app).await {
                            warn!(event = "browser_proxy_serve_failed", error = %e);
                        }
                    })
                })
                .collect();
            info!(event = "browser_proxy_open", target = %target.connect, port);
            map.insert(target.connect.clone(), Proxy { port, addrs: ips, tasks });
            return Some(port);
        }
        warn!(event = "browser_proxy_no_port", target = %target.connect);
        None
    }

    /// 원격 접속을 끄면 다 닫는다
    pub fn close_all(&self) {
        for (_, p) in self.map.lock().unwrap().drain() {
            p.tasks.iter().for_each(|t| t.abort());
        }
    }
}

fn bind(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let l = std::net::TcpListener::bind(addr)?;
    l.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(l)
}

struct Ctx {
    remote: Arc<Remote>,
    target: Target,
    port: u16,
}

fn page(status: StatusCode, text: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text.to_string()).into_response()
}

/// 쿼리에서 토큰을 꺼내고, 토큰을 뺀 경로 · 쿼리를 돌려준다
fn take_token(uri: &Uri) -> (Option<String>, String) {
    let path = uri.path();
    let Some(q) = uri.query() else { return (None, path.to_string()) };
    let mut token = None;
    let rest: Vec<&str> = q
        .split('&')
        .filter(|kv| match kv.strip_prefix(TOKEN_NAME).and_then(|r| r.strip_prefix('=')) {
            Some(v) => {
                token = Some(v.to_string());
                false
            }
            None => true,
        })
        .collect();
    let clean = if rest.is_empty() { path.to_string() } else { format!("{path}?{}", rest.join("&")) };
    (token, clean)
}

/// `Cookie` 머리에서 우리 토큰을 꺼내고 나머지 쿠키만 남긴다
fn take_cookie(headers: &mut HeaderMap) -> Option<String> {
    let mut token = None;
    let mut keep = Vec::new();
    for v in headers.get_all(header::COOKIE).iter() {
        for c in v.to_str().unwrap_or("").split(';') {
            let c = c.trim();
            match c.strip_prefix(TOKEN_NAME).and_then(|r| r.strip_prefix('=')) {
                Some(t) => token = Some(t.to_string()),
                None if !c.is_empty() => keep.push(c.to_string()),
                None => {}
            }
        }
    }
    headers.remove(header::COOKIE);
    if !keep.is_empty()
        && let Ok(v) = HeaderValue::from_str(&keep.join("; "))
    {
        headers.insert(header::COOKIE, v);
    }
    token
}

/// 홉 사이에서만 쓰는 머리 (업그레이드가 아니면 넘기지 않는다)
const HOP: &[&str] = &["connection", "proxy-connection", "keep-alive", "te", "trailer", "upgrade", "transfer-encoding"];

async fn forward(State(ctx): State<Arc<Ctx>>, mut req: Request) -> Response {
    // 처음 열 때: 주소의 토큰을 쿠키로 바꿔 두고 토큰 없는 주소로 다시 보낸다
    let (query_token, clean) = take_token(req.uri());
    if let Some(t) = query_token {
        if ctx.remote.device_for(&t).is_none() {
            return page(StatusCode::UNAUTHORIZED, "thuminal 원격 접속 토큰이 맞지 않아요. 데스크톱 앱 설정 → 원격 접속에서 기기를 다시 등록해 주세요");
        }
        let cookie = format!("{TOKEN_NAME}={t}; Path=/; HttpOnly; SameSite=Lax");
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, clean)
            .header(header::SET_COOKIE, cookie)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap();
    }
    if take_cookie(req.headers_mut()).is_none_or(|t| ctx.remote.device_for(&t).is_none()) {
        return page(StatusCode::UNAUTHORIZED, "thuminal 원격 접속으로 연 브라우저 칸에서만 볼 수 있어요");
    }

    let upgrade = req.headers().contains_key(header::UPGRADE);
    let client_upgrade = upgrade.then(|| hyper::upgrade::on(&mut req));
    let (mut parts, body) = req.into_parts();
    parts.uri = parts.uri.path_and_query().map_or("/", |p| p.as_str()).parse().unwrap_or_else(|_| Uri::from_static("/"));
    let h = &mut parts.headers;
    if !upgrade {
        for name in HOP {
            h.remove(*name);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&ctx.target.authority) {
        h.insert(header::HOST, v);
    }
    let original = format!("http://{}", ctx.target.authority);
    for name in [header::ORIGIN, header::REFERER] {
        if let Some(v) = h.get(&name).and_then(|v| v.to_str().ok())
            && let Some(rest) = proxy_origin_rest(v, ctx.port)
            && let Ok(nv) = HeaderValue::from_str(&format!("{original}{rest}"))
        {
            h.insert(name, nv);
        }
    }

    let stream = match tokio::net::TcpStream::connect(&ctx.target.connect).await {
        Ok(s) => s,
        Err(e) => {
            return page(StatusCode::BAD_GATEWAY, &format!("이 컴퓨터의 개발 서버에 연결하지 못했어요 ({}): {e}. 개발 서버가 실행 중인지 확인해 주세요", ctx.target.authority));
        }
    };
    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
        Ok(v) => v,
        Err(e) => return page(StatusCode::BAD_GATEWAY, &format!("개발 서버와 통신하지 못했어요 ({}): {e}", ctx.target.authority)),
    };
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let mut res = match sender.send_request(axum::http::Request::from_parts(parts, body)).await {
        Ok(r) => r,
        Err(e) => return page(StatusCode::BAD_GATEWAY, &format!("개발 서버가 응답하지 않았어요 ({}): {e}", ctx.target.authority)),
    };

    if res.status() == StatusCode::SWITCHING_PROTOCOLS
        && let Some(client) = client_upgrade
    {
        let server = hyper::upgrade::on(&mut res);
        tokio::spawn(async move {
            if let (Ok(a), Ok(b)) = (client.await, server.await) {
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
            }
        });
        let (parts, _) = res.into_parts();
        return Response::from_parts(parts, Body::empty());
    }

    let (mut parts, body) = res.into_parts();
    let h = &mut parts.headers;
    for name in HOP {
        h.remove(*name);
    }
    h.remove(header::X_FRAME_OPTIONS);
    if let Some(v) = h.get(header::CONTENT_SECURITY_POLICY).and_then(|v| v.to_str().ok()) {
        let kept: Vec<&str> = v.split(';').filter(|d| !d.trim().to_ascii_lowercase().starts_with("frame-ancestors")).collect();
        match HeaderValue::from_str(kept.join(";").trim()) {
            Ok(nv) if !nv.is_empty() => {
                h.insert(header::CONTENT_SECURITY_POLICY, nv);
            }
            _ => {
                h.remove(header::CONTENT_SECURITY_POLICY);
            }
        }
    }
    if let Some(v) = h.get(header::LOCATION).and_then(|v| v.to_str().ok())
        && let Some(rest) = v.strip_prefix(&original)
        && let Ok(nv) = HeaderValue::from_str(if rest.is_empty() { "/" } else { rest })
    {
        h.insert(header::LOCATION, nv);
    }
    let cookies: Vec<HeaderValue> = h.get_all(header::SET_COOKIE).iter().filter_map(|v| HeaderValue::from_str(&drop_domain(v.to_str().ok()?)).ok()).collect();
    if !cookies.is_empty() {
        h.remove(header::SET_COOKIE);
        for c in cookies {
            h.append(header::SET_COOKIE, c);
        }
    }
    Response::from_parts(parts, Body::new(body))
}

/// `http://<아무 호스트>:<대리 포트><나머지>` 면 나머지 (`Origin` · `Referer` 를 원래 주소로 바꿀 때)
fn proxy_origin_rest(v: &str, port: u16) -> Option<&str> {
    let rest = v.strip_prefix("http://")?;
    let end = rest.find('/').unwrap_or(rest.len());
    rest[..end].ends_with(&format!(":{port}")).then_some(&rest[end..])
}

/// `Set-Cookie` 의 `Domain=…` 을 뺀다 (대리 주소 호스트에서도 쿠키가 남게)
fn drop_domain(cookie: &str) -> String {
    cookie.split(';').filter(|a| !a.trim().to_ascii_lowercase().starts_with("domain=")).collect::<Vec<_>>().join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_targets() {
        assert_eq!(local_target("http://localhost:3000/a?b"), Some(Target { authority: "localhost:3000".into(), connect: "localhost:3000".into() }));
        assert_eq!(local_target("http://0.0.0.0:5173").map(|t| t.connect), Some("127.0.0.1:5173".into()));
        assert_eq!(local_target("http://[::1]:8080/").map(|t| t.connect), Some("[::1]:8080".into()));
        assert_eq!(local_target("http://localhost/").map(|t| t.connect), Some("localhost:80".into()));
        assert_eq!(local_target("https://localhost:3000"), None);
        assert_eq!(local_target("http://example.com:3000"), None);
        assert_eq!(local_target("http://192.168.0.2:3000"), None);
    }

    #[test]
    fn token_and_headers() {
        let (t, clean) = take_token(&"/app?x=1&thuminal_proxy=abc&y=2".parse().unwrap());
        assert_eq!((t.as_deref(), clean.as_str()), (Some("abc"), "/app?x=1&y=2"));
        let (t, clean) = take_token(&"/?thuminal_proxy=abc".parse().unwrap());
        assert_eq!((t.as_deref(), clean.as_str()), (Some("abc"), "/"));
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; thuminal_proxy=tok; b=2"));
        assert_eq!(take_cookie(&mut h).as_deref(), Some("tok"));
        assert_eq!(h.get(header::COOKIE).unwrap(), "a=1; b=2");
        assert_eq!(proxy_origin_rest("http://100.1.2.3:6781/x", 6781), Some("/x"));
        assert_eq!(proxy_origin_rest("http://100.1.2.3:6782", 6781), None);
        assert_eq!(drop_domain("s=1; Domain=localhost; Path=/"), "s=1; Path=/");
    }
}
