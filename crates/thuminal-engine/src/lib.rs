//! 데몬이 쓰는 터미널 엔진 인터페이스.
//!
//! 데몬은 세션마다 엔진 하나를 세션 전용 스레드에서 들고 있다. 엔진은 PTY 출력을
//! 받아 화면 상태를 만들고, 앱이 다시 붙을 때 화면 저장본을 만든다.
//! 엔진은 스레드 사이로 옮기지 않으므로 `Send` 가 아니어도 된다. 대신 엔진을 만드는
//! [`EngineFactory`] 는 여러 스레드에서 쓰인다.

pub use thuminal_protocol::{ScreenFormat, SnapshotFormat};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("엔진이 이 저장본 형식을 만들지 못한다: {0:?}")]
    UnsupportedFormat(SnapshotFormat),
    #[error("엔진 오류: {0}")]
    Engine(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub cols: u16,
    pub rows: u16,
    /// 스크롤백으로 남길 최대 줄 수
    pub scrollback_lines: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self { cols: 80, rows: 24, scrollback_lines: 10_000 }
    }
}

pub trait TerminalEngine {
    /// PTY 에서 읽은 바이트를 넣는다. 잘린 제어 코드가 와도 다음 호출에서 이어 처리한다.
    fn feed(&mut self, bytes: &[u8]);

    /// 프로그램이 터미널에 물은 것(커서 위치, 장치 속성 등)에 대한 답.
    /// 데몬이 PTY 에 다시 써 준다. 꺼내면 비워진다.
    fn take_replies(&mut self) -> Vec<u8>;

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;

    /// 붙는 클라이언트에 넘길 화면 저장본.
    fn snapshot(&mut self, format: SnapshotFormat) -> Result<Vec<u8>>;

    /// 화면 글자를 읽는다. `scrollback` 이면 스크롤백까지.
    fn read_screen(&mut self, format: ScreenFormat, scrollback: bool) -> Result<String>;

    /// OSC 0/2 로 정한 제목. 없으면 빈 문자열.
    fn title(&self) -> String;

    /// OSC 7 로 알린 작업 폴더 (file:// URL 일 수 있다). 없으면 빈 문자열.
    fn pwd(&self) -> String;
}

pub trait EngineFactory: Send + Sync {
    /// 로그와 `hello` 응답에 쓰는 이름 (예: `ghostty`)
    fn name(&self) -> &'static str;

    /// 고유 저장본(`SnapshotFormat::Native`)을 만들 수 있는지
    fn supports_native_snapshot(&self) -> bool;

    fn create(&self, config: EngineConfig) -> Result<Box<dyn TerminalEngine>>;
}
