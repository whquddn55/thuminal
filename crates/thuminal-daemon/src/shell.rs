//! 셸 통합: thuminal 이 띄운 셸에만 기능을 더한다.
//!
//! 지금 더하는 것은 `claude` 함수 하나다. thuminal 안에서 `claude` 를 치면 실행기 `shell/claude-launch` 가
//! `--plugin-dir <thuminal claude 플러그인>` 을 붙여, 그 실행에만 훅이 들어간다.
//! Claude Code 설정(~/.claude)에는 아무것도 설치하지 않는다.
//! 실행기는 에이전트 설정(`agent-settings.json`)이 바뀔 때마다 다시 쓴다. 함수가 부를 때마다 실행기를 돌리므로
//! 설정을 바꾸면 이미 뜬 셸에서 치는 `claude` 에도 바로 들어간다.
//! - 스킬: 플러그인의 `skills/` 중 설정에서 끈 것을 뺀다. 실행기는 원본 플러그인 대신 `shell/claude-plugin` 을 얹는다.
//!   그 폴더의 `skills` 는 켠 스킬만 링크한 `skills.<번호>` 를 가리키는 링크이고, 설정이 바뀌면 그 링크만 바꿔 끼운다
//!   (떠 있는 claude 의 훅 경로 `${CLAUDE_PLUGIN_ROOT}/hooks/…` 가 끊기지 않게 한다).
//! - 권한: `--dangerously-skip-permissions`
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

use thuminal_protocol::{AgentSettings, PluginSkill};
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
        if let Some(p) = self.plugin_dir() {
            out.push_str(&format!("[ -d {p} ] && set -- --plugin-dir {p} \"$@\"\n", p = sh_quote(&p.to_string_lossy())));
        }
        out.push_str("exec claude \"$@\"\n");
        out
    }

    /// 플러그인에 든 스킬들 (`skills/<이름>/SKILL.md`, 이름 순)
    pub fn skills(&self) -> Vec<PluginSkill> {
        let Some(src) = &self.claude_plugin else { return Vec::new() };
        let mut out: Vec<PluginSkill> = std::fs::read_dir(src.join("skills"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let md = std::fs::read_to_string(e.path().join("SKILL.md")).ok()?;
                Some(PluginSkill { description: frontmatter(&md, "description").unwrap_or_default(), name })
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// 실행기가 얹는 플러그인 폴더. 짜 둔 `shell/claude-plugin` 이 있으면 그것, 아니면 원본
    fn plugin_dir(&self) -> Option<PathBuf> {
        self.claude_plugin.as_ref()?;
        let built = self.dir.join("claude-plugin");
        Some(if built.join("skills").exists() { built } else { self.claude_plugin.clone()? })
    }

    /// `shell/claude-plugin` 을 원본에 맞춰 다시 짠다. 스킬 말고는 원본으로 가는 링크다
    fn build_plugin(&self) -> std::io::Result<()> {
        use std::os::unix::fs::symlink;
        let Some(src) = &self.claude_plugin else { return Ok(()) };
        let root = self.dir.join("claude-plugin");
        std::fs::create_dir_all(&root)?;
        let disabled = self.settings.lock().unwrap().claude.disabled_skills.clone();
        // 원본 맨 위 항목마다 링크 (스킬 폴더는 따로). 원본에서 사라진 것은 지운다
        let mut keep = vec![std::ffi::OsString::from("skills")];
        for e in std::fs::read_dir(src)?.flatten() {
            let name = e.file_name();
            if name == "skills" {
                continue;
            }
            let link = root.join(&name);
            if std::fs::read_link(&link).ok().as_deref() != Some(e.path().as_path()) {
                let _ = std::fs::remove_file(&link);
                symlink(e.path(), &link)?;
            }
            keep.push(name);
        }
        for e in std::fs::read_dir(&root)?.flatten() {
            let name = e.file_name();
            if !keep.contains(&name) && !name.to_string_lossy().starts_with("skills.") {
                let _ = std::fs::remove_file(e.path());
            }
        }
        // 켠 스킬만 든 새 skills.<번호> 를 만들고 skills 링크를 바꿔 끼운다
        let fresh = format!("skills.{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        let dir = root.join(&fresh);
        std::fs::create_dir_all(&dir)?;
        for skill in self.skills() {
            if !disabled.contains(&skill.name) {
                symlink(src.join("skills").join(&skill.name), dir.join(&skill.name))?;
            }
        }
        let tmp = root.join("skills.link-tmp");
        let _ = std::fs::remove_file(&tmp);
        symlink(&fresh, &tmp)?;
        std::fs::rename(&tmp, root.join("skills"))?;
        // 옛 skills.<번호> 는 지운다 (안에는 링크뿐이다)
        for e in std::fs::read_dir(&root)?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("skills.") && name != fresh && name != "skills.link-tmp" {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
        Ok(())
    }

    fn launcher_file(&self) -> PathBuf {
        self.dir.join("claude-launch")
    }

    fn teams_bin(&self) -> PathBuf {
        self.dir.join("teams-bin")
    }

    fn write_launcher(&self) {
        if let Err(e) = self.build_plugin() {
            warn!(event = "claude_plugin_build_failed", error = %e);
        }
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

/// SKILL.md 머리(`---` 사이)에서 `key: 값` 을 읽는다. 따옴표는 벗기고, 여러 줄 값(`>-`, `|` 처럼 다음 줄들을
/// 들여 쓴 것)은 한 줄로 잇는다
fn frontmatter(md: &str, key: &str) -> Option<String> {
    let body = md.strip_prefix("---")?;
    let head = &body[..body.find("\n---")?];
    let mut lines = head.lines().skip_while(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(':')).is_none());
    let v = lines.next()?[key.len() + 1..].trim();
    if matches!(v, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
        let parts: Vec<&str> = lines.take_while(|l| l.is_empty() || l.starts_with(' ') || l.starts_with('\t')).map(str::trim).filter(|l| !l.is_empty()).collect();
        return Some(parts.join(" "));
    }
    Some(v.trim_matches(|c| c == '"' || c == '\'').to_string())
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
        // 원본 대신 데몬이 짠 플러그인 폴더를 얹는다
        let p = home.path().join("shell/claude-plugin").to_string_lossy().into_owned();
        let in_session = [("THUMINAL_SESSION_ID", "7"), ("THUMINAL_CLI", "/x/thuminal")];

        // 기본: 권한 확인 없이 + 팀 (세션 안에서만 tmux 흉내)
        assert_eq!(
            run(&shell, home.path(), &in_session),
            format!("--plugin-dir {p} --teammate-mode auto --dangerously-skip-permissions --resume x | TMUX_PANE=%7 TEAMS=1")
        );
        assert_eq!(run(&shell, home.path(), &[]), format!("--plugin-dir {p} --dangerously-skip-permissions --resume x | TMUX_PANE= TEAMS=1"));

        let mut off = AgentSettings::default();
        off.claude.skip_permissions = false;
        off.claude.teams = false;
        shell.set_settings(off.clone());
        assert_eq!(run(&shell, home.path(), &in_session), format!("--plugin-dir {p} --resume x | TMUX_PANE= TEAMS="));
        // 데몬이 다시 떠도 남는다
        assert_eq!(ShellIntegration::new(home.path(), None).settings(), off);
    }

    #[test]
    fn plugin_drops_disabled_skills() {
        let home = tempfile::tempdir().unwrap();
        let plugin = home.path().join("plugin");
        for (name, desc) in [("new-work", ">-\n  새 브랜치를 따고\n  claude 를 띄운다\nargument-hint: x"), ("agenda-picker", "\"안건 고르기\"")] {
            std::fs::create_dir_all(plugin.join("skills").join(name)).unwrap();
            std::fs::write(plugin.join("skills").join(name).join("SKILL.md"), format!("---\nname: {name}\ndescription: {desc}\n---\n\n본문\n")).unwrap();
        }
        std::fs::create_dir_all(plugin.join("hooks")).unwrap();
        std::fs::write(plugin.join("hooks/report.sh"), "#!/bin/sh\n").unwrap();
        let shell = ShellIntegration::new(home.path(), Some(plugin.clone()));
        shell.install();

        let names = |s: &ShellIntegration| s.skills().into_iter().map(|k| (k.name, k.description)).collect::<Vec<_>>();
        assert_eq!(names(&shell), [("agenda-picker".to_string(), "안건 고르기".to_string()), ("new-work".into(), "새 브랜치를 따고 claude 를 띄운다".into())]);
        let built = home.path().join("shell/claude-plugin");
        let listed = || {
            let mut v: Vec<String> = std::fs::read_dir(built.join("skills")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            v.sort();
            v
        };
        assert_eq!(listed(), ["agenda-picker", "new-work"]);
        assert!(built.join("hooks/report.sh").exists(), "스킬 말고는 원본으로 가는 링크다");
        assert!(built.join("skills/new-work/SKILL.md").exists());

        let mut s = AgentSettings::default();
        s.claude.disabled_skills = vec!["agenda-picker".into()];
        shell.set_settings(s.clone());
        assert_eq!(listed(), ["new-work"]);
        // 옛 skills.<번호> 는 남지 않는다
        let gens = std::fs::read_dir(&built).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("skills.")).count();
        assert_eq!(gens, 1);

        s.claude.disabled_skills.clear();
        shell.set_settings(s);
        assert_eq!(listed(), ["agenda-picker", "new-work"]);
    }
}
