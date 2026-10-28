//! 배치를 들고 있고, op 를 돌리고, 바뀌면 알리고, 파일로 남긴다.
//!
//! 트리 규칙은 `thuminal-layout` 에 있다. 여기서는 세션과 엮는 일만 한다.
//! - 새 칸이 필요한 op 는 배치 잠금을 쥔 채 세션을 만든다. op 가 실패하면 만든 세션을 지운다
//! - 칸을 닫는 op 가 빼낸 터미널 세션은 지운다
//! - 다른 workspace 로 옮긴 세션은 꼬리표(`worktree`, `floating`)를 고친다 (다시 뜰 때 맞추기가 같은 곳에 넣게)
//! - `layout-v1.json` 은 바뀌고 1초 안에 원자적으로 쓴다. `daemon stop` 이면 지운다

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use thuminal_layout::{LayoutError, Outcome, SpawnRequest, Spawner, Store, workspace_for_labels};
use thuminal_protocol::{
    CreateSession, ErrorBody, ErrorCode, Event, FLOATING_LABEL, FLOATING_WORKSPACE, LayoutOp, PaneId, SessionId, SessionInfo,
    SessionState, WORKTREE_LABEL, WorkspaceLayout, is_worktree_workspace,
};
use tracing::{info, warn};

use crate::manager::Manager;

/// 데몬은 대상 칸 크기를 모른다. 이 크기로 띄우고 앱이 붙어서 맞춘다
const SPAWN_COLS: u16 = 120;
const SPAWN_ROWS: u16 = 40;

pub struct Layouts {
    store: Mutex<Store>,
    file: PathBuf,
    dirty: AtomicBool,
}

fn error_body(e: LayoutError) -> ErrorBody {
    let code = match e {
        LayoutError::NotFound(_) => ErrorCode::NotFound,
        LayoutError::Invalid(_) => ErrorCode::InvalidRequest,
        LayoutError::Spawn(_) => ErrorCode::SpawnFailed,
    };
    ErrorBody { code, message: e.to_string() }
}

/// workspace 에 맞는 세션 꼬리표. 빈 값은 그 꼬리표를 지운다는 뜻이다 (`SetLabels` 와 같다)
fn labels_for(workspace: &str) -> BTreeMap<String, String> {
    let (worktree, floating) = match workspace {
        w if is_worktree_workspace(w) => (w.to_string(), String::new()),
        FLOATING_WORKSPACE => (String::new(), "1".to_string()),
        _ => (String::new(), String::new()),
    };
    [(WORKTREE_LABEL.to_string(), worktree), (FLOATING_LABEL.to_string(), floating)].into()
}

/// op 가 부탁한 세션을 만든다. 만든 것을 기억해 두었다가 op 가 실패하면 지운다
struct SessionSpawner<'a> {
    manager: &'a Manager,
    created: Vec<SessionId>,
}

impl Spawner for SessionSpawner<'_> {
    fn spawn(&mut self, req: SpawnRequest) -> Result<SessionId, LayoutError> {
        let SpawnRequest { workspace, near, spawn } = req;
        // 작업 폴더: 준 것 → 옆 칸 세션의 지금 폴더 → workspace(워크트리) 경로 → 홈
        let cwd = spawn
            .cwd
            .or_else(|| near.and_then(|s| self.manager.info(s).ok()).map(|i| i.cwd).filter(|c| Path::new(c).is_dir()))
            .or_else(|| is_worktree_workspace(&workspace).then(|| workspace.clone()).filter(|w| Path::new(w).is_dir()));
        let labels = labels_for(&workspace).into_iter().filter(|(_, v)| !v.is_empty()).collect();
        let req = CreateSession { command: spawn.command, cwd, env: spawn.env, cols: SPAWN_COLS, rows: SPAWN_ROWS, labels };
        let info = self.manager.create_with_input(req, spawn.input).map_err(|e| LayoutError::Spawn(e.message))?;
        self.created.push(info.id);
        Ok(info.id)
    }
}

impl Layouts {
    /// 지난번 데몬이 남긴 배치를 읽는다 (세션 번호는 아직 옛 번호다. [`Layouts::restore`] 가 바꿔 끼운다)
    pub fn load(home: &Path) -> Self {
        let file = home.join("layout-v1.json");
        let store = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                warn!(event = "layout_load_failed", error = %e);
                Store::default()
            }),
            Err(_) => Store::default(),
        };
        Self { store: Mutex::new(store), file, dirty: AtomicBool::new(false) }
    }

    pub fn get(&self, workspace: Option<&str>) -> Vec<WorkspaceLayout> {
        let st = self.store.lock().unwrap();
        match workspace {
            Some(w) => st.get(w).cloned().into_iter().collect(),
            None => st.all(),
        }
    }

    /// 바뀐 배치를 알리고, 저장할 것으로 표시하고, 옮겨 간 세션의 꼬리표를 고친다
    fn publish(&self, manager: &Manager, out: &Outcome) {
        for layout in &out.changed {
            let _ = manager.events.send(Event::LayoutChanged { layout: layout.clone() });
        }
        for workspace in &out.removed {
            let _ = manager.events.send(Event::LayoutRemoved { workspace: workspace.clone() });
        }
        if !out.changed.is_empty() || !out.removed.is_empty() {
            self.dirty.store(true, Ordering::SeqCst);
        }
        for (session, workspace) in &out.moved {
            let _ = manager.set_labels(*session, labels_for(workspace));
        }
    }

    /// op 하나. 실패하면 배치는 그대로이고, op 가 만든 세션은 지운다
    pub fn op(&self, manager: &Manager, op: LayoutOp) -> Result<Outcome, ErrorBody> {
        let kind = op.kind();
        let mut spawner = SessionSpawner { manager, created: Vec::new() };
        let result = self.store.lock().unwrap().apply(op, &mut spawner);
        match result {
            Ok(out) => {
                info!(event = "layout_op", op = kind, created = out.created.len(), closed = out.closed.len());
                self.publish(manager, &out);
                for s in &out.closed {
                    let _ = manager.remove(*s);
                }
                Ok(out)
            }
            Err(e) => {
                info!(event = "layout_op", op = kind, error = %e);
                for s in spawner.created {
                    let _ = manager.remove(s);
                }
                Err(error_body(e))
            }
        }
    }

    /// op 여럿을 차례로. 실패하면 그 앞까지는 남기고 몇 번째에서 멈췄는지 알린다
    pub fn batch(&self, manager: &Manager, ops: Vec<LayoutOp>) -> Result<(Vec<WorkspaceLayout>, Vec<PaneId>), ErrorBody> {
        let mut names = BTreeSet::new();
        let mut created = Vec::new();
        for (i, op) in ops.into_iter().enumerate() {
            let out = self.op(manager, op).map_err(|e| ErrorBody { code: e.code, message: format!("{}번째 op: {}", i + 1, e.message) })?;
            names.extend(out.layouts.iter().map(|l| l.workspace.clone()));
            created.extend(out.created);
        }
        let st = self.store.lock().unwrap();
        Ok((names.iter().filter_map(|n| st.get(n).cloned()).collect(), created))
    }

    /// `CreateSession` 으로 만든 세션을 꼬리표의 workspace 새 탭 끝에 넣는다 (`layout=none` 이면 넣지 않는다)
    pub fn place(&self, manager: &Manager, session: &SessionInfo) {
        let Some(workspace) = workspace_for_labels(&session.labels) else { return };
        let out = self.store.lock().unwrap().place_session(session.id, &workspace);
        self.publish(manager, &out);
    }

    /// 세션이 지워졌다: 그 칸을 뺀다
    pub fn session_removed(&self, manager: &Manager, session: SessionId) {
        let out = self.store.lock().unwrap().remove_session(session);
        self.publish(manager, &out);
    }

    /// 워크트리를 지웠다: 그 workspace 배치를 지운다
    pub fn remove_workspace(&self, manager: &Manager, workspace: &str) {
        let out = self.store.lock().unwrap().remove_workspace(workspace);
        self.publish(manager, &out);
    }

    /// 데몬이 뜰 때: 되살린 세션의 새 번호로 바꿔 끼우고, 세션 목록과 맞춘다
    pub fn restore(&self, manager: &Manager) {
        let sessions = manager.list();
        let map: BTreeMap<SessionId, SessionId> = sessions.iter().filter_map(|s| s.restored_from.map(|old| (old, s.id))).collect();
        let mut st = self.store.lock().unwrap();
        let remapped = st.remap_sessions(&map);
        let list: Vec<_> = sessions.iter().map(|s| (s.id, workspace_for_labels(&s.labels), s.state == SessionState::Running)).collect();
        let reconciled = st.reconcile(&list);
        drop(st);
        info!(event = "layout_restored", remapped = map.len(), added = reconciled.created.len(), layouts = self.get(None).len());
        self.publish(manager, &remapped);
        self.publish(manager, &reconciled);
    }

    /// 바뀐 것이 있으면 파일로 남긴다 (임시 파일에 쓰고 이름을 바꾼다)
    pub fn save_if_dirty(&self) {
        if self.dirty.swap(false, Ordering::SeqCst) {
            self.save();
        }
    }

    pub fn save(&self) {
        let bytes = serde_json::to_vec_pretty(&*self.store.lock().unwrap()).expect("배치 JSON");
        let tmp = self.file.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &self.file)) {
            warn!(event = "layout_save_failed", error = %e);
        }
    }

    /// 사용자가 데몬을 내렸다. 다음에 배치를 되살리지 않는다
    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.file);
    }
}
