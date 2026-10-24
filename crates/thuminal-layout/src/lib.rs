//! thuminal 배치 규칙.
//!
//! workspace 마다 탭 목록, 탭마다 n갈래 칸 트리를 들고 [`LayoutOp`] 로 바꾼다.
//! 입출력은 하지 않는다. 새 터미널이 필요한 op(새 탭, 분할, apply 의 새 칸)는
//! [`Spawner`] 에 세션을 만들어 달라고 한다. op 는 사본에서 돌리고 끝까지 되면
//! 바꿔 끼우므로, 중간에 실패하면 배치는 그대로다 (만든 세션을 치우는 것은 Spawner 쪽 일이다).

pub mod dsl;
pub mod tree;

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thuminal_protocol::{
    FLOATING_LABEL, FLOATING_WORKSPACE, LAYOUT_LABEL, LayoutOp, LayoutSpec, OTHER_WORKSPACE, Pane, PaneContent, PaneId,
    PaneNode, PaneRef, SessionId, Spawn, Tab, TabId, TabRef, WORKTREE_LABEL, WorkspaceLayout,
};

use crate::tree::MIN_SIZE;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LayoutError {
    /// 없는 칸, 탭, workspace
    #[error("{0}")]
    NotFound(String),
    /// 뜻이 안 되는 요청
    #[error("{0}")]
    Invalid(String),
    /// 세션을 만들지 못했다
    #[error("{0}")]
    Spawn(String),
}

pub type Result<T> = std::result::Result<T, LayoutError>;

fn invalid(msg: impl Into<String>) -> LayoutError {
    LayoutError::Invalid(msg.into())
}

/// 새 터미널 하나 만들어 달라는 부탁
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnRequest {
    pub workspace: String,
    /// 이 세션 옆에 띄운다 (작업 폴더를 물려받을 세션)
    pub near: Option<SessionId>,
    pub spawn: Spawn,
}

pub trait Spawner {
    fn spawn(&mut self, req: SpawnRequest) -> Result<SessionId>;
}

impl<F: FnMut(SpawnRequest) -> Result<SessionId>> Spawner for F {
    fn spawn(&mut self, req: SpawnRequest) -> Result<SessionId> {
        self(req)
    }
}

/// 새 터미널이 필요 없는 바꾸기에 쓴다
pub struct NoSpawn;

impl Spawner for NoSpawn {
    fn spawn(&mut self, _req: SpawnRequest) -> Result<SessionId> {
        Err(invalid("이 op 는 세션을 만들 수 없다"))
    }
}

/// 바꾼 결과. 이벤트와 응답, 세션 정리에 쓴다
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outcome {
    /// 바뀌었거나 새로 생긴 workspace 배치
    pub changed: Vec<WorkspaceLayout>,
    /// 없어진 workspace
    pub removed: Vec<String>,
    /// 응답에 넣을 배치: 바뀐 것과 op 가 가리킨 것
    pub layouts: Vec<WorkspaceLayout>,
    /// 새로 만든 칸
    pub created: Vec<PaneId>,
    /// 배치에서 빠진 터미널 세션 (닫은 칸). 데몬이 세션을 지운다
    pub closed: Vec<SessionId>,
    /// 다른 workspace 로 옮겨 간 세션과 새 workspace. 데몬이 꼬리표를 고친다
    pub moved: Vec<(SessionId, String)>,
}

/// workspace 이름이 맞는지: 워크트리 절대 경로, `floating`, `other`
pub fn check_workspace(ws: &str) -> Result<()> {
    if ws.starts_with('/') || ws == FLOATING_WORKSPACE || ws == OTHER_WORKSPACE {
        Ok(())
    } else {
        Err(invalid(format!("workspace 는 워크트리 절대 경로나 floating, other 다: {ws}")))
    }
}

/// 세션 꼬리표로 workspace 를 정한다. `layout=none` 이면 칸에 넣지 않는다 (None)
pub fn workspace_for_labels(labels: &BTreeMap<String, String>) -> Option<String> {
    if labels.get(LAYOUT_LABEL).is_some_and(|v| v == "none") {
        return None;
    }
    if labels.contains_key(FLOATING_LABEL) {
        return Some(FLOATING_WORKSPACE.into());
    }
    match labels.get(WORKTREE_LABEL) {
        Some(p) if p.starts_with('/') => Some(p.clone()),
        _ => Some(OTHER_WORKSPACE.into()),
    }
}

/// 모든 workspace 의 배치와 다음 번호. 데몬이 파일로 남긴다
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Store {
    next_pane: u64,
    next_tab: u64,
    workspaces: BTreeMap<String, WorkspaceLayout>,
}

impl Default for Store {
    fn default() -> Self {
        Self { next_pane: 1, next_tab: 1, workspaces: BTreeMap::new() }
    }
}

/// 칸이 있는 곳: workspace 와 탭 인덱스
type At = (String, usize);

impl Store {
    pub fn get(&self, workspace: &str) -> Option<&WorkspaceLayout> {
        self.workspaces.get(workspace)
    }

    pub fn all(&self) -> Vec<WorkspaceLayout> {
        self.workspaces.values().cloned().collect()
    }

    /// 이 세션이 든 칸
    pub fn pane_of_session(&self, session: SessionId) -> Option<PaneId> {
        self.all_panes().find(|(_, p)| p.session() == Some(session)).map(|(_, p)| p.id)
    }

    fn all_panes(&self) -> impl Iterator<Item = (&str, &Pane)> {
        self.workspaces
            .iter()
            .flat_map(|(ws, l)| l.tabs.iter().flat_map(move |t| tree::panes(&t.root).into_iter().map(move |p| (ws.as_str(), p))))
    }

    fn sessions(&self) -> BTreeMap<SessionId, String> {
        self.all_panes().filter_map(|(ws, p)| p.session().map(|s| (s, ws.to_string()))).collect()
    }

    // ---- 바꾸기: 사본에서 돌리고 되면 바꿔 끼운다 ----

    fn mutate(&mut self, f: impl FnOnce(&mut Store, &mut Vec<String>, &mut Vec<PaneId>) -> Result<()>) -> Result<Outcome> {
        let mut next = self.clone();
        let mut touched = Vec::new();
        let mut created = Vec::new();
        f(&mut next, &mut touched, &mut created)?;
        next.prune();
        let out = self.diff(&next, touched, created);
        *self = next;
        Ok(out)
    }

    fn diff(&self, next: &Store, touched: Vec<String>, created: Vec<PaneId>) -> Outcome {
        let changed: Vec<WorkspaceLayout> =
            next.workspaces.iter().filter(|(k, v)| self.workspaces.get(*k) != Some(v)).map(|(_, v)| v.clone()).collect();
        let removed: Vec<String> = self.workspaces.keys().filter(|k| !next.workspaces.contains_key(*k)).cloned().collect();
        let mut names: BTreeSet<&str> = changed.iter().map(|l| l.workspace.as_str()).collect();
        names.extend(touched.iter().map(String::as_str));
        let layouts = names.into_iter().filter_map(|n| next.workspaces.get(n).cloned()).collect();
        let (before, after) = (self.sessions(), next.sessions());
        let closed = before.keys().filter(|s| !after.contains_key(s)).copied().collect();
        let moved = after.iter().filter(|(s, ws)| before.get(s).is_some_and(|b| b != *ws)).map(|(s, ws)| (*s, ws.clone())).collect();
        Outcome { changed, removed, layouts, created, closed, moved }
    }

    /// 빈 workspace 를 지우고, 트리를 정규화하고, 포커스·펼침·활성 탭이 늘 맞는 칸을 가리키게 한다
    fn prune(&mut self) {
        self.workspaces.retain(|_, l| !l.tabs.is_empty());
        for l in self.workspaces.values_mut() {
            for t in &mut l.tabs {
                tree::normalize(&mut t.root);
                let ids = tree::pane_ids(&t.root);
                if !ids.contains(&t.focused) {
                    t.focused = ids[0];
                }
                if t.zoomed.is_some_and(|z| !ids.contains(&z)) {
                    t.zoomed = None;
                }
            }
            if !l.active_tab.is_some_and(|a| l.tabs.iter().any(|t| t.id == a)) {
                l.active_tab = l.tabs.first().map(|t| t.id);
            }
        }
    }

    fn alloc_pane(&mut self, content: PaneContent) -> Pane {
        let id = PaneId(self.next_pane);
        self.next_pane += 1;
        Pane { id, content }
    }

    fn alloc_tab(&mut self, root: PaneNode) -> Tab {
        let id = TabId(self.next_tab);
        self.next_tab += 1;
        let focused = tree::pane_ids(&root)[0];
        Tab { id, title: None, root, focused, zoomed: None }
    }

    fn ws_mut(&mut self, ws: &str) -> &mut WorkspaceLayout {
        self.workspaces
            .entry(ws.to_string())
            .or_insert_with(|| WorkspaceLayout { workspace: ws.to_string(), tabs: Vec::new(), active_tab: None })
    }

    fn tab_mut(&mut self, at: &At) -> &mut Tab {
        &mut self.workspaces.get_mut(&at.0).expect("찾은 workspace").tabs[at.1]
    }

    fn tab(&self, at: &At) -> &Tab {
        &self.workspaces[&at.0].tabs[at.1]
    }

    fn find_pane(&self, id: PaneId) -> Option<At> {
        self.workspaces.iter().find_map(|(ws, l)| l.tabs.iter().position(|t| tree::contains(&t.root, id)).map(|i| (ws.clone(), i)))
    }

    fn find_tab(&self, id: TabId) -> Option<At> {
        self.workspaces.iter().find_map(|(ws, l)| l.tabs.iter().position(|t| t.id == id).map(|i| (ws.clone(), i)))
    }

    fn resolve_pane(&self, r: &PaneRef) -> Result<(At, PaneId)> {
        let id = match r {
            PaneRef::Id(id) => *id,
            PaneRef::Session(s) => self.pane_of_session(*s).ok_or_else(|| LayoutError::NotFound(format!("세션 {s} 이 든 칸이 없다")))?,
            PaneRef::Focused(ws) => {
                let l = self.workspaces.get(ws).ok_or_else(|| LayoutError::NotFound(format!("{ws} 에 배치가 없다")))?;
                let t = l
                    .active_tab
                    .and_then(|a| l.tabs.iter().find(|t| t.id == a))
                    .ok_or_else(|| LayoutError::NotFound(format!("{ws} 에 활성 탭이 없다")))?;
                t.focused
            }
        };
        let at = self.find_pane(id).ok_or_else(|| LayoutError::NotFound(format!("칸 {id} 이 없다")))?;
        Ok((at, id))
    }

    fn resolve_tab(&self, r: &TabRef) -> Result<At> {
        match r {
            TabRef::Id(id) => self.find_tab(*id).ok_or_else(|| LayoutError::NotFound(format!("탭 {id} 이 없다"))),
            TabRef::Pane(p) => self.resolve_pane(p).map(|(at, _)| at),
            TabRef::Active(ws) => {
                let l = self.workspaces.get(ws).ok_or_else(|| LayoutError::NotFound(format!("{ws} 에 배치가 없다")))?;
                l.active_tab
                    .and_then(|a| l.tabs.iter().position(|t| t.id == a))
                    .map(|i| (ws.clone(), i))
                    .ok_or_else(|| LayoutError::NotFound(format!("{ws} 에 활성 탭이 없다")))
            }
        }
    }

    /// 탭을 넣는다 (index 를 비우면 끝)
    fn insert_tab(&mut self, ws: &str, tab: Tab, index: Option<usize>, activate: bool) -> At {
        let l = self.ws_mut(ws);
        let i = index.unwrap_or(l.tabs.len()).min(l.tabs.len());
        if activate || l.active_tab.is_none() {
            l.active_tab = Some(tab.id);
        }
        l.tabs.insert(i, tab);
        (ws.to_string(), i)
    }

    /// 탭을 뺀다. 활성 탭이었으면 옆 탭이 활성이 된다
    fn take_tab(&mut self, at: &At) -> Tab {
        let l = self.workspaces.get_mut(&at.0).expect("찾은 workspace");
        let tab = l.tabs.remove(at.1);
        if l.active_tab == Some(tab.id) {
            l.active_tab = l.tabs.get(at.1.min(l.tabs.len().saturating_sub(1))).map(|t| t.id);
        }
        tab
    }

    /// 칸을 트리에서 빼낸다. 탭이 비면 탭을 지운다
    fn take_pane(&mut self, id: PaneId) -> Result<Pane> {
        let at = self.find_pane(id).ok_or_else(|| LayoutError::NotFound(format!("칸 {id} 이 없다")))?;
        let t = self.tab_mut(&at);
        let root = std::mem::replace(&mut t.root, tree::leaf(Pane { id: PaneId(0), content: PaneContent::Doc { doc: BTreeMap::new() } }));
        let order = tree::pane_ids(&root);
        let (rest, pane) = tree::remove_pane(root, id);
        match rest {
            Some(rest) => {
                // 포커스가 빠지면 트리 순서로 바로 다음 칸(끝이면 앞 칸)으로
                if t.focused == id {
                    let i = order.iter().position(|p| *p == id).unwrap_or(0);
                    let left = tree::pane_ids(&rest);
                    t.focused = left[i.min(left.len() - 1)];
                }
                t.root = rest;
            }
            None => {
                self.take_tab(&at);
            }
        }
        Ok(pane.expect("찾은 칸"))
    }

    fn focus(&mut self, at: &At, id: PaneId) {
        let t = self.tab_mut(at);
        t.focused = id;
        if t.zoomed.is_some_and(|z| z != id) {
            t.zoomed = None;
        }
        let tab = t.id;
        self.workspaces.get_mut(&at.0).expect("찾은 workspace").active_tab = Some(tab);
    }

    fn near_session(&self, at: &At, id: PaneId) -> Option<SessionId> {
        tree::find(&self.tab(at).root, id).and_then(Pane::session)
    }

    fn spawn_pane(&mut self, spawner: &mut dyn Spawner, workspace: &str, near: Option<SessionId>, spawn: Spawn, created: &mut Vec<PaneId>) -> Result<Pane> {
        let session = spawner.spawn(SpawnRequest { workspace: workspace.to_string(), near, spawn })?;
        let pane = self.alloc_pane(PaneContent::Terminal { session });
        created.push(pane.id);
        Ok(pane)
    }

    /// op 하나. 실패하면 배치는 그대로다
    pub fn apply(&mut self, op: LayoutOp, spawner: &mut dyn Spawner) -> Result<Outcome> {
        self.mutate(|s, touched, created| s.run(op, spawner, touched, created))
    }

    fn run(&mut self, op: LayoutOp, spawner: &mut dyn Spawner, touched: &mut Vec<String>, created: &mut Vec<PaneId>) -> Result<()> {
        match op {
            LayoutOp::NewTab { workspace, spawn, index, focus } => {
                check_workspace(&workspace)?;
                let pane = self.spawn_pane(spawner, &workspace, None, spawn, created)?;
                let tab = self.alloc_tab(tree::leaf(pane));
                self.insert_tab(&workspace, tab, index, focus);
            }
            LayoutOp::OpenDoc { workspace, doc } => {
                check_workspace(&workspace)?;
                touched.push(workspace.clone());
                let existing = self.workspaces.get(&workspace).and_then(|l| {
                    l.tabs.iter().enumerate().find_map(|(i, t)| {
                        tree::panes(&t.root).into_iter().find(|p| matches!(&p.content, PaneContent::Doc { doc: d } if *d == doc)).map(|p| (i, p.id))
                    })
                });
                match existing {
                    Some((i, id)) => self.focus(&(workspace, i), id),
                    None => {
                        let pane = self.alloc_pane(PaneContent::Doc { doc });
                        created.push(pane.id);
                        let tab = self.alloc_tab(tree::leaf(pane));
                        self.insert_tab(&workspace, tab, None, true);
                    }
                }
            }
            LayoutOp::Split { target, side, size, spawn, focus } => {
                let size = size.unwrap_or(0.5);
                if !(MIN_SIZE..=1.0 - MIN_SIZE).contains(&size) {
                    return Err(invalid(format!("size 는 0.05~0.95 다: {size}")));
                }
                let (at, id) = self.resolve_pane(&target)?;
                let near = self.near_session(&at, id);
                let pane = self.spawn_pane(spawner, &at.0, near, spawn, created)?;
                let new = pane.id;
                let t = self.tab_mut(&at);
                tree::insert_beside(&mut t.root, id, side, size, tree::leaf(pane)).map_err(|_| invalid("칸을 넣지 못했다"))?;
                t.zoomed = None;
                if focus {
                    self.focus(&at, new);
                }
            }
            LayoutOp::Resize { target, size, axis } => {
                if !(MIN_SIZE..=1.0 - MIN_SIZE).contains(&size) {
                    return Err(invalid(format!("size 는 0.05~0.95 다: {size}")));
                }
                self.resize(&target, axis, touched, |_| size)?;
            }
            LayoutOp::ResizeBy { target, delta, axis } => {
                if !delta.is_finite() {
                    return Err(invalid("delta 가 숫자가 아니다"));
                }
                self.resize(&target, axis, touched, |cur| cur + delta)?;
            }
            LayoutOp::SetSizes { tab, path, sizes } => {
                let at = self.find_tab(tab).ok_or_else(|| LayoutError::NotFound(format!("탭 {tab} 이 없다")))?;
                touched.push(at.0.clone());
                let t = self.tab_mut(&at);
                match tree::node_at_mut(&mut t.root, &path) {
                    Some(PaneNode::Split { children, sizes: cur, .. }) => {
                        if sizes.len() != children.len() || sizes.iter().any(|s| !s.is_finite() || *s <= 0.0) {
                            return Err(invalid(format!("sizes 는 양수 {}개다", children.len())));
                        }
                        *cur = sizes;
                        tree::fix_sizes(cur, children.len());
                    }
                    _ => return Err(invalid(format!("경로 {path:?} 가 분할이 아니다"))),
                }
            }
            LayoutOp::Equalize { tab } => {
                let at = self.resolve_tab(&tab)?;
                touched.push(at.0.clone());
                tree::equalize(&mut self.tab_mut(&at).root);
            }
            LayoutOp::Focus { target } => {
                let (at, id) = self.resolve_pane(&target)?;
                touched.push(at.0.clone());
                self.focus(&at, id);
            }
            LayoutOp::FocusDir { from, side } => {
                let (at, id) = self.resolve_pane(&from)?;
                touched.push(at.0.clone());
                if let Some(next) = tree::neighbor(&self.tab(&at).root, id, side) {
                    self.focus(&at, next);
                }
            }
            LayoutOp::FocusCycle { from, delta } => {
                let (at, id) = self.resolve_pane(&from)?;
                touched.push(at.0.clone());
                let ids = tree::pane_ids(&self.tab(&at).root);
                let i = ids.iter().position(|p| *p == id).expect("찾은 칸") as i64;
                let next = ids[(i + delta as i64).rem_euclid(ids.len() as i64) as usize];
                self.focus(&at, next);
            }
            LayoutOp::Zoom { target, on } => {
                let (at, id) = self.resolve_pane(&target)?;
                touched.push(at.0.clone());
                let t = self.tab_mut(&at);
                let want = on.unwrap_or(t.zoomed != Some(id));
                if want {
                    t.focused = id;
                    t.zoomed = Some(id);
                } else {
                    t.zoomed = None;
                }
            }
            LayoutOp::MovePane { pane, to, side } => {
                let (_, id) = self.resolve_pane(&pane)?;
                let (_, to_id) = self.resolve_pane(&to)?;
                if id == to_id {
                    return Err(invalid(format!("칸 {id} 을 자기 옆으로 옮길 수 없다")));
                }
                let moved = self.take_pane(id)?;
                let at = self.find_pane(to_id).expect("남아 있는 칸");
                let t = self.tab_mut(&at);
                tree::insert_beside(&mut t.root, to_id, side, 0.5, tree::leaf(moved)).map_err(|_| invalid("칸을 넣지 못했다"))?;
                t.zoomed = None;
                self.focus(&at, id);
            }
            LayoutOp::Swap { a, b } => {
                let (at_a, a) = self.resolve_pane(&a)?;
                let (at_b, b) = self.resolve_pane(&b)?;
                touched.push(at_a.0.clone());
                if a == b {
                    return Ok(());
                }
                let pa = tree::find(&self.tab(&at_a).root, a).cloned().expect("찾은 칸");
                let pb = tree::find(&self.tab(&at_b).root, b).cloned().expect("찾은 칸");
                let hole = Pane { id: PaneId(u64::MAX), content: PaneContent::Doc { doc: BTreeMap::new() } };
                let _ = tree::replace_pane(&mut self.tab_mut(&at_a).root, a, hole.clone());
                let _ = tree::replace_pane(&mut self.tab_mut(&at_b).root, b, pa);
                let _ = tree::replace_pane(&mut self.tab_mut(&at_a).root, hole.id, pb);
                if at_a != at_b {
                    // 다른 탭끼리면 포커스와 펼침은 자리를 따라간다
                    for (at, from, to) in [(&at_a, a, b), (&at_b, b, a)] {
                        let t = self.tab_mut(at);
                        if t.focused == from {
                            t.focused = to;
                        }
                        t.zoomed = None;
                    }
                }
            }
            LayoutOp::BreakPane { pane, workspace, index } => {
                let (at, id) = self.resolve_pane(&pane)?;
                let dest = workspace.unwrap_or_else(|| at.0.clone());
                check_workspace(&dest)?;
                let tab = if tree::pane_ids(&self.tab(&at).root).len() == 1 {
                    // 칸 하나짜리 탭은 탭째 옮긴다 (번호와 이름을 지킨다)
                    self.take_tab(&at)
                } else {
                    let p = self.take_pane(id)?;
                    self.alloc_tab(tree::leaf(p))
                };
                self.insert_tab(&dest, tab, index, true);
            }
            LayoutOp::JoinTab { tab, to, side } => {
                let at = self.resolve_tab(&tab)?;
                let (_, to_id) = self.resolve_pane(&to)?;
                if tree::contains(&self.tab(&at).root, to_id) {
                    return Err(invalid(format!("탭을 자기 칸 {to_id} 옆으로 합칠 수 없다")));
                }
                let joined = self.take_tab(&at);
                let dest = self.find_pane(to_id).expect("남아 있는 칸");
                let t = self.tab_mut(&dest);
                tree::insert_beside(&mut t.root, to_id, side, 0.5, joined.root).map_err(|_| invalid("칸을 넣지 못했다"))?;
                t.zoomed = None;
                self.focus(&dest, joined.focused);
            }
            LayoutOp::MoveTab { tab, workspace, index } => {
                let at = self.resolve_tab(&tab)?;
                let dest = workspace.unwrap_or_else(|| at.0.clone());
                check_workspace(&dest)?;
                touched.push(at.0.clone());
                // 같은 workspace 안에서 순서만 바꾸면 활성 탭은 그대로다
                let keep_active = dest != at.0 || self.workspaces[&at.0].active_tab == Some(self.tab(&at).id);
                let t = self.take_tab(&at);
                self.insert_tab(&dest, t, Some(index), keep_active);
            }
            LayoutOp::SelectTab { tab } => {
                let at = self.resolve_tab(&tab)?;
                touched.push(at.0.clone());
                let id = self.tab(&at).id;
                self.ws_mut(&at.0).active_tab = Some(id);
            }
            LayoutOp::RenameTab { tab, title } => {
                let at = self.resolve_tab(&tab)?;
                touched.push(at.0.clone());
                self.tab_mut(&at).title = title.filter(|t| !t.trim().is_empty());
            }
            LayoutOp::ClosePane { target } => {
                let (at, id) = self.resolve_pane(&target)?;
                touched.push(at.0.clone());
                self.take_pane(id)?;
            }
            LayoutOp::CloseTab { tab } => {
                let at = self.resolve_tab(&tab)?;
                touched.push(at.0.clone());
                self.take_tab(&at);
            }
            LayoutOp::Apply { workspace, tab, spec, focus } => self.apply_spec(workspace, tab, spec, focus, spawner, touched, created)?,
        }
        Ok(())
    }

    fn resize(&mut self, target: &PaneRef, axis: Option<thuminal_protocol::Axis>, touched: &mut Vec<String>, share: impl FnOnce(f32) -> f32) -> Result<()> {
        let (at, id) = self.resolve_pane(target)?;
        touched.push(at.0.clone());
        let t = self.tab_mut(&at);
        let (path, index) = tree::resize_target(&t.root, id, axis).ok_or_else(|| invalid(format!("칸 {id} 이 든 분할이 없다")))?;
        let Some(PaneNode::Split { sizes, .. }) = tree::node_at_mut(&mut t.root, &path) else { unreachable!("분할 길") };
        let want = share(sizes[index]);
        tree::set_share(sizes, index, want);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_spec(
        &mut self,
        workspace: String,
        tab: Option<TabRef>,
        spec: LayoutSpec,
        focus: bool,
        spawner: &mut dyn Spawner,
        touched: &mut Vec<String>,
        created: &mut Vec<PaneId>,
    ) -> Result<()> {
        check_workspace(&workspace)?;
        // 1. spec 을 미리 훑는다: 모양이 맞는지, 가리킨 칸이 있는지, 두 번 나오지 않는지
        let mut refs = Vec::new();
        fn scan(s: &LayoutSpec, st: &Store, refs: &mut Vec<PaneId>) -> Result<()> {
            match s {
                LayoutSpec::Split { children, sizes, .. } => {
                    if children.is_empty() {
                        return Err(invalid("분할에 칸이 없다"));
                    }
                    if let Some(sz) = sizes
                        && (sz.len() != children.len() || sz.iter().any(|v| !v.is_finite() || *v <= 0.0))
                    {
                        return Err(invalid(format!("sizes 는 양수 {}개다", children.len())));
                    }
                    children.iter().try_for_each(|c| scan(c, st, refs))
                }
                LayoutSpec::Pane { pane } => {
                    let (_, id) = st.resolve_pane(pane)?;
                    if refs.contains(&id) {
                        return Err(invalid(format!("칸 {id} 이 두 번 나온다")));
                    }
                    refs.push(id);
                    Ok(())
                }
                LayoutSpec::Spawn { .. } => Ok(()),
            }
        }
        scan(&spec, self, &mut refs)?;
        let target = tab.as_ref().map(|r| self.resolve_tab(r)).transpose()?;
        let (ws, tab_id) = match &target {
            Some(at) => (at.0.clone(), Some(self.tab(at).id)),
            None => (workspace, None),
        };
        touched.push(ws.clone());

        // 2. 대상 탭의 옛 칸을 꺼내 두고, 다른 탭에서 가리킨 칸을 떼어 온다
        let mut pool: BTreeMap<PaneId, Pane> = BTreeMap::new();
        let mut old_ids = Vec::new();
        let mut near = None;
        if let Some(at) = &target {
            let t = self.tab(at);
            near = self.near_session(at, t.focused);
            for p in tree::panes(&t.root) {
                old_ids.push(p.id);
                pool.insert(p.id, p.clone());
            }
        }
        for id in &refs {
            if !pool.contains_key(id) {
                let p = self.take_pane(*id)?;
                pool.insert(*id, p);
            }
        }

        // 3. 새 트리를 만든다 (새 칸은 여기서 세션을 만든다)
        struct Build<'a> {
            pool: &'a mut BTreeMap<PaneId, Pane>,
            refs: std::slice::Iter<'a, PaneId>,
            ws: &'a str,
            near: Option<SessionId>,
            spawner: &'a mut dyn Spawner,
            created: &'a mut Vec<PaneId>,
        }
        fn build(s: LayoutSpec, st: &mut Store, b: &mut Build<'_>) -> Result<PaneNode> {
            Ok(match s {
                LayoutSpec::Split { axis, children, sizes } => {
                    let n = children.len();
                    let children = children.into_iter().map(|c| build(c, st, b)).collect::<Result<Vec<_>>>()?;
                    PaneNode::Split { axis, children, sizes: sizes.unwrap_or_else(|| vec![1.0 / n as f32; n]) }
                }
                LayoutSpec::Pane { .. } => {
                    let id = b.refs.next().expect("훑은 칸");
                    tree::leaf(b.pool.remove(id).expect("모아 둔 칸"))
                }
                LayoutSpec::Spawn { spawn } => tree::leaf(st.spawn_pane(&mut *b.spawner, b.ws, b.near, spawn, b.created)?),
            })
        }
        let mut b = Build { pool: &mut pool, refs: refs.iter(), ws: &ws, near, spawner, created };
        let mut root = build(spec, self, &mut b)?;
        tree::normalize(&mut root);

        // 4. 끼운다. spec 에 없던 옛 칸은 각자 새 탭으로 떼어 대상 탭 뒤에 둔다
        let at = match tab_id {
            Some(id) => {
                let at = self.find_tab(id).expect("대상 탭");
                let t = self.tab_mut(&at);
                if !tree::contains(&root, t.focused) {
                    t.focused = tree::pane_ids(&root)[0];
                }
                t.root = root;
                t.zoomed = None;
                at
            }
            None => {
                let t = self.alloc_tab(root);
                self.insert_tab(&ws, t, None, focus)
            }
        };
        let mut index = at.1 + 1;
        for id in old_ids {
            if let Some(p) = pool.remove(&id) {
                let t = self.alloc_tab(tree::leaf(p));
                self.insert_tab(&ws, t, Some(index), false);
                index += 1;
            }
        }
        if focus {
            let id = self.tab(&at).id;
            self.ws_mut(&ws).active_tab = Some(id);
        }
        Ok(())
    }

    // ---- 세션 쪽에서 오는 바꾸기 ----

    /// `CreateSession` 으로 만든 세션을 workspace 의 새 탭 끝에 넣는다
    pub fn place_session(&mut self, session: SessionId, workspace: &str) -> Outcome {
        self.mutate(|s, _, created| {
            if s.pane_of_session(session).is_some() {
                return Ok(());
            }
            let pane = s.alloc_pane(PaneContent::Terminal { session });
            created.push(pane.id);
            let tab = s.alloc_tab(tree::leaf(pane));
            s.insert_tab(workspace, tab, None, true);
            Ok(())
        })
        .expect("넣기는 실패하지 않는다")
    }

    /// 세션이 지워졌다: 그 칸을 뺀다 (탭이 비면 탭도)
    pub fn remove_session(&mut self, session: SessionId) -> Outcome {
        self.mutate(|s, _, _| {
            while let Some(id) = s.pane_of_session(session) {
                s.take_pane(id)?;
            }
            Ok(())
        })
        .expect("빼기는 실패하지 않는다")
    }

    /// workspace 배치를 통째로 지운다 (워크트리를 지웠을 때)
    pub fn remove_workspace(&mut self, workspace: &str) -> Outcome {
        self.mutate(|s, _, _| {
            s.workspaces.remove(workspace);
            Ok(())
        })
        .expect("지우기는 실패하지 않는다")
    }

    /// 데몬이 다시 떠 세션 번호가 바뀌었다: 옛 번호 → 새 번호. 되살리지 못한 세션의 칸은 뺀다
    pub fn remap_sessions(&mut self, map: &BTreeMap<SessionId, SessionId>) -> Outcome {
        self.mutate(|s, _, _| {
            fn walk(n: &mut PaneNode, map: &BTreeMap<SessionId, SessionId>, gone: &mut Vec<PaneId>) {
                match n {
                    PaneNode::Pane { pane } => {
                        if let PaneContent::Terminal { session } = &mut pane.content {
                            match map.get(session) {
                                Some(new) => *session = *new,
                                None => gone.push(pane.id),
                            }
                        }
                    }
                    PaneNode::Split { children, .. } => children.iter_mut().for_each(|c| walk(c, map, gone)),
                }
            }
            let mut gone = Vec::new();
            for l in s.workspaces.values_mut() {
                for t in &mut l.tabs {
                    walk(&mut t.root, map, &mut gone);
                }
            }
            for id in gone {
                s.take_pane(id)?;
            }
            Ok(())
        })
        .expect("바꿔 끼우기는 실패하지 않는다")
    }

    /// 세션 목록과 맞춘다: 없는 세션을 가리키는 칸은 빼고, 칸에 없는 돌고 있는 세션은 새 탭으로 넣는다.
    /// `sessions` 는 (세션, 들어갈 workspace(None 이면 넣지 않는다), 돌고 있는지)
    pub fn reconcile(&mut self, sessions: &[(SessionId, Option<String>, bool)]) -> Outcome {
        self.mutate(|s, _, created| {
            let known: BTreeSet<SessionId> = sessions.iter().map(|(id, _, _)| *id).collect();
            let gone: Vec<PaneId> = s.all_panes().filter(|(_, p)| p.session().is_some_and(|x| !known.contains(&x))).map(|(_, p)| p.id).collect();
            for id in gone {
                s.take_pane(id)?;
            }
            let mut sorted: Vec<_> = sessions.iter().collect();
            sorted.sort_by_key(|(id, _, _)| *id);
            for (id, ws, running) in sorted {
                let Some(ws) = ws else { continue };
                if !*running || s.pane_of_session(*id).is_some() || check_workspace(ws).is_err() {
                    continue;
                }
                let pane = s.alloc_pane(PaneContent::Terminal { session: *id });
                created.push(pane.id);
                let tab = s.alloc_tab(tree::leaf(pane));
                s.insert_tab(ws, tab, None, false);
            }
            Ok(())
        })
        .expect("맞추기는 실패하지 않는다")
    }
}

#[cfg(test)]
mod tests;
