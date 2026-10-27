//! 데몬과 같은 컴퓨터의 클라이언트(앱 · CLI)가 붙는 로컬 연결.
//!
//! 자리는 데이터 폴더의 소켓 경로([`thuminal_protocol::paths::Paths::socket`]) 하나로 정한다.
//! - 유닉스(macOS · Linux): 그 경로의 유닉스 소켓이다.
//! - Windows: tokio 가 유닉스 소켓을 받지 않으므로 그 경로로 이름을 지은 named pipe(`\\.\pipe\thuminal-<해시>`)다.
//!   같은 데이터 폴더면 같은 이름이 나오므로 `THUMINAL_HOME` 으로 여러 데몬을 띄워도 갈린다.
//!
//! 연결은 읽기 · 쓰기 반쪽으로 나눠 돌려준다. 프레임은 그 위에서 똑같이 오간다.

use std::io;
use std::path::Path;

use tokio::io::{AsyncRead, AsyncWrite};

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;

#[cfg(unix)]
mod imp {
    use super::*;
    use tokio::net::{UnixListener, UnixStream};

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(endpoint: &Path) -> io::Result<Self> {
            // 잠금을 잡은 뒤 부르므로 남아 있는 소켓은 죽은 데몬이 남긴 것이다
            let _ = std::fs::remove_file(endpoint);
            UnixListener::bind(endpoint).map(Self)
        }

        pub async fn accept(&mut self) -> io::Result<(Reader, Writer)> {
            let (stream, _) = self.0.accept().await?;
            let (rd, wr) = stream.into_split();
            Ok((Box::new(rd), Box::new(wr)))
        }
    }

    pub async fn connect(endpoint: &Path) -> io::Result<(Reader, Writer)> {
        let (rd, wr) = UnixStream::connect(endpoint).await?.into_split();
        Ok((Box::new(rd), Box::new(wr)))
    }

    pub fn cleanup(endpoint: &Path) {
        let _ = std::fs::remove_file(endpoint);
    }

    pub fn display(endpoint: &Path) -> String {
        endpoint.display().to_string()
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::time::Duration;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    /// 모든 파이프 인스턴스가 바쁠 때(ERROR_PIPE_BUSY) 다시 해 보는 횟수 · 간격
    const BUSY_RETRIES: u32 = 50;
    const BUSY_WAIT: Duration = Duration::from_millis(20);
    const ERROR_PIPE_BUSY: i32 = 231;

    /// 소켓 경로로 지은 파이프 이름. 경로를 FNV-1a 64비트로 줄인다 (대소문자 · 구분자를 맞춘 뒤)
    pub fn pipe_name(endpoint: &Path) -> String {
        let key = endpoint.to_string_lossy().to_lowercase().replace('/', "\\");
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in key.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!(r"\\.\pipe\thuminal-{h:016x}")
    }

    pub struct Listener {
        name: String,
        next: NamedPipeServer,
    }

    impl Listener {
        pub fn bind(endpoint: &Path) -> io::Result<Self> {
            let name = pipe_name(endpoint);
            // 첫 인스턴스로만 연다. 같은 이름을 다른 프로세스가 먼저 잡았으면 실패한다
            let next = ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&name)?;
            Ok(Self { name, next })
        }

        pub async fn accept(&mut self) -> io::Result<(Reader, Writer)> {
            self.next.connect().await?;
            // 다음 클라이언트가 기다리지 않게 새 인스턴스를 먼저 만들어 둔다
            let fresh = ServerOptions::new().reject_remote_clients(true).create(&self.name)?;
            let connected = std::mem::replace(&mut self.next, fresh);
            let (rd, wr) = tokio::io::split(connected);
            Ok((Box::new(rd), Box::new(wr)))
        }
    }

    pub async fn connect(endpoint: &Path) -> io::Result<(Reader, Writer)> {
        let name = pipe_name(endpoint);
        let mut tries = 0;
        let client = loop {
            match ClientOptions::new().open(&name) {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < BUSY_RETRIES => {
                    tries += 1;
                    tokio::time::sleep(BUSY_WAIT).await;
                }
                Err(e) => return Err(e),
            }
        };
        let (rd, wr) = tokio::io::split(client);
        Ok((Box::new(rd), Box::new(wr)))
    }

    pub fn cleanup(_endpoint: &Path) {}

    pub fn display(endpoint: &Path) -> String {
        pipe_name(endpoint)
    }
}

pub use imp::{Listener, connect};

/// 데몬이 내려갈 때 연결 자리를 치운다 (유닉스 소켓 파일. named pipe 는 저절로 없어진다)
pub fn cleanup(endpoint: &Path) {
    imp::cleanup(endpoint)
}

/// 로그 · 오류에 찍을 연결 자리 (유닉스는 소켓 경로, Windows 는 파이프 이름)
pub fn display(endpoint: &Path) -> String {
    imp::display(endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = dir.path().join("daemon.sock");
        let mut listener = Listener::bind(&endpoint).unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut rd, mut wr) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4];
                rd.read_exact(&mut buf).await.unwrap();
                wr.write_all(&buf).await.unwrap();
            }
        });
        for msg in [b"ping", b"pong"] {
            let (mut rd, mut wr) = connect(&endpoint).await.unwrap();
            wr.write_all(msg).await.unwrap();
            let mut buf = [0u8; 4];
            rd.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, msg);
        }
        server.await.unwrap();
    }
}
