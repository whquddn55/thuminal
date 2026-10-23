//! 데몬 쪽 Ghostty 엔진 확인용 시제품.
//!
//! 1. 처리 속도: 녹화된 claude 출력을 엔진에 넣는 데 걸리는 시간
//! 2. 화면 저장·복원: snapshot 으로 저장했다 되살린 터미널이 원래와 같은지
//! 3. 메모리: 터미널 N 개가 같은 출력을 들고 있을 때 늘어나는 RSS
//!
//! 사용법: vt-daemon-probe <workload 파일...> [--terminals 20]

use std::time::Instant;

use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use libghostty_vt::snapshot::Decoder;
use libghostty_vt::Terminal;

const COLS: u16 = 300;
const ROWS: u16 = 60;
const SCROLLBACK_LINES: usize = 10_000;

fn new_terminal<'a>() -> Terminal<'a, 'a> {
    let mut t = Terminal::new(COLS, ROWS).expect("terminal");
    t.set_scrollback_max_lines(Some(SCROLLBACK_LINES)).expect("scrollback");
    // 기본 바이트 한도가 작아 줄 한도보다 먼저 걸린다. 줄 한도만 쓰도록 바이트 한도를 푼다
    t.set_scrollback_max_bytes(None).expect("scrollback bytes");
    t
}

fn format(t: &Terminal<'_, '_>, f: Format) -> Vec<u8> {
    let mut fm = Formatter::new(t, FormatterOptions::new().with_format(f)).expect("formatter");
    let mut buf = vec![0; fm.format_len().expect("len")];
    let n = fm.format_buf(&mut buf).expect("format");
    buf.truncate(n);
    buf
}

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1024.0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut files = Vec::new();
    let mut n_terms = 20usize;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--terminals" {
            n_terms = it.next().and_then(|v| v.parse().ok()).expect("--terminals N");
        } else {
            files.push(a.clone());
        }
    }
    let workloads: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|f| (f.clone(), std::fs::read(f).expect("read workload")))
        .collect();

    println!("## 1. 처리 속도 ({COLS}x{ROWS}, 스크롤백 {SCROLLBACK_LINES}줄)");
    for (name, data) in &workloads {
        let mut t = new_terminal();
        let start = Instant::now();
        // PTY 에서 오는 것처럼 4KB 씩 끊어 넣는다
        for chunk in data.chunks(4096) {
            t.vt_write(chunk);
        }
        let secs = start.elapsed().as_secs_f64();
        let mb = data.len() as f64 / 1_048_576.0;
        println!(
            "- {}: {:.2} MB, {:.1} ms, {:.0} MB/s",
            std::path::Path::new(name).file_name().unwrap().to_string_lossy(),
            mb,
            secs * 1000.0,
            mb / secs
        );
    }

    println!("\n## 2. 화면 저장·복원");
    for (name, data) in &workloads {
        let mut t = new_terminal();
        t.vt_write(data);
        let before_vt = format(&t, Format::Vt);
        let before_plain = format(&t, Format::Plain);

        let start = Instant::now();
        let mut snap = Vec::new();
        t.encode_snapshot(&mut snap).expect("encode");
        let enc_ms = start.elapsed().as_secs_f64() * 1000.0;

        let start = Instant::now();
        let restored = Decoder::new_buf(&snap).expect("decoder").decode().expect("decode");
        let dec_ms = start.elapsed().as_secs_f64() * 1000.0;

        let same_vt = format(&restored, Format::Vt) == before_vt;
        let after_plain = format(&restored, Format::Plain);
        let same_plain = after_plain == before_plain;
        if !same_plain {
            let a: Vec<&[u8]> = before_plain.split(|&b| b == b'\n').collect();
            let b: Vec<&[u8]> = after_plain.split(|&b| b == b'\n').collect();
            let first = a.iter().zip(b.iter()).position(|(x, y)| x != y);
            println!("  원래 {}줄, 복원 {}줄, 처음 다른 줄 {:?}", a.len(), b.len(), first);
            if let Some(i) = first {
                println!("  원래: {:?}", String::from_utf8_lossy(&a[i][..a[i].len().min(80)]));
                println!("  복원: {:?}", String::from_utf8_lossy(&b[i][..b[i].len().min(80)]));
            }
        }
        println!(
            "- {}: 줄 {}, 저장본 {:.0} KB, 저장 {:.1} ms, 복원 {:.1} ms, VT 출력 같음 {}, 글자 같음 {}",
            std::path::Path::new(name).file_name().unwrap().to_string_lossy(),
            before_plain.iter().filter(|&&b| b == b'\n').count() + 1,
            snap.len() as f64 / 1024.0,
            enc_ms,
            dec_ms,
            same_vt,
            same_plain
        );
    }

    println!("\n## 3. 메모리 (터미널 {n_terms}개)");
    let base = rss_mb();
    let mut terms = Vec::new();
    for i in 0..n_terms {
        let mut t = new_terminal();
        t.vt_write(&workloads[i % workloads.len()].1);
        terms.push(t);
    }
    let after = rss_mb();
    println!(
        "- 시작 {:.0} MB → 터미널 {}개 뒤 {:.0} MB (터미널당 약 {:.1} MB)",
        base,
        n_terms,
        after,
        (after - base) / n_terms as f64
    );
}
