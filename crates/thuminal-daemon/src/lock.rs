//! 데몬이 한 개만 뜨게 하는 잠금 (std `File::try_lock`: 유닉스는 `flock`, Windows 는 `LockFileEx`). 잠금 파일에 pid 를 적어 둔다.
//! Windows 는 잠긴 파일을 다른 프로세스가 읽지 못해 이미 떠 있는 데몬의 pid 를 알 수 없다.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::Path;

use crate::DaemonError;

pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    pub fn acquire(path: &Path) -> Result<Self, DaemonError> {
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        // 파일이 살아 있는 동안 잠금이 유지된다
        if file.try_lock().is_err() {
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
