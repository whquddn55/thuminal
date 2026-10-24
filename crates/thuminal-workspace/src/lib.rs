//! 저장소 목록과 워크트리 관리.
//!
//! 버전 관리 도구는 [`Vcs`] 로만 안다 (지금 구현은 `thuminal-vcs-git`).
//! 등록한 저장소 목록은 데이터 폴더의 `workspace.json` 에 남긴다.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
/// 어댑터가 쓰는 프로토콜 타입 (어댑터가 프로토콜 크레이트에 직접 기대지 않게 다시 내보낸다)
pub use thuminal_protocol as protocol;
use thuminal_protocol::{BranchList, DirEntry, FileContent, GitStatus, RepoInfo, WorktreeInfo};
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorktreeMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pinned: bool,
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
        Self { vcs, file, repos: Mutex::new(saved.repos), meta: Mutex::new(saved.worktrees) }
    }

    fn save(&self, repos: &[SavedRepo]) -> Result<(), WorkspaceError> {
        let tmp = self.file.with_extension("json.tmp");
        let worktrees = self.meta.lock().unwrap().clone();
        std::fs::write(&tmp, serde_json::to_vec_pretty(&Saved { repos: repos.to_vec(), worktrees }).unwrap())?;
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
        self.save(&repos)?;
        Ok(())
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
                });
            }
        }
        Ok(out)
    }

    /// 저장소 옆 폴더 `<저장소>-thm-wt-<브랜치>` 에 새 워크트리를 만든다
    pub fn create_worktree(&self, repo: &str, branch: &str, base: Option<&str>, name: Option<&str>) -> Result<WorktreeInfo, WorkspaceError> {
        if branch.trim().is_empty() {
            return Err(WorkspaceError::Invalid("브랜치 이름이 비었다".into()));
        }
        let root = self.repo_path(repo)?;
        let folder = format!("{}-thm-wt-{}", root.file_name().unwrap_or_default().to_string_lossy(), branch_slug(branch));
        let path = root.parent().unwrap_or(&root).join(folder);
        if path.exists() {
            return Err(WorkspaceError::Invalid(format!("이미 있는 폴더: {}", path.display())));
        }
        self.vcs.create_worktree(&root, &path, branch, base)?;
        info!(event = "worktree_created", repo, branch, path = %path.display());
        if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
            let canonical = std::fs::canonicalize(&path).unwrap_or(path.clone());
            self.meta.lock().unwrap().insert(canonical, WorktreeMeta { name: Some(n.to_string()), pinned: false });
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
        self.meta.lock().unwrap().remove(path);
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

    pub fn update_worktree(&self, path: &str, name: Option<String>, pinned: Option<bool>) -> Result<(), WorkspaceError> {
        let p = self.known_worktree(path)?;
        {
            let mut meta = self.meta.lock().unwrap();
            let m = meta.entry(p.clone()).or_default();
            if let Some(n) = name {
                m.name = Some(n.trim().to_string()).filter(|n| !n.is_empty());
            }
            if let Some(pin) = pinned {
                m.pinned = pin;
            }
            if m.name.is_none() && !m.pinned {
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
}
