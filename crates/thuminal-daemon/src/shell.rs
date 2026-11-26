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
//! - Windows: PowerShell(`pwsh.exe`, 없으면 `powershell.exe`)을 띄운다. 사용자 `$PROFILE` 은 PowerShell 이 그대로 읽고,
//!   그 뒤 `-Command` 로 우리 `pwsh/profile.ps1` 을 읽어 함수를 정의한다. Windows 기본 실행 정책(Restricted)은 스크립트를
//!   막으므로 thuminal 이 띄우는 PowerShell 에만 `-ExecutionPolicy Bypass` 를 준다. 실행기는 `claude-launch.ps1` 이다.
//!   에이전트 팀(가짜 tmux)은 Windows 에서 아직 켜지 않는다.
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

const PWSH_PROFILE: &str = r#"# thuminal 셸 통합 (데몬이 만든 파일이다. 고치지 않는다)
# 사용자 $PROFILE 을 읽은 뒤 thuminal 이 이 파일을 읽어 기능을 더한다.
if ($env:THUMINAL_CLAUDE_LAUNCH -and (Test-Path -LiteralPath $env:THUMINAL_CLAUDE_LAUNCH)) {
  function global:claude { & $env:THUMINAL_CLAUDE_LAUNCH @args }
}
# 프롬프트마다 작업 폴더를 OSC 7 로 알린다 (데몬이 세션 폴더 · 워크트리를 안다). 사용자 프롬프트(oh-my-posh 등)는 감싸서 그대로 쓴다
if (-not $global:__thuminal_prompt) {
  $global:__thuminal_prompt = $function:prompt
  function global:prompt {
    $loc = $executionContext.SessionState.Path.CurrentLocation
    $osc = ''
    if ($loc.Provider.Name -eq 'FileSystem' -and $loc.ProviderPath -match '^[A-Za-z]:') {
      $p = [uri]::EscapeDataString($loc.ProviderPath.Replace('\', '/')) -replace '%2F', '/' -replace '%3A', ':'
      $osc = "$([char]27)]7;file://localhost/$p$([char]7)"
    }
    $osc + (& $global:__thuminal_prompt)
  }
}
"#;

const TMUX_SHIM: &str = r#"#!/bin/sh
# thuminal 에이전트 팀: claude 가 부르는 tmux 명령을 thuminal 데몬으로 넘긴다 (데몬이 만든 파일이다. 고치지 않는다)
exec "${THUMINAL_CLI:-thuminal}" tmux "$@"
"#;

/// sh 작은따옴표로 감싼다
#[cfg_attr(windows, allow(dead_code))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// PowerShell 작은따옴표로 감싼다
#[cfg_attr(not(windows), allow(dead_code))]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 명령 첫 낱말이 claude 인지 (`/…/claude`, `C:\…\claude.exe`, `claude.cmd` 도)
fn is_claude(program: &str) -> bool {
    let base = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".cmd")).unwrap_or(base);
    base == "claude"
}

/// Windows 에서 띄울 PowerShell. `pwsh.exe`(PowerShell 7)가 PATH 에 있으면 그것, 없으면 Windows 에 들어 있는 `powershell.exe`
#[cfg(windows)]
fn powershell() -> String {
    std::env::var_os("PATH")
        .and_then(|path| std::env::split_paths(&path).map(|d| d.join("pwsh.exe")).find(|p| p.is_file()))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "powershell.exe".into())
}

fn set_exec(p: &Path) -> std::io::Result<()> {
    crate::sys::set_mode(p, 0o755)
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
    #[cfg(unix)]
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
        // 상태 줄 명령을 thuminal 것으로 바꿔 claude 가 주는 모델 · 컨텍스트 · 사용량을 데몬이 받게 한다 (대화 보기 상태 줄).
        // 그 명령이 사용자의 원래 상태 줄 명령을 이어 돌리므로 터미널 화면은 그대로다. thuminal 세션 안에서만 건다
        out.push_str(&format!(
            "if [ -n \"${{THUMINAL_SESSION_ID-}}\" ] && [ -n \"${{THUMINAL_CLI-}}\" ]; then\n  set -- --settings {json} \"$@\"\nfi\n",
            json = sh_quote(&statusline_settings()),
        ));
        out.push_str("exec claude \"$@\"\n");
        out
    }

    /// claude 실행기 (PowerShell). 에이전트 팀은 유닉스와 같게 가짜 tmux(`teams-bin\tmux.exe`)를 쓴다
    #[cfg(windows)]
    fn launcher(&self) -> String {
        let s = self.settings.lock().unwrap();
        // Windows PowerShell 5.1 은 BOM 없는 .ps1 을 시스템 코드 페이지(CP949 등)로 읽어 한글이 깨지고 따옴표까지 어긋난다
        let mut out = String::from("\u{feff}# thuminal 이 에이전트 설정(agent-settings.json)으로 만든 claude 실행기 (데몬이 만든 파일이다. 고치지 않는다)\n$a = @($args)\n");
        if s.claude.skip_permissions {
            out.push_str("$a = @('--dangerously-skip-permissions') + $a\n");
        }
        if s.claude.teams {
            // 진짜 tmux 안이면 그 tmux 를 쓰게 둔다. 여기서 바꾼 환경은 아래에서 띄우는 claude 가 물려받는다
            out.push_str(&format!(
                r#"$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
if (-not $env:TMUX -and $env:THUMINAL_SESSION_ID -and $env:THUMINAL_CLI) {{
  $env:TMUX = {tmux} + ",$PID,0"
  $env:TMUX_PANE = '%' + $env:THUMINAL_SESSION_ID
  $env:PATH = {bin} + ';' + $env:PATH
  $a = @('--teammate-mode', 'auto') + $a
}}
"#,
                tmux = ps_quote(&self.dir.join("tmux").to_string_lossy()),
                bin = ps_quote(&self.teams_bin().to_string_lossy()),
            ));
        }
        if let Some(p) = self.plugin_dir() {
            out.push_str(&format!("if (Test-Path -LiteralPath {p}) {{ $a = @('--plugin-dir', {p}) + $a }}\n", p = ps_quote(&p.to_string_lossy())));
        }
        // 셸의 claude 함수(이 실행기를 부른다)를 다시 부르지 않게 실행 파일만 찾는다
        out.push_str("$claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n");
        out.push_str("if (-not $claude) { Write-Error 'claude 를 찾지 못했어요'; exit 127 }\n");
        out.push_str("& $claude.Source @a\nexit $LASTEXITCODE\n");
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
    pub fn plugin_dir(&self) -> Option<PathBuf> {
        self.claude_plugin.as_ref()?;
        let built = self.dir.join("claude-plugin");
        Some(if built.join("skills").exists() { built } else { self.claude_plugin.clone()? })
    }

    /// `shell/claude-plugin` 을 원본에 맞춰 다시 짠다. 스킬 말고는 원본으로 가는 링크다
    #[cfg(unix)]
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

    /// Windows 는 심볼릭 링크에 관리자 권한(또는 개발자 모드)이 들어 원본을 통째로 복사해 짠다 (켠 스킬만)
    #[cfg(windows)]
    fn build_plugin(&self) -> std::io::Result<()> {
        fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
            std::fs::create_dir_all(to)?;
            for e in std::fs::read_dir(from)?.flatten() {
                let dest = to.join(e.file_name());
                if e.file_type()?.is_dir() { copy_dir(&e.path(), &dest)? } else { std::fs::copy(e.path(), dest).map(|_| ())? }
            }
            Ok(())
        }
        let Some(src) = &self.claude_plugin else { return Ok(()) };
        let root = self.dir.join("claude-plugin");
        let disabled = self.settings.lock().unwrap().claude.disabled_skills.clone();
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("skills"))?;
        for e in std::fs::read_dir(src)?.flatten() {
            if e.file_name() != "skills" {
                let dest = root.join(e.file_name());
                if e.file_type()?.is_dir() { copy_dir(&e.path(), &dest)? } else { std::fs::copy(e.path(), dest).map(|_| ())? }
            }
        }
        for skill in self.skills() {
            if !disabled.contains(&skill.name) {
                copy_dir(&src.join("skills").join(&skill.name), &root.join("skills").join(&skill.name))?;
            }
        }
        Ok(())
    }

    fn launcher_file(&self) -> PathBuf {
        self.dir.join(if cfg!(windows) { "claude-launch.ps1" } else { "claude-launch" })
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
            // .ps1 은 BOM 을 붙여야 Windows PowerShell 5.1 이 UTF-8 로 읽는다 (launcher 와 같다)
            let body = if rel.ends_with(".ps1") { format!("\u{feff}{body}") } else { body.to_string() };
            if let Err(e) = std::fs::write(&p, body) {
                warn!(event = "shell_integration_write_failed", path = %p.display(), error = %e);
            }
        };
        write("zsh/.zshenv", ZSHENV);
        write("bash/rc", BASHRC);
        write("pwsh/profile.ps1", PWSH_PROFILE);
        write("teams-bin/tmux", TMUX_SHIM);
        let _ = set_exec(&self.teams_bin().join("tmux"));
        #[cfg(windows)]
        self.install_tmux_exe();
        self.write_launcher();
        info!(event = "shell_integration_ready", claude_plugin = ?self.claude_plugin);
    }

    /// Windows 가짜 tmux: claude 는 `tmux` 를 실행 파일로 찾으므로(sh 스크립트 · .cmd 는 인자가 cmd 를 거치며 깨진다)
    /// CLI 사본을 `teams-bin\tmux.exe` 로 둔다. CLI 는 자기 이름이 tmux 면 `thuminal tmux` 로 동작한다.
    /// 크기와 바뀐 때가 같으면 다시 쓰지 않는다 (팀원이 쓰는 중이면 잠겨 있어 덮어쓰지 못한다)
    #[cfg(windows)]
    fn install_tmux_exe(&self) {
        let Some(cli) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("thuminal.exe"))).filter(|p| p.is_file()) else { return };
        let dest = self.teams_bin().join("tmux.exe");
        let stamp = |p: &Path| std::fs::metadata(p).ok().map(|m| (m.len(), m.modified().ok()));
        if stamp(&cli).is_some_and(|a| stamp(&dest).is_some_and(|b| a.0 == b.0 && a.1 <= b.1)) {
            return;
        }
        if let Err(e) = std::fs::copy(&cli, &dest) {
            warn!(event = "tmux_shim_copy_failed", path = %dest.display(), error = %e);
        }
    }

    /// 새 세션에 넣을 환경 변수와, 기본 셸이면 셸 명령을 정한다.
    /// `command` 가 비면 사용자 로그인 셸을 띄우는 자리다.
    pub fn apply(&self, command: &mut Vec<String>, env: &mut BTreeMap<String, String>) {
        if let Some(p) = &self.claude_plugin {
            env.insert("THUMINAL_CLAUDE_PLUGIN".into(), p.to_string_lossy().into_owned());
        }
        env.insert("THUMINAL_CLAUDE_LAUNCH".into(), self.launcher_file().to_string_lossy().into_owned());
        // `term new -- claude …` 처럼 claude 를 바로 띄우면 실행기로 띄운다
        if command.first().is_some_and(|c| is_claude(c)) {
            let launcher = self.launcher_file().to_string_lossy().into_owned();
            #[cfg(windows)]
            {
                let rest = command.split_off(1);
                *command = [powershell(), "-NoLogo".into(), "-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), launcher]
                    .into_iter()
                    .chain(rest)
                    .collect();
            }
            #[cfg(not(windows))]
            {
                command[0] = launcher;
            }
        }
        // `term new -- zsh` 처럼 셸 이름 하나만 주면 그 셸에도 셸 통합을 넣는다
        let explicit = match command.as_slice() {
            [one] if matches!(one.rsplit('/').next(), Some("zsh" | "bash")) => Some(one.clone()),
            _ => None,
        };
        if !command.is_empty() && explicit.is_none() {
            return;
        }
        #[cfg(windows)]
        if explicit.is_none() {
            let profile = self.dir.join("pwsh/profile.ps1").to_string_lossy().into_owned();
            *command = vec![
                powershell(),
                "-NoLogo".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-NoExit".into(),
                "-Command".into(),
                format!(". {}", ps_quote(&profile)),
            ];
            return;
        }
        let shell = explicit.unwrap_or_else(|| std::env::var("SHELL").unwrap_or_default());
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

/// claude `--settings` 에 줄 상태 줄 설정. 명령의 `$THUMINAL_CLI` 는 claude 가 명령을 돌릴 때 세션 환경에서 풀린다.
/// 사용자가 정한 다시 그리기 주기(`refreshInterval`) · 여백(`padding`)은 그대로 옮긴다
fn statusline_settings() -> String {
    let mut line = serde_json::json!({ "type": "command", "command": "\"$THUMINAL_CLI\" agent statusline" });
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| thuminal_protocol::paths::user_home().map(|h| h.join(".claude")));
    let user: serde_json::Value = dir.and_then(|d| std::fs::read(d.join("settings.json")).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for key in ["refreshInterval", "padding"] {
        if let Some(v) = user.pointer(&format!("/statusLine/{key}")).filter(|v| v.is_number()) {
            line[key] = v.clone();
        }
    }
    serde_json::json!({ "statusLine": line }).to_string()
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
    find_in_shell(&names)
}

/// Windows 는 로그인 셸이 PATH 를 바꾸는 일이 드물어 데몬의 PATH 에서 PATHEXT 확장자를 붙여 찾는다
#[cfg(windows)]
fn find_in_shell(names: &[&String]) -> Vec<String> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let exts: Vec<String> = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').map(str::to_lowercase).collect();
    names.iter().filter(|n| dirs.iter().any(|d| exts.iter().any(|e| d.join(format!("{n}{e}")).is_file()))).map(|n| n.to_string()).collect()
}

#[cfg(not(windows))]
fn find_in_shell(names: &[&String]) -> Vec<String> {
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

// 유닉스 셸(sh · 실행 비트)을 쓰는 시험이다
#[cfg(all(test, unix))]
mod find_tests {
    #[test]
    fn finds_sh_but_not_nonsense() {
        let found = super::find_commands(&["sh".into(), "thuminal-no-such-cmd".into(), "bad name".into()]);
        assert_eq!(found, vec!["sh".to_string()]);
    }
}

// 유닉스 셸(sh · 실행 비트)을 쓰는 시험이다
#[cfg(all(test, unix))]
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
        // 세션 안에서는 상태 줄 명령을 thuminal 것으로 건다 (세션 밖에서는 걸지 않는다)
        let st = statusline_settings();
        assert!(st.contains(r#""command":"\"$THUMINAL_CLI\" agent statusline""#), "{st}");

        // 기본: 권한 확인 없이 + 팀 (세션 안에서만 tmux 흉내)
        assert_eq!(
            run(&shell, home.path(), &in_session),
            format!("--settings {st} --plugin-dir {p} --teammate-mode auto --dangerously-skip-permissions --resume x | TMUX_PANE=%7 TEAMS=1")
        );
        assert_eq!(run(&shell, home.path(), &[]), format!("--plugin-dir {p} --dangerously-skip-permissions --resume x | TMUX_PANE= TEAMS=1"));

        let mut off = AgentSettings::default();
        off.claude.skip_permissions = false;
        off.claude.teams = false;
        shell.set_settings(off.clone());
        assert_eq!(run(&shell, home.path(), &in_session), format!("--settings {st} --plugin-dir {p} --resume x | TMUX_PANE= TEAMS="));
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
