//! 앱 쪽 엔진(ghostty-vt.wasm) 시험에 쓰는 고유 저장본을 만든다.
//! 데몬 엔진과 wasm 엔진의 Ghostty 버전이 달라도 저장본을 읽을 수 있는지 확인하려는 것이다.
//!
//! cargo run -p thuminal-engine-ghostty --example snapshot_fixture -- <출력 파일>

use thuminal_engine::{EngineConfig, EngineFactory, SnapshotFormat};
use thuminal_engine_ghostty::GhosttyFactory;

fn main() {
    let out = std::env::args().nth(1).expect("출력 파일");
    let mut e = GhosttyFactory.create(EngineConfig { cols: 40, rows: 6, scrollback_lines: 1000 }).unwrap();
    e.feed("\x1b]2;fixture title\x07".as_bytes());
    for i in 0..20 {
        e.feed(format!("\x1b[3{}mline {i}\x1b[0m\r\n", i % 8).as_bytes());
    }
    e.feed("한글 \x1b[1mbold\x1b[0m end".as_bytes());
    std::fs::write(out, e.snapshot(SnapshotFormat::Native).unwrap()).unwrap();
}
