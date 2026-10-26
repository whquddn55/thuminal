//! 저장소 목록과 워크트리 관리.
//!
//! 버전 관리 도구는 [`Vcs`] 로만 안다 (지금 구현은 `thuminal-vcs-git`).
//! 등록한 저장소 목록과 사이드바 워크스페이스(프로젝트 묶음, `groups`)는 데이터 폴더의 `workspace.json` 에 남긴다.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
/// 어댑터가 쓰는 프로토콜 타입 (어댑터가 프로토콜 크레이트에 직접 기대지 않게 다시 내보낸다)
pub use thuminal_protocol as protocol;
use thuminal_protocol::{BranchList, DEFAULT_GROUP, DirEntry, FileContent, GitStatus, LineCount, RepoGroup, RepoInfo, SearchHit, WorktreeInfo};
use tracing::info;

#[derive(Debug, thiserror::Error)]
pub enum VcsError {
    #[error("git 저장소가 아니다: {0}")]
    NotARepo(String),
    #[error("{0}")]
    Command(String),
    /// 합치지 않은 커밋이 있어 `force` 없이는 브랜치를 지우지 않았다
    #[error("브랜치 {0} 에 합치지 않은 커밋이 있다")]
    NotMerged(String),
}

/// 버전 관리 도구 인터페이스. 경로는 모두 절대 경로다.
pub trait Vcs: Send + Sync {
    /// 경로가 든 저장소의 메인 워크트리 경로 (워크트리 안이어도 메인을 돌려준다)
    fn main_worktree(&self, path: &Path) -> Result<PathBuf, VcsError>;
    /// 경로가 든 워크트리의 맨 위 폴더
    fn worktree_root(&self, path: &Path) -> Result<PathBuf, VcsError>;
    fn list_worktrees(&self, repo: &Path) -> Result<Vec<VcsWorktree>, VcsError>;
    /// 새 브랜치 `branch` 를 `base`(없으면 HEAD) 에서 만들어 `path` 에 워크트리로 꺼낸다
    fn create_worktree(&self, repo: &Path, path: &Path, branch: &str, base: Option<&str>) -> Result<(), VcsError>;
    /// `force` 면 바뀐 파일이 있어도 지운다
    fn remove_worktree(&self, repo: &Path, path: &Path, force: bool) -> Result<(), VcsError>;
    /// `force` 가 아니면 합친 브랜치만 지우고, 합치지 않은 커밋이 있으면 [`VcsError::NotMerged`]
    fn delete_branch(&self, repo: &Path, branch: &str, force: bool) -> Result<(), VcsError>;
    fn status(&self, worktree: &Path) -> Result<GitStatus, VcsError>;
    /// 파일 하나의 unified diff. `staged` 면 스테이지된 변경, 아니면 작업 폴더 변경 (새 파일 포함)
    fn diff(&self, worktree: &Path, file: &str, staged: bool) -> Result<String, VcsError>;
    fn stage(&self, worktree: &Path, files: &[String]) -> Result<(), VcsError>;
    fn unstage(&self, worktree: &Path, files: &[String]) -> Result<(), VcsError>;
    /// 작업 폴더 변경을 버린다. 새(추적하지 않는) 파일은 지운다
    fn discard(&self, worktree: &Path, files: &[String]) -> Result<(), VcsError>;
    /// 커밋하고 커밋 id 를 돌려준다. `all` 이면 추적하는 파일의 변경을 모두 담는다
    fn commit(&self, worktree: &Path, message: &str, all: bool) -> Result<String, VcsError>;
    /// 지금 브랜치를 올린다. 업스트림이 없으면 origin 에 같은 이름으로 만든다
    fn push(&self, worktree: &Path) -> Result<String, VcsError>;
    fn branches(&self, repo: &Path) -> Result<BranchList, VcsError>;
    /// 워크트리 기준 상대 경로들 가운데 git 이 무시하는 것
    fn ignored(&self, worktree: &Path, paths: &[String]) -> Result<Vec<String>, VcsError>;
    /// 파일 내용에서 글을 찾는다. `max` 개를 넘으면 앞부분과 함께 true(잘렸다)를 돌려준다
    fn grep(&self, worktree: &Path, query: &str, case_sensitive: bool, max: usize) -> Result<(Vec<SearchHit>, bool), VcsError>;
    /// 추적하는 파일과 무시하지 않는 새 파일의 경로
    fn list_files(&self, worktree: &Path, max: usize) -> Result<(Vec<String>, bool), VcsError>;
    /// 작업 폴더·스테이지 변경의 파일별 줄 수
    fn line_counts(&self, worktree: &Path) -> Result<Vec<LineCount>, VcsError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VcsWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("등록하지 않은 저장소: {0}")]
    UnknownRepo(String),
    #[error(transparent)]
    Vcs(#[from] VcsError),
    #[error("목록 파일을 쓰지 못했다: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    repos: Vec<SavedRepo>,
    /// 워크트리 경로 → 사용자가 붙인 이름, 고정
    #[serde(default)]
    worktrees: std::collections::BTreeMap<PathBuf, WorktreeMeta>,
    /// 사이드바 워크스페이스 (옛 파일에는 없다. 없으면 기본 하나에 모든 프로젝트)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    groups: Vec<RepoGroup>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorktreeMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pinned: bool,
    /// 부모 워크트리 (하위 워크트리면)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent: Option<PathBuf>,
}

impl WorktreeMeta {
    fn is_empty(&self) -> bool {
        self.name.is_none() && !self.pinned && self.parent.is_none()
    }
}

/// 파일 보기로 읽는 최대 크기
const MAX_READ: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedRepo {
    path: PathBuf,
}

pub struct Workspace {
    vcs: Arc<dyn Vcs>,
    file: PathBuf,
    repos: Mutex<Vec<SavedRepo>>,
    meta: Mutex<std::collections::BTreeMap<PathBuf, WorktreeMeta>>,
    /// 남긴 그대로의 워크스페이스. 읽을 때마다 [`normalize_groups`] 로 지금 저장소 목록에 맞춘다
    groups: Mutex<Vec<RepoGroup>>,
}

/// 기본 워크스페이스 이름 (사용자가 바꿀 수 있다)
const DEFAULT_GROUP_NAME: &str = "기본";

/// 워크스페이스 이름 최대 글자 수
const MAX_GROUP_NAME: usize = 80;

/// 워크스페이스 목록을 저장소 목록에 맞춘다: 같은 id 는 앞 것만, 없는 저장소와 두 번째로 나온 저장소는 빼고,
/// 기본 워크스페이스가 없으면 맨 앞에 넣고, 어디에도 없는 저장소는 등록한 차례대로 기본 끝에 붙인다
fn normalize_groups(groups: &[RepoGroup], repos: &[String]) -> Vec<RepoGroup> {
    let mut ids = std::collections::HashSet::new();
    let mut placed = std::collections::HashSet::new();
    let mut out: Vec<RepoGroup> = groups
        .iter()
        .filter(|g| ids.insert(g.id.as_str()))
        .map(|g| RepoGroup {
            id: g.id.clone(),
            name: g.name.clone(),
            repos: g.repos.iter().filter(|r| repos.contains(r) && placed.insert(r.as_str())).cloned().collect(),
        })
        .collect();
    if !out.iter().any(|g| g.id == DEFAULT_GROUP) {
        out.insert(0, RepoGroup { id: DEFAULT_GROUP.into(), name: DEFAULT_GROUP_NAME.into(), repos: Vec::new() });
    }
    let rest: Vec<String> = repos.iter().filter(|r| !placed.contains(r.as_str())).cloned().collect();
    out.iter_mut().find(|g| g.id == DEFAULT_GROUP).expect("기본 워크스페이스를 넣었다").repos.extend(rest);
    out
}

/// 경로로 만든 짧은 id (FNV-1a 64비트의 앞 8자리)
fn repo_id(path: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_string_lossy().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:08x}", h >> 32)
}

/// 브랜치 이름을 폴더 이름에 쓸 수 있게 바꾼다 (`feature/x` → `feature-x`)
pub fn branch_slug(branch: &str) -> String {
    branch.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect()
}

impl Workspace {
    pub fn open(vcs: Arc<dyn Vcs>, home: &Path) -> Self {
        let file = home.join("workspace.json");
        let saved: Saved = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { vcs, file, repos: Mutex::new(saved.repos), meta: Mutex::new(saved.worktrees), groups: Mutex::new(saved.groups) }
    }

    fn save(&self, repos: &[SavedRepo]) -> Result<(), WorkspaceError> {
        let tmp = self.file.with_extension("json.tmp");
        let worktrees = self.meta.lock().unwrap().clone();
        let groups = self.groups.lock().unwrap().clone();
        std::fs::write(&tmp, serde_json::to_vec_pretty(&Saved { repos: repos.to_vec(), worktrees, groups }).unwrap())?;
        std::fs::rename(tmp, &self.file)?;
        Ok(())
    }

    fn info(path: &Path) -> RepoInfo {
        RepoInfo {
            id: repo_id(path),
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
        }
    }

    pub fn repos(&self) -> Vec<RepoInfo> {
        self.repos.lock().unwrap().iter().map(|r| Self::info(&r.path)).collect()
    }

    fn repo_path(&self, id: &str) -> Result<PathBuf, WorkspaceError> {
        self.repos
            .lock()
            .unwrap()
            .iter()
            .find(|r| repo_id(&r.path) == id)
            .map(|r| r.path.clone())
            .ok_or_else(|| WorkspaceError::UnknownRepo(id.into()))
    }

    pub fn add_repo(&self, path: &Path) -> Result<RepoInfo, WorkspaceError> {
        // 화면에서 `~/…` 로 적어도 받는다
        let expanded;
        let path = match (path.strip_prefix("~"), std::env::var_os("HOME")) {
            (Ok(rest), Some(home)) => {
                expanded = PathBuf::from(home).join(rest);
                expanded.as_path()
            }
            _ => path,
        };
        let main = self.vcs.main_worktree(path)?;
        let mut repos = self.repos.lock().unwrap();
        if !repos.iter().any(|r| r.path == main) {
            repos.push(SavedRepo { path: main.clone() });
            self.save(&repos)?;
            info!(event = "repo_added", path = %main.display());
        }
        Ok(Self::info(&main))
    }

    pub fn remove_repo(&self, id: &str) -> Result<(), WorkspaceError> {
        let mut repos = self.repos.lock().unwrap();
        let before = repos.len();
        repos.retain(|r| repo_id(&r.path) != id);
        if repos.len() == before {
            return Err(WorkspaceError::UnknownRepo(id.into()));
        }
        // 워크스페이스에서도 뺀다 (다시 등록하면 옛 워크스페이스가 아니라 기본에 든다)
        for g in self.groups.lock().unwrap().iter_mut() {
            g.repos.retain(|r| r != id);
        }
        self.save(&repos)?;
        Ok(())
    }

    fn repo_ids(&self) -> Vec<String> {
        self.repos.lock().unwrap().iter().map(|r| repo_id(&r.path)).collect()
    }

    /// 사이드바 워크스페이스. 기본 워크스페이스가 늘 들어 있고, 등록한 프로젝트는 저마다 꼭 한 워크스페이스에 든다
    pub fn groups(&self) -> Vec<RepoGroup> {
        let ids = self.repo_ids();
        normalize_groups(&self.groups.lock().unwrap(), &ids)
    }

    /// 워크스페이스 목록을 통째로 바꾼다. id 가 빈 것은 새 id 를 붙이고, 빠진 기본 워크스페이스는 다시 넣고,
    /// 어디에도 없는 프로젝트는 기본으로 보낸다 (그래서 워크스페이스를 지우면 든 프로젝트가 기본으로 간다).
    /// 이름이 비었거나 id 가 겹치면 거절한다. 맞춘 목록을 돌려준다
    pub fn set_groups(&self, groups: Vec<RepoGroup>) -> Result<Vec<RepoGroup>, WorkspaceError> {
        let mut seen = std::collections::HashSet::new();
        for g in &groups {
            if g.name.trim().is_empty() {
                return Err(WorkspaceError::Invalid("워크스페이스 이름이 비었다".into()));
            }
            if !g.id.is_empty() && !seen.insert(g.id.as_str()) {
                return Err(WorkspaceError::Invalid(format!("워크스페이스 id 가 겹친다: {}", g.id)));
            }
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let mut next = now;
        let mut used: std::collections::HashSet<String> = groups.iter().map(|g| g.id.clone()).collect();
        let groups: Vec<RepoGroup> = groups
            .into_iter()
            .map(|g| {
                let id = if g.id.is_empty() {
                    let mut id = format!("g{next:x}");
                    while used.contains(&id) {
                        next += 1;
                        id = format!("g{next:x}");
                    }
                    used.insert(id.clone());
                    id
                } else {
                    g.id
                };
                RepoGroup { id, name: g.name.trim().chars().take(MAX_GROUP_NAME).collect(), repos: g.repos }
            })
            .collect();
        let repos = self.repos.lock().unwrap().clone();
        let ids: Vec<String> = repos.iter().map(|r| repo_id(&r.path)).collect();
        let normalized = normalize_groups(&groups, &ids);
        *self.groups.lock().unwrap() = normalized.clone();
        self.save(&repos)?;
        info!(event = "groups_set", groups = normalized.len());
        Ok(normalized)
    }

    pub fn worktrees(&self, repo: Option<&str>) -> Result<Vec<WorktreeInfo>, WorkspaceError> {
        let repos: Vec<PathBuf> = match repo {
            Some(id) => vec![self.repo_path(id)?],
            None => self.repos.lock().unwrap().iter().map(|r| r.path.clone()).collect(),
        };
        let mut out = Vec::new();
        for path in repos {
            let id = repo_id(&path);
            let meta = self.meta.lock().unwrap();
            for w in self.vcs.list_worktrees(&path)? {
                let m = meta.get(&w.path).cloned().unwrap_or_default();
                out.push(WorktreeInfo {
                    repo: id.clone(),
                    is_main: w.path == path,
                    path: w.path.to_string_lossy().into_owned(),
                    branch: w.branch,
                    head: w.head,
                    name: m.name,
                    pinned: m.pinned,
                    parent: m.parent.map(|p| p.to_string_lossy().into_owned()),
                });
            }
        }
        Ok(out)
    }

    /// 저장소 옆 폴더 `<저장소>-thm-wt-<브랜치>` 에 새 워크트리를 만든다
    pub fn create_worktree(&self, repo: &str, branch: &str, base: Option<&str>, name: Option<&str>, parent: Option<&str>) -> Result<WorktreeInfo, WorkspaceError> {
        if branch.trim().is_empty() {
            return Err(WorkspaceError::Invalid("브랜치 이름이 비었다".into()));
        }
        let root = self.repo_path(repo)?;
        let folder = format!("{}-thm-wt-{}", root.file_name().unwrap_or_default().to_string_lossy(), branch_slug(branch));
        let path = root.parent().unwrap_or(&root).join(folder);
        if path.exists() {
            return Err(WorkspaceError::Invalid(format!("이미 있는 폴더: {}", path.display())));
        }
        // 부모는 만들기 전에 확인한다 (등록한 워크트리여야 한다)
        let parent = parent.filter(|p| !p.is_empty()).map(|p| self.known_worktree(p)).transpose()?;
        self.vcs.create_worktree(&root, &path, branch, base)?;
        info!(event = "worktree_created", repo, branch, path = %path.display(), parent = ?parent);
        let name = name.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        if name.is_some() || parent.is_some() {
            let canonical = std::fs::canonicalize(&path).unwrap_or(path.clone());
            self.meta.lock().unwrap().insert(canonical, WorktreeMeta { name, pinned: false, parent });
            let repos = self.repos.lock().unwrap().clone();
            self.save(&repos)?;
        }
        let path_s = path.to_string_lossy().into_owned();
        self.worktrees(Some(repo))?
            .into_iter()
            .find(|w| w.path == path_s)
            .ok_or_else(|| WorkspaceError::Invalid("만든 워크트리를 목록에서 찾지 못했다".into()))
    }

    /// 워크트리를 지운다. `force` 는 워크트리에만(바뀐 파일이 있어도), `force_branch` 는 브랜치에만(합치지 않았어도) 쓴다.
    /// 브랜치를 지우지 못해도 워크트리는 지운 채로 두고, 남긴 까닭을 글로 돌려준다 (알릴 것이 없으면 빈 글)
    pub fn remove_worktree(&self, repo: &str, path: &Path, force: bool, delete_branch: bool, force_branch: bool) -> Result<String, WorkspaceError> {
        let root = self.repo_path(repo)?;
        if path == root {
            return Err(WorkspaceError::Invalid("메인 워크트리는 지우지 않는다".into()));
        }
        let path_s = path.to_string_lossy();
        let branch = self.worktrees(Some(repo))?.into_iter().find(|w| w.path == path_s).and_then(|w| w.branch);
        self.vcs.remove_worktree(&root, path, force)?;
        {
            // 지운 워크트리의 하위 워크트리는 그 부모 밑으로 옮긴다 (없으면 맨 위로)
            let mut meta = self.meta.lock().unwrap();
            let grand = meta.remove(path).and_then(|m| m.parent);
            for m in meta.values_mut().filter(|m| m.parent.as_deref() == Some(path)) {
                m.parent = grand.clone();
            }
            meta.retain(|_, m| !m.is_empty());
        }
        let repos = self.repos.lock().unwrap().clone();
        self.save(&repos)?;
        let mut note = String::new();
        if let (true, Some(b)) = (delete_branch, branch) {
            match self.vcs.delete_branch(&root, &b, force_branch) {
                Ok(()) => {}
                Err(VcsError::NotMerged(_)) => note = format!("브랜치 {b} 는 합치지 않은 커밋이 있어 남겼다"),
                Err(e) => note = format!("브랜치 {b} 는 지우지 못해 남겼다: {e}"),
            }
        }
        info!(event = "worktree_removed", repo, path = %path.display(), delete_branch, force_branch, branch_kept = !note.is_empty());
        Ok(note)
    }

    /// 폴더가 저장소면 등록하고, 아니면 바로 아래 폴더들에서 저장소를 찾아 모두 등록한다
    pub fn add_repos(&self, path: &Path) -> Result<Vec<RepoInfo>, WorkspaceError> {
        match self.add_repo(path) {
            Ok(r) => return Ok(vec![r]),
            // 저장소인데 다른 까닭으로 못 읽었으면(소유자 검사 등) 그 까닭을 알린다
            Err(WorkspaceError::Vcs(VcsError::NotARepo(_))) => {}
            Err(e) => return Err(e),
        }
        let entries = std::fs::read_dir(path).map_err(|e| WorkspaceError::Invalid(format!("폴더를 읽지 못했다: {} ({e})", path.display())))?;
        let mut dirs: Vec<_> = entries.flatten().map(|e| e.path()).filter(|p| p.join(".git").exists()).collect();
        dirs.sort();
        let mut found: Vec<RepoInfo> = Vec::new();
        let mut first_error = None;
        for d in dirs {
            match self.add_repo(&d) {
                // 워크트리 폴더도 메인 저장소로 풀리므로 같은 저장소가 여러 번 나온다
                Ok(r) if !found.iter().any(|f| f.path == r.path) => found.push(r),
                Ok(_) => {}
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        if found.is_empty() {
            return Err(first_error.unwrap_or_else(|| WorkspaceError::Invalid(format!("git 저장소를 찾지 못했다: {}", path.display()))));
        }
        Ok(found)
    }

    /// 등록한 저장소의 워크트리인지 확인하고 경로를 돌려준다
    fn known_worktree(&self, path: &str) -> Result<PathBuf, WorkspaceError> {
        let p = std::fs::canonicalize(path).map_err(|_| WorkspaceError::Invalid(format!("없는 폴더: {path}")))?;
        if self.worktrees(None)?.iter().any(|w| Path::new(&w.path) == p) {
            Ok(p)
        } else {
            Err(WorkspaceError::Invalid(format!("등록한 저장소의 워크트리가 아니다: {path}")))
        }
    }

    pub fn update_worktree(&self, path: &str, name: Option<String>, pinned: Option<bool>, parent: Option<String>) -> Result<(), WorkspaceError> {
        let p = self.known_worktree(path)?;
        // 부모: 빈 글이면 뗀다. 자기 자신이나 자기 밑의 워크트리는 부모로 삼지 못한다
        let parent = match parent {
            Some(s) if s.is_empty() => Some(None),
            Some(s) => {
                let q = self.known_worktree(&s)?;
                let meta = self.meta.lock().unwrap();
                let mut cur = Some(q.clone());
                while let Some(c) = cur {
                    if c == p {
                        return Err(WorkspaceError::Invalid("자기 자신이나 자기 밑의 워크트리를 부모로 삼을 수 없다".into()));
                    }
                    cur = meta.get(&c).and_then(|m| m.parent.clone());
                }
                Some(Some(q))
            }
            None => None,
        };
        {
            let mut meta = self.meta.lock().unwrap();
            let m = meta.entry(p.clone()).or_default();
            if let Some(n) = name {
                m.name = Some(n.trim().to_string()).filter(|n| !n.is_empty());
            }
            if let Some(pin) = pinned {
                m.pinned = pin;
            }
            if let Some(par) = parent {
                m.parent = par;
            }
            if m.is_empty() {
                meta.remove(&p);
            }
        }
        let repos = self.repos.lock().unwrap().clone();
        self.save(&repos)
    }

    pub fn status(&self, worktree: &str) -> Result<GitStatus, WorkspaceError> {
        Ok(self.vcs.status(&self.known_worktree(worktree)?)?)
    }

    pub fn diff(&self, worktree: &str, file: &str, staged: bool) -> Result<String, WorkspaceError> {
        let w = self.known_worktree(worktree)?;
        inside(&w, file)?;
        Ok(self.vcs.diff(&w, file, staged)?)
    }

    pub fn stage(&self, worktree: &str, files: &[String]) -> Result<(), WorkspaceError> {
        let w = self.known_worktree(worktree)?;
        Ok(self.vcs.stage(&w, files)?)
    }

    pub fn unstage(&self, worktree: &str, files: &[String]) -> Result<(), WorkspaceError> {
        let w = self.known_worktree(worktree)?;
        Ok(self.vcs.unstage(&w, files)?)
    }

    pub fn discard(&self, worktree: &str, files: &[String]) -> Result<(), WorkspaceError> {
        let w = self.known_worktree(worktree)?;
        for f in files {
            inside(&w, f)?;
        }
        info!(event = "git_discard", worktree, files = files.len());
        Ok(self.vcs.discard(&w, files)?)
    }

    pub fn commit(&self, worktree: &str, message: &str, all: bool) -> Result<String, WorkspaceError> {
        if message.trim().is_empty() {
            return Err(WorkspaceError::Invalid("커밋 메시지가 비었다".into()));
        }
        let w = self.known_worktree(worktree)?;
        let id = self.vcs.commit(&w, message, all)?;
        info!(event = "git_commit", worktree, commit = %id);
        Ok(id)
    }

    pub fn push(&self, worktree: &str) -> Result<String, WorkspaceError> {
        let w = self.known_worktree(worktree)?;
        info!(event = "git_push", worktree);
        Ok(self.vcs.push(&w)?)
    }

    pub fn branches(&self, repo: &str) -> Result<BranchList, WorkspaceError> {
        Ok(self.vcs.branches(&self.repo_path(repo)?)?)
    }

    /// 워크트리 안 폴더 목록. 폴더 먼저, 숫자를 아는 이름 순서. `.git` 은 뺀다
    pub fn list_dir(&self, worktree: &str, dir: &str) -> Result<Vec<DirEntry>, WorkspaceError> {
        let w = self.known_worktree(worktree)?;
        let target = inside(&w, dir)?;
        let mut entries: Vec<DirEntry> = std::fs::read_dir(&target)?
            .flatten()
            .filter(|e| e.file_name() != ".git")
            .map(|e| DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
                ignored: false,
            })
            .collect();
        // 무시하는 파일은 화면에서 흐리게 보인다. 폴더는 끝에 / 를 붙여 물어야 `target/` 같은 규칙에 맞는다
        let rel = |e: &DirEntry| {
            let p = if dir.is_empty() { e.name.clone() } else { format!("{dir}/{}", e.name) };
            if e.is_dir { format!("{p}/") } else { p }
        };
        let paths: Vec<String> = entries.iter().map(rel).collect();
        if let Ok(ignored) = self.vcs.ignored(&w, &paths) {
            for e in &mut entries {
                e.ignored = ignored.contains(&rel(e));
            }
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
        Ok(entries)
    }

    pub fn search(&self, worktree: &str, query: &str, case_sensitive: bool) -> Result<(Vec<SearchHit>, bool), WorkspaceError> {
        if query.is_empty() {
            return Ok((Vec::new(), false));
        }
        Ok(self.vcs.grep(&self.known_worktree(worktree)?, query, case_sensitive, 500)?)
    }

    pub fn list_files(&self, worktree: &str) -> Result<(Vec<String>, bool), WorkspaceError> {
        Ok(self.vcs.list_files(&self.known_worktree(worktree)?, 50_000)?)
    }

    pub fn line_counts(&self, worktree: &str) -> Result<Vec<LineCount>, WorkspaceError> {
        Ok(self.vcs.line_counts(&self.known_worktree(worktree)?)?)
    }

    pub fn read_file(&self, worktree: &str, file: &str) -> Result<FileContent, WorkspaceError> {
        use std::io::Read;
        let w = self.known_worktree(worktree)?;
        let p = inside(&w, file)?;
        let size = std::fs::metadata(&p)?.len();
        let mut buf = Vec::new();
        std::fs::File::open(&p)?.take(MAX_READ).read_to_end(&mut buf)?;
        let binary = buf.iter().take(8000).any(|&b| b == 0);
        let text = (!binary).then(|| String::from_utf8_lossy(&buf).into_owned());
        Ok(FileContent { text, binary, truncated: size > MAX_READ, size })
    }

    /// 경로가 든 워크트리 맨 위 폴더 (세션 꼬리표용). git 저장소가 아니면 None
    pub fn worktree_of(&self, path: &Path) -> Option<PathBuf> {
        self.vcs.worktree_root(path).ok()
    }
}

/// `rel` 이 `root` 밖으로 나가지 않는지 확인하고 절대 경로를 돌려준다
fn inside(root: &Path, rel: &str) -> Result<PathBuf, WorkspaceError> {
    let outside = || WorkspaceError::Invalid(format!("워크트리 밖 경로: {rel}"));
    if Path::new(rel).is_absolute() || rel.split('/').any(|c| c == "..") {
        return Err(outside());
    }
    let joined = root.join(rel);
    match std::fs::canonicalize(&joined) {
        // 있는 경로는 실제 위치로 본다 (밖을 가리키는 심볼릭 링크를 막는다)
        Ok(real) if real.starts_with(root) => Ok(real),
        Ok(_) => Err(outside()),
        // 아직 없는 경로 (지운 파일의 diff 등)
        Err(_) => Ok(joined),
    }
}

/// 숫자를 아는 이름 비교 (`9`, `10`, `100` 순서)
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = a.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    a.next();
                }
                let mut nb = String::new();
                while let Some(c) = b.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    b.next();
                }
                let o = na.trim_start_matches('0').len().cmp(&nb.trim_start_matches('0').len()).then(na.cmp(&nb));
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
                a.next();
                b.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order() {
        let mut v = vec!["file10", "File2", "file1", "a100", "a9"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["a9", "a100", "file1", "File2", "file10"]);
    }

    #[test]
    fn rejects_paths_outside_worktree() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        assert!(inside(&root, "../etc/passwd").is_err());
        assert!(inside(&root, "/etc/passwd").is_err());
        assert!(inside(&root, "src/main.rs").is_ok());
        std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
        assert!(inside(&root, "escape/passwd").is_err(), "밖을 가리키는 링크를 막아야 한다");
    }

    /// 워크스페이스 시험용 Vcs: 경로를 그대로 메인 워크트리로 본다. 다른 것은 부르지 않는다
    struct PathVcs;

    impl Vcs for PathVcs {
        fn main_worktree(&self, path: &Path) -> Result<PathBuf, VcsError> {
            Ok(path.to_path_buf())
        }
        fn worktree_root(&self, path: &Path) -> Result<PathBuf, VcsError> {
            Ok(path.to_path_buf())
        }
        fn list_worktrees(&self, _: &Path) -> Result<Vec<VcsWorktree>, VcsError> {
            Ok(Vec::new())
        }
        fn create_worktree(&self, _: &Path, _: &Path, _: &str, _: Option<&str>) -> Result<(), VcsError> {
            unimplemented!()
        }
        fn remove_worktree(&self, _: &Path, _: &Path, _: bool) -> Result<(), VcsError> {
            unimplemented!()
        }
        fn delete_branch(&self, _: &Path, _: &str, _: bool) -> Result<(), VcsError> {
            unimplemented!()
        }
        fn status(&self, _: &Path) -> Result<GitStatus, VcsError> {
            unimplemented!()
        }
        fn diff(&self, _: &Path, _: &str, _: bool) -> Result<String, VcsError> {
            unimplemented!()
        }
        fn stage(&self, _: &Path, _: &[String]) -> Result<(), VcsError> {
            unimplemented!()
        }
        fn unstage(&self, _: &Path, _: &[String]) -> Result<(), VcsError> {
            unimplemented!()
        }
        fn discard(&self, _: &Path, _: &[String]) -> Result<(), VcsError> {
            unimplemented!()
        }
        fn commit(&self, _: &Path, _: &str, _: bool) -> Result<String, VcsError> {
            unimplemented!()
        }
        fn push(&self, _: &Path) -> Result<String, VcsError> {
            unimplemented!()
        }
        fn branches(&self, _: &Path) -> Result<BranchList, VcsError> {
            unimplemented!()
        }
        fn ignored(&self, _: &Path, _: &[String]) -> Result<Vec<String>, VcsError> {
            unimplemented!()
        }
        fn grep(&self, _: &Path, _: &str, _: bool, _: usize) -> Result<(Vec<SearchHit>, bool), VcsError> {
            unimplemented!()
        }
        fn list_files(&self, _: &Path, _: usize) -> Result<(Vec<String>, bool), VcsError> {
            unimplemented!()
        }
        fn line_counts(&self, _: &Path) -> Result<Vec<LineCount>, VcsError> {
            unimplemented!()
        }
    }

    fn open(home: &Path) -> Workspace {
        Workspace::open(Arc::new(PathVcs), home)
    }

    fn group(id: &str, name: &str, repos: &[&str]) -> RepoGroup {
        RepoGroup { id: id.into(), name: name.into(), repos: repos.iter().map(|r| r.to_string()).collect() }
    }

    /// (id, 이름, 든 저장소 이름들)
    fn shape(ws: &Workspace) -> Vec<(String, String, Vec<String>)> {
        let names: std::collections::HashMap<String, String> = ws.repos().into_iter().map(|r| (r.id, r.name)).collect();
        ws.groups().into_iter().map(|g| (g.id, g.name, g.repos.iter().map(|r| names[r].clone()).collect())).collect()
    }

    fn row(id: &str, name: &str, repos: &[&str]) -> (String, String, Vec<String>) {
        (id.into(), name.into(), repos.iter().map(|r| r.to_string()).collect())
    }

    #[test]
    fn old_file_without_groups_puts_every_repo_in_default() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("workspace.json"), r#"{"repos":[{"path":"/w/a"},{"path":"/w/b"}],"worktrees":{}}"#).unwrap();
        let ws = open(d.path());
        assert_eq!(shape(&ws), [row(DEFAULT_GROUP, "기본", &["a", "b"])]);
    }

    #[test]
    fn set_groups_saves_and_reloads() {
        let d = tempfile::tempdir().unwrap();
        let ws = open(d.path());
        let [a, b, c] = ["/w/a", "/w/b", "/w/c"].map(|p| ws.add_repo(Path::new(p)).unwrap().id);
        // 새 워크스페이스는 id 를 비워 보낸다. 기본을 뒤로 보내도 된다
        let got = ws.set_groups(vec![group("", "  일  ", &[&c, &a]), group(DEFAULT_GROUP, "기본", &[&b])]).unwrap();
        let new_id = got[0].id.clone();
        assert!(!new_id.is_empty() && new_id != DEFAULT_GROUP);
        assert_eq!(shape(&ws), [row(&new_id, "일", &["c", "a"]), row(DEFAULT_GROUP, "기본", &["b"])]);
        // 다시 열어도 같다
        assert_eq!(shape(&open(d.path())), shape(&ws));
        // 새로 등록한 프로젝트는 기본 끝에 든다
        ws.add_repo(Path::new("/w/d")).unwrap();
        assert_eq!(shape(&ws), [row(&new_id, "일", &["c", "a"]), row(DEFAULT_GROUP, "기본", &["b", "d"])]);
    }

    #[test]
    fn deleting_group_moves_its_repos_to_default() {
        let d = tempfile::tempdir().unwrap();
        let ws = open(d.path());
        let [a, b] = ["/w/a", "/w/b"].map(|p| ws.add_repo(Path::new(p)).unwrap().id);
        ws.set_groups(vec![group(DEFAULT_GROUP, "기본", &[&b]), group("x", "일", &[&a])]).unwrap();
        // 지울 워크스페이스를 빼고 보내면 든 프로젝트는 기본 끝으로 간다
        ws.set_groups(vec![group(DEFAULT_GROUP, "기본", &[&b])]).unwrap();
        assert_eq!(shape(&ws), [row(DEFAULT_GROUP, "기본", &["b", "a"])]);
        // 기본을 빼고 보내도 맨 앞에 다시 넣는다
        ws.set_groups(vec![group("y", "놀이", &[&a])]).unwrap();
        assert_eq!(shape(&ws), [row(DEFAULT_GROUP, "기본", &["b"]), row("y", "놀이", &["a"])]);
    }

    #[test]
    fn set_groups_rejects_bad_input_and_drops_unknown_repos() {
        let d = tempfile::tempdir().unwrap();
        let ws = open(d.path());
        let [a, b] = ["/w/a", "/w/b"].map(|p| ws.add_repo(Path::new(p)).unwrap().id);
        assert!(matches!(ws.set_groups(vec![group("x", " ", &[])]), Err(WorkspaceError::Invalid(_))));
        assert!(matches!(ws.set_groups(vec![group("x", "일", &[]), group("x", "놀이", &[])]), Err(WorkspaceError::Invalid(_))));
        // 모르는 저장소는 빼고, 두 곳에 든 저장소는 앞 것만 남긴다
        ws.set_groups(vec![group("x", "일", &["nope", &a, &b]), group("y", "놀이", &[&a])]).unwrap();
        assert_eq!(shape(&ws), [row(DEFAULT_GROUP, "기본", &[]), row("x", "일", &["a", "b"]), row("y", "놀이", &[])]);
    }

    #[test]
    fn removing_repo_drops_it_from_its_group() {
        let d = tempfile::tempdir().unwrap();
        let ws = open(d.path());
        let [a, b] = ["/w/a", "/w/b"].map(|p| ws.add_repo(Path::new(p)).unwrap().id);
        ws.set_groups(vec![group(DEFAULT_GROUP, "기본", &[&a]), group("x", "일", &[&b])]).unwrap();
        ws.remove_repo(&b).unwrap();
        assert_eq!(shape(&open(d.path())), [row(DEFAULT_GROUP, "기본", &["a"]), row("x", "일", &[])]);
        // 다시 등록하면 옛 워크스페이스가 아니라 기본에 든다
        ws.add_repo(Path::new("/w/b")).unwrap();
        assert_eq!(shape(&ws), [row(DEFAULT_GROUP, "기본", &["a", "b"]), row("x", "일", &[])]);
    }
}
