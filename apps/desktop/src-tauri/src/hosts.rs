//! 원격 호스트(다른 컴퓨터의 thuminal 데몬) 목록.
//!
//! 원격 컴퓨터에서 `thuminal remote pair <이름>` 이나 설정 창 · 원격 접속이 찍는 주소(`http://100.x.y.z:6780/#token=…`)를
//! 붙여 넣어 등록한다. 데이터 폴더의 `hosts.json`(0600, 평문 JSON. Orca 의 `orca-environments.json` 과 같다)에
//! id·이름·주소·토큰을 남긴다. 호스트마다 [`Link`] 하나가 붙어 있고, 끊기면 스스로 다시 붙는다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thuminal_client::link::{LinkState, LinkStatus};

/// `hosts.json` 에 남기는 호스트 하나
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRecord {
    pub id: String,
    pub name: String,
    /// `http://100.x.y.z:6780` (끝 / 없이)
    pub base: String,
    pub token: String,
    #[serde(default)]
    pub added_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    hosts: Vec<HostRecord>,
}

pub fn file(home: &Path) -> PathBuf {
    home.join("hosts.json")
}

pub fn load(file: &Path) -> Vec<HostRecord> {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Stored>(&b).ok()).map(|s| s.hosts).unwrap_or_default()
}

/// 토큰이 들어 있으므로 처음부터 0600 으로 만든 임시 파일에 쓰고 바꿔 끼운다 (Windows 는 사용자 폴더 권한을 물려받는다)
pub fn save(file: &Path, hosts: &[HostRecord]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(&Stored { hosts: hosts.to_vec() }).map_err(std::io::Error::other)?;
    let tmp = file.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(&tmp)?;
    f.write_all(&bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, file)
}

/// 호스트 id: 8자리 16진수
pub fn new_id() -> String {
    let mut b = [0u8; 4];
    if getrandom::fill(&mut b).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos() as u32;
        b = t.to_be_bytes();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 화면에 보내는 호스트 하나 (토큰은 싣지 않는다). TS 쪽은 `term-core` 의 `RemoteHost`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub id: String,
    pub name: String,
    pub address: String,
    /// connecting · connected · disconnected · unauthorized · version_mismatch
    pub state: &'static str,
    pub error: Option<String>,
    pub daemon_version: Option<String>,
    /// [주 판, 부 판]
    pub protocol: Option<[u32; 2]>,
    pub warning: Option<String>,
    pub retry_in_ms: Option<u64>,
}

pub fn view(r: &HostRecord, s: &LinkStatus) -> HostView {
    HostView {
        id: r.id.clone(),
        name: r.name.clone(),
        address: r.base.strip_prefix("http://").unwrap_or(&r.base).to_string(),
        state: match s.state {
            LinkState::Connecting => "connecting",
            LinkState::Connected => "connected",
            LinkState::Disconnected => "disconnected",
            LinkState::Unauthorized => "unauthorized",
            LinkState::VersionMismatch => "version_mismatch",
        },
        error: s.error.clone(),
        daemon_version: s.daemon_version.clone(),
        protocol: s.protocol.map(|(a, b)| [a, b]),
        warning: s.warning.clone(),
        retry_in_ms: s.retry_in.map(|d| d.as_millis() as u64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_with_owner_only_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let f = file(dir.path());
        assert!(load(&f).is_empty());
        let r = HostRecord { id: new_id(), name: "작업 맥".into(), base: "http://100.64.0.1:6780".into(), token: "abc".into(), added_at: 1 };
        save(&f, std::slice::from_ref(&r)).unwrap();
        save(&f, std::slice::from_ref(&r)).unwrap();
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&f).unwrap().permissions()) & 0o777, 0o600);
        let back = load(&f);
        assert_eq!(back.len(), 1);
        assert_eq!((back[0].name.as_str(), back[0].token.as_str()), ("작업 맥", "abc"));
        assert_eq!(r.id.len(), 8);
    }
}
