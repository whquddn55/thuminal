use super::*;
use thuminal_protocol::{Axis, Side};

const W: &str = "/wt/a";

/// 세션 번호를 100 부터 하나씩 주는 Spawner. 받은 부탁을 남긴다
#[derive(Default)]
struct Fake {
    next: u64,
    asked: Vec<SpawnRequest>,
    fail_after: Option<usize>,
}

impl Spawner for Fake {
    fn spawn(&mut self, req: SpawnRequest) -> Result<SessionId> {
        if self.fail_after.is_some_and(|n| self.asked.len() >= n) {
            return Err(LayoutError::Spawn("못 띄웠다".into()));
        }
        self.asked.push(req);
        self.next += 1;
        Ok(SessionId(100 + self.next))
    }
}

fn tab_of(s: &Store, ws: &str, i: usize) -> Tab {
    s.get(ws).unwrap().tabs[i].clone()
}

fn ids(t: &Tab) -> Vec<u64> {
    tree::pane_ids(&t.root).into_iter().map(|p| p.0).collect()
}

fn line(t: &Tab) -> String {
    dsl::print(&t.root, &|_| String::new())
}

fn op(s: &mut Store, f: &mut Fake, o: LayoutOp) -> Outcome {
    s.apply(o, f).unwrap()
}

fn new_tab(ws: &str) -> LayoutOp {
    LayoutOp::NewTab { workspace: ws.into(), spawn: Spawn::default(), index: None, focus: true, title: None, doc: None }
}

fn split(target: u64, side: Side) -> LayoutOp {
    LayoutOp::Split { target: PaneRef::Id(PaneId(target)), side, size: None, spawn: Spawn::default(), focus: true, doc: None }
}

fn id(n: u64) -> PaneRef {
    PaneRef::Id(PaneId(n))
}

#[test]
fn new_tab_and_split_make_tree_and_report_changes() {
    let mut s = Store::default();
    let mut f = Fake::default();
    let out = op(&mut s, &mut f, new_tab(W));
    assert_eq!(out.created, vec![PaneId(1)]);
    assert_eq!(out.changed.len(), 1);
    assert_eq!(f.asked[0].workspace, W);
    let out = op(&mut s, &mut f, split(1, Side::Right));
    assert_eq!(out.created, vec![PaneId(2)]);
    // 새 칸은 대상 칸 세션 옆에서 띄운다 (작업 폴더를 물려받게)
    assert_eq!(f.asked[1].near, Some(SessionId(101)));
    op(&mut s, &mut f, split(2, Side::Down));
    let t = tab_of(&s, W, 0);
    assert_eq!(line(&t), "row(p1:50%, col(p2:50%, p3:50%):50%)");
    assert_eq!(t.focused, PaneId(3));
    assert_eq!(s.get(W).unwrap().active_tab, Some(t.id));
    // 같은 축으로 또 나누면 펼쳐 합친다
    op(&mut s, &mut f, split(1, Side::Left));
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p4:25%, p1:25%, col(p2:50%, p3:50%):50%)");
}

#[test]
fn new_tab_takes_title() {
    let mut s = Store::default();
    let mut f = Fake::default();
    let titled = |t: &str| LayoutOp::NewTab { workspace: W.into(), spawn: Spawn::default(), index: None, focus: true, title: Some(t.into()), doc: None };
    op(&mut s, &mut f, titled("feature/x"));
    op(&mut s, &mut f, titled("  "));
    assert_eq!(tab_of(&s, W, 0).title.as_deref(), Some("feature/x"));
    assert_eq!(tab_of(&s, W, 1).title, None, "빈 이름은 붙이지 않는다");
}

#[test]
fn failed_spawn_leaves_layout_unchanged() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W));
    let before = s.clone();
    f.fail_after = Some(1);
    let spec = dsl::parse("row(p1, a, b)").unwrap();
    let r = s.apply(LayoutOp::Apply { workspace: W.into(), tab: None, spec, focus: true }, &mut f);
    assert!(matches!(r, Err(LayoutError::Spawn(_))));
    assert_eq!(s, before);
    assert!(matches!(s.apply(split(9, Side::Right), &mut f), Err(LayoutError::NotFound(m)) if m == "칸을 찾지 못했어요: p9"));
    assert!(matches!(
        s.apply(LayoutOp::Split { target: id(1), side: Side::Right, size: Some(0.99), spawn: Spawn::default(), focus: true, doc: None }, &mut f),
        Err(LayoutError::Invalid(_))
    ));
    assert!(matches!(s.apply(new_tab("nope"), &mut f), Err(LayoutError::Invalid(_))));
}

#[test]
fn resize_and_set_sizes_and_equalize() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W));
    op(&mut s, &mut f, split(1, Side::Right));
    op(&mut s, &mut f, split(2, Side::Down));
    op(&mut s, &mut f, LayoutOp::Resize { target: id(3), size: 0.3, axis: None });
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p1:50%, col(p2:70%, p3:30%):50%)");
    op(&mut s, &mut f, LayoutOp::Resize { target: id(3), size: 0.8, axis: Some(Axis::Row) });
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p1:20%, col(p2:70%, p3:30%):80%)");
    op(&mut s, &mut f, LayoutOp::ResizeBy { target: id(1), delta: 0.1, axis: None });
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p1:30%, col(p2:70%, p3:30%):70%)");
    // 끝까지 줄여도 MIN_SIZE 아래로 가지 않는다
    op(&mut s, &mut f, LayoutOp::ResizeBy { target: id(1), delta: -2.0, axis: None });
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p1:5%, col(p2:70%, p3:30%):95%)");
    let tab = tab_of(&s, W, 0).id;
    op(&mut s, &mut f, LayoutOp::SetSizes { tab, path: vec![1], sizes: vec![1.0, 3.0] });
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p1:5%, col(p2:25%, p3:75%):95%)");
    assert!(matches!(s.apply(LayoutOp::SetSizes { tab, path: vec![0], sizes: vec![0.5, 0.5] }, &mut f), Err(LayoutError::Invalid(_))));
    assert!(matches!(s.apply(LayoutOp::SetSizes { tab, path: vec![], sizes: vec![0.5] }, &mut f), Err(LayoutError::Invalid(_))));
    op(&mut s, &mut f, LayoutOp::Equalize { tab: TabRef::Pane(id(2)) });
    assert_eq!(line(&tab_of(&s, W, 0)), "row(p1:50%, col(p2:50%, p3:50%):50%)");
    // 분할이 없는 칸은 크기를 바꿀 수 없다
    op(&mut s, &mut f, new_tab(W));
    assert!(matches!(s.apply(LayoutOp::Resize { target: id(4), size: 0.5, axis: None }, &mut f), Err(LayoutError::Invalid(_))));
}

#[test]
fn focus_by_direction_cycle_and_refs() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W));
    op(&mut s, &mut f, split(1, Side::Right));
    op(&mut s, &mut f, split(2, Side::Down));
    // row(p1, col(p2, p3))
    op(&mut s, &mut f, LayoutOp::FocusDir { from: id(3), side: Side::Up });
    assert_eq!(tab_of(&s, W, 0).focused, PaneId(2));
    op(&mut s, &mut f, LayoutOp::FocusDir { from: PaneRef::Focused(W.into()), side: Side::Left });
    assert_eq!(tab_of(&s, W, 0).focused, PaneId(1));
    // 끝이면 그대로
    let out = op(&mut s, &mut f, LayoutOp::FocusDir { from: id(1), side: Side::Left });
    assert!(out.changed.is_empty());
    assert_eq!(out.layouts.len(), 1, "가리킨 workspace 는 응답에 넣는다");
    op(&mut s, &mut f, LayoutOp::FocusCycle { from: id(1), delta: -1 });
    assert_eq!(tab_of(&s, W, 0).focused, PaneId(3));
    op(&mut s, &mut f, LayoutOp::FocusCycle { from: PaneRef::Session(SessionId(103)), delta: 1 });
    assert_eq!(tab_of(&s, W, 0).focused, PaneId(1));
    assert!(matches!(s.apply(LayoutOp::Focus { target: PaneRef::Session(SessionId(1)) }, &mut f), Err(LayoutError::NotFound(_))));
}

#[test]
fn zoom_toggles_and_clears_on_split() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W));
    op(&mut s, &mut f, split(1, Side::Right));
    op(&mut s, &mut f, LayoutOp::Zoom { target: id(1), on: None });
    let t = tab_of(&s, W, 0);
    assert_eq!((t.zoomed, t.focused), (Some(PaneId(1)), PaneId(1)));
    op(&mut s, &mut f, LayoutOp::Zoom { target: id(1), on: None });
    assert_eq!(tab_of(&s, W, 0).zoomed, None);
    op(&mut s, &mut f, LayoutOp::Zoom { target: id(2), on: Some(true) });
    op(&mut s, &mut f, LayoutOp::Focus { target: id(1) });
    assert_eq!(tab_of(&s, W, 0).zoomed, None, "다른 칸으로 가면 펼침을 푼다");
    op(&mut s, &mut f, LayoutOp::Zoom { target: id(2), on: Some(true) });
    op(&mut s, &mut f, split(1, Side::Down));
    assert_eq!(tab_of(&s, W, 0).zoomed, None);
}

#[test]
fn move_swap_break_join_and_move_tab() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W)); // t1: p1
    op(&mut s, &mut f, split(1, Side::Right)); // t1: p1 p2
    op(&mut s, &mut f, new_tab(W)); // t2: p3
    // 다른 탭으로 옮기기
    op(&mut s, &mut f, LayoutOp::MovePane { pane: id(2), to: id(3), side: Side::Down });
    assert_eq!(ids(&tab_of(&s, W, 0)), vec![1]);
    assert_eq!(line(&tab_of(&s, W, 1)), "col(p3:50%, p2:50%)");
    assert!(matches!(s.apply(LayoutOp::MovePane { pane: id(3), to: id(3), side: Side::Left }, &mut f), Err(LayoutError::Invalid(_))));
    // 마지막 칸을 옮기면 원래 탭이 없어진다
    op(&mut s, &mut f, LayoutOp::MovePane { pane: id(1), to: id(3), side: Side::Left });
    assert_eq!(s.get(W).unwrap().tabs.len(), 1);
    assert_eq!(line(&tab_of(&s, W, 0)), "col(row(p1:50%, p3:50%):50%, p2:50%)");
    op(&mut s, &mut f, LayoutOp::Swap { a: id(1), b: id(2) });
    assert_eq!(line(&tab_of(&s, W, 0)), "col(row(p2:50%, p3:50%):50%, p1:50%)");
    // 떼어 내기 (다른 workspace 로) → 세션 workspace 가 바뀐다
    let out = op(&mut s, &mut f, LayoutOp::BreakPane { pane: id(1), workspace: Some("other".into()), index: None });
    assert_eq!(out.moved, vec![(SessionId(101), "other".to_string())]);
    assert_eq!(s.get("other").unwrap().tabs.len(), 1);
    // 탭 합치기
    let other_tab = tab_of(&s, "other", 0).id;
    op(&mut s, &mut f, LayoutOp::JoinTab { tab: TabRef::Id(other_tab), to: id(2), side: Side::Up });
    assert!(s.get("other").is_none(), "빈 workspace 는 지운다");
    assert_eq!(line(&tab_of(&s, W, 0)), "row(col(p1:50%, p2:50%):50%, p3:50%)");
    assert!(matches!(
        s.apply(LayoutOp::JoinTab { tab: TabRef::Pane(id(3)), to: id(2), side: Side::Up }, &mut f),
        Err(LayoutError::Invalid(_))
    ));
    // 탭 순서 바꾸기: 활성 탭은 그대로
    op(&mut s, &mut f, new_tab(W));
    op(&mut s, &mut f, new_tab(W));
    let tabs: Vec<TabId> = s.get(W).unwrap().tabs.iter().map(|t| t.id).collect();
    let active = s.get(W).unwrap().active_tab;
    op(&mut s, &mut f, LayoutOp::MoveTab { tab: TabRef::Id(tabs[2]), workspace: None, index: 0 });
    let after: Vec<TabId> = s.get(W).unwrap().tabs.iter().map(|t| t.id).collect();
    assert_eq!(after, vec![tabs[2], tabs[0], tabs[1]]);
    assert_eq!(s.get(W).unwrap().active_tab, active);
    op(&mut s, &mut f, LayoutOp::MoveTab { tab: TabRef::Id(tabs[1]), workspace: Some("floating".into()), index: 5 });
    assert_eq!(s.get("floating").unwrap().active_tab, Some(tabs[1]));
}

#[test]
fn break_single_pane_tab_keeps_tab_and_close_reports_sessions() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W));
    op(&mut s, &mut f, new_tab(W));
    let t1 = tab_of(&s, W, 0).id;
    op(&mut s, &mut f, LayoutOp::RenameTab { tab: TabRef::Id(t1), title: Some("서버".into()) });
    op(&mut s, &mut f, LayoutOp::BreakPane { pane: id(1), workspace: None, index: None });
    let last = s.get(W).unwrap().tabs.last().unwrap().clone();
    assert_eq!((last.id, last.title.as_deref()), (t1, Some("서버")));
    op(&mut s, &mut f, split(2, Side::Right));
    let out = op(&mut s, &mut f, LayoutOp::ClosePane { target: id(3) });
    assert_eq!(out.closed, vec![SessionId(103)]);
    let out = op(&mut s, &mut f, LayoutOp::CloseTab { tab: TabRef::Pane(id(1)) });
    assert_eq!(out.closed, vec![SessionId(101)]);
    let out = op(&mut s, &mut f, LayoutOp::CloseTab { tab: TabRef::Active(W.into()) });
    assert_eq!(out.closed, vec![SessionId(102)]);
    assert_eq!(out.removed, vec![W.to_string()]);
    assert!(s.all().is_empty());
}

#[test]
fn closing_focused_pane_moves_focus_to_next() {
    let mut s = Store::default();
    let mut f = Fake::default();
    op(&mut s, &mut f, new_tab(W));
    op(&mut s, &mut f, split(1, Side::Right));
    op(&mut s, &mut f, split(2, Side::Right));
    op(&mut s, &mut f, LayoutOp::Focus { target: id(2) });
    op(&mut s, &mut f, LayoutOp::ClosePane { target: id(2) });
    assert_eq!(tab_of(&s, W, 0).focused, PaneId(3));
}

#[test]
fn open_doc_reuses_same_doc() {
    let mut s = Store::default();
    let mut f = Fake::default();
    let doc: BTreeMap<String, String> = [("kind".to_string(), "diff".to_string()), ("file".to_string(), "a.rs".to_string())].into();
    let out = op(&mut s, &mut f, LayoutOp::OpenDoc { workspace: W.into(), doc: doc.clone() });
    assert_eq!(out.created, vec![PaneId(1)]);
    op(&mut s, &mut f, new_tab(W));
    let out = op(&mut s, &mut f, LayoutOp::OpenDoc { workspace: W.into(), doc });
    assert!(out.created.is_empty());
    assert_eq!(s.get(W).unwrap().tabs.len(), 2);
    assert_eq!(s.get(W).unwrap().active_tab, Some(tab_of(&s, W, 0).id));
    assert!(f.asked.len() == 1, "문서 칸은 세션을 만들지 않는다");
}

#[test]
fn apply_builds_new_tab_and_rearranges_existing_one() {
    let mut s = Store::default();
    let mut f = Fake::default();
    let spec = dsl::parse(r#"row(claude, col(zsh, "npm run dev"):40%)"#).unwrap();
    let out = op(&mut s, &mut f, LayoutOp::Apply { workspace: W.into(), tab: None, spec, focus: true });
    assert_eq!(out.created, vec![PaneId(1), PaneId(2), PaneId(3)]);
    assert_eq!(f.asked.iter().map(|r| r.spawn.input.clone()).collect::<Vec<_>>(), vec![Some("claude".into()), None, Some("npm run dev".into())]);
    let t = tab_of(&s, W, 0);
    assert_eq!(line(&t), "row(p1:60%, col(p2:50%, p3:50%):40%)");

    // show 출력을 그대로 다시 넣으면 같은 배치다
    let shown = dsl::print(&t.root, &|p| format!("s{}", p.session().unwrap()));
    let out = op(&mut s, &mut f, LayoutOp::Apply { workspace: W.into(), tab: Some(TabRef::Id(t.id)), spec: dsl::parse(&shown).unwrap(), focus: true });
    assert!(out.changed.is_empty(), "{shown}");
    assert!(out.created.is_empty());

    // 옛 칸 p2 는 spec 에 없으니 새 탭으로 떼어 낸다. 다른 탭의 칸 p4 를 끌어온다
    op(&mut s, &mut f, new_tab(W)); // t2: p4
    let spec = dsl::parse("col(p3, p4:30%, p1)").unwrap();
    let out = op(&mut s, &mut f, LayoutOp::Apply { workspace: W.into(), tab: Some(TabRef::Id(t.id)), spec, focus: true });
    assert!(out.closed.is_empty(), "apply 는 칸을 닫지 않는다");
    let l = s.get(W).unwrap();
    assert_eq!(l.tabs.len(), 2, "p4 가 빠진 탭은 없어지고 p2 탭이 생긴다");
    assert_eq!(line(&l.tabs[0]), "col(p3:35%, p4:30%, p1:35%)");
    assert_eq!(ids(&l.tabs[1]), vec![2]);
    assert_eq!(l.active_tab, Some(t.id));

    // 같은 칸 두 번, 없는 칸은 거절하고 세션을 만들지 않는다
    let asked = f.asked.len();
    for bad in ["row(p1, p1)", "row(zsh, p99)"] {
        let r = s.apply(LayoutOp::Apply { workspace: W.into(), tab: None, spec: dsl::parse(bad).unwrap(), focus: true }, &mut f);
        assert!(r.is_err(), "{bad}");
    }
    assert_eq!(f.asked.len(), asked);
}

#[test]
fn session_side_changes_place_remove_remap_reconcile() {
    let mut s = Store::default();
    let out = s.place_session(SessionId(5), W);
    assert_eq!(out.created, vec![PaneId(1)]);
    assert!(s.place_session(SessionId(5), W).changed.is_empty(), "이미 있으면 그대로");
    s.place_session(SessionId(6), "other");
    let mut f = Fake::default();
    op(&mut s, &mut f, split(1, Side::Right)); // 세션 101
    // 데몬이 다시 떴다: 5 → 1, 101 → 2, 6 은 되살리지 못했다
    let out = s.remap_sessions(&[(SessionId(5), SessionId(1)), (SessionId(101), SessionId(2))].into());
    assert_eq!(out.removed, vec!["other".to_string()]);
    let t = tab_of(&s, W, 0);
    let sessions: Vec<_> = tree::panes(&t.root).iter().map(|p| p.session().unwrap()).collect();
    assert_eq!(sessions, vec![SessionId(1), SessionId(2)]);
    // 맞추기: 3 은 칸이 없으니 새 탭, 2 는 목록에 없으니 뺀다, 끝난 세션 4 는 넣지 않는다, 7 은 layout=none
    let out = s.reconcile(&[(SessionId(1), Some(W.into()), true), (SessionId(3), Some("floating".into()), true), (SessionId(4), Some(W.into()), false), (SessionId(7), None, true)]);
    assert_eq!(out.created.len(), 1);
    assert_eq!(ids(&tab_of(&s, W, 0)).len(), 1);
    assert!(s.get("floating").is_some());
    let out = s.remove_session(SessionId(1));
    assert_eq!(out.removed, vec![W.to_string()]);
    let out = s.remove_workspace("floating");
    assert_eq!(out.removed, vec!["floating".to_string()]);
    assert!(s.all().is_empty());
}

#[test]
fn ids_keep_counting_after_save_and_load() {
    let mut s = Store::default();
    s.place_session(SessionId(1), W);
    s.remove_session(SessionId(1));
    let saved = serde_json::to_string(&s).unwrap();
    let mut back: Store = serde_json::from_str(&saved).unwrap();
    let out = back.place_session(SessionId(2), W);
    assert_eq!(out.created, vec![PaneId(2)]);
    assert_eq!(back.get(W).unwrap().tabs[0].id, TabId(2));
}

#[test]
fn labels_pick_workspace() {
    let l = |kv: &[(&str, &str)]| kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
    assert_eq!(workspace_for_labels(&l(&[("worktree", "/a")])), Some("/a".into()));
    assert_eq!(workspace_for_labels(&l(&[("worktree", "/a"), ("floating", "1")])), Some("floating".into()));
    assert_eq!(workspace_for_labels(&l(&[])), Some("other".into()));
    assert_eq!(workspace_for_labels(&l(&[("layout", "none"), ("worktree", "/a")])), None);
}

#[test]
fn browser_doc_tab_split_and_update() {
    let (mut s, mut f) = (Store::default(), Fake::default());
    let browser = |url: &str| BTreeMap::from([("kind".to_string(), "browser".to_string()), ("url".to_string(), url.to_string())]);
    // 같은 주소라도 new_tab 은 새로 연다 (open_doc 과 다르다)
    let a = op(&mut s, &mut f, LayoutOp::NewTab { workspace: W.into(), spawn: Spawn::default(), index: None, focus: true, title: None, doc: Some(browser("http://localhost:3000")) });
    let b = op(&mut s, &mut f, LayoutOp::NewTab { workspace: W.into(), spawn: Spawn::default(), index: None, focus: true, title: None, doc: Some(browser("http://localhost:3000")) });
    assert_ne!(a.created, b.created);
    assert!(f.asked.is_empty(), "브라우저 칸은 세션을 띄우지 않는다");
    let p = b.created[0];
    let c = op(&mut s, &mut f, LayoutOp::Split { target: PaneRef::Id(p), side: Side::Right, size: None, spawn: Spawn::default(), focus: true, doc: Some(browser("https://example.com")) });
    assert!(f.asked.is_empty());
    op(&mut s, &mut f, LayoutOp::UpdateDoc { pane: PaneRef::Id(c.created[0]), doc: browser("https://example.com/next") });
    let l = s.get(W).unwrap();
    let urls: Vec<String> = l.tabs.iter().flat_map(|t| tree::panes(&t.root)).filter_map(|p| match &p.content {
        PaneContent::Doc { doc } => doc.get("url").cloned(),
        _ => None,
    }).collect();
    assert!(urls.contains(&"https://example.com/next".to_string()), "{urls:?}");
}
