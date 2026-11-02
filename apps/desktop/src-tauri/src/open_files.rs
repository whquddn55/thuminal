//! Finder · 파일 탐색기에서 "다음으로 열기 → thuminal" 로 연 파일을 화면에 넘긴다.
//!
//! 파일 종류 등록은 설치본이 한다 (macOS · Linux 는 `tauri.conf.json` `bundle.fileAssociations`,
//! Windows 는 `windows/file-associations.nsh`). 여기서는 운영체제가 넘긴 경로를 받는다.
//!
//! - macOS 는 `RunEvent::Opened` 로 온다. 꺼진 앱이 파일로 켜질 때도 같다.
//! - Windows · Linux 는 실행 인자로 온다. 이미 켜진 앱이 있으면 `tauri-plugin-single-instance` 가 새 프로세스를 끝내고
//!   그 인자를 켜진 앱에 넘긴다.
//!
//! 앱이 막 켜졌으면 화면이 아직 준비되지 않았으므로 경로를 쌓아 두고, 화면은 `OPEN_EVENT` 를 받거나 시작할 때
//! `take_opened_files` 로 쌓인 것을 가져간다 (이벤트에는 경로를 싣지 않아 두 번 열리지 않는다).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 열 파일이 쌓였다고 화면에 알리는 이벤트 (`tauri-host.ts` `onOpenFiles`)
const OPEN_EVENT: &str = "thuminal://open-files";

/// 화면이 아직 가져가지 않은 경로
#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

/// 받은 경로를 쌓고 창을 앞으로 가져온 뒤 화면에 알린다
pub fn push(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<String> = paths.into_iter().filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned()).collect();
    if paths.is_empty() {
        return;
    }
    app.state::<Pending>().0.lock().unwrap().extend(paths);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit_to("main", OPEN_EVENT, ());
}

/// 실행 인자에서 파일 경로를 고른다 (첫 인자는 실행 파일). 상대 경로는 `cwd` 기준이다
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.is_file())
        .collect()
}

/// 화면이 쌓인 경로를 가져간다 (가져간 것은 지운다)
#[tauri::command]
pub fn take_opened_files(pending: tauri::State<'_, Pending>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_existing_files_from_args() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.md"), "").unwrap();
        std::fs::create_dir(d.path().join("dir")).unwrap();
        let args = ["thuminal", "a.md", "--flag", "dir", "missing.md"].map(String::from);
        assert_eq!(from_args(args, d.path()), vec![d.path().join("a.md")], "옵션 · 폴더 · 없는 파일은 뺀다");
        let abs = d.path().join("a.md").to_string_lossy().into_owned();
        assert_eq!(from_args(["thuminal".into(), abs], Path::new("/")), vec![d.path().join("a.md")]);
    }
}
