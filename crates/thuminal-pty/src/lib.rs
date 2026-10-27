//! 데몬이 쓰는 PTY 인터페이스.
//!
//! 데몬은 세션 하나에 PTY 하나를 연다. 읽기, 쓰기, 크기 바꾸기, 끝 기다리기를
//! 서로 다른 스레드에서 하므로 각각을 따로 떼어 넘긴다.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("PTY 를 열지 못했어요: {0}")]
    Open(String),
    #[error("프로그램을 실행하지 못했어요: {0}")]
    Spawn(String),
    #[error("PTY 오류: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, PtyError>;

#[derive(Debug, Clone, Default)]
pub struct SpawnSpec {
    /// 비우면 사용자 로그인 셸
    pub command: Vec<String>,
    /// 비우면 사용자 홈
    pub cwd: Option<PathBuf>,
    /// 데몬 환경 위에 덧씌운다
    pub env: BTreeMap<String, String>,
    /// 데몬 환경에서 물려주지 않을 변수
    pub env_remove: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

/// PTY 하나를 열고 프로그램을 띄운 결과. 데몬이 조각마다 다른 스레드에 나눠 준다.
pub struct Spawned {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub control: Box<dyn PtyControl>,
    pub child: Box<dyn PtyChild>,
    pub killer: Box<dyn PtyKiller>,
}

pub trait PtyControl: Send {
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
}

pub trait PtyChild: Send {
    fn pid(&self) -> Option<u32>;
    /// 끝날 때까지 막는다. 종료 코드를 돌려준다 (신호로 끝났으면 None 일 수 있다).
    fn wait(&mut self) -> Result<Option<i32>>;
}

pub trait PtyKiller: Send + Sync {
    fn kill(&mut self) -> Result<()>;
}

pub trait PtySystem: Send + Sync {
    fn spawn(&self, spec: &SpawnSpec) -> Result<Spawned>;
}
