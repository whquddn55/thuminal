//! `thuminal repo …`, `thuminal wt …`: 저장소와 워크트리 명령.

use clap::Subcommand;
use thuminal_client::Client;
use thuminal_protocol::{RepoInfo, SessionState, WORKTREE_LABEL, WorktreeInfo};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Subcommand)]
pub enum RepoCmd {
    /// 저장소를 등록한다 (기본: 지금 폴더)
    Add { path: Option<String> },
    /// 등록한 저장소
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// 등록을 푼다 (파일은 건드리지 않는다)
    Rm { repo: String },
}

#[derive(Subcommand)]
pub enum WtCmd {
    /// 워크트리 목록
    Ls {
        /// 저장소 id 나 이름 (기본: 모두)
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 새 브랜치로 저장소 옆에 워크트리를 만들고 경로를 찍는다
    New {
        branch: String,
        /// 시작할 커밋이나 브랜치 (기본: 지금 HEAD)
        #[arg(long)]
        base: Option<String>,
        /// 저장소 id 나 이름 (기본: 지금 폴더의 저장소)
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 워크트리를 지운다. 그 안에서 돌던 세션도 끝낸다
    Rm {
        /// 워크트리 경로나 브랜치 이름
        target: String,
        #[arg(long)]
        force: bool,
        /// 브랜치도 지운다
        #[arg(long)]
        delete_branch: bool,
    },
    /// 워크트리마다 돌고 있는 터미널
    Ps {
        #[arg(long)]
        json: bool,
    },
}

/// 지금 폴더의 저장소를 찾는다. 등록하지 않았으면 등록한다
async fn repo_here(c: &Client) -> Res<RepoInfo> {
    let cwd = std::env::current_dir()?;
    Ok(c.add_repo(cwd.to_string_lossy()).await?)
}

async fn resolve_repo(c: &Client, repo: Option<String>) -> Res<RepoInfo> {
    match repo {
        None => repo_here(c).await,
        Some(r) => c
            .repos()
            .await?
            .into_iter()
            .find(|x| x.id == r || x.name == r || x.path == r)
            .ok_or_else(|| format!("등록하지 않은 저장소: {r}").into()),
    }
}

pub async fn repo(c: &Client, cmd: RepoCmd) -> Res<()> {
    match cmd {
        RepoCmd::Add { path } => {
            let path = match path {
                Some(p) => std::fs::canonicalize(p)?,
                None => std::env::current_dir()?,
            };
            let r = c.add_repo(path.to_string_lossy()).await?;
            println!("{}  {}  {}", r.id, r.name, r.path);
        }
        RepoCmd::Ls { json } => {
            let repos = c.repos().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&repos)?);
            } else {
                for r in repos {
                    println!("{}  {:<24}  {}", r.id, r.name, r.path);
                }
            }
        }
        RepoCmd::Rm { repo } => {
            let r = resolve_repo(c, Some(repo)).await?;
            c.request(thuminal_protocol::Request::RemoveRepo { repo: r.id }).await?;
        }
    }
    Ok(())
}

fn print_worktrees(list: &[WorktreeInfo]) {
    for w in list {
        println!("{}  {:<32}  {}{}", w.repo, w.branch.as_deref().unwrap_or("(detached)"), w.path, if w.is_main { "  (메인)" } else { "" });
    }
}

pub async fn wt(c: &Client, cmd: WtCmd) -> Res<()> {
    match cmd {
        WtCmd::Ls { repo, json } => {
            let repo = match repo {
                Some(r) => Some(resolve_repo(c, Some(r)).await?.id),
                None => None,
            };
            let list = c.worktrees(repo).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                print_worktrees(&list);
            }
        }
        WtCmd::New { branch, base, repo, json } => {
            let r = resolve_repo(c, repo).await?;
            let w = c.create_worktree(r.id, branch, base).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&w)?);
            } else {
                println!("{}", w.path);
            }
        }
        WtCmd::Rm { target, force, delete_branch } => {
            let all = c.worktrees(None).await?;
            let abs = std::fs::canonicalize(&target).ok().map(|p| p.to_string_lossy().into_owned());
            let w = all
                .iter()
                .find(|w| Some(&w.path) == abs.as_ref() || w.path == target || w.branch.as_deref() == Some(target.as_str()))
                .ok_or(format!("워크트리를 찾지 못했다: {target}"))?;
            // 그 워크트리에서 돌던 세션을 먼저 끝낸다
            for s in c.list().await? {
                if s.labels.get(WORKTREE_LABEL) == Some(&w.path) {
                    c.remove(s.id).await?;
                }
            }
            c.remove_worktree(w.repo.clone(), w.path.clone(), force, delete_branch).await?;
            println!("지웠다: {}", w.path);
        }
        WtCmd::Ps { json } => {
            let worktrees = c.worktrees(None).await?;
            let sessions = c.list().await?;
            if json {
                let rows: Vec<_> = worktrees
                    .iter()
                    .map(|w| {
                        let s: Vec<_> = sessions.iter().filter(|s| s.labels.get(WORKTREE_LABEL) == Some(&w.path)).collect();
                        serde_json::json!({ "worktree": w, "sessions": s })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&rows)?);
                return Ok(());
            }
            for w in &worktrees {
                let mine: Vec<_> = sessions.iter().filter(|s| s.labels.get(WORKTREE_LABEL) == Some(&w.path)).collect();
                let running = mine.iter().filter(|s| s.state == SessionState::Running).count();
                println!("{}  {}  터미널 {} (도는 중 {})", w.branch.as_deref().unwrap_or("(detached)"), w.path, mine.len(), running);
                for s in mine {
                    println!("    {:>4}  {}", s.id, s.title);
                }
            }
        }
    }
    Ok(())
}
