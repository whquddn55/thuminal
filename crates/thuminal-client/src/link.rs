//! 끊기면 다시 붙는 연결 (원격 호스트).
//!
//! [`Link`] 는 붙기 함수를 받아 감독 작업 하나를 돌린다. 붙으면 그 [`Client`] 를 내주고, 끊기면 0.25초에서 30초까지
//! 두 배씩 늘려 기다리며 다시 붙는다. 토큰이 틀리면 멈추고([`LinkState::Unauthorized`], [`Link::reconnect_now`] 를
//! 부르면 다시 해 본다), 프로토콜 주 판이 다르면 30초마다 다시 본다 (원격이 업데이트하면 붙는다).
//! 상태는 [`Link::status`] 로 지켜본다. 붙을 때마다 `generation` 이 하나 는다 (다시 붙었는지 가른다).

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use crate::{Client, ClientError, Result};

const FIRST_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Connecting,
    Connected,
    /// 끊겼다. `retry_in` 뒤에 다시 붙는다
    Disconnected,
    /// 토큰이 맞지 않는다. 다시 붙지 않는다
    Unauthorized,
    /// 프로토콜 주 판이 다르다
    VersionMismatch,
}

#[derive(Debug, Clone)]
pub struct LinkStatus {
    pub state: LinkState,
    /// 마지막 실패 까닭
    pub error: Option<String>,
    /// 붙은 데몬의 판 (붙은 적이 있으면 마지막 것)
    pub daemon_version: Option<String>,
    pub protocol: Option<(u32, u32)>,
    /// 부 판이 다를 때 알릴 글
    pub warning: Option<String>,
    /// 붙은 횟수. 늘면 새 연결이다
    pub generation: u64,
    pub retry_in: Option<Duration>,
}

impl Default for LinkStatus {
    fn default() -> Self {
        Self { state: LinkState::Connecting, error: None, daemon_version: None, protocol: None, warning: None, generation: 0, retry_in: None }
    }
}

struct Inner {
    client: Mutex<Option<Arc<Client>>>,
    status: watch::Sender<LinkStatus>,
    wake: Notify,
}

pub struct Link {
    inner: Arc<Inner>,
    task: JoinHandle<()>,
}

impl Drop for Link {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Link {
    /// 감독 작업을 띄운다. `connect` 는 붙을 때마다 부른다
    pub fn spawn<F, Fut>(connect: F) -> Link
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Client>> + Send + 'static,
    {
        let inner = Arc::new(Inner { client: Mutex::new(None), status: watch::channel(LinkStatus::default()).0, wake: Notify::new() });
        let task = tokio::spawn(supervise(inner.clone(), connect));
        Link { inner, task }
    }

    /// 지금 붙어 있는 연결. 끊겼으면 None
    pub fn client(&self) -> Option<Arc<Client>> {
        self.inner.client.lock().unwrap().clone().filter(|c| !c.is_closed())
    }

    pub fn status(&self) -> watch::Receiver<LinkStatus> {
        self.inner.status.subscribe()
    }

    pub fn current(&self) -> LinkStatus {
        self.inner.status.borrow().clone()
    }

    /// 기다리는 중이면 바로 다시 붙는다 (토큰이 틀려 멈췄어도)
    pub fn reconnect_now(&self) {
        self.inner.wake.notify_one();
    }
}

async fn supervise<F, Fut>(inner: Arc<Inner>, connect: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Client>> + Send + 'static,
{
    let mut delay = FIRST_DELAY;
    loop {
        inner.status.send_modify(|s| {
            s.state = LinkState::Connecting;
            s.retry_in = None;
        });
        let wait = match connect().await {
            Ok(c) => {
                let c = Arc::new(c);
                *inner.client.lock().unwrap() = Some(c.clone());
                inner.status.send_modify(|s| {
                    s.state = LinkState::Connected;
                    s.error = None;
                    s.warning = c.version_warning.clone();
                    if let Some((v, major, minor)) = c.hello() {
                        s.daemon_version = Some(v.to_string());
                        s.protocol = Some((major, minor));
                    }
                    s.generation += 1;
                });
                c.closed().await;
                inner.client.lock().unwrap().take();
                inner.status.send_modify(|s| {
                    s.state = LinkState::Disconnected;
                    s.error = Some("연결이 끊겼어요".into());
                });
                delay = FIRST_DELAY;
                Some(next(&mut delay))
            }
            Err(ClientError::Unauthorized) => {
                inner.status.send_modify(|s| {
                    s.state = LinkState::Unauthorized;
                    s.error = Some(ClientError::Unauthorized.to_string());
                });
                None
            }
            Err(e @ ClientError::VersionMismatch(_)) => {
                inner.status.send_modify(|s| {
                    s.state = LinkState::VersionMismatch;
                    s.error = Some(e.to_string());
                });
                delay = MAX_DELAY;
                Some(MAX_DELAY)
            }
            Err(e) => {
                inner.status.send_modify(|s| {
                    s.state = LinkState::Disconnected;
                    s.error = Some(e.to_string());
                });
                Some(next(&mut delay))
            }
        };
        match wait {
            Some(d) => {
                inner.status.send_modify(|s| s.retry_in = Some(d));
                tokio::select! {
                    _ = tokio::time::sleep(d) => {}
                    _ = inner.wake.notified() => delay = FIRST_DELAY,
                }
            }
            None => {
                inner.wake.notified().await;
                delay = FIRST_DELAY;
            }
        }
    }
}

/// 이번에 기다릴 시간을 돌려주고 다음 것을 두 배로 늘린다
fn next(delay: &mut Duration) -> Duration {
    let d = *delay;
    *delay = (*delay * 2).min(MAX_DELAY);
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_max() {
        let mut d = FIRST_DELAY;
        let got: Vec<u128> = (0..10).map(|_| next(&mut d).as_millis()).collect();
        assert_eq!(got, [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    }
}
