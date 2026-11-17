//! claude 대화 기록(transcript jsonl)에서 아직 끝나지 않은 백그라운드 작업을 센다.
//!
//! claude 가 셸 명령을 백그라운드로 돌려 두고(`run_in_background`) 턴을 끝내면 Stop 훅이 와서 "끝남" 이 되지만, 셸은
//! 뒤에서 아직 돈다. 작업이 끝났다는 훅은 없으므로 기록에서 시작 · 끝을 읽는다 (images.rs 의 `Scan` 이 늘어난 줄마다 부른다).
//! - 시작: 도구 결과 줄(`type:"user"`)의 `toolUseResult` 에 작업 번호가 있다. Bash 는 `backgroundTaskId`, Monitor 는
//!   `taskId`(+`timeoutMs`), 백그라운드 서브에이전트는 `isAsync:true` · `status:"async_launched"` 의 `agentId`.
//!   세션 내내 지켜보는 Monitor(`persistent:true`)는 끝나지 않으므로 세지 않는다.
//! - 끝: `<task-notification>` 에 `<status>`(completed · failed · killed · stopped)가 있다. claude 가 TaskStop 으로
//!   멈추면 알림 없이 도구 결과(`toolUseResult.task_id`)만 남는다. 작업이 끝나는 순간
//!   `queue-operation` enqueue 줄로 먼저 남고, claude 가 읽으면 `type:"user"` 줄로 또 남는다. Monitor 가 알리는
//!   중간 이벤트(`<event>`)에는 `<status>` 가 없다.

use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub enum Task {
    Start(String),
    End(String),
}

/// 한 줄에서 시작 · 끝난 백그라운드 작업
pub fn tasks_in_line(line: &[u8]) -> Vec<Task> {
    // 대부분의 줄은 상관없다. 풀기 전에 바이트로 거른다 (요청 사본 줄은 같은 글이 또 들어 있어 뺀다)
    let has = |s: &[u8]| memchr::memmem::find(line, s).is_some();
    if line.starts_with(br#"{"type":"api-request-"#) || !(has(b"backgroundTaskId") || has(b"taskId") || has(b"task_id") || has(b"async_launched") || has(b"<task-notification>")) {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return Vec::new() };
    if v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
        return Vec::new();
    }
    let mut out = Vec::new();
    match v.get("type").and_then(Value::as_str) {
        Some("queue-operation") if v.get("operation").and_then(Value::as_str) == Some("enqueue") => {
            if let Some(c) = v.get("content").and_then(Value::as_str) {
                ended(c, &mut out);
            }
        }
        Some("user") => {
            if let Some(r) = v.get("toolUseResult") {
                if let Some(id) = started(r) {
                    out.push(Task::Start(id));
                }
                // TaskStop 결과. 다른 도구의 task_id 가 걸려도 시작한 적 없는 번호라 상관없다
                if let Some(id) = r.get("task_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    out.push(Task::End(id.to_owned()));
                }
            }
            match v.pointer("/message/content") {
                Some(Value::String(c)) => ended(c, &mut out),
                Some(Value::Array(parts)) => {
                    for c in parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)) {
                        ended(c, &mut out);
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
    out
}

/// 도구 결과가 백그라운드 작업을 시작했으면 그 번호
fn started(r: &Value) -> Option<String> {
    let s = |k: &str| r.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    if let Some(id) = s("backgroundTaskId") {
        return Some(id);
    }
    if r.get("timeoutMs").is_some() && r.get("persistent").and_then(Value::as_bool) != Some(true) {
        return s("taskId");
    }
    if r.get("isAsync").and_then(Value::as_bool) == Some(true) && r.get("status").and_then(Value::as_str) == Some("async_launched") {
        return s("agentId");
    }
    None
}

/// 글 안의 `<task-notification>` 가운데 끝을 알린 것들
fn ended(text: &str, out: &mut Vec<Task>) {
    for block in text.split("<task-notification>").skip(1) {
        let block = block.split("</task-notification>").next().unwrap_or(block);
        if let (Some(id), Some(_)) = (tag(block, "task-id"), tag(block, "status")) {
            out.push(Task::End(id.to_owned()));
        }
    }
}

fn tag<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = s.find(&open)? + open.len();
    let len = s[start..].find(&format!("</{name}>"))?;
    Some(s[start..start + len].trim()).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tasks(line: &str) -> Vec<Task> {
        tasks_in_line(line.as_bytes())
    }

    #[test]
    fn bash_monitor_agent_start() {
        let bash = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Command running in background with ID: b1"}]},"toolUseResult":{"stdout":"","backgroundTaskId":"b1"}}"#;
        assert_eq!(tasks(bash), vec![Task::Start("b1".into())]);
        let monitor = r#"{"type":"user","message":{"content":[]},"toolUseResult":{"taskId":"m1","timeoutMs":1800000,"persistent":false}}"#;
        assert_eq!(tasks(monitor), vec![Task::Start("m1".into())]);
        let persistent = r#"{"type":"user","message":{"content":[]},"toolUseResult":{"taskId":"m2","timeoutMs":0,"persistent":true}}"#;
        assert_eq!(tasks(persistent), vec![]);
        let agent = r#"{"type":"user","message":{"content":[]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a1"}}"#;
        assert_eq!(tasks(agent), vec![Task::Start("a1".into())]);
        let side = r#"{"type":"user","isSidechain":true,"message":{"content":[]},"toolUseResult":{"backgroundTaskId":"b2"}}"#;
        assert_eq!(tasks(side), vec![]);
    }

    #[test]
    fn notification_with_status_ends() {
        let q = r#"{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"}"#;
        assert_eq!(tasks(q), vec![Task::End("b1".into())]);
        let user = r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>b1</task-id>\n<status>killed</status>\n</task-notification>"}}"#;
        assert_eq!(tasks(user), vec![Task::End("b1".into())]);
        // Monitor 중간 이벤트는 끝이 아니다
        let event = r#"{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>m1</task-id>\n<event>line</event>\n</task-notification>"}"#;
        assert_eq!(tasks(event), vec![]);
        let remove = r#"{"type":"queue-operation","operation":"remove","content":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"}"#;
        assert_eq!(tasks(remove), vec![]);
        let stop = r#"{"type":"user","message":{"content":[]},"toolUseResult":{"message":"Successfully stopped task: b1","task_id":"b1"}}"#;
        assert_eq!(tasks(stop), vec![Task::End("b1".into())]);
        let blob = r#"{"type":"api-request-blob","message":{"content":"<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"}}"#;
        assert_eq!(tasks(blob), vec![]);
    }
}
