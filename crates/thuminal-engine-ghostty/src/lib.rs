//! [`thuminal_engine::TerminalEngine`] 의 libghostty-vt 어댑터.

use std::cell::RefCell;
use std::rc::Rc;

use libghostty_vt::Terminal;
use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use libghostty_vt::style::{Palette, RgbColor};
use libghostty_vt::terminal::{Mode, ModeKind};
use thuminal_engine::{
    ColorScheme, EngineConfig, EngineError, EngineFactory, Result, ScreenFormat, SnapshotFormat, TerminalColors, TerminalEngine,
    scheme_of,
};

fn err(e: impl std::fmt::Debug) -> EngineError {
    EngineError::Engine(format!("{e:?}"))
}

fn rgb(v: u32) -> RgbColor {
    RgbColor { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 }
}

fn packed(c: RgbColor) -> u32 {
    (c.r as u32) << 16 | (c.g as u32) << 8 | c.b as u32
}

/// 지금 적용 중인 색(OSC 덮어쓰기 포함)으로 본 밝기. 색을 받은 적이 없으면 Dark
fn effective_scheme(term: &Terminal<'_, '_>) -> ColorScheme {
    match (term.fg_color().ok().flatten(), term.bg_color().ok().flatten()) {
        (Some(fg), Some(bg)) => scheme_of(packed(fg), packed(bg)),
        _ => ColorScheme::Dark,
    }
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
        // `CSI ?996n` (색 밝기 질의): 배경이 전경보다 어두우면 dark 로 답한다
        term.on_color_scheme(|t: &Terminal<'_, '_>| {
            Some(match effective_scheme(t) {
                ColorScheme::Dark => libghostty_vt::terminal::ColorScheme::Dark,
                ColorScheme::Light => libghostty_vt::terminal::ColorScheme::Light,
            })
        })
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

    fn set_default_colors(&mut self, colors: &TerminalColors) -> Result<()> {
        // 팔레트는 Ghostty 기본 256색 위에 받은 만큼 덮는다 (16개면 16~255 는 기본 그대로)
        let mut palette = Palette::default();
        for (slot, v) in palette.0.iter_mut().zip(&colors.palette) {
            *slot = rgb(*v);
        }
        self.term.set_default_fg_color(Some(rgb(colors.foreground))).map_err(err)?;
        self.term.set_default_bg_color(Some(rgb(colors.background))).map_err(err)?;
        self.term.set_default_cursor_color(colors.cursor.map(rgb)).map_err(err)?;
        self.term.set_default_color_palette(Some(palette)).map_err(err)?;
        Ok(())
    }

    fn color_scheme(&self) -> ColorScheme {
        effective_scheme(&self.term)
    }

    fn dec_mode(&self, mode: u16) -> bool {
        self.term.mode(Mode::new(mode, ModeKind::Dec)).unwrap_or(false)
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

    fn colors(fg: u32, bg: u32) -> TerminalColors {
        TerminalColors {
            foreground: fg,
            background: bg,
            cursor: Some(0xff0000),
            palette: vec![0x111111, 0x222222],
            scheme: thuminal_engine::ColorScheme::Dark,
        }
    }

    #[test]
    fn answers_color_queries_with_default_colors() {
        let mut e = engine(20, 5);
        e.set_default_colors(&colors(0xf8f8f2, 0x282a36)).unwrap();
        e.feed(b"\x1b]11;?\x07\x1b]10;?\x07\x1b]4;1;?\x07");
        let reply = String::from_utf8(e.take_replies()).unwrap();
        assert!(reply.contains("11;rgb:2828/2a2a/3636"), "{reply:?}");
        assert!(reply.contains("10;rgb:f8f8/f8f8/f2f2"), "{reply:?}");
        assert!(reply.contains("4;1;rgb:2222/2222/2222"), "{reply:?}");
        // 프로그램이 OSC 11 로 바꾼 배경은 기본색을 다시 넣어도 지킨다
        e.feed(b"\x1b]11;#ffffff\x07");
        e.set_default_colors(&colors(0xf8f8f2, 0x101010)).unwrap();
        e.feed(b"\x1b]11;?\x07");
        assert!(String::from_utf8(e.take_replies()).unwrap().contains("rgb:ffff/ffff/ffff"));
    }

    #[test]
    fn answers_color_scheme_query_and_reports_mode_2031() {
        let mut e = engine(20, 5);
        e.feed(b"\x1b[?996n");
        assert_eq!(e.take_replies(), b"\x1b[?997;1n", "색을 받기 전에는 dark");
        e.set_default_colors(&colors(0x24292f, 0xffffff)).unwrap();
        assert_eq!(e.color_scheme(), ColorScheme::Light);
        e.feed(b"\x1b[?996n");
        assert_eq!(e.take_replies(), b"\x1b[?997;2n");
        assert!(!e.dec_mode(2031));
        e.feed(b"\x1b[?2031h");
        assert!(e.dec_mode(2031));
        assert!(e.take_replies().is_empty(), "켜는 순간에는 알리지 않는다");
    }

    #[test]
    fn title_and_pwd_from_osc() {
        let mut e = engine(30, 5);
        e.feed(b"\x1b]2;my title\x07\x1b]7;file://host/tmp/x\x07");
        assert_eq!(e.title(), "my title");
        assert!(e.pwd().ends_with("/tmp/x"), "{}", e.pwd());
    }
}
