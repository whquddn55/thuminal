//! [`thuminal_engine::TerminalEngine`] 의 libghostty-vt 어댑터.

use std::cell::RefCell;
use std::rc::Rc;

use libghostty_vt::Terminal;
use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use thuminal_engine::{
    EngineConfig, EngineError, EngineFactory, Result, ScreenFormat, SnapshotFormat, TerminalEngine,
};

fn err(e: impl std::fmt::Debug) -> EngineError {
    EngineError::Engine(format!("{e:?}"))
}

pub struct GhosttyEngine {
    term: Terminal<'static, 'static>,
    replies: Rc<RefCell<Vec<u8>>>,
}

impl GhosttyEngine {
    pub fn new(config: EngineConfig) -> Result<Self> {
        let mut term = Terminal::new(config.cols, config.rows).map_err(err)?;
        // 기본 바이트 한도가 작아 줄 한도보다 먼저 걸린다. 바이트 한도는 풀고 줄 한도만 건다
        // (spikes/vt-daemon-probe 에서 확인: 풀지 않으면 1만 줄 설정에도 284줄만 남았다)
        term.set_scrollback_max_bytes(None).map_err(err)?;
        term.set_scrollback_max_lines(Some(config.scrollback_lines)).map_err(err)?;
        let replies = Rc::new(RefCell::new(Vec::new()));
        let sink = replies.clone();
        term.on_pty_write(move |_term, data: &[u8]| sink.borrow_mut().extend_from_slice(data))
            .map_err(err)?;
        Ok(Self { term, replies })
    }

    fn format(&self, format: Format, scrollback: bool) -> Result<Vec<u8>> {
        let _ = scrollback; // 포매터는 지금 스크롤백까지 함께 낸다. 화면만 자르는 것은 호출한 쪽이 한다
        let mut f = Formatter::new(&self.term, FormatterOptions::new().with_format(format)).map_err(err)?;
        // format_len 은 출력이 비면 InvalidValue 를 낸다 (libghostty-rs 0ef8041 바인딩).
        // 한 번에 할당해 받는 format_alloc 은 빈 출력도 그대로 돌려준다
        Ok(f.format_alloc(None).map_err(err)?.to_vec())
    }
}

impl TerminalEngine for GhosttyEngine {
    fn feed(&mut self, bytes: &[u8]) {
        self.term.vt_write(bytes);
    }

    fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut *self.replies.borrow_mut())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        // 칸 픽셀 크기는 데몬이 모른다. 이미지 프로토콜용이라 0 을 넘긴다
        self.term.resize(cols, rows, 0, 0).map_err(err)
    }

    fn snapshot(&mut self, format: SnapshotFormat) -> Result<Vec<u8>> {
        match format {
            SnapshotFormat::Native => {
                let mut out = Vec::new();
                self.term.encode_snapshot(&mut out).map_err(err)?;
                Ok(out)
            }
            SnapshotFormat::Vt => self.format(Format::Vt, true),
        }
    }

    fn read_screen(&mut self, format: ScreenFormat, scrollback: bool) -> Result<String> {
        let bytes = match format {
            ScreenFormat::Plain => self.format(Format::Plain, scrollback)?,
            ScreenFormat::Vt => self.format(Format::Vt, scrollback)?,
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if scrollback || format == ScreenFormat::Vt {
            return Ok(text);
        }
        // 화면 줄 수만큼 끝에서 자른다
        let rows = self.term.rows().map_err(err)? as usize;
        let lines: Vec<&str> = text.split('\n').collect();
        let start = lines.len().saturating_sub(rows);
        Ok(lines[start..].join("\n"))
    }

    fn title(&self) -> String {
        self.term.title().unwrap_or_default().to_owned()
    }

    fn pwd(&self) -> String {
        self.term.pwd().unwrap_or_default().to_owned()
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct GhosttyFactory;

impl EngineFactory for GhosttyFactory {
    fn name(&self) -> &'static str {
        "ghostty"
    }

    fn supports_native_snapshot(&self) -> bool {
        true
    }

    fn create(&self, config: EngineConfig) -> Result<Box<dyn TerminalEngine>> {
        Ok(Box::new(GhosttyEngine::new(config)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(cols: u16, rows: u16) -> Box<dyn TerminalEngine> {
        GhosttyFactory.create(EngineConfig { cols, rows, scrollback_lines: 1000 }).unwrap()
    }

    #[test]
    fn feeds_and_reads_plain_text() {
        let mut e = engine(20, 3);
        e.feed(b"plain \x1b[1;31mred\x1b[0m\r\nsecond");
        let text = e.read_screen(ScreenFormat::Plain, false).unwrap();
        assert!(text.contains("plain red"), "{text:?}");
        assert!(text.contains("second"));
    }

    #[test]
    fn answers_cursor_position_query() {
        let mut e = engine(20, 5);
        e.feed(b"ab\x1b[6n");
        assert_eq!(e.take_replies(), b"\x1b[1;3R");
        assert!(e.take_replies().is_empty());
    }

    #[test]
    fn vt_snapshot_redraws_same_text_in_fresh_engine() {
        let mut a = engine(30, 5);
        for i in 0..50 {
            a.feed(format!("\x1b[3{}mline {i}\x1b[0m\r\n", i % 8).as_bytes());
        }
        let snap = a.snapshot(SnapshotFormat::Vt).unwrap();
        let mut b = engine(30, 5);
        b.feed(&snap);
        assert_eq!(
            a.read_screen(ScreenFormat::Plain, false).unwrap(),
            b.read_screen(ScreenFormat::Plain, false).unwrap()
        );
    }

    #[test]
    fn reads_empty_screen() {
        let mut e = engine(20, 3);
        assert_eq!(e.read_screen(ScreenFormat::Plain, true).unwrap(), "");
        assert!(e.snapshot(SnapshotFormat::Vt).is_ok());
    }

    #[test]
    fn native_snapshot_is_not_empty() {
        let mut e = engine(30, 5);
        e.feed(b"hello");
        assert!(!e.snapshot(SnapshotFormat::Native).unwrap().is_empty());
    }

    #[test]
    fn title_and_pwd_from_osc() {
        let mut e = engine(30, 5);
        e.feed(b"\x1b]2;my title\x07\x1b]7;file://host/tmp/x\x07");
        assert_eq!(e.title(), "my title");
        assert!(e.pwd().ends_with("/tmp/x"), "{}", e.pwd());
    }
}
