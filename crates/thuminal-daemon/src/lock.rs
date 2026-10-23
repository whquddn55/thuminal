//! 데몬이 한 개만 뜨게 하는 잠금 (`flock`). 잠금 파일에 pid 를 적어 둔다.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::os::fd::AsRawFd;
use std::path::Path;

use crate::DaemonError;

pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    pub fn acquire(path: &Path) -> Result<Self, DaemonError> {
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        // SAFETY: 열린 파일의 fd 에 flock 을 건다. 파일이 살아 있는 동안 잠금이 유지된다
        let r = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if r != 0 {
            let mut s = String::new();
            let _ = file.read_to_string(&mut s);
            return Err(DaemonError::AlreadyRunning(s.trim().parse().ok()));
        }
        file.set_len(0)?;
        file.rewind()?;
        write!(file, "{}", std::process::id())?;
        file.flush()?;
        Ok(Self { _file: file })
    }
}
