//! 셸 통합: thuminal 이 띄운 셸에만 기능을 더한다.
//!
//! 지금 더하는 것은 `claude` 함수 하나다. thuminal 안에서 `claude` 를 치면 실행기 `shell/claude-launch` 가
//! `--plugin-dir <thuminal claude 플러그인>` 을 붙여, 그 실행에만 훅이 들어간다.
//! Claude Code 설정(~/.claude)에는 아무것도 설치하지 않는다.
//! 실행기는 에이전트 설정(`agent-settings.json`)이 바뀔 때마다 다시 쓴다. 함수가 부를 때마다 실행기를 돌리므로
//! 설정을 바꾸면 이미 뜬 셸에서 치는 `claude` 에도 바로 들어간다.
//! - 권한: `--dangerously-skip-permissions`
//! - 휠 가속 끄기: 앱이 휠 이벤트 하나에 휠 신호 하나를 보내므로(xterm.js 와 같다) claude 가 더 가속하지 않게 한다.
//!   claude 는 xterm.js(Orca)에서는 가속하지 않는데, thuminal 은 일반 터미널로 보고 신호마다 최대 6줄까지 가속해
//!   한 번 쓸면 Orca 의 열 배 넘게 날아갔다
//! - 에이전트 팀: 팀 환경 변수를 켜고, 가짜 `tmux`(`shell/teams-bin/tmux` → `thuminal tmux`)를 claude 에게만 보인다.
//!   claude 가 tmux 안이라고 믿고 팀원 칸을 나누려 하면 데몬이 팀원 세션을 띄운다 (`teams.rs`).
//!
//! - zsh: `ZDOTDIR` 를 thuminal 폴더로 돌려 우리 `.zshenv` 를 먼저 읽게 한다. 거기서 `ZDOTDIR` 를
//!   원래대로 되돌리고 사용자의 `.zshenv` 를 읽는다. 그 뒤 `.zprofile`, `.zshrc`, `.zlogin` 은 zsh 가
//!   사용자 폴더에서 그대로 읽는다. 함수는 첫 프롬프트 직전에 정의해 사용자 설정보다 나중에 들어간다.
//! - bash: `--rcfile` 로 우리 파일을 읽게 하고, 거기서 로그인 셸이 읽는 파일과 `.bashrc` 를 차례로 읽은 뒤 함수를 정의한다.
//! - 그 밖의 셸: 아무것도 더하지 않는다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use thuminal_protocol::AgentSettings;
use tracing::{info, warn};

#[derive(Debug, Default)]
pub struct ShellIntegration {
    /// thuminal claude 플러그인 폴더. 없으면 claude 함수를 넣지 않는다
    pub claude_plugin: Option<PathBuf>,
    /// 셸 통합 파일을 쓸 폴더 (데이터 폴더/shell)
    dir: PathBuf,
    settings: Mutex<AgentSettings>,
    settings_file: PathBuf,
}

const ZSHENV: &str = r#"# thuminal 셸 통합 (데몬이 만든 파일이다. 고치지 않는다)
# 사용자 설정을 먼저 그대로 읽고, 첫 프롬프트 직전에 thuminal 기능을 더한다.
if [[ -n "${THUMINAL_ZDOTDIR_ORIG-}" ]]; then
  ZDOTDIR="$THUMINAL_ZDOTDIR_ORIG"
else
  unset ZDOTDIR
fi
unset THUMINAL_ZDOTDIR_ORIG
[[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

if [[ -o interactive ]]; then
  _thuminal_init() {
    precmd_functions=(${precmd_functions:#_thuminal_init})
    unfunction _thuminal_init
    if [[ -n "${THUMINAL_CLAUDE_LAUNCH-}" && -x "$THUMINAL_CLAUDE_LAUNCH" ]]; then
      function claude { "$THUMINAL_CLAUDE_LAUNCH" "$@" }
    fi
  }
  typeset -ga precmd_functions
  precmd_functions+=(_thuminal_init)
fi
"#;

const BASHRC: &str = r#"# thuminal 셸 통합 (데몬이 만든 파일이다. 고치지 않는다)
# 로그인 셸이 읽는 파일과 .bashrc 를 그대로 읽은 뒤 thuminal 기능을 더한다.
[ -f /etc/profile ] && . /etc/profile
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"
fi
# .bash_profile 이 .bashrc 를 읽지 않는 흔한 경우를 위해 한 번 더 확인한다
if [ -z "${_THUMINAL_BASHRC_DONE-}" ] && [ -f "$HOME/.bashrc" ]; then
  _THUMINAL_BASHRC_DONE=1
  case "$(cat "$HOME/.bash_profile" 2>/dev/null)" in
    *bashrc*) ;;
    *) . "$HOME/.bashrc" ;;
  esac
fi
# `claude() {` 로 쓰면 사용자가 둔 claude 별칭이 펼쳐져 문법 오류가 난다. function 키워드로 정의한다
if [ -n "${THUMINAL_CLAUDE_LAUNCH-}" ] && [ -x "$THUMINAL_CLAUDE_LAUNCH" ]; then
  function claude { "$THUMINAL_CLAUDE_LAUNCH" "$@"; }
fi
"#;

const TMUX_SHIM: &str = r#"#!/bin/sh
# thuminal 에이전트 팀: claude 가 부르는 tmux 명령을 thuminal 데몬으로 넘긴다 (데몬이 만든 파일이다. 고치지 않는다)
exec "${THUMINAL_CLI:-thuminal}" tmux "$@"
"#;

/// sh 작은따옴표로 감싼다
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn set_exec(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
}

impl ShellIntegration {
    pub fn new(home: &Path, claude_plugin: Option<PathBuf>) -> Self {
        let settings_file = home.join("agent-settings.json");
        let settings = std::fs::read(&settings_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { claude_plugin, dir: home.join("shell"), settings: Mutex::new(settings), settings_file }
    }

    pub fn settings(&self) -> AgentSettings {
        self.settings.lock().unwrap().clone()
    }

    /// 설정을 저장하고 claude 실행기를 다시 쓴다
    pub fn set_settings(&self, settings: AgentSettings) {
        *self.settings.lock().unwrap() = settings.clone();
        let tmp = self.settings_file.with_extension("json.tmp");
        let r = std::fs::write(&tmp, serde_json::to_vec_pretty(&settings).unwrap()).and_then(|_| std::fs::rename(&tmp, &self.settings_file));
        if let Err(e) = r {
            warn!(event = "agent_settings_save_failed", error = %e);
        }
        self.write_launcher();
        info!(event = "agent_settings_set", ?settings);
    }

    /// claude 실행기. 설정을 바꾸면 다시 쓴다
    fn launcher(&self) -> String {
        let s = self.settings.lock().unwrap();
        let mut out = String::from(
            "#!/bin/sh\n# thuminal 이 에이전트 설정(agent-settings.json)으로 만든 claude 실행기 (데몬이 만든 파일이다. 고치지 않는다)\n",
        );
        out.push_str(&format!("set -- --settings {} \"$@\"\n", sh_quote(r#"{"wheelScrollAccelerationEnabled":false}"#)));
        if s.claude.skip_permissions {
            out.push_str("set -- --dangerously-skip-permissions \"$@\"\n");
        }
        if s.claude.teams {
            // 진짜 tmux 안에서 띄우면 claude 가 그 tmux 를 쓰게 둔다
            out.push_str(&format!(
                r#"export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
if [ -z "${{TMUX-}}" ] && [ -n "${{THUMINAL_SESSION_ID-}}" ] && [ -n "${{THUMINAL_CLI-}}" ]; then
  TMUX={tmux},$$,0 TMUX_PANE="%$THUMINAL_SESSION_ID" PATH={bin}:"$PATH"
  export TMUX TMUX_PANE PATH
  set -- --teammate-mode auto "$@"
fi
"#,
                tmux = sh_quote(&self.dir.join("tmux").to_string_lossy()),
                bin = sh_quote(&self.teams_bin().to_string_lossy()),
            ));
        }
        if let Some(p) = &self.claude_plugin {
            out.push_str(&format!("[ -d {p} ] && set -- --plugin-dir {p} \"$@\"\n", p = sh_quote(&p.to_string_lossy())));
        }
        out.push_str("exec claude \"$@\"\n");
        out
    }

    fn launcher_file(&self) -> PathBuf {
        self.dir.join("claude-launch")
    }

    fn teams_bin(&self) -> PathBuf {
        self.dir.join("teams-bin")
    }

    fn write_launcher(&self) {
        let p = self.launcher_file();
        let tmp = p.with_extension("tmp");
        let r = std::fs::write(&tmp, self.launcher()).and_then(|_| set_exec(&tmp)).and_then(|_| std::fs::rename(&tmp, &p));
        if let Err(e) = r {
            warn!(event = "claude_launcher_write_failed", path = %p.display(), error = %e);
        }
    }

    /// 셸 통합 파일을 쓴다. 데몬이 뜰 때마다 다시 써서 데몬 버전과 늘 맞춘다
    pub fn install(&self) {
        let write = |rel: &str, body: &str| {
            let p = self.dir.join(rel);
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(&p, body) {
                warn!(event = "shell_integration_write_failed", path = %p.display(), error = %e);
            }
        };
        write("zsh/.zshenv", ZSHENV);
        write("bash/rc", BASHRC);
        write("teams-bin/tmux", TMUX_SHIM);
        let _ = set_exec(&self.teams_bin().join("tmux"));
        self.write_launcher();
        info!(event = "shell_integration_ready", claude_plugin = ?self.claude_plugin);
    }

    /// 새 세션에 넣을 환경 변수와, 기본 셸이면 셸 명령을 정한다.
    /// `command` 가 비면 사용자 로그인 셸을 띄우는 자리다.
    pub fn apply(&self, command: &mut Vec<String>, env: &mut BTreeMap<String, String>) {
        if let Some(p) = &self.claude_plugin {
            env.insert("THUMINAL_CLAUDE_PLUGIN".into(), p.to_string_lossy().into_owned());
        }
        env.insert("THUMINAL_CLAUDE_LAUNCH".into(), self.launcher_file().to_string_lossy().into_owned());
        // `term new -- claude …` 처럼 claude 를 바로 띄우면 실행기로 띄운다
        if command.first().is_some_and(|c| c.rsplit('/').next() == Some("claude")) {
            command[0] = self.launcher_file().to_string_lossy().into_owned();
        }
        if !command.is_empty() {
            return;
        }
        let shell = std::env::var("SHELL").unwrap_or_default();
        match shell.rsplit('/').next() {
            Some("zsh") => {
                if let Ok(orig) = std::env::var("ZDOTDIR") {
                    env.insert("THUMINAL_ZDOTDIR_ORIG".into(), orig);
                }
                env.insert("ZDOTDIR".into(), self.dir.join("zsh").to_string_lossy().into_owned());
            }
            Some("bash") => {
                *command = vec![shell.clone(), "--rcfile".into(), self.dir.join("bash/rc").to_string_lossy().into_owned(), "-i".into()];
            }
            _ => {}
        }
    }
}

/// 사용자 로그인 셸의 PATH 에서 찾을 수 있는 명령만 돌려준다.
/// PATH 를 .zshrc 에서 정하는 사람이 많아 대화형 로그인 셸(-ilc)로 묻는다. 3초 안에 답이 없으면 빈 목록이다.
pub fn find_commands(names: &[String]) -> Vec<String> {
    let names: Vec<&String> = names.iter().filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).collect();
    if names.is_empty() {
        return Vec::new();
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = r#"for c in "$@"; do command -v -- "$c" >/dev/null 2>&1 && printf 'thuminal-found:%s\n' "$c"; done"#;
    let child = std::process::Command::new(&shell)
        .args(["-ilc", script, "sh"])
        .args(names.iter().map(|s| s.as_str()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return Vec::new() };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return Vec::new();
            }
        }
    }
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut so, &mut out);
    }
    out.lines().filter_map(|l| l.strip_prefix("thuminal-found:")).filter(|n| names.iter().any(|x| x.as_str() == *n)).map(str::to_string).collect()
}

#[cfg(test)]
mod find_tests {
    #[test]
    fn finds_sh_but_not_nonsense() {
        let found = super::find_commands(&["sh".into(), "thuminal-no-such-cmd".into(), "bad name".into()]);
        assert_eq!(found, vec!["sh".to_string()]);
    }
}

#[cfg(test)]
mod launcher_tests {
    use super::*;

    /// 가짜 claude 를 PATH 에 두고 실행기를 돌려, claude 가 받은 인자와 팀 환경을 돌려준다
    fn run(shell: &ShellIntegration, home: &Path, extra_env: &[(&str, &str)]) -> String {
        let bin = home.join("fakebin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("claude"), "#!/bin/sh\necho \"$* | TMUX_PANE=${TMUX_PANE-} TEAMS=${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS-}\"\n").unwrap();
        set_exec(&bin.join("claude")).unwrap();
        let mut command = vec!["claude".to_string(), "--resume".into(), "x".into()];
        shell.apply(&mut command, &mut BTreeMap::new());
        let out = std::process::Command::new(&command[0])
            .args(&command[1..])
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .env_remove("THUMINAL_SESSION_ID")
            .env_remove("THUMINAL_CLI")
            .env_remove("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")
            .envs(extra_env.iter().copied())
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn launcher_follows_settings() {
        let home = tempfile::tempdir().unwrap();
        let plugin = home.path().join("plugin");
        std::fs::create_dir_all(&plugin).unwrap();
        let shell = ShellIntegration::new(home.path(), Some(plugin.clone()));
        shell.install();
        let p = plugin.to_string_lossy().into_owned();
        let in_session = [("THUMINAL_SESSION_ID", "7"), ("THUMINAL_CLI", "/x/thuminal")];
        const W: &str = r#"--settings {"wheelScrollAccelerationEnabled":false}"#;

        // 기본: 권한 확인 없이 + 팀 (세션 안에서만 tmux 흉내)
        assert_eq!(
            run(&shell, home.path(), &in_session),
            format!("--plugin-dir {p} --teammate-mode auto --dangerously-skip-permissions {W} --resume x | TMUX_PANE=%7 TEAMS=1")
        );
        assert_eq!(run(&shell, home.path(), &[]), format!("--plugin-dir {p} --dangerously-skip-permissions {W} --resume x | TMUX_PANE= TEAMS=1"));

        let mut off = AgentSettings::default();
        off.claude.skip_permissions = false;
        off.claude.teams = false;
        shell.set_settings(off.clone());
        assert_eq!(run(&shell, home.path(), &in_session), format!("--plugin-dir {p} {W} --resume x | TMUX_PANE= TEAMS="));
        // 데몬이 다시 떠도 남는다
        assert_eq!(ShellIntegration::new(home.path(), None).settings(), off);
    }
}
