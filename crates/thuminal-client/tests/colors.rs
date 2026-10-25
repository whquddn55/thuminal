//! 터미널 기본색: 데몬 엔진이 받은 색으로 질의에 답하고, mode 2031 을 켠 세션에만 밝기 바뀜을 알리는지 확인한다.
//!
//! `/bin/cat` 세션에 질의를 보내면 cat 이 그대로 내보내 데몬 엔진이 답하고, 그 답은 tty 가 되울려
//! `^[]11;rgb:…` 꼴로 화면에 남는다. 그 글자로 답을 확인한다.

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{ColorScheme, CreateSession, Event, ScreenFormat, SessionId, TerminalColors};
use thuminal_pty_portable::PortablePty;

fn config(home: &std::path::Path) -> DaemonConfig {
    DaemonConfig {
        paths: Paths::new(home),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin: None,
        web_root: None,
    }
}

fn colors(fg: u32, bg: u32, scheme: ColorScheme) -> TerminalColors {
    TerminalColors { foreground: fg, background: bg, cursor: None, palette: (0..16).map(|i| i * 0x0f0f0f).collect(), scheme }
}

fn cat() -> CreateSession {
    CreateSession { command: vec!["/bin/cat".into()], cols: 100, rows: 10, ..Default::default() }
}

async fn screen(c: &Client, s: SessionId) -> String {
    c.read_screen(s, ScreenFormat::Plain, true).await.unwrap()
}

async fn wait_screen(c: &Client, s: SessionId, needle: &str) -> String {
    let mut last = String::new();
    for _ in 0..100 {
        last = screen(c, s).await;
        if last.contains(needle) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("화면에 {needle:?} 이 나오지 않았다:\n{last}");
}

#[tokio::test]
async fn daemon_engines_answer_with_set_colors_and_report_scheme_changes() {
    let dir = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    tokio::spawn(Daemon::bind(config(dir.path())).unwrap().run());
    let c = Client::connect(&Paths::new(dir.path()), "test").await.unwrap();
    assert_eq!(c.terminal_colors().await.unwrap(), None);

    // 색을 받기 전에 뜬 세션 둘: 하나만 mode 2031 을 켠다
    let subscribed = c.create(cat()).await.unwrap().id;
    let plain = c.create(cat()).await.unwrap().id;
    c.send_text(subscribed, "\x1b[?2031h-on\n").await.unwrap();
    wait_screen(&c, subscribed, "-on").await;

    let mut events = c.events();
    let dark = colors(0xf8f8f2, 0x282a36, ColorScheme::Dark);
    c.set_terminal_colors(dark.clone()).await.unwrap();
    loop {
        let e = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap().unwrap();
        if let Event::TerminalColorsChanged { colors } = e {
            assert_eq!(colors, dark);
            break;
        }
    }
    assert_eq!(c.terminal_colors().await.unwrap(), Some(dark.clone()));
    assert!(dir.path().join("terminal-colors.json").is_file());

    // 이미 떠 있던 세션도 새 배경으로 OSC 11 에 답한다
    c.send_text(plain, "\x1b]11;?\x07\n").await.unwrap();
    wait_screen(&c, plain, "11;rgb:2828/2a2a/3636").await;
    // 새 세션도 처음부터 이 색이다. ?996n 은 배경이 어두우니 dark
    let fresh = c.create(cat()).await.unwrap().id;
    c.send_text(fresh, "\x1b]10;?\x07\x1b[?996n\n").await.unwrap();
    wait_screen(&c, fresh, "10;rgb:f8f8/f8f8/f2f2").await;
    wait_screen(&c, fresh, "[?997;1n").await;

    // 처음 색을 받을 때는 밝기가 dark 그대로라 알리지 않는다
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!screen(&c, subscribed).await.contains("997"), "켜는 순간이나 밝기가 같을 때는 알리지 않는다");

    // light 로 바꾸면 2031 을 켠 세션에만 알린다
    c.set_terminal_colors(colors(0x24292f, 0xffffff, ColorScheme::Light)).await.unwrap();
    wait_screen(&c, subscribed, "[?997;2n").await;
    // 밝기가 같은 색으로 또 바꾸면 알리지 않는다
    c.set_terminal_colors(colors(0x000000, 0xfafafa, ColorScheme::Light)).await.unwrap();
    c.set_terminal_colors(dark).await.unwrap();
    wait_screen(&c, subscribed, "[?997;1n").await;
    let s = screen(&c, subscribed).await;
    assert_eq!(s.matches("?997;2n").count(), 1, "{s}");
    assert!(!screen(&c, plain).await.contains("997"), "2031 을 켜지 않은 세션에는 알리지 않는다");
}
