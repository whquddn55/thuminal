//! 데몬을 설치본 밖에서 실행한다.
//!
//! 설치본 안 데몬을 그대로 띄우면 업데이트가 데몬을 내려야 한다: Windows 는 떠 있는 `thuminald.exe` 를 덮어쓰지 못하고,
//! Linux AppImage 는 앱이 끝나면 데몬이 돌던 마운트가 사라진다. 그래서 앱 · CLI 는 데몬을 띄우기 전에
//! 데몬 · CLI 실행 파일과 claude 플러그인을 데이터 폴더 `runtime/<데몬 빌드 id>/` 로 복사하고 그것을 띄운다.
//! 그러면 설치본은 아무도 쓰지 않아 마음대로 바꿀 수 있고, 업데이트한 앱은 OS 와 상관없이 떠 있는 데몬의 빌드 id 가
//! 자기 것과 다를 때만 데몬을 다시 시작한다.
//!
//! - 빌드 폴더 안 차림은 데몬이 리소스를 찾는 자리(실행 파일 옆 `claude-plugin`)와 맞춘다. 데몬은 세션에 옆의 CLI 를 넘긴다.
//! - 웹 화면은 데몬 빌드 id 해시에 들지 않아 빌드 폴더에 두면 웹 화면만 바뀐 업데이트가 닿지 않는다.
//!   그래서 고정 폴더 `runtime/web` 에 두고 앱 버전이 바뀌면 바꿔 끼운다 (데몬은 요청마다 이 폴더에서 읽는다).
//! - 쓰지 않는 옛 빌드 폴더는 새 데몬이 시작할 때 지운다 (thuminald `prune_runtime`. 데몬 동작이라 데몬 빌드 id 에 드는 쪽에 둔다).
//! - 개발 빌드(`debug_assertions`)와 `THUMINAL_DAEMON_BIN` 을 준 경우는 복사하지 않고 실행 파일 옆 데몬을 그대로 띄운다.

use std::path::{Path, PathBuf};

use thuminal_protocol::paths::{Paths, RUNTIME_READY as READY};

/// `runtime/web` 을 채운 앱 버전
const WEB_VERSION: &str = ".version";

fn exe(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// 설치본 리소스 폴더 안 `name`. Tauri 가 리소스를 두는 곳은 OS 마다 다르다:
/// macOS 는 `Contents/MacOS/../Resources`, Linux(deb · AppImage)는 `usr/bin/../lib/thuminal`, Windows 는 실행 파일 옆이다
fn bundled_resource(exe_dir: &Path, name: &str, marker: &str) -> Option<PathBuf> {
    ["../Resources", "../lib/thuminal", "."].iter().map(|base| exe_dir.join(base).join(name)).find(|p| p.join(marker).is_file())
}

/// 띄울 데몬 실행 파일. 릴리스 빌드면 설치본 데몬을 `runtime/<빌드 id>/` 로 복사해 그것을 돌려주고 웹 화면도 맞춘다.
/// 복사하지 못하면 설치본 데몬을 그대로 돌려준다 (예전처럼 동작한다)
pub fn prepare_daemon(paths: &Paths) -> PathBuf {
    let bundled = crate::default_daemon_bin();
    if cfg!(debug_assertions) || std::env::var_os("THUMINAL_DAEMON_BIN").is_some() {
        return bundled;
    }
    let Some(src) = bundled.parent().map(Path::to_path_buf) else { return bundled };
    if !bundled.is_file() {
        return bundled;
    }
    refresh_web(paths, &src);
    match stage(paths, &src) {
        Ok(dir) => dir.join(exe("thuminald")),
        Err(e) => {
            tracing::warn!(event = "daemon_stage_failed", error = %e);
            bundled
        }
    }
}

/// 빌드 폴더를 만든다. 이미 다 복사돼 있으면 그대로 쓴다
fn stage(paths: &Paths, src: &Path) -> std::io::Result<PathBuf> {
    let root = paths.runtime();
    let dir = root.join(thuminal_protocol::DAEMON_BUILD);
    if dir.join(READY).is_file() {
        return Ok(dir);
    }
    std::fs::create_dir_all(&root)?;
    // 반쯤 남은 폴더(복사하다 끊김)는 지우고 새로 만든다
    let _ = std::fs::remove_dir_all(&dir);
    let tmp = root.join(format!(".tmp-{}-{}", thuminal_protocol::DAEMON_BUILD, std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let result = (|| {
        for name in [exe("thuminald"), exe("thuminal")] {
            let from = src.join(&name);
            if from.is_file() {
                std::fs::copy(&from, tmp.join(&name))?;
                unquarantine(&tmp.join(&name));
            }
        }
        if let Some(plugin) = bundled_resource(src, "claude-plugin", ".claude-plugin/plugin.json") {
            copy_dir(&plugin, &tmp.join("claude-plugin"))?;
        }
        std::fs::write(tmp.join(READY), env!("CARGO_PKG_VERSION"))
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, &dir) {
        let _ = std::fs::remove_dir_all(&tmp);
        // 다른 앱 · CLI 가 먼저 만들었으면 그것을 쓴다
        if !dir.join(READY).is_file() {
            return Err(e);
        }
    }
    tracing::info!(event = "daemon_staged", dir = %dir.display());
    Ok(dir)
}

/// 설치본 웹 화면을 `runtime/web` 으로 맞춘다. 앱 버전이 같으면 그대로 둔다.
/// 새 폴더를 다 채운 뒤 바꿔 끼워, 떠 있는 데몬이 반쯤 복사된 파일을 내지 않게 한다
fn refresh_web(paths: &Paths, src: &Path) {
    let Some(web) = bundled_resource(src, "web", "index.html") else { return };
    let root = paths.runtime();
    let dest = root.join("web");
    let version = env!("CARGO_PKG_VERSION");
    if std::fs::read_to_string(dest.join(WEB_VERSION)).is_ok_and(|v| v == version) {
        return;
    }
    let tmp = root.join(format!(".web-tmp-{}", std::process::id()));
    let old = root.join(format!(".web-old-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let filled = std::fs::create_dir_all(&root).and_then(|_| copy_dir(&web, &tmp)).and_then(|_| std::fs::write(tmp.join(WEB_VERSION), version));
    if let Err(e) = filled {
        let _ = std::fs::remove_dir_all(&tmp);
        tracing::warn!(event = "web_stage_failed", error = %e);
        return;
    }
    let had = dest.exists() && std::fs::rename(&dest, &old).is_ok();
    if std::fs::rename(&tmp, &dest).is_err() {
        // 바꿔 끼우지 못했으면 옛것을 돌려놓는다
        if had {
            let _ = std::fs::rename(&old, &dest);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return;
    }
    let _ = std::fs::remove_dir_all(&old);
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), &target)?;
        }
    }
    Ok(())
}

/// 브라우저로 받은 설치본이면 복사본에도 격리 표시가 따라와 Gatekeeper 가 실행을 막을 수 있어 뗀다 (macOS)
fn unquarantine(_path: &Path) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        if let Ok(p) = std::ffi::CString::new(_path.as_os_str().as_bytes()) {
            // SAFETY: 살아 있는 C 문자열 두 개를 넘긴다
            unsafe { libc::removexattr(p.as_ptr(), c"com.apple.quarantine".as_ptr(), 0) };
        }
    }
}
