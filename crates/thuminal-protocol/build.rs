//! 데몬 빌드 id (`DAEMON_BUILD`): 데몬 동작을 정하는 소스의 해시.
//!
//! 앱 버전은 릴리스마다 바뀌지만 데몬 코드는 그대로일 때가 많다. 앱은 업데이트 뒤 떠 있는 데몬의 빌드 id 가
//! 자기 것과 다를 때만 데몬을 다시 시작한다 (다시 시작하면 터미널에서 돌던 프로그램이 끝난다).
//! 해시에 넣는 것: `crates/` (데몬이 쓰지 않는 CLI · 클라이언트와 시험 폴더 빼고), 데몬이 시작할 때 짜는 claude 플러그인 `plugins/`,
//! 버전 줄을 뺀 `Cargo.toml` · `Cargo.lock`. 줄바꿈은 LF 로 맞춘다 (Windows checkout 의 CRLF).

use std::path::{Path, PathBuf};

/// 해시에서 빼는 폴더 · 파일 이름
const SKIP: &[&str] = &["target", "tests", "benches", "node_modules", "__pycache__", ".git", ".DS_Store", "thuminal-cli", "thuminal-client"];

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name();
        if SKIP.iter().any(|s| name == *s) {
            continue;
        }
        if p.is_dir() {
            files(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// FNV-1a 64비트
fn fnv(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= *b as u64;
        *h = h.wrapping_mul(0x100000001b3);
    }
}

/// thuminal 패키지 버전 줄 · 작업 공간 버전 줄을 뺀다 (릴리스마다 바뀐다)
fn without_versions(text: &str) -> String {
    let mut out = String::new();
    let mut ours = false;
    for line in text.lines() {
        if line.starts_with("name = ") {
            ours = line.starts_with("name = \"thuminal");
        }
        let workspace_version = line.starts_with("version = ") && !text.contains("[[package]]");
        if line.starts_with("version = ") && (ours || workspace_version) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut list = Vec::new();
    for dir in ["crates", "plugins"] {
        files(&root.join(dir), &mut list);
        println!("cargo:rerun-if-changed={}", root.join(dir).display());
    }
    let rel = |p: &Path| p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    list.sort_by_key(|p| rel(p));
    let mut h: u64 = 0xcbf29ce484222325;
    for p in &list {
        let Ok(bytes) = std::fs::read(p) else { continue };
        fnv(&mut h, rel(p).as_bytes());
        fnv(&mut h, &[0]);
        let bytes: Vec<u8> = bytes.into_iter().filter(|b| *b != b'\r').collect();
        fnv(&mut h, &bytes);
    }
    for f in ["Cargo.toml", "Cargo.lock"] {
        let p = root.join(f);
        println!("cargo:rerun-if-changed={}", p.display());
        if let Ok(text) = std::fs::read_to_string(&p) {
            fnv(&mut h, f.as_bytes());
            fnv(&mut h, without_versions(&text.replace('\r', "")).as_bytes());
        }
    }
    println!("cargo:rustc-env=THUMINAL_DAEMON_BUILD={h:016x}");
}
