//! claude 가 고를 수 있는 모델 목록을 claude 에게 묻는다 (대화 보기의 모델 · 생각 강도 고르기).
//!
//! claude CLI 에는 모델을 나열하는 명령이 없다. 대신 `--print` 스트림 JSON 에 `list_models` 제어 요청 하나를 보내면
//! `/model` 창에 뜨는 목록을 API 턴 없이 돌려준다 (Orca `claude-model-list-probe` 와 같은 방법).
//! 이 요청을 모르는 옛 claude 는 오류로 답하고, 그때는 빈 목록이다 (화면이 손으로 적어 둔 목록을 쓴다).
//! 계정 · claude 버전에 따라 달라지고 한 번에 몇 초가 걸려 10분 동안 기억해 둔다.
//!
//! 스킬 · 사용자 명령 목록(대화 보기의 `/` 목록)도 같은 방법으로 받는다: `initialize` 제어 요청의 답에 claude 의 `/` 목록이
//! 들어 있다. 폴더(프로젝트 스킬)와 얹은 플러그인에 따라 달라 폴더마다 묻고 2분 기억한다.
//! claude 는 그것이 스킬인지 명령인지, 어디에 정의됐는지는 알려 주지 않아 정의 파일을 직접 찾아 붙인다 ([`locate`]).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use thuminal_protocol::{ClaudeCommand, ClaudeModel};

const REQUEST: &str = "{\"type\":\"control_request\",\"request_id\":\"thuminal-models\",\"request\":{\"subtype\":\"list_models\"}}\n";
/// 훅 · MCP 를 띄우지 않는다 (목록만 묻는다). `--print` 는 `--verbose` 가 있어야 스트림 JSON 을 낸다
const ARGS: &[&str] = &["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--settings", "{\"disableAllHooks\":true}"];
const TIMEOUT: Duration = Duration::from_secs(25);
const KEEP: Duration = Duration::from_secs(600);
const INIT_REQUEST: &str = "{\"type\":\"control_request\",\"request_id\":\"thuminal-init\",\"request\":{\"subtype\":\"initialize\"}}\n";
const COMMANDS_KEEP: Duration = Duration::from_secs(120);

/// 폴더마다 기억한 명령 목록 (폴더, 받은 때, 목록)
static COMMANDS: Mutex<Vec<(String, Instant, Vec<ClaudeCommand>)>> = Mutex::new(Vec::new());

static CACHE: Mutex<Option<(Instant, Vec<ClaudeModel>)>> = Mutex::new(None);

/// 모델 목록. 못 얻으면 빈 목록 (블로킹 스레드에서 부른다)
pub fn list() -> Vec<ClaudeModel> {
    if let Some((at, models)) = CACHE.lock().unwrap().as_ref()
        && at.elapsed() < KEEP
    {
        return models.clone();
    }
    let models = run(REQUEST, None, None).map(|out| parse(&out)).unwrap_or_default();
    // 못 얻은 것은 기억하지 않는다 (claude 를 막 깔았거나 로그인한 뒤 다시 묻게)
    if !models.is_empty() {
        *CACHE.lock().unwrap() = Some((Instant::now(), models.clone()));
    }
    models
}

/// `cwd` 에서 띄운 claude 의 `/` 목록에 뜨는 스킬 · 사용자 명령 (claude 내장 명령은 뺀다). `plugin_dir` 은 실행기가 얹는
/// thuminal 플러그인이다 (그 스킬도 목록에 넣는다). 못 얻으면 빈 목록 (블로킹 스레드에서 부른다)
pub fn commands(cwd: &str, plugin_dir: Option<&Path>) -> Vec<ClaudeCommand> {
    if let Some((_, _, list)) = COMMANDS.lock().unwrap().iter().find(|(c, at, _)| c == cwd && at.elapsed() < COMMANDS_KEEP) {
        return list.clone();
    }
    let mut list = run(INIT_REQUEST, Some(Path::new(cwd)), plugin_dir).map(|out| parse_commands(&out)).unwrap_or_default();
    if let Some(home) = claude_home() {
        let plugins = plugin_dirs(&home, plugin_dir, Path::new(cwd));
        for c in &mut list {
            locate(c, Path::new(cwd), &home, &plugins);
        }
    }
    if !list.is_empty() {
        let mut cache = COMMANDS.lock().unwrap();
        cache.retain(|(c, at, _)| c != cwd && at.elapsed() < COMMANDS_KEEP);
        cache.push((cwd.to_string(), Instant::now(), list.clone()));
    }
    list
}

/// claude 를 사용자 로그인 셸의 PATH 로 띄운다 (PATH 를 .zshrc 에서 정하는 사람이 많다. `command` 로 셸 함수 · 별칭은 건너뛴다)
#[cfg(not(windows))]
fn command() -> Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut c = Command::new(shell);
    c.args(["-ilc", r#"exec command claude "$@""#, "sh"]).args(ARGS);
    c
}

#[cfg(windows)]
fn command() -> Command {
    let mut c = Command::new("cmd");
    c.args(["/C", "claude"]).args(ARGS);
    c
}

/// claude 에 제어 요청 하나를 보내고 출력을 받는다. `cwd` 가 없으면 홈에서 띄운다
fn run(request: &str, cwd: Option<&Path>, plugin_dir: Option<&Path>) -> Option<String> {
    let mut cmd = command();
    if let Some(p) = plugin_dir.filter(|p| p.is_dir()) {
        cmd.arg("--plugin-dir").arg(p);
    }
    // 데몬을 claude 세션 안에서 띄웠을 때 따라온 값이 있으면 claude 가 자기를 하위 세션으로 안다
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().into_owned();
        if k.starts_with("CLAUDE_CODE_") || k == "CLAUDECODE" {
            cmd.env_remove(k);
        }
    }
    if let Some(dir) = cwd.filter(|d| d.is_dir()).map(Path::to_path_buf).or_else(thuminal_protocol::paths::user_home) {
        cmd.current_dir(dir);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    // 입력을 닫아야 claude 가 답하고 끝난다
    child.stdin.take()?.write_all(request.as_bytes()).ok()?;
    // 답이 파이프보다 클 수 있어(명령 목록은 수십 KB) 따로 읽으면서 끝나길 기다린다
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        stdout.read_to_string(&mut out).ok().map(|_| out)
    });
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()?
}

/// `initialize` 답에서 스킬 · 사용자 명령을 읽는다. claude 내장 명령(`builtin`)과 안에서만 쓰는 이름(`__…`)은 뺀다
pub fn parse_commands(stdout: &str) -> Vec<ClaudeCommand> {
    for line in stdout.lines().map(str::trim).filter(|l| l.starts_with('{') && l.contains("control_response")) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(list) = v.pointer("/response/response/commands").and_then(Value::as_array) else { continue };
        let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        let mut out: Vec<ClaudeCommand> = Vec::new();
        for c in list {
            let name = text(c, "name");
            if name.is_empty() || name.starts_with("__") || c.get("builtin").and_then(Value::as_bool) == Some(true) || out.iter().any(|x| x.name == name) {
                continue;
            }
            // claude 는 설명에 출처를 글로 붙인다: 플러그인은 앞에 `(이름) `, 프로젝트 · 사용자 것은 뒤에 ` (project)` · ` (user)`.
            // 떼어 내고 출처 칸에 옮긴다 (정의 파일을 찾으면 [`locate`] 가 더 자세히 채운다)
            let mut description = text(c, "description");
            let mut source = String::new();
            let mut plugin = String::new();
            // 플러그인 것의 범위(설치한 곳)는 [`locate`] 가 채운다
            if let Some((prefix, _)) = name.split_once(':')
                && let Some(rest) = description.strip_prefix(&format!("({prefix}) "))
            {
                description = rest.to_string();
                plugin = prefix.to_string();
            }
            for scope in ["project", "user"] {
                if let Some(rest) = description.strip_suffix(&format!(" ({scope})")) {
                    description = rest.to_string();
                    source = scope.into();
                }
            }
            // 설명은 목록 한 줄에 보일 만큼만 보낸다 (스킬 설명은 수백 자다)
            let description = thuminal_protocol::clip_text(&description, 300).unwrap_or_default();
            out.push(ClaudeCommand { name, description, argument_hint: text(c, "argumentHint"), kind: String::new(), source, plugin, path: String::new() });
        }
        return out;
    }
    Vec::new()
}

/// claude 설정 폴더 (`CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`)
fn claude_home() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| thuminal_protocol::paths::user_home().map(|h| h.join(".claude")))
}

/// 플러그인 하나: 이름, 폴더, 설치 범위 (`user` · `project` · `local`, 실행기가 얹는 thuminal 플러그인은 `app`)
pub struct PluginDir {
    pub name: String,
    pub dir: PathBuf,
    pub scope: String,
}

/// `cwd` 에서 쓰이는 플러그인들. 설치한 플러그인(`plugins/installed_plugins.json`)과 실행기가 얹는 thuminal 플러그인.
/// 같은 플러그인을 여러 범위에 깔았으면 claude 가 고르는 차례대로 로컬 → 프로젝트 → 사용자다 (프로젝트 · 로컬 것은 그 폴더 밑에서만)
fn plugin_dirs(home: &Path, extra: Option<&Path>, cwd: &Path) -> Vec<PluginDir> {
    let mut out = Vec::new();
    if let Some(dir) = extra {
        let name = std::fs::read(dir.join(".claude-plugin/plugin.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.get("name")?.as_str().map(str::to_string));
        if let Some(name) = name {
            out.push(PluginDir { name, dir: dir.to_path_buf(), scope: "app".into() });
        }
    }
    let installed = std::fs::read(home.join("plugins/installed_plugins.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(map) = installed.as_ref().and_then(|v| v.get("plugins")).and_then(Value::as_object) {
        for (key, entries) in map {
            // 키는 `이름@마켓` 이다
            let name = key.split('@').next().unwrap_or(key);
            let entries: Vec<&Value> = entries.as_array().map(|a| a.iter().collect()).unwrap_or_else(|| vec![entries]);
            let text = |e: &Value, k: &str| e.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
            // 프로젝트 · 로컬 것에 폴더가 적혀 있으면 그 밑에서만 잡는다 (폴더가 없는 기록이면 그대로 받는다)
            let rank = |e: &&Value| {
                let order = match text(e, "scope").as_str() {
                    "local" => 0,
                    "project" => 1,
                    _ => 2,
                };
                match e.get("projectPath").and_then(Value::as_str) {
                    Some(p) if order < 2 && !cwd.starts_with(p) => None,
                    _ => Some(order),
                }
            };
            let best = entries.iter().filter_map(|e| rank(e).map(|r| (r, e))).min_by_key(|(r, _)| *r);
            if let Some((_, e)) = best
                && let Some(path) = e.get("installPath").and_then(Value::as_str)
            {
                let scope = text(e, "scope");
                out.push(PluginDir { name: name.to_string(), dir: PathBuf::from(path), scope: if scope.is_empty() { "user".into() } else { scope } });
            }
        }
    }
    out
}

/// `base` 밑에서 이름이 `name` 인 스킬(`skills/<name>/SKILL.md`)이나 명령(`commands/**/<name>.md`)의 정의 파일을 찾는다
fn find_def(base: &Path, name: &str) -> Option<(&'static str, PathBuf)> {
    let skill = base.join("skills").join(name).join("SKILL.md");
    if skill.is_file() {
        return Some(("skill", skill));
    }
    // 명령은 하위 폴더에 둘 수 있다 (두 단계까지 본다)
    fn walk(dir: &Path, file: &str, depth: u8) -> Option<PathBuf> {
        let direct = dir.join(file);
        if direct.is_file() {
            return Some(direct);
        }
        if depth == 0 {
            return None;
        }
        std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| walk(&e.path(), file, depth - 1))
    }
    walk(&base.join("commands"), &format!("{name}.md"), 2).map(|p| ("command", p))
}

/// 조직이 관리하는 설정 폴더 (그 밑 `.claude/skills` 에 조직 스킬이 있다). 문서에는 Linux 경로만 적혀 있고,
/// macOS · Windows 는 관리 설정 파일이 있는 폴더를 같은 식으로 본다
fn managed_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    }
}

/// 스킬 · 명령의 정의 파일을 찾아 종류 · 범위 · 경로를 채운다. claude 가 스킬을 읽는 곳을 문서의 우선순위대로 본다
/// (code.claude.com/docs/en/skills): 조직(관리 폴더) → 사용자(claude 설정 폴더) → 프로젝트(`cwd` 와 그 위 폴더들의 `.claude`)
/// → claude.ai 계정에서 내려받은 스킬(`skills/synced/*`). claude 가 설명에 범위를 적어 줬으면 그곳을 먼저 본다.
/// `플러그인:이름` 은 그 플러그인 폴더이고 범위는 플러그인을 설치한 범위다 (스킬 자체에는 로컬 범위가 없다).
/// 플러그인이 아닌 `a:b` 는 하위 폴더의 명령(`commands/a/b.md`)이나 하위 폴더의 스킬(`a/.claude/skills/b`)이다.
/// `--add-dir` 로 더한 폴더의 것은 데몬이 알 수 없어 못 찾는다. 못 찾으면 claude 가 설명에 적어 준 것만 남는다
pub fn locate(c: &mut ClaudeCommand, cwd: &Path, home: &Path, plugins: &[PluginDir]) {
    locate_in(c, cwd, home, &managed_dir().join(".claude"), plugins)
}

fn locate_in(c: &mut ClaudeCommand, cwd: &Path, home: &Path, managed: &Path, plugins: &[PluginDir]) {
    let set = |c: &mut ClaudeCommand, source: &str, plugin: &str, hit: Option<(&'static str, PathBuf)>| {
        c.source = source.to_string();
        c.plugin = plugin.to_string();
        if let Some((kind, path)) = hit {
            c.kind = kind.to_string();
            // 짜 둔 플러그인 폴더는 원본으로 가는 링크다. 원본 경로를 보인다
            c.path = path.canonicalize().unwrap_or(path).to_string_lossy().into_owned();
        }
    };
    let synced = |name: &str| -> Option<(&'static str, PathBuf)> {
        let dirs = std::fs::read_dir(home.join("skills/synced")).ok()?;
        dirs.flatten().map(|e| e.path().join(name).join("SKILL.md")).filter(|p| p.is_file()).max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok()).map(|p| ("skill", p))
    };
    let name = c.name.clone();
    if let Some((prefix, rest)) = name.split_once(':') {
        if let Some(p) = plugins.iter().find(|p| p.name == prefix) {
            return set(c, &p.scope, prefix, find_def(&p.dir, rest));
        }
        if let Some(hit) = synced(rest) {
            return set(c, "account", "", Some(hit));
        }
        // 플러그인 것이 아니다 (claude 가 붙여 준 플러그인 이름은 지운다)
        c.plugin.clear();
    }
    // 홈 폴더의 `.claude` 는 사용자 것이라 프로젝트로 치지 않는다
    let user_root = home.parent();
    let project_dirs: Vec<&Path> = cwd.ancestors().take_while(|d| Some(*d) != user_root).collect();
    // `a/b:c` 는 하위 폴더 `a/b` 의 스킬 `c` 이거나 명령 `commands/a/b/c.md` 다
    let (sub, leaf) = name.rsplit_once(':').map_or(("", name.as_str()), |(a, b)| (a, b));
    let sub: PathBuf = sub.split([':', '/']).filter(|p| !p.is_empty() && *p != "..").collect();
    let in_base = |base: &Path| -> Option<(&'static str, PathBuf)> {
        if sub.as_os_str().is_empty() {
            return find_def(base, leaf);
        }
        let cmd = base.join("commands").join(&sub).join(format!("{leaf}.md"));
        cmd.is_file().then_some(("command", cmd))
    };
    let project = || -> Option<(&'static str, PathBuf)> {
        project_dirs.iter().find_map(|d| {
            in_base(&d.join(".claude")).or_else(|| {
                let nested = d.join(&sub).join(".claude/skills").join(leaf).join("SKILL.md");
                (!sub.as_os_str().is_empty() && nested.is_file()).then_some(("skill", nested))
            })
        })
    };
    let hint = c.source.clone();
    let order: [&str; 3] = match hint.as_str() {
        "project" => ["project", "managed", "user"],
        "user" => ["user", "managed", "project"],
        _ => ["managed", "user", "project"],
    };
    for scope in order {
        let hit = match scope {
            "managed" => in_base(managed),
            "user" => in_base(home),
            _ => project(),
        };
        if hit.is_some() {
            return set(c, scope, "", hit);
        }
    }
    if let Some(hit) = synced(leaf).filter(|_| sub.as_os_str().is_empty()) {
        set(c, "account", "", Some(hit));
    }
}

/// 출력에서 `control_response` 줄의 모델 목록을 읽는다. 쓸 수 없다고 표시된 줄(`disabled`)은 뺀다
pub fn parse(stdout: &str) -> Vec<ClaudeModel> {
    for line in stdout.lines().map(str::trim).filter(|l| l.starts_with('{') && l.contains("control_response")) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.pointer("/response/subtype").and_then(Value::as_str) != Some("success") {
            continue;
        }
        let Some(list) = v.pointer("/response/response/models").and_then(Value::as_array) else { continue };
        let text = |m: &Value, k: &str| m.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let mut out: Vec<ClaudeModel> = Vec::new();
        for m in list {
            let Some(value) = text(m, "value") else { continue };
            if m.get("disabled").and_then(Value::as_bool) == Some(true) || out.iter().any(|x| x.value == value) {
                continue;
            }
            let efforts = m.get("supportedEffortLevels").and_then(Value::as_array).map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()).unwrap_or_default();
            out.push(ClaudeModel { label: text(m, "displayName").unwrap_or_else(|| value.clone()), description: text(m, "description").unwrap_or_default(), resolved: text(m, "resolvedModel").unwrap_or_default(), efforts, value });
        }
        if !out.is_empty() {
            return out;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands_without_builtins() {
        let out = concat!(
            "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"response\":{\"commands\":[",
            "{\"name\":\"docx\",\"description\":\" Word 문서 (project)\",\"argumentHint\":\"\"},",
            "{\"name\":\"clear\",\"description\":\"Start a new session\",\"builtin\":true},",
            "{\"name\":\"__remote-workflow\",\"description\":\"\"},",
            "{\"name\":\"thuthi:setup\",\"description\":\"(thuthi) 점검\",\"argumentHint\":\"[플러그인]\",\"aliases\":[\"x\"]}]}}}\n"
        );
        let got = parse_commands(out);
        assert_eq!(got.iter().map(|c| (c.name.as_str(), c.description.as_str(), c.argument_hint.as_str())).collect::<Vec<_>>(), [("docx", "Word 문서", ""), ("thuthi:setup", "점검", "[플러그인]")]);
        assert_eq!(got.iter().map(|c| (c.source.as_str(), c.plugin.as_str())).collect::<Vec<_>>(), [("project", ""), ("", "thuthi")]);
        assert!(parse_commands("{\"type\":\"control_response\",\"response\":{\"subtype\":\"error\"}}").is_empty());
    }

    #[test]
    fn locates_definition_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let touch = |rel: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x").unwrap();
            p.to_string_lossy().into_owned()
        };
        let home = root.join("home/.claude");
        let cwd = root.join("home/work/repo/sub");
        std::fs::create_dir_all(&cwd).unwrap();
        let project_skill = touch("home/work/repo/.claude/skills/brand/SKILL.md");
        let project_cmd = touch("home/work/repo/sub/.claude/commands/git/ship.md");
        let user_skill = touch("home/.claude/skills/mine/SKILL.md");
        let account_skill = touch("home/.claude/skills/synced/org_acct/docx/SKILL.md");
        let plugin_skill = touch("plugins/thuthi/skills/setup/SKILL.md");
        let plugin_cmd = touch("plugins/thuthi/commands/hello.md");
        let plugins = vec![PluginDir { name: "thuthi".into(), dir: root.join("plugins/thuthi"), scope: "local".into() }];
        let find = |name: &str| {
            let mut c = ClaudeCommand { name: name.into(), description: String::new(), argument_hint: String::new(), kind: String::new(), source: String::new(), plugin: String::new(), path: String::new() };
            locate_in(&mut c, &cwd, &home, &root.join("managed/.claude"), &plugins);
            (c.kind, c.source, c.plugin, c.path)
        };
        let s = |a: &str, b: &str, c: &str, d: &str| (a.to_string(), b.to_string(), c.to_string(), d.to_string());
        assert_eq!(find("brand"), s("skill", "project", "", &project_skill));
        assert_eq!(find("ship"), s("command", "project", "", &project_cmd));
        assert_eq!(find("mine"), s("skill", "user", "", &user_skill));
        assert_eq!(find("docx"), s("skill", "account", "", &account_skill));
        assert_eq!(find("anthropic-skills:docx"), s("skill", "account", "", &account_skill));
        assert_eq!(find("thuthi:setup"), s("skill", "local", "thuthi", &plugin_skill));
        assert_eq!(find("thuthi:hello"), s("command", "local", "thuthi", &plugin_cmd));
        // 플러그인 폴더는 알지만 정의 파일이 없으면 출처만 남는다
        assert_eq!(find("thuthi:gone"), s("", "local", "thuthi", ""));
        assert_eq!(find("nowhere"), s("", "", "", ""));
        // 하위 폴더의 명령은 `폴더:이름`, 하위 폴더의 스킬은 `폴더:이름` 으로 뜬다
        let nested_cmd = touch("home/work/repo/.claude/commands/frontend/component.md");
        let nested_skill = touch("home/work/repo/apps/web/.claude/skills/deploy/SKILL.md");
        assert_eq!(find("frontend:component"), s("command", "project", "", &nested_cmd));
        assert_eq!(find("apps/web:deploy"), s("skill", "project", "", &nested_skill));
        // 같은 이름이면 조직 → 사용자 → 프로젝트 차례다 (문서의 우선순위)
        let user_brand = touch("home/.claude/skills/brand/SKILL.md");
        assert_eq!(find("brand"), s("skill", "user", "", &user_brand));
        let managed_brand = touch("managed/.claude/skills/brand/SKILL.md");
        assert_eq!(find("brand"), s("skill", "managed", "", &managed_brand));
        // claude 가 설명에 범위를 적어 줬으면 그곳 것이다
        let mut hinted = ClaudeCommand { name: "brand".into(), description: String::new(), argument_hint: String::new(), kind: String::new(), source: "project".into(), plugin: String::new(), path: String::new() };
        locate_in(&mut hinted, &cwd, &home, &root.join("managed/.claude"), &plugins);
        assert_eq!((hinted.source.as_str(), hinted.path.as_str()), ("project", project_skill.as_str()));

        // 설치 기록: 프로젝트 · 로컬 것은 그 폴더 밑에서만 잡히고 사용자 것보다 먼저다
        let proj = root.join("home/work/repo");
        std::fs::create_dir_all(home.join("plugins")).unwrap();
        let installed = serde_json::json!({ "version": 2, "plugins": {
            "a@m": [{ "scope": "user", "installPath": "/u/a" }, { "scope": "local", "projectPath": proj.to_str().unwrap(), "installPath": "/l/a" }],
            "b@m": [{ "scope": "project", "projectPath": "/somewhere/else", "installPath": "/p/b" }],
            "d@m": [{ "scope": "local", "installPath": "/l/d" }],
            "c@m": [{ "scope": "user", "installPath": "/u/c" }],
        }});
        std::fs::write(home.join("plugins/installed_plugins.json"), installed.to_string()).unwrap();
        let mut got: Vec<(String, String, String)> = plugin_dirs(&home, None, &cwd).into_iter().map(|p| (p.name, p.scope, p.dir.to_string_lossy().into_owned())).collect();
        got.sort();
        assert_eq!(got, vec![("a".into(), "local".into(), "/l/a".into()), ("c".into(), "user".into(), "/u/c".into()), ("d".into(), "local".into(), "/l/d".into())]);
    }

    #[test]
    fn parses_model_list() {
        let out = concat!(
            "{\"type\":\"system\",\"subtype\":\"init\"}\n",
            "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"x\",\"response\":{\"models\":[",
            "{\"value\":\"default\",\"displayName\":\"Default (recommended)\",\"description\":\"Opus 5.5\",\"resolvedModel\":\"claude-opus-5-5\",\"supportedEffortLevels\":[\"low\",\"high\"]},",
            "{\"value\":\"cc-update-required-1\",\"displayName\":\"Fable 9 (disabled)\",\"disabled\":true},",
            "{\"value\":\"claude-haiku-4-5\",\"displayName\":\"Haiku 4.5\",\"supportedEffortLevels\":null}]}}}\n"
        );
        let got = parse(out);
        assert_eq!(got.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(), ["default", "claude-haiku-4-5"]);
        assert_eq!((got[0].label.as_str(), got[0].resolved.as_str(), got[0].efforts.len(), got[1].efforts.len()), ("Default (recommended)", "claude-opus-5-5", 2, 0));
        // 요청을 모르는 옛 claude
        assert!(parse("{\"type\":\"control_response\",\"response\":{\"subtype\":\"error\"}}").is_empty());
    }
}
