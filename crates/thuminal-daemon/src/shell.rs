//! 셸 통합: thuminal 이 띄운 셸에만 기능을 더한다.
//!
//! 지금 더하는 것은 `claude` 함수 하나다. thuminal 안에서 `claude` 를 치면
//! `--plugin-dir <thuminal claude 플러그인>` 이 붙어, 그 실행에만 훅이 들어간다.
//! Claude Code 설정(~/.claude)에는 아무것도 설치하지 않는다.
//!
//! - zsh: `ZDOTDIR` 를 thuminal 폴더로 돌려 우리 `.zshenv` 를 먼저 읽게 한다. 거기서 `ZDOTDIR` 를
//!   원래대로 되돌리고 사용자의 `.zshenv` 를 읽는다. 그 뒤 `.zprofile`, `.zshrc`, `.zlogin` 은 zsh 가
//!   사용자 폴더에서 그대로 읽는다. 함수는 첫 프롬프트 직전에 정의해 사용자 설정보다 나중에 들어간다.
//! - bash: `--rcfile` 로 우리 파일을 읽게 하고, 거기서 로그인 셸이 읽는 파일과 `.bashrc` 를 차례로 읽은 뒤 함수를 정의한다.
//! - 그 밖의 셸: 아무것도 더하지 않는다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

#[derive(Debug, Clone, Default)]
pub struct ShellIntegration {
    /// thuminal claude 플러그인 폴더. 없으면 claude 함수를 넣지 않는다
    pub claude_plugin: Option<PathBuf>,
    /// 셸 통합 파일을 쓸 폴더 (데이터 폴더/shell)
    dir: PathBuf,
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
    if [[ -n "${THUMINAL_CLAUDE_PLUGIN-}" && -d "$THUMINAL_CLAUDE_PLUGIN" ]]; then
      function claude { command claude --plugin-dir "$THUMINAL_CLAUDE_PLUGIN" "$@" }
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
if [ -n "${THUMINAL_CLAUDE_PLUGIN-}" ] && [ -d "$THUMINAL_CLAUDE_PLUGIN" ]; then
  function claude { command claude --plugin-dir "$THUMINAL_CLAUDE_PLUGIN" "$@"; }
fi
"#;

impl ShellIntegration {
    pub fn new(home: &Path, claude_plugin: Option<PathBuf>) -> Self {
        Self { claude_plugin, dir: home.join("shell") }
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
        info!(event = "shell_integration_ready", claude_plugin = ?self.claude_plugin);
    }

    /// 새 세션에 넣을 환경 변수와, 기본 셸이면 셸 명령을 정한다.
    /// `command` 가 비면 사용자 로그인 셸을 띄우는 자리다.
    pub fn apply(&self, command: &mut Vec<String>, env: &mut BTreeMap<String, String>) {
        if let Some(p) = &self.claude_plugin {
            env.insert("THUMINAL_CLAUDE_PLUGIN".into(), p.to_string_lossy().into_owned());
            // `term new -- claude …` 처럼 claude 를 바로 띄우면 여기서 옵션을 붙인다
            if command.first().is_some_and(|c| c.rsplit('/').next() == Some("claude")) {
                command.splice(1..1, ["--plugin-dir".to_string(), p.to_string_lossy().into_owned()]);
            }
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
