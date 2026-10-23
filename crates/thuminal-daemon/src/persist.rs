//! 세션 기록을 디스크에 남기고, 데몬이 다시 뜰 때 되살린다.
//!
//! - `sessions-v{주버전}.json`: 돌고 있는 세션의 정보 (폴더, 꼬리표, 크기, 에이전트)
//! - `sessions/<번호>.vt`: 그 세션의 화면 저장본 (VT 형식이라 엔진이 바뀌어도 읽힌다)
//!
//! 사용자가 `daemon stop` 으로 내리면 기록을 지운다. 종료 신호(재부팅, 로그아웃)나
//! 갑작스러운 종료 뒤에는 남은 기록으로 세션을 되살린다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thuminal_protocol::{PROTOCOL_MAJOR, SessionInfo, SessionState};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub info: SessionInfo,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    sessions: Vec<Record>,
}

pub struct Persist {
    file: PathBuf,
    dir: PathBuf,
}

impl Persist {
    pub fn new(home: &Path) -> Self {
        Self { file: home.join(format!("sessions-v{PROTOCOL_MAJOR}.json")), dir: home.join("sessions") }
    }

    fn snapshot_path(&self, id: u64) -> PathBuf {
        self.dir.join(format!("{id}.vt"))
    }

    /// 돌고 있는 세션 정보만 남긴다
    pub fn save_records(&self, sessions: &[SessionInfo]) {
        let saved = Saved {
            sessions: sessions.iter().filter(|s| s.state == SessionState::Running).map(|s| Record { info: s.clone() }).collect(),
        };
        let tmp = self.file.with_extension("json.tmp");
        let r = std::fs::write(&tmp, serde_json::to_vec_pretty(&saved).unwrap()).and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = r {
            warn!(event = "persist_failed", error = %e);
        }
        // 더 이상 없는 세션의 저장본은 지운다
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            let keep: Vec<String> = saved.sessions.iter().map(|r| format!("{}.vt", r.info.id.0)).collect();
            for e in entries.flatten() {
                if !keep.iter().any(|k| e.file_name().to_string_lossy() == *k) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    pub fn save_snapshot(&self, id: u64, bytes: &[u8]) {
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.snapshot_path(id);
        let tmp = path.with_extension("vt.tmp");
        if let Err(e) = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)) {
            warn!(event = "snapshot_save_failed", session = id, error = %e);
        }
    }

    /// 사용자가 데몬을 내렸다. 다음에 되살리지 않는다
    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.file);
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    /// 지난번 데몬이 남긴 기록과 화면 저장본을 꺼내고 지운다
    pub fn take_previous(&self) -> Vec<(SessionInfo, Option<Vec<u8>>)> {
        let saved: Saved = match std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(s) => s,
            None => return Vec::new(),
        };
        let out = saved
            .sessions
            .into_iter()
            .map(|r| {
                let snap = std::fs::read(self.snapshot_path(r.info.id.0)).ok();
                (r.info, snap)
            })
            .collect::<Vec<_>>();
        info!(event = "previous_sessions_found", count = out.len());
        self.clear();
        out
    }
}
