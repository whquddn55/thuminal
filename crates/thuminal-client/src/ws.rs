//! 원격 접속 웹소켓 전송과 짝짓기 주소.
//!
//! 데몬 `/ws` 는 웹소켓 메시지 하나에 프레임 하나를 길이 머리 없이(`[종류 u8][내용]`) 싣는다
//! (`thuminal-daemon/src/remote.rs`). 여기서는 웹소켓 하나를 바이트 줄(duplex)로 바꿔 [`crate::Client`] 가
//! 유닉스 소켓과 똑같이 읽고 쓰게 한다. 토큰은 웹 화면(`apps/web/src/web-host.ts`)과 같이 `/ws?token=` 에 싣는다.
//!
//! 짝짓기 주소는 원격 컴퓨터의 `thuminal remote pair <이름>` 이나 설정 창이 찍는 `http://100.x.y.z:6780/#token=…` 다.
//! 길을 Tailscale(WireGuard)이 암호화하므로 Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)와 시험용 127.0.0.1 만 받는다.
//! 같은 Wi‑Fi 주소는 키 입력이 평문으로 오가므로 거절한다.

use std::net::IpAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use thuminal_protocol::frame::MAX_FRAME;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::{ClientError, Result};

/// 원격 데몬 기본 포트 (`remote.json` 의 기본값과 같다)
pub const DEFAULT_PORT: u16 = 6780;
/// 붙기(TCP + 웹소켓 손잡기)를 기다리는 시간. Tailscale 상대가 꺼져 있으면 TCP 가 오래 매달린다
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 데몬은 25초마다 핑을 보낸다. 이만큼 아무것도 오지 않으면 길이 죽었다고 보고 끊는다 (잠자기, 망 바뀜)
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 짝짓기 주소를 푼 것
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairUrl {
    /// `http://100.1.2.3:6780`, `http://[fd7a:…]:6780` (끝 / 없이)
    pub base: String,
    pub ip: IpAddr,
    pub port: u16,
    pub token: String,
}

/// 원격 호스트로 받는 주소인지: Tailscale 주소와 시험용 127.0.0.1
pub fn allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            (o[0] == 100 && (o[1] & 0xc0) == 64) || o == [127, 0, 0, 1]
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// `http://<주소>:<포트>/#token=<토큰>` 을 푼다. 포트가 없으면 6780. Tailscale 주소가 아니면 거절한다
pub fn parse_pair_url(input: &str) -> std::result::Result<PairUrl, String> {
    let s = input.trim();
    let rest = if let Some(r) = s.strip_prefix("http://") {
        r
    } else if s.starts_with("https://") {
        return Err("thuminal 원격 접속은 https 가 아니라 http 주소를 써요. 연결은 Tailscale 이 암호화해요".into());
    } else {
        return Err("http:// 로 시작하는 주소를 붙여 넣어 주세요. 주소는 원격 컴퓨터에서 thuminal remote pair <이름> 으로 만들어요".into());
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains('@') {
        return Err("주소에 사용자 정보는 넣을 수 없어요".into());
    }
    let (host, port) = split_host_port(authority)?;
    let ip: IpAddr = host.parse().map_err(|_| format!("IP 주소가 아니에요: {host}. Tailscale 주소(100.x.y.z)를 써 주세요"))?;
    if !allowed_ip(ip) {
        return Err(format!("Tailscale 주소가 아니에요: {ip}. 암호화되지 않는 연결이라 쓸 수 없어요. 100.64.0.0/10, fd7a:115c:a1e0::/48 주소만 쓸 수 있어요"));
    }
    let token = tail
        .split(['#', '?', '&'])
        .find_map(|part| part.strip_prefix("token="))
        .filter(|t| !t.is_empty())
        .ok_or("주소에 토큰(#token=…)이 없어요")?;
    if !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("토큰 모양이 올바르지 않아요. 영문과 숫자만 쓸 수 있어요".into());
    }
    let base = match ip {
        IpAddr::V4(_) => format!("http://{ip}:{port}"),
        IpAddr::V6(_) => format!("http://[{ip}]:{port}"),
    };
    Ok(PairUrl { base, ip, port, token: token.to_string() })
}

fn split_host_port(authority: &str) -> std::result::Result<(&str, u16), String> {
    let (host, port) = if let Some(r) = authority.strip_prefix('[') {
        let close = r.find(']').ok_or("IPv6 주소에 ] 가 없어요")?;
        let after = &r[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => Some(p),
            None if after.is_empty() => None,
            None => return Err(format!("주소 모양이 올바르지 않아요: {authority}")),
        };
        (&r[..close], port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return Err("주소가 비어 있어요".into());
    }
    let port = match port {
        Some(p) => p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| format!("포트가 올바르지 않아요: {p}"))?,
        None => DEFAULT_PORT,
    };
    Ok((host, port))
}

/// 웹소켓으로 붙어 프레임 바이트 줄 한 쌍을 돌려준다. 줄을 놓으면(클라이언트가 내려가면) 웹소켓도 닫는다
pub(crate) async fn connect(base: &str, token: &str) -> Result<(ReadHalf<DuplexStream>, WriteHalf<DuplexStream>)> {
    let ws_base = if let Some(r) = base.strip_prefix("http://") {
        format!("ws://{r}")
    } else if base.starts_with("ws://") {
        base.to_string()
    } else {
        return Err(ClientError::ConnectRemote { url: base.into(), reason: "http:// 주소가 아니에요".into() });
    };
    let url = format!("{}/ws?token={token}", ws_base.trim_end_matches('/'));
    let shown = format!("{}/ws", ws_base.trim_end_matches('/'));
    let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
    let fail = |reason: String| ClientError::ConnectRemote { url: shown.clone(), reason };
    let ws = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async_with_config(url, Some(config), true)).await {
        Err(_) => return Err(fail(format!("{}초 안에 응답이 없어요", CONNECT_TIMEOUT.as_secs()))),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(r))) if r.status().as_u16() == 401 => return Err(ClientError::Unauthorized),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(r))) => return Err(fail(format!("HTTP {}", r.status()))),
        Ok(Err(e)) => return Err(fail(e.to_string())),
        Ok(Ok((ws, _))) => ws,
    };
    let (near, far) = tokio::io::duplex(1 << 20);
    tokio::spawn(bridge(ws, far));
    Ok(tokio::io::split(near))
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 웹소켓 하나를 바이트 줄 하나로 잇는다 (데몬 `remote.rs` 의 `bridge` 를 뒤집은 것)
async fn bridge(ws: Ws, far: DuplexStream) {
    let (mut frd, mut fwr) = tokio::io::split(far);
    // 클라이언트가 쓴 프레임을 하나씩 떼어 웹소켓 메시지로 보낸다. read_exact 는 select 안에서 끊으면 안 되므로 따로 돈다
    let (ftx, mut frx) = mpsc::channel::<Vec<u8>>(256);
    let reader = tokio::spawn(async move {
        loop {
            let mut len = [0u8; 4];
            if frd.read_exact(&mut len).await.is_err() {
                break;
            }
            let n = u32::from_be_bytes(len) as usize;
            if n == 0 || n > MAX_FRAME {
                break;
            }
            let mut body = vec![0u8; n];
            if frd.read_exact(&mut body).await.is_err() || ftx.send(body).await.is_err() {
                break;
            }
        }
    });

    let (mut sink, mut stream) = ws.split();
    let mut last = tokio::time::Instant::now();
    let mut check = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            f = frx.recv() => match f {
                Some(body) => if sink.send(Message::Binary(body.into())).await.is_err() { break },
                None => break,
            },
            m = stream.next() => {
                last = tokio::time::Instant::now();
                match m {
                    Some(Ok(Message::Binary(b))) => {
                        if b.is_empty() || b.len() > MAX_FRAME {
                            break;
                        }
                        if fwr.write_all(&(b.len() as u32).to_be_bytes()).await.is_err() || fwr.write_all(&b).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // 핑에는 tungstenite 가 스스로 퐁으로 답한다
                    Some(Ok(_)) => {}
                }
            },
            _ = check.tick() => if last.elapsed() > IDLE_TIMEOUT {
                tracing::warn!("원격 데몬에서 {}초 동안 아무것도 오지 않아 끊는다", IDLE_TIMEOUT.as_secs());
                break;
            },
        }
    }
    reader.abort();
    let _ = sink.send(Message::Close(None)).await;
    // fwr 를 놓으면 클라이언트 읽기 작업이 끝(EOF)을 보고 끊겼다고 안다
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_tailscale_and_loopback() {
        for ok in ["100.64.0.1", "100.100.100.100", "100.127.255.254", "127.0.0.1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::5"] {
            assert!(allowed_ip(ok.parse().unwrap()), "{ok}");
        }
        for no in ["100.63.255.255", "100.128.0.1", "192.168.0.10", "10.0.0.1", "127.0.0.2", "0.0.0.0", "8.8.8.8", "::1", "fd7a:115c:a1e1::1", "fe80::1", "::ffff:100.64.0.1"] {
            assert!(!allowed_ip(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn parses_pair_urls() {
        let p = parse_pair_url(" http://100.101.102.103:6780/#token=abc123 ").unwrap();
        assert_eq!(p.base, "http://100.101.102.103:6780");
        assert_eq!((p.port, p.token.as_str()), (6780, "abc123"));
        let p = parse_pair_url("http://[fd7a:115c:a1e0::9]:7000/#token=ff").unwrap();
        assert_eq!(p.base, "http://[fd7a:115c:a1e0::9]:7000");
        assert_eq!(p.port, 7000);
        let p = parse_pair_url("http://100.64.1.2#token=aa").unwrap();
        assert_eq!(p.base, "http://100.64.1.2:6780");
        let p = parse_pair_url("http://127.0.0.1:1234/ws?token=bb").unwrap();
        assert_eq!((p.base.as_str(), p.token.as_str()), ("http://127.0.0.1:1234", "bb"));
    }

    #[test]
    fn rejects_bad_pair_urls() {
        for (url, why) in [
            ("http://192.168.0.5:6780/#token=aa", "Tailscale"),
            ("http://0.0.0.0:6780/#token=aa", "Tailscale"),
            ("http://mac.tail1234.ts.net:6780/#token=aa", "IP"),
            ("https://100.64.0.1:6780/#token=aa", "https"),
            ("100.64.0.1:6780/#token=aa", "http://"),
            ("http://100.64.0.1:6780/", "토큰"),
            ("http://100.64.0.1:6780/#token=", "토큰"),
            ("http://100.64.0.1:0/#token=aa", "포트"),
            ("http://100.64.0.1:99999/#token=aa", "포트"),
            ("http://user@100.64.0.1/#token=aa", "사용자"),
            ("http://100.64.0.1/#token=a%20b", "토큰"),
            ("http://[fd7a:115c:a1e0::1/#token=aa", "]"),
        ] {
            let e = parse_pair_url(url).unwrap_err();
            assert!(e.contains(why), "{url}: {e}");
        }
    }
}
