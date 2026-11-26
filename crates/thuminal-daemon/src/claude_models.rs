//! claude 가 고를 수 있는 모델 목록을 claude 에게 묻는다 (대화 보기의 모델 · 생각 강도 고르기).
//!
//! claude CLI 에는 모델을 나열하는 명령이 없다. 대신 `--print` 스트림 JSON 에 `list_models` 제어 요청 하나를 보내면
//! `/model` 창에 뜨는 목록을 API 턴 없이 돌려준다 (Orca `claude-model-list-probe` 와 같은 방법).
//! 이 요청을 모르는 옛 claude 는 오류로 답하고, 그때는 빈 목록이다 (화면이 손으로 적어 둔 목록을 쓴다).
//! 계정 · claude 버전에 따라 달라지고 한 번에 몇 초가 걸려 10분 동안 기억해 둔다.
//!
//! 스킬 · 사용자 명령 목록(대화 보기의 `/` 목록)도 같은 방법으로 받는다: `initialize` 제어 요청의 답에 claude 의 `/` 목록이
//! 들어 있다. 폴더(프로젝트 스킬)와 얹은 플러그인에 따라 달라 폴더마다 묻고 2분 기억한다.

use std::io::{Read, Write};
use std::path::Path;
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
    let list = run(INIT_REQUEST, Some(Path::new(cwd)), plugin_dir).map(|out| parse_commands(&out)).unwrap_or_default();
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
            // 설명은 목록 한 줄에 보일 만큼만 보낸다 (스킬 설명은 수백 자다)
            let description = thuminal_protocol::clip_text(&text(c, "description"), 300).unwrap_or_default();
            out.push(ClaudeCommand { name, description, argument_hint: text(c, "argumentHint") });
        }
        return out;
    }
    Vec::new()
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
            "{\"name\":\"docx\",\"description\":\" Word 문서 \",\"argumentHint\":\"\"},",
            "{\"name\":\"clear\",\"description\":\"Start a new session\",\"builtin\":true},",
            "{\"name\":\"__remote-workflow\",\"description\":\"\"},",
            "{\"name\":\"thuthi:setup\",\"description\":\"점검\",\"argumentHint\":\"[플러그인]\",\"aliases\":[\"x\"]}]}}}\n"
        );
        let got = parse_commands(out);
        assert_eq!(got.iter().map(|c| (c.name.as_str(), c.description.as_str(), c.argument_hint.as_str())).collect::<Vec<_>>(), [("docx", "Word 문서", ""), ("thuthi:setup", "점검", "[플러그인]")]);
        assert!(parse_commands("{\"type\":\"control_response\",\"response\":{\"subtype\":\"error\"}}").is_empty());
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
