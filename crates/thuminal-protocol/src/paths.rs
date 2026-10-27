//! 데이터 폴더와 그 안의 파일 이름. 데몬과 클라이언트가 같은 곳을 보게 한다.

use std::path::{Path, PathBuf};

use crate::PROTOCOL_MAJOR;

/// 사용자 홈 폴더. 유닉스는 `HOME`, Windows 는 `HOME` 이 보통 없어 `USERPROFILE` 을 본다
pub fn user_home() -> Option<PathBuf> {
    let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    var("HOME").or_else(|| if cfg!(windows) { var("USERPROFILE") } else { None })
}

/// 데이터 폴더. `THUMINAL_HOME` 이 있으면 그것을 쓴다 (시험, 여러 벌 띄우기).
/// 없으면 macOS 는 `~/Library/Application Support/thuminal`, Windows 는 `%LOCALAPPDATA%\dev.thuminal.app`,
/// 그 밖은 `$XDG_DATA_HOME/thuminal`(없으면 `~/.local/share/thuminal`)
pub fn home() -> PathBuf {
    if let Some(p) = std::env::var_os("THUMINAL_HOME") {
        return PathBuf::from(p);
    }
    if cfg!(windows)
        && let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())
    {
        // `%LOCALAPPDATA%\thuminal` 은 NSIS 설치본(사용자 설치)의 프로그램 폴더라 겹치지 않게 앱 식별자 폴더를 쓴다.
        // 웹뷰 데이터(EBWebView)도 이 폴더에 있고, 지울 때 "앱 데이터 지우기" 를 고르면 함께 지워진다
        return PathBuf::from(local).join("dev.thuminal.app");
    }
    let base = user_home().unwrap_or_else(std::env::temp_dir);
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
