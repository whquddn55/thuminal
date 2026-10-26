//! claude 를 Esc 로 멈추면 Stop 훅이 오지 않아 "일하는 중" 으로 남는다. 대화 기록(transcript) 끝을 보고 알아챈다.
//! 멈추면 claude 는 기록에 `[Request interrupted by user]`(도구 중이면 `… for tool use`) 사용자 글을 남긴다.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 기록 끝에서 읽을 바이트. 마지막 대화 줄 하나가 이보다 길면 놓친다 (다음 훅이 상태를 바로잡는다)
const TAIL: u64 = 64 * 1024;
const MARK: &str = "[Request interrupted by user";

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
