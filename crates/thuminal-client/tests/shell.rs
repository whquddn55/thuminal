//! 셸 통합: 사용자 설정을 그대로 읽고, `claude` 에만 `--plugin-dir` 과 에이전트 설정 옵션이 붙는지 확인한다.
//! 환경 변수(HOME, SHELL, PATH)를 바꾸므로 이 파일에는 시험을 하나만 둔다.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use thuminal_client::Client;
use thuminal_daemon::{Daemon, DaemonConfig};
use thuminal_engine_ghostty::GhosttyFactory;
use thuminal_protocol::paths::Paths;
use thuminal_protocol::{CreateSession, ScreenFormat, SessionId};
use thuminal_pty_portable::PortablePty;

async fn wait_screen(c: &Client, s: SessionId, needle: &str) -> String {
    let mut last = String::new();
    for _ in 0..200 {
        last = c.read_screen(s, ScreenFormat::Plain, true).await.unwrap();
        if last.contains(needle) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    panic!("화면에 {needle:?} 이 나오지 않았다:\n{last}");
}

fn write(p: &Path, body: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// 셸을 띄우고 첫 프롬프트를 기다린 뒤 명령을 친다
async fn run_in_shell(c: &Client, shell: &str, line: &str, expect: &str) -> String {
    unsafe { std::env::set_var("SHELL", shell) };
    let s = c.create(CreateSession { cols: 200, rows: 20, ..Default::default() }).await.unwrap();
    wait_screen(c, s.id, "READY>").await;
    c.send_text(s.id, format!("{line}\n")).await.unwrap();
    wait_screen(c, s.id, expect).await
}

#[tokio::test(flavor = "multi_thread")]
async fn zsh_and_bash_read_user_config_and_wrap_claude() {
    let root = tempfile::Builder::new().prefix("thm").tempdir_in("/tmp").unwrap();
    let home = root.path().join("home");
    let bin = root.path().join("bin");
    let plugin = root.path().join("plugin");
    std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    // 받은 인자를 그대로 찍는 가짜 claude
    write(&bin.join("claude"), "#!/bin/sh\necho \"FAKE-CLAUDE $*\"\n");
    std::process::Command::new("chmod").arg("+x").arg(bin.join("claude")).status().unwrap();

    // 사용자 설정: 단계마다 표시를 남기고, claude 별칭과 PATH 바꾸기를 둔다
    write(&home.join(".zshenv"), "export MARK_ENV=1\n");
    write(&home.join(".zprofile"), "export MARK_PROFILE=1\nexport PATH=\"/opt/elsewhere:$PATH\"\n");
    write(&home.join(".zshrc"), "export MARK_RC=1\nalias claude='claude --user-alias'\nPROMPT='READY> '\n");
    write(&home.join(".zlogin"), "export MARK_LOGIN=1\n");
    // Debian 의 /etc/profile 은 PATH 를 새로 정하므로, 실제 사용자처럼 프로필에서 PATH 를 더한다
    write(&home.join(".bash_profile"), &format!("export MARK_PROFILE=1\nexport PATH=\"{}:$PATH\"\n[ -f ~/.bashrc ] && . ~/.bashrc\n", bin.display()));
    write(&home.join(".bashrc"), "export MARK_RC=1\nalias claude='claude --user-alias'\nPS1='READY> '\n");

    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin.display()));
        std::env::remove_var("ZDOTDIR");
    }

    let data = root.path().join("data");
    let d = Daemon::bind(DaemonConfig {
        paths: Paths::new(&data),
        engine: Arc::new(GhosttyFactory),
        pty: Arc::new(PortablePty),
        vcs: Arc::new(thuminal_vcs_git::GitCli),
        claude_plugin: Some(plugin.clone()),
        web_root: None,
    })
    .unwrap();
    tokio::spawn(d.run());
    let c = Client::connect(&Paths::new(&data), "test").await.unwrap();
    // 실행기는 원본 대신 데몬이 짠 플러그인 폴더(켠 스킬만)를 얹는다
    let plugin_s = data.join("shell/claude-plugin").to_string_lossy().into_owned();

    // zsh: 네 단계 설정을 다 읽고, ZDOTDIR 는 원래대로(없음), claude 에 별칭과 플러그인이 붙는다
    let screen = run_in_shell(
        &c,
        "/bin/zsh",
        "echo \"Z:$MARK_ENV$MARK_PROFILE$MARK_RC$MARK_LOGIN zd=${ZDOTDIR-unset}\"; claude hello",
        "FAKE-CLAUDE",
    )
    .await;
    assert!(screen.contains("Z:1111 zd=unset"), "zsh 사용자 설정을 다 읽지 않았다:\n{screen}");
    assert!(
        screen.contains(&format!("FAKE-CLAUDE --plugin-dir {plugin_s} --dangerously-skip-permissions --user-alias hello")),
        "zsh 의 claude 에 플러그인이 붙지 않았다:\n{screen}"
    );

    // bash: 로그인 파일과 .bashrc 를 읽고, claude 에 별칭과 플러그인이 붙는다
    let screen = run_in_shell(&c, "/bin/bash", "echo \"B:$MARK_PROFILE$MARK_RC\"; claude hi", "FAKE-CLAUDE").await;
    assert!(screen.contains("B:11"), "bash 사용자 설정을 다 읽지 않았다:\n{screen}");
    assert!(
        screen.contains(&format!("FAKE-CLAUDE --plugin-dir {plugin_s} --dangerously-skip-permissions --user-alias hi")),
        "bash 의 claude 에 플러그인이 붙지 않았다:\n{screen}"
    );

    // `term new -- claude …` 처럼 바로 띄우는 claude 에도 붙는다
    let s = c
        .create(CreateSession { command: vec![bin.join("claude").to_string_lossy().into_owned(), "direct".into()], cols: 200, rows: 5, ..Default::default() })
        .await
        .unwrap();
    let screen = wait_screen(&c, s.id, "FAKE-CLAUDE").await;
    assert!(screen.contains(&format!("FAKE-CLAUDE --plugin-dir {plugin_s} --dangerously-skip-permissions direct")), "{screen}");
}
