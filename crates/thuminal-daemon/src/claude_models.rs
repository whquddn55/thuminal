//! claude 가 고를 수 있는 모델 목록을 claude 에게 묻는다 (대화 보기의 모델 · 생각 강도 고르기).
//!
//! claude CLI 에는 모델을 나열하는 명령이 없다. 대신 `--print` 스트림 JSON 에 `list_models` 제어 요청 하나를 보내면
//! `/model` 창에 뜨는 목록을 API 턴 없이 돌려준다 (Orca `claude-model-list-probe` 와 같은 방법).
//! 이 요청을 모르는 옛 claude 는 오류로 답하고, 그때는 빈 목록이다 (화면이 손으로 적어 둔 목록을 쓴다).
//! 계정 · claude 버전에 따라 달라지고 한 번에 몇 초가 걸려 10분 동안 기억해 둔다.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use thuminal_protocol::ClaudeModel;

const REQUEST: &str = "{\"type\":\"control_request\",\"request_id\":\"thuminal-models\",\"request\":{\"subtype\":\"list_models\"}}\n";
/// 훅 · MCP 를 띄우지 않는다 (목록만 묻는다). `--print` 는 `--verbose` 가 있어야 스트림 JSON 을 낸다
const ARGS: &[&str] = &["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--settings", "{\"disableAllHooks\":true}"];
const TIMEOUT: Duration = Duration::from_secs(25);
const KEEP: Duration = Duration::from_secs(600);

static CACHE: Mutex<Option<(Instant, Vec<ClaudeModel>)>> = Mutex::new(None);

/// 모델 목록. 못 얻으면 빈 목록 (블로킹 스레드에서 부른다)
pub fn list() -> Vec<ClaudeModel> {
    if let Some((at, models)) = CACHE.lock().unwrap().as_ref()
        && at.elapsed() < KEEP
    {
        return models.clone();
    }
    let models = run().map(|out| parse(&out)).unwrap_or_default();
    // 못 얻은 것은 기억하지 않는다 (claude 를 막 깔았거나 로그인한 뒤 다시 묻게)
    if !models.is_empty() {
        *CACHE.lock().unwrap() = Some((Instant::now(), models.clone()));
    }
    models
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

fn run() -> Option<String> {
    let mut cmd = command();
    // 데몬을 claude 세션 안에서 띄웠을 때 따라온 값이 있으면 claude 가 자기를 하위 세션으로 안다
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().into_owned();
        if k.starts_with("CLAUDE_CODE_") || k == "CLAUDECODE" {
            cmd.env_remove(k);
        }
    }
    if let Some(home) = thuminal_protocol::paths::user_home() {
        cmd.current_dir(home);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    // 입력을 닫아야 claude 가 답하고 끝난다
    child.stdin.take()?.write_all(REQUEST.as_bytes()).ok()?;
    // 답은 수 KB 라 파이프에 다 들어간다. 끝나길 기다렸다가 읽는다
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
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
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
