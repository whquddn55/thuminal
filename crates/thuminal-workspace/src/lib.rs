//! 저장소 목록과 워크트리 관리.
//!
//! 버전 관리 도구는 [`Vcs`] 로만 안다 (지금 구현은 `thuminal-vcs-git`).
//! 등록한 저장소 목록은 데이터 폴더의 `workspace.json` 에 남긴다.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thuminal_protocol::{RepoInfo, WorktreeInfo};
use tracing::info;

#[derive(Debug, thiserror::Error)]
pub enum VcsError {
    #[error("git 저장소가 아니다: {0}")]
    NotARepo(String),
    #[error("{0}")]
    Command(String),
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
    fn remove_worktree(&self, repo: &Path, path: &Path, force: bool) -> Result<(), VcsError>;
    fn delete_branch(&self, repo: &Path, branch: &str, force: bool) -> Result<(), VcsError>;
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedRepo {
    path: PathBuf,
}

pub struct Workspace {
    vcs: Arc<dyn Vcs>,
    file: PathBuf,
    repos: Mutex<Vec<SavedRepo>>,
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
        Self { vcs, file, repos: Mutex::new(saved.repos) }
    }

    fn save(&self, repos: &[SavedRepo]) -> Result<(), WorkspaceError> {
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&Saved { repos: repos.to_vec() }).unwrap())?;
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
            for w in self.vcs.list_worktrees(&path)? {
                out.push(WorktreeInfo {
                    repo: id.clone(),
                    is_main: w.path == path,
                    path: w.path.to_string_lossy().into_owned(),
                    branch: w.branch,
                    head: w.head,
                });
            }
        }
        Ok(out)
    }

    /// 저장소 옆 폴더 `<저장소>-thm-wt-<브랜치>` 에 새 워크트리를 만든다
    pub fn create_worktree(&self, repo: &str, branch: &str, base: Option<&str>) -> Result<WorktreeInfo, WorkspaceError> {
        if branch.trim().is_empty() {
            return Err(WorkspaceError::Invalid("브랜치 이름이 비었다".into()));
        }
        let root = self.repo_path(repo)?;
        let name = format!("{}-thm-wt-{}", root.file_name().unwrap_or_default().to_string_lossy(), branch_slug(branch));
        let path = root.parent().unwrap_or(&root).join(name);
        if path.exists() {
            return Err(WorkspaceError::Invalid(format!("이미 있는 폴더: {}", path.display())));
        }
        self.vcs.create_worktree(&root, &path, branch, base)?;
        info!(event = "worktree_created", repo, branch, path = %path.display());
        let path_s = path.to_string_lossy().into_owned();
        self.worktrees(Some(repo))?
            .into_iter()
            .find(|w| w.path == path_s)
            .ok_or_else(|| WorkspaceError::Invalid("만든 워크트리를 목록에서 찾지 못했다".into()))
    }

    pub fn remove_worktree(&self, repo: &str, path: &Path, force: bool, delete_branch: bool) -> Result<(), WorkspaceError> {
        let root = self.repo_path(repo)?;
        if path == root {
            return Err(WorkspaceError::Invalid("메인 워크트리는 지우지 않는다".into()));
        }
        let path_s = path.to_string_lossy();
        let branch = self.worktrees(Some(repo))?.into_iter().find(|w| w.path == path_s).and_then(|w| w.branch);
        self.vcs.remove_worktree(&root, path, force)?;
        if let (true, Some(b)) = (delete_branch, branch) {
            self.vcs.delete_branch(&root, &b, force)?;
        }
        info!(event = "worktree_removed", repo, path = %path.display(), delete_branch);
        Ok(())
    }

    /// 경로가 든 워크트리 맨 위 폴더 (세션 꼬리표용). git 저장소가 아니면 None
    pub fn worktree_of(&self, path: &Path) -> Option<PathBuf> {
        self.vcs.worktree_root(path).ok()
    }
}
