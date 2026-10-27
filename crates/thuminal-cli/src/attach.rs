//! `thuminal term attach`: 지금 터미널을 raw 모드로 바꾸고 세션에 붙는다.
//! Ctrl-\ 를 누르면 떨어진다. 세션은 그대로 살아 있다.

use std::io::Write;

use thuminal_client::Client;
use thuminal_protocol::{SessionId, SnapshotFormat};
use tokio::io::AsyncReadExt;

const DETACH_KEY: u8 = 0x1c; // Ctrl-\

#[cfg(unix)]
mod term {
    use std::os::fd::AsRawFd;

    pub struct RawMode {
        fd: i32,
        saved: libc::termios,
    }

    impl RawMode {
        pub fn enter() -> std::io::Result<Self> {
            let fd = std::io::stdin().as_raw_fd();
            // SAFETY: 표준 입력 fd 의 termios 를 읽고 raw 로 바꾼다. Drop 에서 되돌린다
            unsafe {
                let mut t: libc::termios = std::mem::zeroed();
                if libc::tcgetattr(fd, &mut t) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let saved = t;
                libc::cfmakeraw(&mut t);
                if libc::tcsetattr(fd, libc::TCSANOW, &t) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Self { fd, saved })
            }
        }
    }

    impl Drop for RawMode {
        fn drop(&mut self) {
            // SAFETY: enter 에서 읽어 둔 값으로 되돌린다
            unsafe {
                libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
            }
        }
    }

    pub fn size() -> Option<(u16, u16)> {
        let fd = std::io::stdout().as_raw_fd();
        // SAFETY: TIOCGWINSZ 는 winsize 구조체를 채운다
        unsafe {
            let mut ws: libc::winsize = std::mem::zeroed();
            (libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0).then_some((ws.ws_col, ws.ws_row))
        }
    }

    /// 창 크기가 바뀔 때마다 깨는 것 (SIGWINCH)
    pub struct Resize(tokio::signal::unix::Signal);

    impl Resize {
        pub fn new() -> std::io::Result<Self> {
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()).map(Self)
        }

        pub async fn changed(&mut self) {
            self.0.recv().await;
        }
    }
}

/// Windows 콘솔: 입력은 줄 · 메아리 · Ctrl+C 처리를 끄고 VT 순서로 받는다. 출력은 VT 순서를 해석하게 한다
#[cfg(windows)]
mod term {
    use windows_sys::Win32::System::Console::{
        CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO, DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
        ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetConsoleScreenBufferInfo, GetStdHandle,
        STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleMode,
    };

    pub struct RawMode {
        input: CONSOLE_MODE,
        output: CONSOLE_MODE,
    }

    fn mode(std: u32) -> std::io::Result<CONSOLE_MODE> {
        let mut m: CONSOLE_MODE = 0;
        // SAFETY: 표준 핸들의 콘솔 모드를 읽는다
        if unsafe { GetConsoleMode(GetStdHandle(std), &mut m) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(m)
    }

    fn set(std: u32, m: CONSOLE_MODE) -> std::io::Result<()> {
        // SAFETY: 표준 핸들의 콘솔 모드를 바꾼다
        if unsafe { SetConsoleMode(GetStdHandle(std), m) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    impl RawMode {
        pub fn enter() -> std::io::Result<Self> {
            let (input, output) = (mode(STD_INPUT_HANDLE)?, mode(STD_OUTPUT_HANDLE)?);
            set(STD_INPUT_HANDLE, (input & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT)) | ENABLE_VIRTUAL_TERMINAL_INPUT)?;
            set(STD_OUTPUT_HANDLE, output | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN)?;
            Ok(Self { input, output })
        }
    }

    impl Drop for RawMode {
        fn drop(&mut self) {
            let _ = set(STD_INPUT_HANDLE, self.input);
            let _ = set(STD_OUTPUT_HANDLE, self.output);
        }
    }

    pub fn size() -> Option<(u16, u16)> {
        // SAFETY: 화면 버퍼 정보를 채운다
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) == 0 {
                return None;
            }
            let w = info.srWindow;
            let (cols, rows) = (w.Right - w.Left + 1, w.Bottom - w.Top + 1);
            (cols > 0 && rows > 0).then_some((cols as u16, rows as u16))
        }
    }

    /// Windows 에는 SIGWINCH 가 없어 0.5초마다 크기를 보고 달라졌을 때 깬다
    pub struct Resize {
        last: Option<(u16, u16)>,
        tick: tokio::time::Interval,
    }

    impl Resize {
        pub fn new() -> std::io::Result<Self> {
            Ok(Self { last: size(), tick: tokio::time::interval(std::time::Duration::from_millis(500)) })
        }

        pub async fn changed(&mut self) {
            loop {
                self.tick.tick().await;
                let now = size();
                if now != self.last {
                    self.last = now;
                    return;
                }
            }
        }
    }
}

pub async fn run(c: &Client, id: SessionId) -> Result<(), Box<dyn std::error::Error>> {
    if let Some((cols, rows)) = term::size() {
        c.resize(id, cols, rows).await?;
    }
    let mut at = c.attach(id, SnapshotFormat::Vt).await?;
    let _raw = term::RawMode::enter()?;
    let mut out = std::io::stdout();
    // 화면을 지우고 저장본으로 다시 그린다
    out.write_all(b"\x1b[H\x1b[2J")?;
    out.write_all(&at.snapshot)?;
    out.flush()?;

    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 4096];
    let mut resize = term::Resize::new()?;
    loop {
        tokio::select! {
            n = stdin.read(&mut buf) => {
                let n = n?;
                if n == 0 { break; }
                if let Some(pos) = buf[..n].iter().position(|&b| b == DETACH_KEY) {
                    if pos > 0 { c.input(id, buf[..pos].to_vec()).await?; }
                    break;
                }
                c.input(id, buf[..n].to_vec()).await?;
            }
            chunk = at.output.recv() => match chunk {
                Some(data) => { out.write_all(&data)?; out.flush()?; }
                None => break,
            },
            _ = resize.changed() => {
                if let Some((cols, rows)) = term::size() { c.resize(id, cols, rows).await?; }
            }
        }
    }
    let _ = c.detach(id).await;
    drop(_raw);
    println!("\r\n[thuminal] 세션 {id} 에서 떨어졌다");
    Ok(())
}
