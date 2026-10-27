//! OS 마다 다른 작은 일: 파일 권한, 프로세스가 살았는지 · 끝내기.
//! 유닉스는 libc 로, Windows 는 sysinfo 로 한다 (Windows 에는 신호가 없어 끝내기는 곧바로 끝낸다).

use std::io;
use std::path::Path;

/// 파일 · 폴더 권한을 정한다 (`0o600`, `0o700`, `0o755`). Windows 는 폴더 권한을 물려받으므로 하지 않는다
pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// 그 pid 의 프로세스가 살아 있는지
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        i32::try_from(pid).is_ok_and(|p| p > 0 && unsafe { libc::kill(p, 0) } == 0)
    }
    #[cfg(windows)]
    {
        win::process(pid, |_| ()).is_some()
    }
}

/// 프로세스에 끝내라고 한다. 유닉스는 SIGTERM 이라 그 프로세스가 정리하고 끝난다. Windows 는 곧바로 끝낸다
pub fn terminate(pid: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        let raw = i32::try_from(pid).ok().filter(|p| *p > 1).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        if unsafe { libc::kill(raw, libc::SIGTERM) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        match win::process(pid, |p| p.kill()) {
            Some(true) => Ok(()),
            Some(false) => Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            None => Err(io::Error::from(io::ErrorKind::NotFound)),
        }
    }
}

/// 실행 파일 이름 (경로 없이). 다른 프로세스를 잘못 끄지 않게 확인할 때 쓴다
pub fn process_name(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let out = std::process::Command::new("ps").args(["-o", "comm=", "-p", &pid.to_string()]).output().ok()?;
        let comm = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!comm.is_empty()).then_some(comm)
    }
    #[cfg(windows)]
    {
        win::process(pid, |p| p.name().to_string_lossy().into_owned())
    }
}

#[cfg(windows)]
mod win {
    use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System};

    /// 그 pid 하나만 읽어 `f` 를 부른다
    pub fn process<T>(pid: u32, f: impl FnOnce(&Process) -> T) -> Option<T> {
        let mut sys = System::new();
        let pid = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
        sys.process(pid).map(f)
    }
}
