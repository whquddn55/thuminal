//! 프레임: `[길이 u32 BE][종류 u8][내용]`. 길이는 종류 바이트와 내용을 합친 크기다.
//!
//! - `Json`: [`crate::ClientMessage`] 또는 [`crate::ServerMessage`] 의 JSON
//! - `Output`: `[세션 u64 BE][바이트]` 세션 출력 (데몬 → 클라이언트)
//! - `Input`: `[세션 u64 BE][바이트]` 세션 입력 (클라이언트 → 데몬)
//! - `Snapshot`: `[세션 u64 BE][형식 u8][바이트]` 붙을 때 보내는 화면 저장본 (데몬 → 클라이언트)

use crate::{SessionId, SnapshotFormat};

/// 프레임 하나의 최대 크기. 스크롤백 1만 줄 저장본이 10MB 남짓이라 넉넉히 잡는다.
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    Json = 0,
    Output = 1,
    Input = 2,
    Snapshot = 3,
}

impl TryFrom<u8> for FrameKind {
    type Error = FrameError;
    fn try_from(v: u8) -> Result<Self, FrameError> {
        Ok(match v {
            0 => Self::Json,
            1 => Self::Output,
            2 => Self::Input,
            3 => Self::Snapshot,
            other => return Err(FrameError::UnknownKind(other)),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Json(Vec<u8>),
    Output { session: SessionId, data: Vec<u8> },
    Input { session: SessionId, data: Vec<u8> },
    Snapshot { session: SessionId, format: SnapshotFormat, data: Vec<u8> },
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("알 수 없는 프레임 종류 {0}")]
    UnknownKind(u8),
    #[error("프레임이 너무 크다: {0} 바이트")]
    TooLarge(usize),
    #[error("프레임이 잘렸다")]
    Truncated,
    #[error("알 수 없는 저장본 형식 {0}")]
    UnknownSnapshotFormat(u8),
}

impl Frame {
    pub fn kind(&self) -> FrameKind {
        match self {
            Frame::Json(_) => FrameKind::Json,
            Frame::Output { .. } => FrameKind::Output,
            Frame::Input { .. } => FrameKind::Input,
            Frame::Snapshot { .. } => FrameKind::Snapshot,
        }
    }

    pub fn json<T: serde::Serialize>(msg: &T) -> Frame {
        Frame::Json(serde_json::to_vec(msg).expect("메시지 직렬화"))
    }

    /// 길이 머리까지 붙인 바이트로 만든다.
    pub fn encode(&self) -> Vec<u8> {
        let mut body = Vec::new();
        body.push(self.kind() as u8);
        match self {
            Frame::Json(json) => body.extend_from_slice(json),
            Frame::Output { session, data } | Frame::Input { session, data } => {
                body.extend_from_slice(&session.0.to_be_bytes());
                body.extend_from_slice(data);
            }
            Frame::Snapshot { session, format, data } => {
                body.extend_from_slice(&session.0.to_be_bytes());
                body.push(*format as u8);
                body.extend_from_slice(data);
            }
        }
        let mut out = Vec::with_capacity(4 + body.len());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    /// 길이 머리를 뗀 나머지(종류 + 내용)를 풀어낸다.
    pub fn decode(body: &[u8]) -> Result<Frame, FrameError> {
        let (&kind, rest) = body.split_first().ok_or(FrameError::Truncated)?;
        let session = |rest: &[u8]| -> Result<(SessionId, usize), FrameError> {
            let id = rest.get(..8).ok_or(FrameError::Truncated)?;
            Ok((SessionId(u64::from_be_bytes(id.try_into().unwrap())), 8))
        };
        Ok(match FrameKind::try_from(kind)? {
            FrameKind::Json => Frame::Json(rest.to_vec()),
            FrameKind::Output => {
                let (s, n) = session(rest)?;
                Frame::Output { session: s, data: rest[n..].to_vec() }
            }
            FrameKind::Input => {
                let (s, n) = session(rest)?;
                Frame::Input { session: s, data: rest[n..].to_vec() }
            }
            FrameKind::Snapshot => {
                let (s, n) = session(rest)?;
                let &fmt = rest.get(n).ok_or(FrameError::Truncated)?;
                let format = SnapshotFormat::try_from(fmt)?;
                Frame::Snapshot { session: s, format, data: rest[n + 1..].to_vec() }
            }
        })
    }

    /// 길이 머리를 읽어 내용 크기를 돌려준다. 너무 크면 오류.
    pub fn body_len(header: [u8; 4]) -> Result<usize, FrameError> {
        let n = u32::from_be_bytes(header) as usize;
        if n > MAX_FRAME {
            return Err(FrameError::TooLarge(n));
        }
        if n == 0 {
            return Err(FrameError::Truncated);
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(f: Frame) {
        let bytes = f.encode();
        let n = Frame::body_len(bytes[..4].try_into().unwrap()).unwrap();
        assert_eq!(n, bytes.len() - 4);
        assert_eq!(Frame::decode(&bytes[4..]).unwrap(), f);
    }

    #[test]
    fn frames_roundtrip() {
        roundtrip(Frame::Json(br#"{"a":1}"#.to_vec()));
        roundtrip(Frame::Output { session: SessionId(7), data: b"hello\x1b[0m".to_vec() });
        roundtrip(Frame::Input { session: SessionId(u64::MAX), data: vec![] });
        roundtrip(Frame::Snapshot { session: SessionId(1), format: SnapshotFormat::Vt, data: vec![1, 2, 3] });
    }

    #[test]
    fn rejects_bad_frames() {
        assert!(matches!(Frame::decode(&[9]), Err(FrameError::UnknownKind(9))));
        assert!(matches!(Frame::decode(&[1, 0, 0]), Err(FrameError::Truncated)));
        assert!(matches!(Frame::body_len(((MAX_FRAME + 1) as u32).to_be_bytes()), Err(FrameError::TooLarge(_))));
    }
}
