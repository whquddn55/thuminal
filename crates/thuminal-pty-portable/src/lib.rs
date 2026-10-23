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
            .or_else(|| std::env::var_os("HOME").map(Into::into))
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

#[cfg(test)]
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
}
