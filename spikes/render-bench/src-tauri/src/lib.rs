//! 렌더링 측정 시제품의 Rust 쪽.
//!
//! 바깥 스크립트가 환경 변수로 시나리오를 넘기고, 화면 쪽이 측정을 끝내면
//! 결과 JSON 을 파일로 쓰고 앱을 끝낸다.
//! - BENCH_ARGS: 화면 쪽에 넘길 시나리오 (쿼리 문자열 모양, 예: mode=ghostty&visible=1)
//! - BENCH_WORKLOAD_DIR: 녹화된 터미널 출력 파일이 든 폴더
//! - BENCH_OUT: 결과 JSON 을 쓸 경로

use tauri::ipc::Response;

#[tauri::command]
fn bench_args() -> String {
    std::env::var("BENCH_ARGS").unwrap_or_default()
}

/// 녹화 파일 목록 (이름순). 화면 쪽은 터미널 i 에 i % 개수 번째 파일을 흘린다.
fn workload_files() -> Vec<std::path::PathBuf> {
    let dir = std::env::var("BENCH_WORKLOAD_DIR").expect("BENCH_WORKLOAD_DIR");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .expect("workload dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "log"))
        .collect();
    files.sort();
    files
}

#[tauri::command]
fn workload_count() -> usize {
    workload_files().len()
}

#[tauri::command]
fn load_workload(index: usize) -> Response {
    let files = workload_files();
    Response::new(std::fs::read(&files[index % files.len()]).expect("read workload"))
}

#[tauri::command]
fn bench_log(msg: String) {
    eprintln!("[bench] {msg}");
}

#[tauri::command]
fn bench_done(app: tauri::AppHandle, result: String) {
    if let Ok(out) = std::env::var("BENCH_OUT") {
        std::fs::write(out, result).expect("write result");
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                // BENCH_WINDOW="x,y,w,h" (논리 좌표, 왼쪽 위 기준): 레티나 화면 같은 특정 화면에 창을 놓는다
                if let Ok(spec) = std::env::var("BENCH_WINDOW") {
                    let v: Vec<f64> = spec.split(',').filter_map(|s| s.trim().parse().ok()).collect();
                    if v.len() == 4 {
                        w.set_position(tauri::LogicalPosition::new(v[0], v[1]))?;
                        w.set_size(tauri::LogicalSize::new(v[2], v[3]))?;
                    }
                }
                eprintln!("[bench] setup: visible={:?}", w.is_visible());
                w.show()?;
                w.set_focus()?;
                eprintln!("[bench] setup 뒤: visible={:?}", w.is_visible());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bench_args,
            workload_count,
            load_workload,
            bench_done,
            bench_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
