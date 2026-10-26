//! claude 를 Esc · ⌃C 로 멈추면 Stop 훅이 오지 않아 "일하는 중" 으로 남는다. 두 가지로 알아챈다.
//!
//! 1. 화면: Orca 처럼 "멈춤 키 + claude 스스로 쉬고 있다는 증거" 를 맞춘다. Orca 는 증거로 claude 의 OSC 7501
//!    상태 보고(2.1.295 부터)나 터미널 제목 글리프(일할 때 ◐◑◒◓ · 브라유, 쉴 때 ✳)를 본다. 제목 글리프는 주제가
//!    바뀔 때만 다시 써서 일하는 동안에도 ✳ 로 남는 일이 잦으므로, 여기서는 일하는 동안 아래 줄에 늘 보이는
//!    "esc to interrupt" 를 증거로 쓴다. 키를 보낼 때 이 글이 보였고, 3초 안에 사라져 잠시 그대로면 멈춘 것이다
//!    (메뉴를 닫는 Esc 처럼 일이 계속되면 글이 남는다).
//! 2. 대화 기록: 응답 도중 멈추면 claude 는 기록에 `[Request interrupted by user]`(도구 중이면 `… for tool use`)
//!    사용자 글을 남긴다. 다른 길(웹 · CLI 입력, 권한 창의 Esc)로 멈춘 것도 잡는다.
//!    보내자마자 멈추면 프롬프트가 입력 칸으로 돌아가고 기록에 아무것도 남지 않아 1 만 잡는다.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 기록 끝에서 읽을 바이트. 마지막 대화 줄 하나가 이보다 길면 놓친다 (다음 훅이 상태를 바로잡는다)
const TAIL: u64 = 64 * 1024;
const MARK: &str = "[Request interrupted by user";

/// claude 가 일하는 동안 아래 상태 줄에 보이는 글
const WORKING_HINT: &str = "esc to interrupt";
/// 멈춤 키를 보낸 뒤 이 안에 쉬는 화면이 되지 않으면 멈추지 않은 것으로 본다
const ESC_WINDOW_MS: u64 = 3000;
/// 글이 사라진 뒤 이만큼 그대로여야 멈춘 것으로 본다 (다시 그리는 중간 화면에 속지 않게)
const ESC_SETTLE_MS: u64 = 250;
/// 지켜보는 동안 출력이 없어도 다시 볼 간격
pub const ESC_RECHECK: std::time::Duration = std::time::Duration::from_millis(100);

/// 혼자 온 Esc(kitty 키보드 프로토콜의 Esc 누름 포함)나 ⌃C
pub fn is_interrupt_key(data: &[u8]) -> bool {
    matches!(data, b"\x1b" | b"\x03" | b"\x1b[27u" | b"\x1b[27;1u" | b"\x1b[27;1:1u" | b"\x1b[99;5u")
}

pub fn shows_working(screen: &str) -> bool {
    screen.contains(WORKING_HINT)
}

pub enum Verdict {
    Wait,
    Interrupted,
    GiveUp,
}

pub struct EscWatch {
    /// 키를 보낼 때 에이전트 상태의 updated_at. 그 뒤 훅이 오면 훅을 믿는다
    pub updated_at: u64,
    started: u64,
    idle_since: Option<u64>,
}

impl EscWatch {
    pub fn new(updated_at: u64, now: u64) -> Self {
        Self { updated_at, started: now, idle_since: None }
    }

    pub fn observe(&mut self, working: bool, now: u64) -> Verdict {
        if working {
            self.idle_since = None;
        } else if let Some(since) = self.idle_since {
            if now - since >= ESC_SETTLE_MS {
                return Verdict::Interrupted;
            }
        } else {
            self.idle_since = Some(now);
        }
        if now - self.started > ESC_WINDOW_MS + ESC_SETTLE_MS { Verdict::GiveUp } else { Verdict::Wait }
    }
}

/// 기록의 마지막 대화 줄(user · assistant)이 멈춤 표시면 그 시각(유닉스 ms)
pub fn interrupted_at(transcript: &Path) -> Option<u64> {
    let mut f = std::fs::File::open(transcript).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    last_interrupt(&String::from_utf8_lossy(&buf))
}

fn last_interrupt(text: &str) -> Option<u64> {
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let kind = v.get("type").and_then(|t| t.as_str());
        if !matches!(kind, Some("user" | "assistant")) || v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
            continue;
        }
        if kind != Some("user") || !has_mark(v.pointer("/message/content")?) {
            return None;
        }
        return v.get("timestamp").and_then(|t| t.as_str()).and_then(parse_rfc3339_ms);
    }
    None
}

/// 글 조각 · tool_result 내용 어디든 멈춤 표시로 시작하는 글이 있다
fn has_mark(content: &serde_json::Value) -> bool {
    match content {
        serde_json::Value::String(s) => s.starts_with(MARK),
        serde_json::Value::Array(items) => items.iter().any(|i| {
            i.get("text").and_then(|t| t.as_str()).is_some_and(|t| t.starts_with(MARK)) || i.get("content").is_some_and(has_mark)
        }),
        _ => false,
    }
}

/// `2026-10-26T05:58:20.659Z` → 유닉스 ms (UTC 만)
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let (date, time) = s.trim_end_matches('Z').split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    // 그레고리력 날짜 → 1970-01-01 부터 날 수 (Howard Hinnant days_from_civil)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + hh) * 60 + mm) * 60 * 1000 + ss * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esc_watch_needs_hint_to_stay_gone() {
        let mut w = EscWatch::new(1, 0);
        assert!(matches!(w.observe(false, 10), Verdict::Wait));
        assert!(matches!(w.observe(true, 100), Verdict::Wait));
        assert!(matches!(w.observe(false, 200), Verdict::Wait));
        assert!(matches!(w.observe(false, 460), Verdict::Interrupted));
        let mut w = EscWatch::new(1, 0);
        assert!(matches!(w.observe(true, 3300), Verdict::GiveUp));
        assert!(is_interrupt_key(b"\x1b") && is_interrupt_key(b"\x03") && !is_interrupt_key(b"\x1b[A"));
    }

    #[test]
    fn parses_timestamp() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_rfc3339_ms("2026-10-26T05:58:20.659Z"), Some(1_792_994_300_659));
    }

    #[test]
    fn finds_interrupt_only_when_last() {
        let interrupted = r#"{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"[Request interrupted by user for tool use]"}]},"timestamp":"1970-01-01T00:00:02.000Z"}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"timestamp":"1970-01-01T00:00:03.000Z"}
{"type":"attachment"}
"#;
        assert_eq!(last_interrupt(interrupted), Some(3000));
        let resumed = format!("{interrupted}{}\n", r#"{"type":"user","message":{"content":"next"},"timestamp":"1970-01-01T00:00:04.000Z"}"#);
        assert_eq!(last_interrupt(&resumed), None);
        assert_eq!(last_interrupt(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#), None);
    }
}
