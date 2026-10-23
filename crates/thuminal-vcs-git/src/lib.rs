//! [`thuminal_workspace::Vcs`] 의 git 명령 어댑터.

use std::path::{Path, PathBuf};
use std::process::Command;

use thuminal_workspace::{Vcs, VcsError, VcsWorktree};

#[derive(Debug, Default, Clone, Copy)]
pub struct GitCli;

fn git(dir: &Path, args: &[&str]) -> Result<String, VcsError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // 사용자 설정의 페이저나 색이 끼지 않게 한다
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| VcsError::Command(format!("git 을 실행하지 못했다: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(VcsError::Command(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

/// git 이 돌려준 경로를 실제 경로로 맞춘다 (/tmp → /private/tmp 같은 차이를 없앤다)
fn canonical(p: &str) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p))
}

impl Vcs for GitCli {
    fn main_worktree(&self, path: &Path) -> Result<PathBuf, VcsError> {
        let common = git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .map_err(|_| VcsError::NotARepo(path.display().to_string()))?;
        let common = canonical(&common);
        // 보통 <메인>/.git 이다. bare 저장소면 그 폴더 자체
        Ok(if common.file_name().is_some_and(|n| n == ".git") { common.parent().unwrap().to_path_buf() } else { common })
    }

    fn worktree_root(&self, path: &Path) -> Result<PathBuf, VcsError> {
        git(path, &["rev-parse", "--show-toplevel"]).map(|p| canonical(&p)).map_err(|_| VcsError::NotARepo(path.display().to_string()))
    }

    fn list_worktrees(&self, repo: &Path) -> Result<Vec<VcsWorktree>, VcsError> {
        let out = git(repo, &["worktree", "list", "--porcelain"])?;
        let mut list = Vec::new();
        let mut cur: Option<VcsWorktree> = None;
        for line in out.lines().chain(std::iter::once("")) {
            if let Some(p) = line.strip_prefix("worktree ") {
                cur = Some(VcsWorktree { path: canonical(p), branch: None, head: String::new() });
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                if let Some(w) = cur.as_mut() {
                    w.head = h.to_string();
                }
            } else if let Some(b) = line.strip_prefix("branch ") {
                if let Some(w) = cur.as_mut() {
                    w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                }
            } else if line.is_empty() {
                if let Some(w) = cur.take() {
                    list.push(w);
                }
            }
        }
        Ok(list)
    }

    fn create_worktree(&self, repo: &Path, path: &Path, branch: &str, base: Option<&str>) -> Result<(), VcsError> {
        let path_s = path.to_string_lossy();
        let mut args = vec!["worktree", "add", "-b", branch, &path_s];
        if let Some(b) = base {
            args.push(b);
        }
        git(repo, &args).map(|_| ())
    }

    fn remove_worktree(&self, repo: &Path, path: &Path, force: bool) -> Result<(), VcsError> {
        let path_s = path.to_string_lossy();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path_s);
        git(repo, &args).map(|_| ())
    }

    fn delete_branch(&self, repo: &Path, branch: &str, force: bool) -> Result<(), VcsError> {
        git(repo, &["branch", if force { "-D" } else { "-d" }, branch]).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use thuminal_workspace::Workspace;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(&dir.path().join("proj").to_string_lossy());
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]).unwrap();
        git(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
        (dir, canonical(&root.to_string_lossy()))
    }

    #[test]
    fn creates_lists_and_removes_worktrees() {
        let (dir, root) = repo();
        let home = tempfile::tempdir().unwrap();
        let ws = Workspace::open(Arc::new(GitCli), home.path());
        let r = ws.add_repo(&root).unwrap();
        assert_eq!(r.name, "proj");

        let w = ws.create_worktree(&r.id, "feature/x", None).unwrap();
        assert_eq!(w.branch.as_deref(), Some("feature/x"));
        assert!(w.path.ends_with("proj-thm-wt-feature-x"), "{}", w.path);

        // 워크트리 안의 경로로 등록해도 같은 저장소다
        assert_eq!(ws.add_repo(Path::new(&w.path)).unwrap().id, r.id);
        assert_eq!(ws.repos().len(), 1);
        let all = ws.worktrees(None).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|w| w.is_main));

        ws.remove_worktree(&r.id, Path::new(&w.path), false, true).unwrap();
        assert_eq!(ws.worktrees(Some(&r.id)).unwrap().len(), 1);
        assert!(git(&root, &["rev-parse", "--verify", "feature/x"]).is_err(), "브랜치가 남았다");

        // 다시 열어도 저장소 목록이 남아 있다
        assert_eq!(Workspace::open(Arc::new(GitCli), home.path()).repos().len(), 1);
        drop(dir);
    }

    #[test]
    fn not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(GitCli.main_worktree(dir.path()), Err(VcsError::NotARepo(_))));
    }
}
