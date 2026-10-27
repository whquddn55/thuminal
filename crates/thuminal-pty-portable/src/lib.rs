//! [`thuminal_pty::PtySystem`] 의 portable-pty 어댑터.

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use thuminal_pty::{PtyChild, PtyControl, PtyError, PtyKiller, PtySystem, Result, SpawnSpec, Spawned};

#[derive(Debug, Default, Clone, Copy)]
pub struct PortablePty;

struct Control(Box<dyn MasterPty + Send>);

impl PtyControl for Control {
    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.0
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| PtyError::Io(e.to_string()))
    }
}

struct Child(Box<dyn portable_pty::Child + Send + Sync>);

impl PtyChild for Child {
    fn pid(&self) -> Option<u32> {
        self.0.process_id()
    }

    fn wait(&mut self) -> Result<Option<i32>> {
        let status = self.0.wait().map_err(|e| PtyError::Io(e.to_string()))?;
        Ok(Some(status.exit_code() as i32))
    }
}

struct Killer(Box<dyn portable_pty::ChildKiller + Send + Sync>);

impl PtyKiller for Killer {
    fn kill(&mut self) -> Result<()> {
        self.0.kill().map_err(|e| PtyError::Io(e.to_string()))
    }
}

impl PtySystem for PortablePty {
    fn spawn(&self, spec: &SpawnSpec) -> Result<Spawned> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| PtyError::Open(e.to_string()))?;

        // 비어 있으면 로그인 셸 (portable-pty 가 $SHELL 을 `-zsh` 처럼 로그인 모드로 띄운다)
        let mut cmd = match spec.command.split_first() {
            Some((prog, args)) => {
                let mut c = CommandBuilder::new(prog);
                c.args(args);
                c
            }
            None => CommandBuilder::new_default_prog(),
        };
        let cwd = spec
            .cwd
            .clone()
            .or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into))
            .unwrap_or_else(|| "/".into());
        cmd.cwd(cwd);
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| PtyError::Spawn(e.to_string()))?;
        // 자식이 PTY 를 열었으니 데몬 쪽 slave 는 닫는다. 그래야 자식이 끝날 때 reader 가 EOF 를 받는다
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| PtyError::Io(e.to_string()))?;
        #[cfg(unix)]
        let reader = coalesce::wrap(reader, pair.master.as_raw_fd());
        let writer = pair.master.take_writer().map_err(|e| PtyError::Io(e.to_string()))?;
        let killer = child.clone_killer();
        Ok(Spawned {
            reader,
            writer,
            control: Box::new(Control(pair.master)),
            child: Box::new(Child(child)),
            killer: Box::new(Killer(killer)),
        })
    }
}

/// PTY 출력을 묶어 읽는다.
///
/// macOS PTY 는 read 한 번에 1KB 까지만 준다. 그래서 claude 가 한 번에 쓴 화면(수 KB)이 1KB 조각 여럿으로 나뉘어
/// 조각마다 메시지가 되었다. 데스크톱 앱은 1KB 넘는 메시지를 Tauri 채널이 웹뷰에서 한 번 더 받아 가는 길로 보내
/// 화면 하나에 왕복이 여러 번 들고, 조각 사이가 수십 ms 씩 벌어져 스크롤이 굼떴다.
/// 한 번 읽은 뒤 더 읽을 수 있으면 버퍼가 찰 때까지 마저 읽는다. 방금 읽은 것이 PTY 한 번 몫(1KB)을 꽉 채웠으면
/// 쓰는 쪽이 아직 넘기는 중일 수 있어 조금(2ms) 기다려 보고, 덜 찼으면 기다리지 않는다
#[cfg(unix)]
mod coalesce {
    use std::io::{self, Read};
    use std::os::fd::{FromRawFd, OwnedFd, RawFd};
    use std::os::unix::io::AsRawFd;

    pub fn wrap(inner: Box<dyn Read + Send>, master: Option<RawFd>) -> Box<dyn Read + Send> {
        // 폴링용 fd 는 따로 복제해 둔다. master 가 먼저 닫혀도 엉뚱한 fd 를 보지 않는다
        let poll_fd = master.and_then(|fd| {
            let d = unsafe { libc::dup(fd) };
            (d >= 0).then(|| unsafe { OwnedFd::from_raw_fd(d) })
        });
        match poll_fd {
            Some(poll_fd) => Box::new(Coalesce { inner, poll_fd }),
            None => inner,
        }
    }

    struct Coalesce {
        inner: Box<dyn Read + Send>,
        poll_fd: OwnedFd,
    }

    /// macOS PTY 가 read 한 번에 주는 최대 크기
    const PTY_CHUNK: usize = 1024;
    /// 꽉 찬 조각 뒤에 다음 조각을 기다리는 시간
    const FOLLOW_WAIT_MS: i32 = 2;

    impl Coalesce {
        fn readable(&self, wait_ms: i32) -> bool {
            let mut p = libc::pollfd { fd: self.poll_fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            unsafe { libc::poll(&mut p, 1, wait_ms) > 0 && p.revents & libc::POLLIN != 0 }
        }
    }

    impl Read for Coalesce {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut n = self.inner.read(buf)?;
            let mut last = n;
            while n > 0 && n < buf.len() && self.readable(if last >= PTY_CHUNK { FOLLOW_WAIT_MS } else { 0 }) {
                match self.inner.read(&mut buf[n..]) {
                    Ok(0) => break,
                    Ok(m) => {
                        n += m;
                        last = m;
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    // 다음 read 가 같은 오류를 다시 낸다. 읽은 것은 먼저 넘긴다
                    Err(_) => break,
                }
            }
            Ok(n)
        }
    }
}

// /bin/sh 로 시험한다
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn runs_command_and_reads_output() {
        let mut s = PortablePty
            .spawn(&SpawnSpec {
                command: vec!["/bin/sh".into(), "-c".into(), "printf \"$GREETING\"; exit 3".into()],
                env: [("GREETING".to_string(), "hi-pty".to_string())].into(),
                cols: 40,
                rows: 10,
                ..Default::default()
            })
            .unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = s.reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
            if out.contains("hi-pty") {
                break;
            }
        }
        assert!(out.contains("hi-pty"), "{out:?}");
        assert_eq!(s.child.wait().unwrap(), Some(3));
    }

    #[test]
    fn reads_one_big_write_at_once() {
        let mut s = PortablePty
            .spawn(&SpawnSpec {
                command: vec!["/bin/sh".into(), "-c".into(), "sleep 0.2; /usr/bin/python3 -c 'import os; os.write(1, b\"x\" * 8000)'; sleep 1".into()],
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .unwrap();
        let mut buf = vec![0u8; 64 * 1024];
        let n = s.reader.read(&mut buf).unwrap();
        // macOS PTY 는 한 번에 1KB 씩 주지만 바로 이어 읽을 수 있는 것은 묶는다
        assert_eq!(n, 8000);
    }
}
