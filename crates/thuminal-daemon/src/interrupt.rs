//! claude 를 Esc · ⌃C 로 멈추면 훅이 아무것도 오지 않아 "일하는 중" 으로 남는다. Orca(2026-10, a9d242d1)의 판정을
//! 따르고, Orca 가 못 잡는 경우를 화면 · 대화 기록으로 보탠다.
//!
//! - ⌃C: 일하는 중에 오면 0.5초 뒤 멈춘 것으로 본다 (그사이 새 훅이 오면 훅을 믿는다).
//!   Orca `agent-interrupt-inference.ts` 의 500ms settle 과 같다.
//! - Esc: claude 에서는 메뉴 · 창을 닫는 데도 쓰여 그 자체로는 증거가 아니다. Orca 는 "키를 보낼 때 일하는 중이 보였고,
//!   확인 창 안에 claude 스스로 쉬는 모습을 보이면" 멈춘 것으로 본다 (`claude-terminal-interrupt.ts`). 증거는 OSC 7501
//!   상태 보고(2.1.295 부터, 창 1.5초)나 터미널 제목 글리프(일할 때 브라유 · ◐◑◒◓, 쉴 때 ✳, 창 5초)다.
//!   여기서는 제목 글리프에 더해 화면을 본다. 제목은 주제가 바뀔 때만 다시 써서 일하는 동안에도 ✳ 로 남는 일이 잦고,
//!   보내자마자 멈추면 Orca 는 일하는 제목을 한 번도 못 봐 놓친다. 화면의 돌아가는 상태 줄(`✻ Thinking… (3s)`)과
//!   아래 줄 "esc to interrupt" 는 보낸 즉시 나타나고 쉬면 사라진다. 다시 일하는 모습이 보이면(메뉴를 닫은 Esc) 멈춤이 아니다.
//! - 묻는 도구(AskUserQuestion)를 Esc 로 닫으면 claude 는 다시 일한다. 0.5초 뒤 "일하는 중" 으로 돌린다 (Orca 와 같다).
//!   진짜 권한 창은 Esc 로 풀지 않는다.
//! - 대화 기록: 응답 도중 멈추면 claude 는 기록에 `[Request interrupted by user]`(도구 중이면 `… for tool use`) 를
//!   남긴다. 웹 · CLI 입력으로 멈춘 것도 잡는다 (Orca 는 기록을 상태에 쓰지 않는다).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 기록 끝에서 읽을 바이트. 마지막 대화 줄 하나가 이보다 길면 놓친다 (다음 훅이 상태를 바로잡는다)
const TAIL: u64 = 64 * 1024;
const MARK: &str = "[Request interrupted by user";

/// claude 가 일하는 동안 아래 줄에 보이는 글 (statusLine 을 쓰면 빠진다)
const WORKING_HINT: &str = "esc to interrupt";
/// Esc 뒤 이 안에 쉬는 모습이 되지 않으면 멈추지 않은 것으로 본다 (Orca 제목 확인 창과 같다)
const ESC_WINDOW_MS: u64 = 5000;
/// 일하는 모습이 사라진 뒤 이만큼 그대로여야 멈춘 것으로 본다 (다시 그리는 중간 화면에 속지 않게)
const ESC_SETTLE_MS: u64 = 250;
/// ⌃C · 묻는 창 Esc 를 받아들이기까지 기다리는 시간 (Orca `AGENT_INTERRUPT_SETTLE_MS`)
const KEY_SETTLE_MS: u64 = 500;
/// 지켜보는 동안 출력이 없어도 다시 볼 간격
pub const ESC_RECHECK: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Esc,
    CtrlC,
}

/// 혼자 온 Esc(kitty 키보드 프로토콜의 Esc 누름 포함, 반복 · 뗌 제외)나 ⌃C
pub fn interrupt_key(data: &[u8]) -> Option<Key> {
    match data {
        b"\x1b" | b"\x1b[27u" | b"\x1b[27;1u" | b"\x1b[27;1:1u" => Some(Key::Esc),
        b"\x03" | b"\x1b[99;5u" | b"\x1b[99;5:1u" => Some(Key::CtrlC),
        _ => None,
    }
}

/// claude 가 일하는 모습이다: 화면의 돌아가는 상태 줄이나 "esc to interrupt", 또는 제목의 일하는 글리프.
/// 끝난 뒤의 `✻ Worked for 12s` 는 말 끝에 … 이 없어 걸리지 않는다
pub fn shows_working(screen: &str, title: &str) -> bool {
    screen.contains(WORKING_HINT) || screen.lines().any(is_spinner_line) || title_busy(title)
}

/// 제목의 일하는 글리프: 브라유(2.1.228 전), 사분원 ◐◑◒◓(2.1.228 부터). Orca `agent-title-glyphs.ts`
fn title_busy(title: &str) -> bool {
    title.chars().any(|c| matches!(c as u32, 0x2800..=0x28ff | 0x25d0..=0x25d3))
}

/// claude 상태 줄 글리프
const SPINNER_GLYPHS: &[char] = &['·', '✢', '✳', '✶', '✻', '✽', '*'];

fn is_spinner_line(line: &str) -> bool {
    let mut chars = line.chars();
    if !chars.next().is_some_and(|c| SPINNER_GLYPHS.contains(&c)) || chars.next() != Some(' ') {
        return false;
    }
    let word = chars.as_str().split_whitespace().next().unwrap_or("");
    word.strip_suffix('…').is_some_and(|w| !w.is_empty() && w.chars().all(char::is_alphabetic))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Wait,
    /// 턴을 멈췄다
    Interrupted,
    /// 묻는 창을 닫았다. claude 가 다시 일한다
    Dismissed,
    GiveUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchKind {
    /// 일하던 claude 에 Esc
    Esc,
    /// 일하던 claude 에 ⌃C
    CtrlC,
    /// 묻는 도구 창에 Esc
    Question,
}

pub struct EscWatch {
    pub kind: WatchKind,
    /// 키를 보낼 때 에이전트 상태의 updated_at. 그 뒤 훅이 오면 훅을 믿는다
    pub updated_at: u64,
    started: u64,
    idle_since: Option<u64>,
}

impl EscWatch {
    pub fn new(kind: WatchKind, updated_at: u64, now: u64) -> Self {
        Self { kind, updated_at, started: now, idle_since: None }
    }

    pub fn observe(&mut self, working: bool, now: u64) -> Verdict {
        let age = now.saturating_sub(self.started);
        match self.kind {
            WatchKind::CtrlC => return if age >= KEY_SETTLE_MS { Verdict::Interrupted } else { Verdict::Wait },
            WatchKind::Question => return if age >= KEY_SETTLE_MS { Verdict::Dismissed } else { Verdict::Wait },
            WatchKind::Esc => {}
        }
        if working {
            self.idle_since = None;
        } else if let Some(since) = self.idle_since {
            if now.saturating_sub(since) >= ESC_SETTLE_MS {
                return Verdict::Interrupted;
            }
        } else {
            self.idle_since = Some(now);
        }
        if age > ESC_WINDOW_MS + ESC_SETTLE_MS { Verdict::GiveUp } else { Verdict::Wait }
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
    fn esc_watch_needs_working_to_stay_gone() {
        let mut w = EscWatch::new(WatchKind::Esc, 1, 0);
        assert_eq!(w.observe(false, 10), Verdict::Wait);
        // 메뉴를 닫은 Esc: 일하는 모습이 다시 보이면 처음부터
        assert_eq!(w.observe(true, 100), Verdict::Wait);
        assert_eq!(w.observe(false, 200), Verdict::Wait);
        assert_eq!(w.observe(false, 460), Verdict::Interrupted);
        let mut w = EscWatch::new(WatchKind::Esc, 1, 0);
        assert_eq!(w.observe(true, 5300), Verdict::GiveUp);
        let mut w = EscWatch::new(WatchKind::CtrlC, 1, 0);
        assert_eq!(w.observe(true, 400), Verdict::Wait);
        assert_eq!(w.observe(true, 500), Verdict::Interrupted);
        let mut w = EscWatch::new(WatchKind::Question, 1, 0);
        assert_eq!(w.observe(false, 600), Verdict::Dismissed);
    }

    #[test]
    fn working_evidence() {
        assert!(shows_working("x\n✻ Recombobulating… (14s · ↓ 1.2k tokens)\n", "✳ t"));
        assert!(shows_working("✢ Nucleating… ", ""));
        assert!(shows_working("", "◐ Poem about terminals"));
        assert!(shows_working("", "⠂ old spinner"));
        assert!(!shows_working("✻ Worked for 12s · done 오후 3:05\n⏺ Bash(sleep 20…)\n  Running cd …", "✳ Poem"));
        assert_eq!(interrupt_key(b"\x1b"), Some(Key::Esc));
        assert_eq!(interrupt_key(b"\x1b[27;1:3u"), None);
        assert_eq!(interrupt_key(b"\x03"), Some(Key::CtrlC));
        assert_eq!(interrupt_key(b"\x1b[A"), None);
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
