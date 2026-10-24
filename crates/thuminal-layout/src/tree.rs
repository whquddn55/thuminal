//! 칸 트리 하나를 다루는 함수: 찾기, 빼기, 옆에 넣기, 정규화, 화면 위치.

use thuminal_protocol::{Axis, Pane, PaneId, PaneNode, Side};

/// 칸 하나가 차지할 수 있는 가장 작은 비율
pub const MIN_SIZE: f32 = 0.05;

pub fn leaf(pane: Pane) -> PaneNode {
    PaneNode::Pane { pane }
}

/// 트리 순서(왼쪽 → 오른쪽, 위 → 아래)대로 칸
pub fn panes(node: &PaneNode) -> Vec<&Pane> {
    let mut out = Vec::new();
    fn walk<'a>(n: &'a PaneNode, out: &mut Vec<&'a Pane>) {
        match n {
            PaneNode::Pane { pane } => out.push(pane),
            PaneNode::Split { children, .. } => children.iter().for_each(|c| walk(c, out)),
        }
    }
    walk(node, &mut out);
    out
}

pub fn pane_ids(node: &PaneNode) -> Vec<PaneId> {
    panes(node).into_iter().map(|p| p.id).collect()
}

pub fn contains(node: &PaneNode, id: PaneId) -> bool {
    panes(node).iter().any(|p| p.id == id)
}

pub fn find(node: &PaneNode, id: PaneId) -> Option<&Pane> {
    panes(node).into_iter().find(|p| p.id == id)
}

/// 루트부터 children 인덱스로 이 칸까지 가는 길
pub fn path_of(node: &PaneNode, id: PaneId) -> Option<Vec<usize>> {
    match node {
        PaneNode::Pane { pane } => (pane.id == id).then(Vec::new),
        PaneNode::Split { children, .. } => children.iter().enumerate().find_map(|(i, c)| {
            path_of(c, id).map(|mut p| {
                p.insert(0, i);
                p
            })
        }),
    }
}

pub fn node_at_mut<'a>(node: &'a mut PaneNode, path: &[usize]) -> Option<&'a mut PaneNode> {
    match path.split_first() {
        None => Some(node),
        Some((&i, rest)) => match node {
            PaneNode::Split { children, .. } => children.get_mut(i).and_then(|c| node_at_mut(c, rest)),
            PaneNode::Pane { .. } => None,
        },
    }
}

/// 이 칸을 다른 칸(같은 id 가 아니어도 된다)으로 바꿔 끼운다
pub fn replace_pane(node: &mut PaneNode, id: PaneId, with: Pane) -> Result<(), Pane> {
    match node {
        PaneNode::Pane { pane } if pane.id == id => {
            *pane = with;
            Ok(())
        }
        PaneNode::Pane { .. } => Err(with),
        PaneNode::Split { children, .. } => {
            let mut with = with;
            for c in children {
                match replace_pane(c, id, with) {
                    Ok(()) => return Ok(()),
                    Err(w) => with = w,
                }
            }
            Err(with)
        }
    }
}

/// 칸 하나를 빼낸다. 형제들은 원래 비율대로 빈 자리를 나눈다. 트리가 비면 첫 값이 None
pub fn remove_pane(node: PaneNode, id: PaneId) -> (Option<PaneNode>, Option<Pane>) {
    match node {
        PaneNode::Pane { pane } if pane.id == id => (None, Some(pane)),
        n @ PaneNode::Pane { .. } => (Some(n), None),
        PaneNode::Split { axis, children, sizes } => {
            let mut removed = None;
            let mut kept = Vec::with_capacity(children.len());
            let mut kept_sizes = Vec::with_capacity(children.len());
            for (c, s) in children.into_iter().zip(sizes) {
                if removed.is_some() {
                    kept.push(c);
                    kept_sizes.push(s);
                    continue;
                }
                let (rest, r) = remove_pane(c, id);
                removed = r;
                if let Some(rest) = rest {
                    kept.push(rest);
                    kept_sizes.push(s);
                }
            }
            if kept.is_empty() {
                return (None, removed);
            }
            let mut n = PaneNode::Split { axis, children: kept, sizes: kept_sizes };
            normalize(&mut n);
            (Some(n), removed)
        }
    }
}

/// `target` 칸 옆(`side`)에 `node` 를 넣는다. `size` 는 넣는 쪽이 대상 칸 자리에서 가져갈 몫이다.
/// 대상 칸이 없으면 `node` 를 돌려준다
pub fn insert_beside(root: &mut PaneNode, target: PaneId, side: Side, size: f32, node: PaneNode) -> Result<(), PaneNode> {
    let Some(path) = path_of(root, target) else { return Err(node) };
    let at = node_at_mut(root, &path).expect("방금 찾은 길");
    let old = std::mem::replace(at, PaneNode::Split { axis: Axis::Row, children: Vec::new(), sizes: Vec::new() });
    let size = size.clamp(MIN_SIZE, 1.0 - MIN_SIZE);
    let (children, sizes) = if side.before() { (vec![node, old], vec![size, 1.0 - size]) } else { (vec![old, node], vec![1.0 - size, size]) };
    *at = PaneNode::Split { axis: side.axis(), children, sizes };
    normalize(root);
    Ok(())
}

/// 비율을 고친다: 길이가 틀리거나 이상한 값이면 똑같이, 합은 1, 칸마다 [`MIN_SIZE`] 이상
pub fn fix_sizes(sizes: &mut Vec<f32>, n: usize) {
    if n == 0 {
        sizes.clear();
        return;
    }
    if sizes.len() != n || sizes.iter().any(|s| !s.is_finite() || *s <= 0.0) {
        *sizes = vec![1.0 / n as f32; n];
        return;
    }
    if MIN_SIZE * n as f32 > 1.0 {
        *sizes = vec![1.0 / n as f32; n];
        return;
    }
    // 작은 칸은 MIN_SIZE 로 묶고, 나머지가 남는 몫을 원래 비율대로 나눈다
    let mut fixed = vec![false; n];
    loop {
        let fixed_n = fixed.iter().filter(|f| **f).count();
        let free_total = 1.0 - MIN_SIZE * fixed_n as f32;
        let free_sum: f32 = sizes.iter().zip(&fixed).filter(|(_, f)| !**f).map(|(s, _)| *s).sum();
        for (s, f) in sizes.iter_mut().zip(&fixed) {
            if *f {
                *s = MIN_SIZE;
            } else {
                *s *= free_total / free_sum;
            }
        }
        let mut changed = false;
        for (s, f) in sizes.iter_mut().zip(fixed.iter_mut()) {
            if !*f && *s < MIN_SIZE - 1e-6 {
                *s = MIN_SIZE;
                *f = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

/// 정규화: 비율을 고치고, 같은 축 분할이 바로 겹치면 펼쳐 합치고, 자식이 하나면 분할을 없앤다
pub fn normalize(node: &mut PaneNode) {
    let PaneNode::Split { axis, children, sizes } = node else { return };
    fix_sizes(sizes, children.len());
    children.iter_mut().for_each(normalize);
    let mut flat = Vec::with_capacity(children.len());
    let mut flat_sizes = Vec::with_capacity(children.len());
    for (c, s) in children.drain(..).zip(sizes.drain(..)) {
        match c {
            PaneNode::Split { axis: a, children: cc, sizes: cs } if a == *axis => {
                for (c2, s2) in cc.into_iter().zip(cs) {
                    flat.push(c2);
                    flat_sizes.push(s * s2);
                }
            }
            other => {
                flat.push(other);
                flat_sizes.push(s);
            }
        }
    }
    fix_sizes(&mut flat_sizes, flat.len());
    *children = flat;
    *sizes = flat_sizes;
    if children.len() == 1 {
        *node = children.pop().expect("자식 하나");
    }
}

pub fn equalize(node: &mut PaneNode) {
    if let PaneNode::Split { children, sizes, .. } = node {
        *sizes = vec![1.0 / children.len() as f32; children.len()];
        children.iter_mut().for_each(equalize);
    }
}

/// 칸이 든 분할에서 이 칸 몫을 고칠 분할의 길과 그 안의 자식 인덱스.
/// `axis` 를 주면 그 축의 가장 가까운 조상, 아니면 가장 가까운 조상
pub fn resize_target(root: &PaneNode, id: PaneId, axis: Option<Axis>) -> Option<(Vec<usize>, usize)> {
    let path = path_of(root, id)?;
    let mut node = root;
    let mut found = None;
    for (depth, &i) in path.iter().enumerate() {
        let PaneNode::Split { axis: a, children, .. } = node else { break };
        if axis.is_none_or(|want| want == *a) {
            found = Some((path[..depth].to_vec(), i));
        }
        node = &children[i];
    }
    found
}

/// 분할 안 자식 하나의 몫을 정한다. 형제들은 원래 비율대로 나머지를 나눈다
pub fn set_share(sizes: &mut Vec<f32>, index: usize, share: f32) {
    let n = sizes.len();
    if n < 2 || index >= n {
        return;
    }
    let share = share.clamp(MIN_SIZE, 1.0 - MIN_SIZE * (n - 1) as f32);
    let others: f32 = sizes.iter().enumerate().filter(|(i, _)| *i != index).map(|(_, s)| *s).sum();
    for (i, s) in sizes.iter_mut().enumerate() {
        if i == index {
            *s = share;
        } else if others > 0.0 {
            *s = *s / others * (1.0 - share);
        } else {
            *s = (1.0 - share) / (n - 1) as f32;
        }
    }
    fix_sizes(sizes, n);
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// 탭을 한 변 1 짜리 정사각형으로 보고 칸마다 자리
pub fn rects(node: &PaneNode) -> Vec<(PaneId, Rect)> {
    let mut out = Vec::new();
    fn walk(n: &PaneNode, r: Rect, out: &mut Vec<(PaneId, Rect)>) {
        match n {
            PaneNode::Pane { pane } => out.push((pane.id, r)),
            PaneNode::Split { axis, children, sizes } => {
                let mut at = 0.0;
                for (c, s) in children.iter().zip(sizes) {
                    let cr = match axis {
                        Axis::Row => Rect { x: r.x + at * r.w, y: r.y, w: s * r.w, h: r.h },
                        Axis::Column => Rect { x: r.x, y: r.y + at * r.h, w: r.w, h: s * r.h },
                    };
                    at += s;
                    walk(c, cr, out);
                }
            }
        }
    }
    walk(node, Rect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, &mut out);
    out
}

/// `from` 칸 가운데에서 `side` 쪽으로 가장 가까운 칸
pub fn neighbor(node: &PaneNode, from: PaneId, side: Side) -> Option<PaneId> {
    const EPS: f32 = 1e-4;
    let all = rects(node);
    let (_, f) = *all.iter().find(|(id, _)| *id == from)?;
    let (cx, cy) = (f.x + f.w / 2.0, f.y + f.h / 2.0);
    // (그 방향 거리, 가로지르는 축 거리, 트리 순서) 가 작은 것
    let dist_to = |lo: f32, hi: f32, c: f32| if c < lo { lo - c } else if c > hi { c - hi } else { 0.0 };
    all.iter()
        .enumerate()
        .filter(|(_, (id, _))| *id != from)
        .filter_map(|(order, (id, r))| {
            let (gap, cross) = match side {
                Side::Right if r.x >= f.x + f.w - EPS => (r.x - (f.x + f.w), dist_to(r.y, r.y + r.h, cy)),
                Side::Left if r.x + r.w <= f.x + EPS => (f.x - (r.x + r.w), dist_to(r.y, r.y + r.h, cy)),
                Side::Down if r.y >= f.y + f.h - EPS => (r.y - (f.y + f.h), dist_to(r.x, r.x + r.w, cx)),
                Side::Up if r.y + r.h <= f.y + EPS => (f.y - (r.y + r.h), dist_to(r.x, r.x + r.w, cx)),
                _ => return None,
            };
            Some(((gap.max(0.0) / EPS).round() as i64, (cross / EPS).round() as i64, order, *id))
        })
        .min()
        .map(|(_, _, _, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use thuminal_protocol::{PaneContent, SessionId};

    pub fn p(id: u64) -> PaneNode {
        leaf(Pane { id: PaneId(id), content: PaneContent::Terminal { session: SessionId(id) } })
    }

    fn split(axis: Axis, children: Vec<PaneNode>, sizes: Vec<f32>) -> PaneNode {
        PaneNode::Split { axis, children, sizes }
    }

    fn sizes_of(n: &PaneNode) -> Vec<f32> {
        match n {
            PaneNode::Split { sizes, .. } => sizes.clone(),
            _ => vec![],
        }
    }

    fn close(a: &[f32], b: &[f32]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-4)
    }

    #[test]
    fn normalize_merges_same_axis_and_collapses_single_child() {
        let mut n = split(Axis::Row, vec![p(1), split(Axis::Row, vec![p(2), p(3)], vec![0.5, 0.5])], vec![0.5, 0.5]);
        normalize(&mut n);
        assert_eq!(pane_ids(&n), vec![PaneId(1), PaneId(2), PaneId(3)]);
        assert!(close(&sizes_of(&n), &[0.5, 0.25, 0.25]));

        let mut one = split(Axis::Column, vec![split(Axis::Row, vec![p(1), p(2)], vec![0.3, 0.7])], vec![1.0]);
        normalize(&mut one);
        assert!(matches!(&one, PaneNode::Split { axis: Axis::Row, .. }));
        assert!(close(&sizes_of(&one), &[0.3, 0.7]));
    }

    #[test]
    fn fix_sizes_sums_to_one_and_clamps() {
        let mut s = vec![2.0, 2.0];
        fix_sizes(&mut s, 2);
        assert!(close(&s, &[0.5, 0.5]));
        let mut s = vec![0.01, 0.49, 0.5];
        fix_sizes(&mut s, 3);
        assert!((s.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        assert!(s[0] >= MIN_SIZE - 1e-6, "{s:?}");
        let mut s = vec![0.5];
        fix_sizes(&mut s, 3);
        assert!(close(&s, &[1.0 / 3.0; 3]));
    }

    #[test]
    fn insert_beside_takes_share_from_target() {
        let mut n = split(Axis::Row, vec![p(1), p(2)], vec![0.6, 0.4]);
        insert_beside(&mut n, PaneId(2), Side::Right, 0.5, p(3)).unwrap();
        assert_eq!(pane_ids(&n), vec![PaneId(1), PaneId(2), PaneId(3)]);
        assert!(close(&sizes_of(&n), &[0.6, 0.2, 0.2]));
        insert_beside(&mut n, PaneId(1), Side::Up, 0.25, p(4)).unwrap();
        let PaneNode::Split { children, .. } = &n else { panic!() };
        assert!(matches!(&children[0], PaneNode::Split { axis: Axis::Column, sizes, .. } if close(sizes, &[0.25, 0.75])));
        assert_eq!(pane_ids(&n), vec![PaneId(4), PaneId(1), PaneId(2), PaneId(3)]);
        assert!(insert_beside(&mut n, PaneId(9), Side::Left, 0.5, p(5)).is_err());
    }

    #[test]
    fn remove_gives_space_back_and_collapses() {
        let n = split(Axis::Row, vec![p(1), split(Axis::Column, vec![p(2), p(3)], vec![0.5, 0.5])], vec![0.5, 0.5]);
        let (rest, removed) = remove_pane(n, PaneId(3));
        assert_eq!(removed.unwrap().id, PaneId(3));
        let rest = rest.unwrap();
        assert!(matches!(&rest, PaneNode::Split { axis: Axis::Row, children, .. } if children.len() == 2));
        let (rest, _) = remove_pane(rest, PaneId(1));
        assert_eq!(rest.unwrap(), p(2));
        let (rest, removed) = remove_pane(p(2), PaneId(2));
        assert!(rest.is_none() && removed.is_some());
    }

    #[test]
    fn resize_picks_ancestor_by_axis() {
        // row(1, col(2, 3))
        let n = split(Axis::Row, vec![p(1), split(Axis::Column, vec![p(2), p(3)], vec![0.5, 0.5])], vec![0.5, 0.5]);
        assert_eq!(resize_target(&n, PaneId(3), None), Some((vec![1], 1)));
        assert_eq!(resize_target(&n, PaneId(3), Some(Axis::Row)), Some((vec![], 1)));
        assert_eq!(resize_target(&n, PaneId(1), Some(Axis::Column)), None);
        assert_eq!(resize_target(&p(1), PaneId(1), None), None);
        let mut s = vec![0.5, 0.3, 0.2];
        set_share(&mut s, 0, 0.8);
        assert!(close(&s, &[0.8, 0.12, 0.08]));
    }

    #[test]
    fn neighbor_by_geometry() {
        // row(1, col(2, 3)) : 1 은 왼쪽 반, 2 는 오른쪽 위, 3 은 오른쪽 아래
        let n = split(Axis::Row, vec![p(1), split(Axis::Column, vec![p(2), p(3)], vec![0.5, 0.5])], vec![0.5, 0.5]);
        assert_eq!(neighbor(&n, PaneId(3), Side::Up), Some(PaneId(2)));
        assert_eq!(neighbor(&n, PaneId(3), Side::Left), Some(PaneId(1)));
        assert_eq!(neighbor(&n, PaneId(2), Side::Left), Some(PaneId(1)));
        assert_eq!(neighbor(&n, PaneId(1), Side::Right), Some(PaneId(2)));
        assert_eq!(neighbor(&n, PaneId(1), Side::Left), None);
        assert_eq!(neighbor(&n, PaneId(2), Side::Down), Some(PaneId(3)));
        // 가로지르는 축으로 가운데가 걸치는 칸을 고른다: col(row(1:30%, 2:70%), 3) 에서 3 위로 가면 가운데 x=0.5 가 든 2
        let m = split(Axis::Column, vec![split(Axis::Row, vec![p(1), p(2)], vec![0.3, 0.7]), p(3)], vec![0.5, 0.5]);
        assert_eq!(neighbor(&m, PaneId(3), Side::Up), Some(PaneId(2)));
    }
}
