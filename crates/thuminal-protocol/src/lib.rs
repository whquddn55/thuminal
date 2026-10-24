//! thuminal 데몬과 클라이언트(앱, CLI) 사이의 약속.
//!
//! 이 크레이트는 입출력을 하지 않는다. 메시지 모양, 프레임 인코딩, 버전 규칙,
//! 데이터 폴더 위치만 정한다. 그래서 어떤 언어로 클라이언트를 만들어도 이 문서와
//! 타입만 맞추면 데몬에 붙을 수 있다.

pub mod frame;
pub mod layout;
pub mod message;
pub mod paths;

pub use frame::{Frame, FrameError, FrameKind};
pub use layout::*;
pub use message::*;

/// 주 버전이 다르면 서로 붙지 않는다. 소켓 이름에도 들어간다.
pub const PROTOCOL_MAJOR: u32 = 1;
/// 부 버전은 하위 호환으로 늘린다 (필드 추가 등).
pub const PROTOCOL_MINOR: u32 = 3;
