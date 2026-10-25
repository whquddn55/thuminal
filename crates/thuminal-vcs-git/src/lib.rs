//! [`thuminal_workspace::Vcs`] 의 git 명령 어댑터.

use std::path::{Path, PathBuf};
use std::process::Command;

use thuminal_workspace::protocol::{BranchList, ChangeKind, FileChange, GitStatus};
use thuminal_workspace::{Vcs, VcsError, VcsWorktree};

#[derive(Debug, Default, Clone, Copy)]
pub struct GitCli;

fn git(dir: &Path, args: &[&str]) -> Result<String, VcsError> {
    git_raw(dir, args).map(|o| String::from_utf8_lossy(&o).trim_end().to_string())
}

/// 출력을 다듬지 않고 그대로 돌려준다 (`-z` 출력, diff)
fn git_raw(dir: &Path, args: &[&str]) -> Result<Vec<u8>, VcsError> {
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
        Ok(out.stdout)
    } else {
        Err(VcsError::Command(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

fn not_a_repo(path: &Path, e: VcsError) -> VcsError {
    match e {
        VcsError::Command(msg) if !msg.contains("not a git repository") => VcsError::Command(format!("{}: {msg}", path.display())),
        _ => VcsError::NotARepo(path.display().to_string()),
    }
}

/// git 이 돌려준 경로를 실제 경로로 맞춘다 (/tmp → /private/tmp 같은 차이를 없앤다)
fn canonical(p: &str) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p))
}

fn kind(c: u8) -> Option<ChangeKind> {
    Some(match c {
        b'M' => ChangeKind::Modified,
        b'A' => ChangeKind::Added,
        b'D' => ChangeKind::Deleted,
        b'R' => ChangeKind::Renamed,
        b'C' => ChangeKind::Copied,
        b'T' => ChangeKind::TypeChanged,
        b'U' => ChangeKind::Conflicted,
        _ => return None,
    })
}

/// `git status --porcelain=v2 --branch -z` 출력을 읽는다
fn parse_status(out: &[u8]) -> GitStatus {
    let mut st = GitStatus::default();
    let mut fields = out.split(|&b| b == 0).filter(|f| !f.is_empty()).map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(line) = fields.next() {
        let mut it = line.splitn(2, ' ');
        let tag = it.next().unwrap_or("");
        let rest = it.next().unwrap_or("");
        match tag {
            "#" => {
                if let Some(v) = rest.strip_prefix("branch.head ") {
                    st.branch = (v != "(detached)").then(|| v.to_string());
                } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
                    st.upstream = Some(v.to_string());
                } else if let Some(v) = rest.strip_prefix("branch.ab ") {
                    for p in v.split(' ') {
                        if let Some(n) = p.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = p.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
            }
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  (다음 필드가 이전 경로)
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            "1" | "2" | "u" => {
                let n = match tag {
                    "1" => 7,
                    "2" => 8,
                    _ => 9,
                };
                let parts: Vec<&str> = rest.splitn(n + 1, ' ').collect();
                let xy = parts.first().copied().unwrap_or("..").as_bytes();
                let path = parts.get(n).copied().unwrap_or("").to_string();
                let orig_path = if tag == "2" { fields.next() } else { None };
                let (staged, unstaged) =
                    if tag == "u" { (Some(ChangeKind::Conflicted), Some(ChangeKind::Conflicted)) } else { (kind(xy[0]), kind(xy[1])) };
                st.files.push(FileChange { path, orig_path, staged, unstaged });
            }
            "?" => st.files.push(FileChange { path: rest.to_string(), orig_path: None, staged: None, unstaged: Some(ChangeKind::Untracked) }),
            _ => {}
        }
    }
    st
}

impl Vcs for GitCli {
    fn main_worktree(&self, path: &Path) -> Result<PathBuf, VcsError> {
        // git 이 저장소가 아니라고 한 것만 NotARepo 로 바꾸고, 그 밖의 까닭(소유자 검사, 권한 등)은 그대로 알린다
        let common = git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map_err(|e| not_a_repo(path, e))?;
        let common = canonical(&common);
        // 보통 <메인>/.git 이다. bare 저장소면 그 폴더 자체
        Ok(if common.file_name().is_some_and(|n| n == ".git") { common.parent().unwrap().to_path_buf() } else { common })
    }

    fn worktree_root(&self, path: &Path) -> Result<PathBuf, VcsError> {
        git(path, &["rev-parse", "--show-toplevel"]).map(|p| canonical(&p)).map_err(|e| not_a_repo(path, e))
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
        if force {
            return git(repo, &["branch", "-D", branch]).map(|_| ());
        }
        // 거절 글로 까닭을 가린다. 사용자 언어 설정과 상관없이 같은 글이 나오게 C 로 돌린다
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["branch", "-d", branch])
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| VcsError::Command(format!("git 을 실행하지 못했다: {e}")))?;
        if out.status.success() {
            return Ok(());
        }
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.contains("not fully merged") {
            Err(VcsError::NotMerged(branch.to_string()))
        } else {
            Err(VcsError::Command(msg))
        }
    }

    fn status(&self, worktree: &Path) -> Result<GitStatus, VcsError> {
        let out = git_raw(worktree, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
        Ok(parse_status(&out))
    }

    fn diff(&self, worktree: &Path, file: &str, staged: bool) -> Result<String, VcsError> {
        let out = if staged {
            git_raw(worktree, &["diff", "--no-color", "--no-ext-diff", "--cached", "--", file])?
        } else {
            let tracked = git(worktree, &["ls-files", "--error-unmatch", "--", file]).is_ok();
            if tracked {
                git_raw(worktree, &["diff", "--no-color", "--no-ext-diff", "--", file])?
            } else {
                // 새 파일: 빈 파일과 비교한다. 다르면 git diff --no-index 는 종료 코드 1 을 낸다
                let out = Command::new("git")
                    .arg("-C")
                    .arg(worktree)
                    .args(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file])
                    .env("GIT_PAGER", "cat")
                    .output()
                    .map_err(|e| VcsError::Command(e.to_string()))?;
                out.stdout
            }
        };
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    fn stage(&self, worktree: &Path, files: &[String]) -> Result<(), VcsError> {
        let mut args = vec!["add", "-A", "--"];
        args.extend(files.iter().map(String::as_str));
        git(worktree, &args).map(|_| ())
    }

    fn unstage(&self, worktree: &Path, files: &[String]) -> Result<(), VcsError> {
        // 첫 커밋 전에는 HEAD 가 없어 restore --staged 가 실패한다. 그때는 rm --cached
        let has_head = git(worktree, &["rev-parse", "--verify", "HEAD"]).is_ok();
        let mut args = if has_head { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-q", "--"] };
        args.extend(files.iter().map(String::as_str));
        git(worktree, &args).map(|_| ())
    }

    fn discard(&self, worktree: &Path, files: &[String]) -> Result<(), VcsError> {
        let (mut tracked, mut untracked) = (Vec::new(), Vec::new());
        for f in files {
            if git(worktree, &["ls-files", "--error-unmatch", "--", f]).is_ok() {
                tracked.push(f.as_str());
            } else {
                untracked.push(f.as_str());
            }
        }
        if !tracked.is_empty() {
            let mut args = vec!["restore", "--worktree", "--"];
            args.extend(tracked);
            git(worktree, &args)?;
        }
        if !untracked.is_empty() {
            let mut args = vec!["clean", "-f", "-q", "--"];
            args.extend(untracked);
            git(worktree, &args)?;
        }
        Ok(())
    }

    fn commit(&self, worktree: &Path, message: &str, all: bool) -> Result<String, VcsError> {
        let mut args = vec!["commit", "-q", "-m", message];
        if all {
            args.push("-a");
        }
        git(worktree, &args)?;
        git(worktree, &["rev-parse", "--short", "HEAD"])
    }

    fn push(&self, worktree: &Path) -> Result<String, VcsError> {
        let has_upstream = git(worktree, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
        let out = Command::new("git")
            .arg("-C")
            .arg(worktree)
            .args(if has_upstream { vec!["push"] } else { vec!["push", "-u", "origin", "HEAD"] })
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| VcsError::Command(e.to_string()))?;
        // git push 는 진행 상황을 stderr 에 쓴다
        let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() { Ok(text) } else { Err(VcsError::Command(text)) }
    }

    fn ignored(&self, worktree: &Path, paths: &[String]) -> Result<Vec<String>, VcsError> {
        use std::io::Write;
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut child = Command::new("git")
            .arg("-C")
            .arg(worktree)
            .args(["check-ignore", "--stdin", "-z"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| VcsError::Command(e.to_string()))?;
        let mut input = Vec::new();
        for p in paths {
            input.extend_from_slice(p.as_bytes());
            input.push(0);
        }
        child.stdin.take().unwrap().write_all(&input).map_err(|e| VcsError::Command(e.to_string()))?;
        // 하나도 무시하지 않으면 종료 코드 1 이다. 출력만 본다
        let out = child.wait_with_output().map_err(|e| VcsError::Command(e.to_string()))?;
        Ok(out.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
    }

    fn branches(&self, repo: &Path) -> Result<BranchList, VcsError> {
        let lines = |r: &str| -> Result<Vec<String>, VcsError> {
            Ok(git(repo, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", r])?
                .lines()
                .filter(|l| !l.is_empty() && !l.ends_with("/HEAD") && *l != "origin")
                .map(str::to_string)
                .collect())
        };
        Ok(BranchList {
            local: lines("refs/heads")?,
            remote: lines("refs/remotes")?,
            current: git(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|s| !s.is_empty()),
            default: git(repo, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).ok().filter(|s| !s.is_empty()),
        })
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

        let w = ws.create_worktree(&r.id, "feature/x", None, Some("로그인 작업"), None).unwrap();
        assert_eq!(w.branch.as_deref(), Some("feature/x"));
        assert_eq!(w.name.as_deref(), Some("로그인 작업"));
        ws.update_worktree(&w.path, None, Some(true), None).unwrap();
        assert!(ws.worktrees(Some(&r.id)).unwrap().iter().any(|x| x.path == w.path && x.pinned));

        // 하위 워크트리: 부모를 기억하고, 자기 밑의 워크트리를 부모로 삼지 못하고, 빈 글로 뗀다
        let child = ws.create_worktree(&r.id, "feature/y", None, None, Some(&w.path)).unwrap();
        assert_eq!(child.parent.as_deref(), Some(w.path.as_str()));
        assert!(ws.update_worktree(&w.path, None, None, Some(child.path.clone())).is_err(), "부모가 돌고 돌면 안 된다");
        ws.update_worktree(&child.path, None, None, Some(String::new())).unwrap();
        assert!(ws.worktrees(Some(&r.id)).unwrap().iter().any(|x| x.path == child.path && x.parent.is_none()));
        ws.update_worktree(&child.path, None, None, Some(root.to_string_lossy().into_owned())).unwrap();
        assert!(Workspace::open(Arc::new(GitCli), home.path()).worktrees(Some(&r.id)).unwrap().iter().any(|x| x.path == child.path && x.parent.as_deref() == Some(&*root.to_string_lossy())), "다시 열어도 남는다");
        // 손자: 가운데(child)를 지우면 손자는 메인 밑으로 옮겨진다
        let grandchild = ws.create_worktree(&r.id, "feature/z", None, None, Some(&child.path)).unwrap();
        ws.remove_worktree(&r.id, Path::new(&child.path), true, true, true).unwrap();
        assert!(ws.worktrees(Some(&r.id)).unwrap().iter().any(|x| x.path == grandchild.path && x.parent.as_deref() == Some(&*root.to_string_lossy())));
        ws.remove_worktree(&r.id, Path::new(&grandchild.path), true, true, true).unwrap();
        assert!(w.path.ends_with("proj-thm-wt-feature-x"), "{}", w.path);

        // 워크트리 안의 경로로 등록해도 같은 저장소다
        assert_eq!(ws.add_repo(Path::new(&w.path)).unwrap().id, r.id);
        assert_eq!(ws.repos().len(), 1);
        let all = ws.worktrees(None).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|w| w.is_main));

        assert_eq!(ws.remove_worktree(&r.id, Path::new(&w.path), false, true, false).unwrap(), "");
        assert_eq!(ws.worktrees(Some(&r.id)).unwrap().len(), 1);
        assert!(git(&root, &["rev-parse", "--verify", "feature/x"]).is_err(), "브랜치가 남았다");

        // 다시 열어도 저장소 목록이 남아 있다
        assert_eq!(Workspace::open(Arc::new(GitCli), home.path()).repos().len(), 1);
        drop(dir);
    }

    #[test]
    fn status_diff_stage_commit() {
        let (dir, root) = repo();
        let ws = GitCli;
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(root.join("공백 있는 파일.txt"), "x\n").unwrap();
        let st = ws.status(&root).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.files.len(), 2, "{st:?}");
        assert!(st.files.iter().all(|f| f.unstaged == Some(ChangeKind::Untracked)));
        assert!(st.files.iter().any(|f| f.path == "공백 있는 파일.txt"));
        assert!(ws.diff(&root, "a.txt", false).unwrap().contains("+one"));

        ws.stage(&root, &["a.txt".into()]).unwrap();
        let st = ws.status(&root).unwrap();
        let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.staged, a.unstaged), (Some(ChangeKind::Added), None));
        assert!(ws.diff(&root, "a.txt", true).unwrap().contains("+one"));
        ws.unstage(&root, &["a.txt".into()]).unwrap();
        ws.stage(&root, &["a.txt".into()]).unwrap();

        let id = git_ok(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add a"]);
        let _ = id;
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let st = ws.status(&root).unwrap();
        let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.unstaged, Some(ChangeKind::Modified));
        assert!(ws.diff(&root, "a.txt", false).unwrap().contains("-one\n+two"));

        // 되돌리기: 추적하는 파일은 원래대로, 새 파일은 지운다
        ws.discard(&root, &["a.txt".into(), "공백 있는 파일.txt".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one\n");
        assert!(!root.join("공백 있는 파일.txt").exists());
        assert!(ws.status(&root).unwrap().files.is_empty());

        // 이름 바꾸기는 이전 경로를 같이 준다
        git_ok(&root, &["mv", "a.txt", "b.txt"]);
        let st = ws.status(&root).unwrap();
        let b = st.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!((b.staged, b.orig_path.as_deref()), (Some(ChangeKind::Renamed), Some("a.txt")));

        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        let ign = ws.ignored(&root, &["target/".into(), "a.log".into(), "b.txt".into()]).unwrap();
        assert_eq!(ign, vec!["target/".to_string(), "a.log".to_string()]);

        let br = ws.branches(&root).unwrap();
        assert_eq!(br.current.as_deref(), Some("main"));
        assert!(br.local.contains(&"main".to_string()));
        drop(dir);
    }

    #[test]
    fn keeps_unmerged_branch_unless_force_branch() {
        let (dir, root) = repo();
        let home = tempfile::tempdir().unwrap();
        let ws = Workspace::open(Arc::new(GitCli), home.path());
        let r = ws.add_repo(&root).unwrap();
        let commit = |w: &str| {
            let w = Path::new(w);
            std::fs::write(w.join("x.txt"), "x\n").unwrap();
            git_ok(w, &["add", "x.txt"]);
            git_ok(w, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]);
        };

        // 합치지 않은 커밋 + 바뀐 파일: force 는 워크트리만 지우고 브랜치는 남긴다
        let w = ws.create_worktree(&r.id, "wip", None, None, None).unwrap();
        commit(&w.path);
        std::fs::write(Path::new(&w.path).join("dirty.txt"), "d\n").unwrap();
        let note = ws.remove_worktree(&r.id, Path::new(&w.path), true, true, false).unwrap();
        assert!(note.contains("wip") && note.contains("합치지 않은"), "{note}");
        assert!(!Path::new(&w.path).exists(), "브랜치를 남겨도 워크트리는 지운다");
        assert_eq!(ws.worktrees(Some(&r.id)).unwrap().len(), 1);
        assert!(git(&root, &["rev-parse", "--verify", "refs/heads/wip"]).is_ok(), "합치지 않은 브랜치를 지웠다");

        // force_branch 면 지운다
        let w = ws.create_worktree(&r.id, "wip2", None, None, None).unwrap();
        commit(&w.path);
        assert_eq!(ws.remove_worktree(&r.id, Path::new(&w.path), false, true, true).unwrap(), "");
        assert!(git(&root, &["rev-parse", "--verify", "refs/heads/wip2"]).is_err());
        drop(dir);
    }

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap()
    }

    #[test]
    fn not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(GitCli.main_worktree(dir.path()), Err(VcsError::NotARepo(_))));
    }
}
