//! 밖에서 바꾼 워크트리를 알아챈다 (`git worktree add` · `remove`, 폴더 지우기).
//! 데몬이 바꾼 것은 그 자리에서 `workspace_changed` 를 알리지만, 밖에서 바꾼 것은 알 길이 없어 10초마다 목록을 견준다.
//! 폴더가 없어진 워크트리에 열려 있던 탭은 "워크트리 밖"(`other`)으로 옮긴다. 세션은 끝내지 않는다
//! (자기 워크트리를 지운 claude 가 그 탭 안에서 아직 돌고 있을 수 있다).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use thuminal_protocol::{Event, LayoutOp, OTHER_WORKSPACE, TabRef};
use tracing::{info, warn};

use crate::server::Server;

/// 저장소 id → 워크트리 경로들
type Lists = BTreeMap<String, Vec<String>>;

pub async fn watch(server: Arc<Server>) {
    let mut seen: Option<Lists> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let s = server.clone();
        let before = seen.clone().unwrap_or_default();
        let Ok((now, cleaned)) = tokio::task::spawn_blocking(move || {
            let cleaned = clean_vanished(&s);
            (lists(&s, &before), cleaned)
        })
        .await
        else {
            continue;
        };
        if cleaned || seen.as_ref().is_some_and(|b| *b != now) {
            let _ = server.manager.events.send(Event::WorkspaceChanged);
        }
        seen = Some(now);
    }
}

/// 저장소마다 워크트리 경로. 읽지 못한 저장소는 앞 값을 그대로 둔다 (git 이 잠깐 실패해도 바뀐 것으로 보지 않는다)
fn lists(server: &Server, before: &Lists) -> Lists {
    server
        .workspace
        .repos()
        .into_iter()
        .filter_map(|r| {
            let paths = match server.workspace.worktrees(Some(&r.id)) {
                Ok(list) => list.into_iter().map(|w| w.path).collect(),
                Err(_) => before.get(&r.id)?.clone(),
            };
            Some((r.id, paths))
        })
        .collect()
}

/// 폴더가 없어진 워크트리를 정리한다: 탭은 `other` 로 옮기고, 배치와 이름 기록을 지운다. 정리한 것이 있으면 true
fn clean_vanished(server: &Server) -> bool {
    let mut cleaned = false;
    for l in server.layouts.get(None) {
        let path = Path::new(&l.workspace);
        if !path.is_absolute() || path.exists() {
            continue;
        }
        for t in &l.tabs {
            let op = LayoutOp::MoveTab { tab: TabRef::Id(t.id), workspace: Some(OTHER_WORKSPACE.into()), index: usize::MAX };
            if let Err(e) = server.layouts.op(&server.manager, op) {
                warn!(event = "vanished_worktree_tab_move_failed", worktree = %l.workspace, error = %e.message);
            }
        }
        server.layouts.remove_workspace(&server.manager, &l.workspace);
        info!(event = "worktree_vanished", worktree = %l.workspace, tabs = l.tabs.len());
        cleaned = true;
    }
    cleaned | (server.workspace.forget_missing_worktrees() > 0)
}
