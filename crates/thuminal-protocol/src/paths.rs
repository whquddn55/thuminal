//! 데이터 폴더와 그 안의 파일 이름. 데몬과 클라이언트가 같은 곳을 보게 한다.

use std::path::{Path, PathBuf};

use crate::PROTOCOL_MAJOR;

/// 데이터 폴더. `THUMINAL_HOME` 이 있으면 그것을 쓴다 (시험, 여러 벌 띄우기).
pub fn home() -> PathBuf {
    if let Some(p) = std::env::var_os("THUMINAL_HOME") {
        return PathBuf::from(p);
    }
    let base = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    if cfg!(target_os = "macos") {
        base.join("Library/Application Support/thuminal")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| base.join(".local/share")).join("thuminal")
    }
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
}

impl Paths {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self { home: home.as_ref().to_path_buf() }
    }

    pub fn default_home() -> Self {
        Self::new(home())
    }

    /// 주 버전이 이름에 들어간다. 새 주 버전 앱은 새 데몬을 띄우고, 옛 데몬은 그대로 둔다.
    pub fn socket(&self) -> PathBuf {
        self.home.join(format!("daemon-v{PROTOCOL_MAJOR}.sock"))
    }

    pub fn lock(&self) -> PathBuf {
        self.home.join(format!("daemon-v{PROTOCOL_MAJOR}.lock"))
    }

    pub fn logs(&self) -> PathBuf {
        self.home.join("logs")
    }
}
