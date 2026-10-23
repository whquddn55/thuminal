//! `thuminal term attach`: 지금 터미널을 raw 모드로 바꾸고 세션에 붙는다.
//! Ctrl-\ 를 누르면 떨어진다. 세션은 그대로 살아 있다.

use std::io::Write;
use std::os::fd::AsRawFd;

use thuminal_client::Client;
use thuminal_protocol::{SessionId, SnapshotFormat};
use tokio::io::AsyncReadExt;

const DETACH_KEY: u8 = 0x1c; // Ctrl-\

struct RawMode {
    fd: i32,
    saved: libc::termios,
}

impl RawMode {
    fn enter(fd: i32) -> std::io::Result<Self> {
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

fn tty_size(fd: i32) -> Option<(u16, u16)> {
    // SAFETY: TIOCGWINSZ 는 winsize 구조체를 채운다
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        (libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0).then_some((ws.ws_col, ws.ws_row))
    }
}

pub async fn run(c: &Client, id: SessionId) -> Result<(), Box<dyn std::error::Error>> {
    let stdin_fd = std::io::stdin().as_raw_fd();
    let stdout_fd = std::io::stdout().as_raw_fd();
    if let Some((cols, rows)) = tty_size(stdout_fd) {
        c.resize(id, cols, rows).await?;
    }
    let mut at = c.attach(id, SnapshotFormat::Vt).await?;
    let _raw = RawMode::enter(stdin_fd)?;
    let mut out = std::io::stdout();
    // 화면을 지우고 저장본으로 다시 그린다
    out.write_all(b"\x1b[H\x1b[2J")?;
    out.write_all(&at.snapshot)?;
    out.flush()?;

    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 4096];
    let mut winch = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
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
            _ = winch.recv() => {
                if let Some((cols, rows)) = tty_size(stdout_fd) { c.resize(id, cols, rows).await?; }
            }
        }
    }
    let _ = c.detach(id).await;
    drop(_raw);
    println!("\r\n[thuminal] 세션 {id} 에서 떨어졌다");
    Ok(())
}
