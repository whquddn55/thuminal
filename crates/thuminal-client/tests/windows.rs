//! Windows 에서 데몬의 핵심 약속을 확인한다: named pipe 연결, ConPTY 세션, PowerShell 셸 통합(claude 함수 · 실행기),
//! 데몬 하나만 뜨기.
#![cfg(windows)]

use std::sync::Arc;
use std::time::Duration;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig, DaemonError};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, LayoutOp, ScreenFormat, SessionId, Spawn, WORKTREE_LABEL};
use thuminal_pty_portable::PortablePty;

fn config(home: &std::path::Path, claude_plugin: Option<std::path::PathBuf>) -> DaemonConfig {
    DaemonConfig {
        paths: Paths::new(home),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin,
        web_root: None,
    }
}

async fn wait_screen(c: &Client, s: SessionId, needle: &str) -> String {
    let mut last = String::new();
    // PowerShell 은 처음 뜰 때 몇 초 걸린다
    for _ in 0..600 {
        last = c.read_screen(s, ScreenFormat::Plain, true).await.unwrap();
        if last.contains(needle) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("화면에 {needle:?} 이 나오지 않았다:\n{last}");
}

#[tokio::test(flavor = "multi_thread")]
async fn pipe_conpty_and_powershell_integration() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let plugin = root.path().join("plugin");
    std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    std::fs::write(plugin.join(".claude-plugin/plugin.json"), "{}").unwrap();
    // 받은 인자를 그대로 찍는 가짜 claude
    let bin = root.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("claude.cmd"), "@echo FAKE-CLAUDE %*\r\n").unwrap();
    // portable-pty 는 Windows 셸 환경을 레지스트리(사용자 · 시스템 환경 변수)로 새로 만들어 이 프로세스의 PATH 를 물려주지 않는다.
    // 그래서 세션을 만들 때 PATH 를 넘긴다
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(std::iter::once(bin.clone()).chain(std::env::split_paths(&path))).unwrap().to_string_lossy().into_owned();

    let d = Daemon::bind(config(&data, Some(plugin))).unwrap();
    tokio::spawn(d.run());
    // 같은 데이터 폴더로 두 번째 데몬은 뜨지 않는다 (잠긴 파일을 읽지 못해 pid 는 모른다)
    assert!(matches!(Daemon::bind(config(&data, None)), Err(DaemonError::AlreadyRunning(_))));

    let c = Client::connect(&Paths::new(&data), "test").await.unwrap();

    // ConPTY 로 띄운 명령의 출력이 엔진 화면에 나온다
    let s = c
        .create(CreateSession {
            command: ["cmd", "/c", "echo hello-from-conpty & ping -n 30 127.0.0.1 >nul"].iter().map(|s| s.to_string()).collect(),
            cols: 80,
            rows: 10,
            ..Default::default()
        })
        .await
        .unwrap();
    wait_screen(&c, s.id, "hello-from-conpty").await;

    // 기본 셸은 PowerShell 이고, thuminal 의 claude 함수가 들어 있으며, 실행기가 플러그인 폴더를 붙인다
    let s = c.create(CreateSession { cols: 200, rows: 20, env: [("PATH".to_string(), path)].into(), ..Default::default() }).await.unwrap();
    wait_screen(&c, s.id, "PS ").await;
    c.send_text(s.id, "(Get-Command claude).CommandType\r").await.unwrap();
    wait_screen(&c, s.id, "Function").await;
    c.send_text(s.id, "claude hello\r").await.unwrap();
    let screen = wait_screen(&c, s.id, "FAKE-CLAUDE").await;
    assert!(screen.contains("--plugin-dir"), "실행기가 플러그인 폴더를 붙여야 한다:\n{screen}");
    assert!(screen.contains("hello"), "{screen}");
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// 워크트리 workspace 는 Windows 경로(`C:\…`)다. 그 워크트리에 세션과 새 탭이 들어가야 한다
/// (예전에는 `/` 로 시작해야 워크트리로 봐서 Windows 에서 탭을 만들지 못했다)
#[tokio::test(flavor = "multi_thread")]
async fn worktree_tabs_with_windows_paths() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    let data = root.path().join("data");
    let d = Daemon::bind(config(&data, None)).unwrap();
    tokio::spawn(d.run());
    let c = Client::connect(&Paths::new(&data), "test").await.unwrap();
    let r = c.add_repo(repo.to_string_lossy()).await.unwrap();
    let wt = c.create_worktree(r.id, "side".into(), None, None).await.unwrap();
    assert!(thuminal_protocol::is_worktree_workspace(&wt.path), "{}", wt.path);

    let cmd = |s: &str| ["cmd", "/c", s].iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let labels = [(WORKTREE_LABEL.to_string(), wt.path.clone())].into();
    c.create(CreateSession { command: cmd("ping -n 30 127.0.0.1 >nul"), cwd: Some(wt.path.clone()), labels, cols: 80, rows: 10, ..Default::default() })
        .await
        .unwrap();
    let tabs = |l: Vec<thuminal_protocol::WorkspaceLayout>| l.first().map_or(0, |l| l.tabs.len());
    assert_eq!(tabs(c.layouts(Some(wt.path.clone())).await.unwrap()), 1, "세션이 워크트리 탭에 들어가지 않았다");

    let spawn = Spawn { command: cmd("ping -n 30 127.0.0.1 >nul"), ..Default::default() };
    c.layout(LayoutOp::NewTab { workspace: wt.path.clone(), spawn, index: None, focus: true, title: None, doc: None }).await.unwrap();
    assert_eq!(tabs(c.layouts(Some(wt.path.clone())).await.unwrap()), 2, "워크트리에 새 탭을 만들지 못했다");
}
