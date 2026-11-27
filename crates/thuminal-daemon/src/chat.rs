//! claude 대화 기록(transcript jsonl)을 대화 보기용 조각([`ChatItem`])으로 바꾼다.
//!
//! 화면은 터미널 원본 대신 이 조각으로 대화를 그린다 (`ui/src/chat/`). 기록 줄 모양은 claude 버전마다 바뀌므로
//! 여기 한 곳에서만 안다. 화면은 조각 여섯 가지만 안다.
//!
//! 읽는 줄:
//! - `type:"user"`: 글(문자열이나 `text` 조각) → [`ChatItem::User`], `tool_result` 조각 → [`ChatItem::ToolResult`].
//!   셸 모드(`!`)의 `<bash-input>` 은 `!명령` 사용자 글로, `<bash-stdout>` · `<bash-stderr>` 는 알림(`shell_output`)으로 낸다
//!   슬래시 명령(`<command-name>`)과 그 출력(`<local-command-stdout>`), 멈춤 표시, 팀원이 보낸 글(`<teammate-message>`)은
//!   [`ChatItem::Notice`] 로 낸다
//! - `type:"assistant"`: `text` → [`ChatItem::Assistant`], `thinking` → [`ChatItem::Thinking`](내용이 있을 때만),
//!   `tool_use` → [`ChatItem::ToolUse`]. claude 는 조각 하나가 끝날 때마다 줄을 하나씩 쓴다
//! - `type:"system"`: 압축 경계, 턴에 걸린 시간, 알림
//! - `type:"attachment"` 의 `queued_command`: 일하는 중에 보내 줄 서 있다가 들어간 사용자 글
//!
//! 넣지 않는 것: `isMeta`(스킬 본문 등 동반 줄), `isSidechain`(서브에이전트), 압축 요약 본문, 요청 사본(`api-request*`)
//! 같은 기록용 줄. 긴 도구 입력 · 결과는 잘라서 낸다 (폰도 같은 응답을 받는다).
//!
//! 상태를 들지 않는다. 화면이 지난 응답의 `offset` 을 돌려주면 그 뒤만 읽는다.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;
use thuminal_protocol::{AgentChat, AgentSession, ChatItem, ChatStatus};

/// 도구 결과 글을 이 바이트까지 남긴다
const RESULT_MAX: usize = 6 * 1024;
/// 도구 입력의 글 하나를 이 바이트까지 남긴다 (Write 의 내용, Edit 의 앞뒤 글)
const INPUT_STR_MAX: usize = 4 * 1024;
/// 한 줄이 이보다 길면 건너뛴다
const MAX_LINE: usize = 64 * 1024 * 1024;

/// 글자 경계에 맞춰 `max` 바이트까지 자른다. 잘랐으면 true
fn clip(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

/// 도구 입력의 긴 글을 자른다 (자른 글 끝에 `…`)
fn clip_input(v: &Value) -> Value {
    match v {
        Value::String(s) => {
            let (t, cut) = clip(s, INPUT_STR_MAX);
            Value::String(if cut { format!("{t}…") } else { t })
        }
        Value::Array(a) => Value::Array(a.iter().take(64).map(clip_input).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), clip_input(v))).collect()),
        other => other.clone(),
    }
}

/// `<tag>…</tag>` 안의 글 (없으면 None)
fn tag<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let a = s.find(&open)? + open.len();
    let b = s[a..].find(&close)? + a;
    Some(&s[a..b])
}

/// `<system-reminder>…</system-reminder>` 덩어리를 뺀다 (claude 가 사용자 글에 끼워 넣은 것)
fn strip_reminders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(a) = rest.find("<system-reminder>") {
        out.push_str(&rest[..a]);
        match rest[a..].find("</system-reminder>") {
            Some(b) => rest = &rest[a + b + "</system-reminder>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// 붙여 넣은 글을 감싼 `<pasted_content id="…">` · `</pasted_content id="…">` 꼬리표를 뺀다 (안의 글은 둔다)
fn strip_paste_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let open = rest.find("<pasted_content");
        let close = rest.find("</pasted_content");
        let Some(a) = [open, close].into_iter().flatten().min() else { break };
        let Some(b) = rest[a..].find('>') else { break };
        out.push_str(&rest[..a]);
        rest = &rest[a + b + 1..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// 터미널 색 코드(CSI)를 뺀다 (슬래시 명령 출력에 들어 있다)
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if ('@'..='~').contains(&d) {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn notice(id: &str, at: u64, kind: &str, text: impl Into<String>) -> ChatItem {
    ChatItem::Notice { id: id.to_string(), at, kind: kind.into(), text: text.into() }
}

/// 사용자 글 하나를 조각으로. 슬래시 명령 · 명령 출력 · 멈춤 표시는 알림으로, 그 밖은 사용자 글로 낸다
fn user_text(id: &str, at: u64, text: &str, images: Vec<String>, parent: Option<&str>, out: &mut Vec<ChatItem>) {
    if let Some(name) = tag(text, "command-name") {
        let args = tag(text, "command-args").unwrap_or("").trim();
        let line = if args.is_empty() { name.trim().to_string() } else { format!("{} {args}", name.trim()) };
        out.push(notice(id, at, "command", line));
        return;
    }
    if text.contains("<local-command-stdout>") || text.contains("<local-command-stderr>") {
        let body = tag(text, "local-command-stdout").or_else(|| tag(text, "local-command-stderr")).unwrap_or("");
        let body = strip_ansi(body);
        if !body.trim().is_empty() {
            out.push(notice(id, at, "command_output", clip(body.trim(), RESULT_MAX).0));
        }
        return;
    }
    // 셸 모드(`!`): 친 명령은 `!명령` 사용자 글로, 출력은 알림(`shell_output`)으로 낸다
    if let Some(cmd) = tag(text, "bash-input") {
        out.push(ChatItem::User { id: id.to_string(), at, text: format!("!{cmd}"), images: Vec::new(), parent: parent.map(str::to_string) });
        return;
    }
    if text.contains("<bash-stdout>") || text.contains("<bash-stderr>") {
        let stdout = strip_ansi(tag(text, "bash-stdout").unwrap_or(""));
        let stderr = strip_ansi(tag(text, "bash-stderr").unwrap_or(""));
        let body = [stdout.trim_end(), stderr.trim_end()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n");
        out.push(notice(id, at, "shell_output", clip(&body, RESULT_MAX).0));
        return;
    }
    if text.starts_with("<local-command-caveat>") || text.starts_with("<task-notification>") {
        return;
    }
    // 에이전트 팀: 다른 claude 가 보낸 글. 리더가 팀원에게 준 일은 그 팀원의 프롬프트이고, 팀원이 보낸 글은 알림으로 낸다
    if text.contains("<teammate-message") {
        let mut rest = text;
        let mut n = 0;
        while let Some(a) = rest.find("<teammate-message") {
            let Some(head_end) = rest[a..].find('>').map(|i| a + i) else { break };
            let Some(close) = rest[head_end..].find("</teammate-message>").map(|i| head_end + i) else { break };
            let head = &rest[a..head_end];
            let from = head.split("teammate_id=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("");
            let body = rest[head_end + 1..close].trim();
            let part = if n == 0 { id.to_string() } else { format!("{id}:{n}") };
            if from == "team-lead" {
                out.push(ChatItem::User { id: part, at, text: body.to_string(), images: Vec::new(), parent: None });
            } else if !body.is_empty() {
                out.push(notice(&part, at, "teammate", format!("{from}\n{body}")));
            }
            n += 1;
            rest = &rest[close + "</teammate-message>".len()..];
        }
        return;
    }
    if text.starts_with("[Request interrupted by user") {
        out.push(notice(id, at, "interrupted", ""));
        return;
    }
    let text = strip_paste_tags(&strip_reminders(text));
    if text.is_empty() && images.is_empty() {
        return;
    }
    out.push(ChatItem::User { id: id.to_string(), at, text, images, parent: parent.map(str::to_string) });
}

/// 도구 결과 내용(문자열이나 조각 배열)을 글로
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 기록 한 줄에서 나오는 조각들. `pos` 는 줄이 시작하는 바이트 위치 (그림 id 를 `images.rs` 와 같게 만든다)
pub fn items_in_line(line: &[u8], pos: u64) -> Vec<ChatItem> {
    line_items(line, pos, false, &mut ChatStatus::default())
}

/// `30.7k` · `1m` · `936` 같은 토큰 수 글을 수로
fn token_count(s: &str) -> Option<u64> {
    let s = s.trim().to_ascii_lowercase();
    let (num, mul) = match s.as_bytes().last()? {
        b'k' => (&s[..s.len() - 1], 1_000.0),
        b'm' => (&s[..s.len() - 1], 1_000_000.0),
        _ => (s.as_str(), 1.0),
    };
    num.parse::<f64>().ok().map(|n| (n * mul) as u64)
}

/// 슬래시 명령 출력에서 상태를 읽는다: `/model` · `/effort` 가 알린 값, `/context` 의 `30.7k/1m tokens`
fn status_from_output(text: &str, st: &mut ChatStatus) {
    let quoted = |after: &str| text.split(after).nth(1).and_then(|r| r.split('`').nth(1)).map(str::to_string);
    if let Some(m) = quoted("Set model to").or_else(|| quoted("Kept model as")) {
        st.model = Some(m);
    }
    if let Some(e) = text.split("Set effort level to ").nth(1).and_then(|r| r.split([' ', ':', '(']).next()).filter(|e| !e.is_empty()) {
        st.effort = Some(e.to_string());
    }
    if let Some(i) = text.find(" tokens (") {
        let word = text[..i].rsplit(char::is_whitespace).next().unwrap_or("");
        if let Some((used, window)) = word.split_once('/')
            && let (Some(u), Some(w)) = (token_count(used), token_count(window))
        {
            st.context_tokens = Some(u);
            st.context_window = Some(w);
        }
    }
}

/// `sidechain` 이면 서브에이전트 기록이다 (줄마다 `isSidechain` 이 붙어 있다)
fn line_items(line: &[u8], pos: u64, sidechain: bool, st: &mut ChatStatus) -> Vec<ChatItem> {
    // 기록용 줄(`{"type":"api-request…"` 등)은 type 이 맨 앞에 온다. 대화 줄이 아니면 풀지 않는다 (요청 사본은 수 MB 다)
    if let Some(rest) = line.strip_prefix(br#"{"type":""#) {
        let kind = rest.split(|&b| b == b'"').next().unwrap_or(b"");
        if !matches!(kind, b"user" | b"assistant" | b"system" | b"attachment") {
            return Vec::new();
        }
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return Vec::new() };
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if flag("isSidechain") != sidechain {
        return Vec::new();
    }
    let id = v.get("uuid").and_then(Value::as_str).unwrap_or("");
    let at = v.get("timestamp").and_then(Value::as_str).and_then(crate::images::parse_time_ms).unwrap_or(0);
    let mut out = Vec::new();
    match v.get("type").and_then(Value::as_str) {
        Some("user") => {
            // 사용자가 친 글에만 앞 줄을 싣는다 (화면이 버려진 갈래를 가린다)
            let parent = v.get("parentUuid").and_then(Value::as_str);
            if flag("isCompactSummary") || flag("isVisibleInTranscriptOnly") {
                return out;
            }
            let meta = flag("isMeta");
            match v.pointer("/message/content") {
                Some(Value::String(s)) if !meta => {
                    if s.contains("<local-command-stdout>") {
                        status_from_output(&strip_ansi(s), st);
                    }
                    user_text(id, at, s, Vec::new(), parent, &mut out);
                }
                Some(Value::Array(parts)) => {
                    let mut text = String::new();
                    let mut images = Vec::new();
                    for (i, p) in parts.iter().enumerate() {
                        match p.get("type").and_then(Value::as_str) {
                            Some("text") if !meta => {
                                if !text.is_empty() {
                                    text.push('\n');
                                }
                                text.push_str(p.get("text").and_then(Value::as_str).unwrap_or(""));
                            }
                            Some("image") if !meta && p.pointer("/source/type").and_then(Value::as_str) == Some("base64") => images.push(format!("{pos}:{i}")),
                            Some("tool_result") => {
                                let Some(tool) = p.get("tool_use_id").and_then(Value::as_str) else { continue };
                                let (text, truncated) = clip(&result_text(p.get("content")), RESULT_MAX);
                                let is_error = p.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                                // 결과 속 그림은 줄 위치와 조각 차례로 가리킨다 (`images.rs` 가 그 줄만 다시 읽는다).
                                // 서브에이전트 기록의 그림은 그림 요청이 본 기록만 읽어 가리킬 수 없다
                                let images = match p.get("content") {
                                    Some(Value::Array(blocks)) if !sidechain => blocks
                                        .iter()
                                        .enumerate()
                                        .filter(|(_, b)| b.get("type").and_then(Value::as_str) == Some("image") && b.pointer("/source/type").and_then(Value::as_str) == Some("base64"))
                                        .map(|(j, _)| format!("tr:{pos}:{i}:{j}"))
                                        .collect(),
                                    _ => Vec::new(),
                                };
                                out.push(ChatItem::ToolResult { id: tool.to_string(), at, text, is_error, truncated, images });
                            }
                            _ => {}
                        }
                    }
                    if !text.is_empty() || !images.is_empty() {
                        user_text(id, at, &text, images, parent, &mut out);
                    }
                }
                _ => {}
            }
        }
        Some("assistant") => {
            let error = flag("isApiErrorMessage");
            if !error {
                if let Some(m) = v.pointer("/message/model").and_then(Value::as_str).filter(|m| !m.starts_with('<')) {
                    st.model = Some(m.to_string());
                }
                if let Some(e) = v.get("effort").and_then(Value::as_str) {
                    st.effort = Some(e.to_string());
                }
                let n = |k: &str| v.pointer(&format!("/message/usage/{k}")).and_then(Value::as_u64).unwrap_or(0);
                let used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                if used > 0 {
                    st.context_tokens = Some(used);
                }
            }
            let Some(parts) = v.pointer("/message/content").and_then(Value::as_array) else { return out };
            for (i, p) in parts.iter().enumerate() {
                let part_id = if i == 0 { id.to_string() } else { format!("{id}:{i}") };
                match p.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = p.get("text").and_then(Value::as_str).unwrap_or("");
                        if text.trim().is_empty() {
                            continue;
                        }
                        if error {
                            out.push(notice(&part_id, at, "error", text));
                        } else {
                            out.push(ChatItem::Assistant { id: part_id, at, text: text.to_string() });
                        }
                    }
                    Some("thinking") => {
                        // 요즘 claude 는 생각 본문을 기록에 남기지 않는다 (서명만 있다)
                        let text = p.get("thinking").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            out.push(ChatItem::Thinking { id: part_id, at, text: text.to_string() });
                        }
                    }
                    Some("tool_use") => {
                        let Some(tool) = p.get("id").and_then(Value::as_str) else { continue };
                        let name = p.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                        let input = p.get("input").map(clip_input).unwrap_or(Value::Null);
                        out.push(ChatItem::ToolUse { id: tool.to_string(), at, name, input });
                    }
                    _ => {}
                }
            }
        }
        Some("system") => {
            let content = v.get("content").and_then(Value::as_str).unwrap_or("");
            match v.get("subtype").and_then(Value::as_str) {
                Some("compact_boundary") => {
                    if let Some(n) = v.pointer("/compactMetadata/postTokens").and_then(Value::as_u64) {
                        st.context_tokens = Some(n);
                    }
                    out.push(notice(id, at, "compact", ""));
                }
                Some("turn_duration") => {
                    let ms = v.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
                    out.push(notice(id, at, "turn", ms.to_string()));
                }
                Some("local_command") => {
                    status_from_output(&strip_ansi(content), st);
                    user_text(id, at, content, Vec::new(), None, &mut out);
                }
                Some("informational") if !content.is_empty() => out.push(notice(id, at, "info", clip(content, RESULT_MAX).0)),
                Some("api_error") => {
                    let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or(content);
                    if !msg.is_empty() {
                        out.push(notice(id, at, "error", clip(msg, RESULT_MAX).0));
                    }
                }
                _ => {}
            }
        }
        Some("attachment") => {
            // 일하는 중에 보낸 글은 줄 서 있다가 이 줄로 들어간다 (따로 user 줄이 없다)
            let a = v.get("attachment");
            let get = |k: &str| a.and_then(|a| a.get(k)).and_then(Value::as_str);
            if get("type") == Some("queued_command") && get("commandMode") == Some("prompt") {
                match a.and_then(|a| a.get("prompt")) {
                    Some(Value::String(s)) => user_text(id, at, s, Vec::new(), None, &mut out),
                    Some(Value::Array(parts)) => {
                        let text: Vec<&str> = parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect();
                        // 같이 붙인 그림은 줄 위치와 조각 차례로 가리킨다 (`images.rs` 가 그 줄만 다시 읽는다)
                        let images = parts
                            .iter()
                            .enumerate()
                            .filter(|(_, p)| !sidechain && p.get("type").and_then(Value::as_str) == Some("image") && p.pointer("/source/type").and_then(Value::as_str) == Some("base64"))
                            .map(|(j, _)| format!("qc:{pos}:{j}"))
                            .collect();
                        user_text(id, at, &text.join("\n"), images, None, &mut out);
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// 기록을 읽는다. `known` 이 이 기록의 지난 자리면 그 뒤만, 아니면 처음부터 읽어 끝의 `tail` 개만 남긴다 (0 이면 모두)
pub fn read(path: &str, known: Option<(&str, u64)>, tail: u32) -> std::io::Result<AgentChat> {
    read_file(path, known, tail, false)
}

/// 도구 호출 `tool` 이 띄운 서브에이전트의 기록 파일. claude 는 `<기록 이름>/subagents/agent-<id>.jsonl` 에 쓰고
/// 옆의 `agent-<id>.meta.json` 에 부른 도구 호출 id(`toolUseId`)를 남긴다
pub fn subagent_path(transcript: &str, tool: &str) -> Option<String> {
    let dir = Path::new(transcript).with_extension("").join("subagents");
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".meta.json")) else { continue };
        let Some(meta) = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        if meta.get("toolUseId").and_then(Value::as_str) == Some(tool) {
            return Some(p.with_file_name(format!("{name}.jsonl")).to_string_lossy().into_owned());
        }
    }
    None
}

/// 서브에이전트 기록을 읽는다 ([`read`] 와 같되 서브에이전트 줄만 본다)
pub fn read_subagent(path: &str, known: Option<(&str, u64)>, tail: u32) -> std::io::Result<AgentChat> {
    read_file(path, known, tail, true)
}

fn read_file(path: &str, known: Option<(&str, u64)>, tail: u32, sidechain: bool) -> std::io::Result<AgentChat> {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        // 메시지를 보내기 전에는 기록 파일이 없다
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let reset = known.is_none_or(|(p, off)| p != path || off != 0);
            return Ok(AgentChat { transcript: path.to_string(), offset: 0, reset, more: false, items: Vec::new(), ..Default::default() });
        }
        Err(e) => return Err(e),
    };
    let start = known.filter(|(p, off)| *p == path && *off <= len).map(|(_, off)| off);
    let reset = start.is_none();
    let mut pos = start.unwrap_or(0);
    let mut items = Vec::new();
    let mut status = ChatStatus::default();
    let mut more = false;
    if pos < len {
        let mut file = File::open(Path::new(path))?;
        file.seek(SeekFrom::Start(pos))?;
        let mut rd = BufReader::with_capacity(256 * 1024, file);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            let n = rd.read_until(b'\n', &mut buf)?;
            // 끝까지 읽었거나 아직 다 쓰지 않은 줄: 다음에 다시 읽는다
            if n == 0 || buf.last() != Some(&b'\n') {
                break;
            }
            if buf.len() <= MAX_LINE {
                items.extend(line_items(&buf, pos, sidechain, &mut status));
            }
            pos += n as u64;
            // 처음부터 읽을 때는 끝쪽만 남긴다. 가끔 앞을 잘라 메모리를 묶어 둔다
            if reset && tail > 0 && items.len() > tail as usize * 2 {
                items.drain(..items.len() - tail as usize);
                more = true;
            }
        }
    }
    if reset && tail > 0 && items.len() > tail as usize {
        items.drain(..items.len() - tail as usize);
        more = true;
    }
    Ok(AgentChat { transcript: path.to_string(), offset: pos, reset, more, items, status })
}

/// 지난 대화 목록에 올리는 수
pub const SESSIONS_MAX: usize = 40;
/// 제목을 찾으려고 기록의 앞 · 뒤에서 읽는 바이트 (기록은 수백 MB 가 되기도 한다)
const TITLE_SCAN: u64 = 256 * 1024;
const TITLE_MAX: usize = 200;

/// `current` 기록과 같은 폴더(같은 프로젝트)에 있는 지난 대화, 최근에 쓴 것부터. `current` 와 사용자 글이 없는 기록은 뺀다
pub fn sessions(current: &str, limit: usize) -> Vec<AgentSession> {
    let cur = Path::new(current);
    let Some(rd) = cur.parent().and_then(|d| std::fs::read_dir(d).ok()) else { return Vec::new() };
    let mut files: Vec<(u64, std::path::PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension()? != "jsonl" || p == cur {
                return None;
            }
            let m = e.metadata().ok()?;
            let at = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            m.is_file().then_some((at, p))
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    files
        .into_iter()
        .filter_map(|(modified, p)| Some(AgentSession { id: p.file_stem()?.to_str()?.to_string(), title: session_title(&p)?, modified }))
        .take(limit)
        .collect()
}

/// 기록의 제목: 사용자가 붙인 이름 → claude 가 붙인 제목 → 마지막 사용자 글 → 처음 사용자 글. 앞 · 뒤 `TITLE_SCAN` 만 본다
fn session_title(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let read = |f: &mut File, from: u64, n: u64| -> Option<Vec<u8>> {
        f.seek(SeekFrom::Start(from)).ok()?;
        let mut buf = Vec::new();
        f.take(n).read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    if len <= TITLE_SCAN * 2 {
        chunks.push(read(&mut f, 0, len)?);
    } else {
        // 앞 조각은 끝의 잘린 줄을, 뒤 조각은 앞의 잘린 줄을 버린다
        let mut head = read(&mut f, 0, TITLE_SCAN)?;
        head.truncate(head.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1));
        let tail = read(&mut f, len - TITLE_SCAN, TITLE_SCAN)?;
        let start = tail.iter().position(|&b| b == b'\n').map_or(tail.len(), |i| i + 1);
        chunks.push(head);
        chunks.push(tail[start..].to_vec());
    }
    let (mut custom, mut ai, mut last, mut first) = (None, None, None, None);
    let has = |line: &[u8], needle: &[u8]| line.windows(needle.len()).any(|w| w == needle);
    for line in chunks.iter().flat_map(|c| c.split(|&b| b == b'\n')) {
        if has(line, b"-title\"") || has(line, b"\"last-prompt\"") {
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string);
            match v.get("type").and_then(Value::as_str) {
                Some("custom-title") => custom = s("customTitle").or(custom),
                Some("ai-title") => ai = s("aiTitle").or(ai),
                Some("last-prompt") => last = s("lastPrompt").or(last),
                _ => {}
            }
        } else if first.is_none() && has(line, b"\"type\":\"user\"") {
            first = items_in_line(line, 0).into_iter().find_map(|i| match i {
                ChatItem::User { text, .. } if !text.trim().is_empty() => Some(text),
                _ => None,
            });
        }
    }
    let title = custom.or(ai).or(last).or(first)?;
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(clip(&title, TITLE_MAX).0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sessions_lists_other_transcripts_with_titles() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, lines: Vec<Value>| {
            let p = dir.path().join(name);
            std::fs::write(&p, lines.into_iter().flat_map(line).collect::<Vec<u8>>()).unwrap();
            p.to_str().unwrap().to_string()
        };
        let user = |text: &str| json!({"type":"user","uuid":"u","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":text}});
        let cur = write("cur.jsonl", vec![user("지금 대화")]);
        write("titled.jsonl", vec![user("처음 글"), json!({"type":"ai-title","aiTitle":"옛 제목"}), json!({"type":"ai-title","aiTitle":"붙인  제목"})]);
        write("plain.jsonl", vec![json!({"type":"mode","mode":"normal"}), user("첫 줄\n둘째 줄")]);
        write("empty.jsonl", vec![json!({"type":"mode","mode":"normal"})]);
        write("note.txt", vec![user("기록이 아니다")]);
        let mut got: Vec<(String, String)> = sessions(&cur, 10).into_iter().map(|s| (s.id, s.title)).collect();
        got.sort();
        assert_eq!(got, vec![("plain".to_string(), "첫 줄 둘째 줄".to_string()), ("titled".to_string(), "붙인 제목".to_string())]);
        assert_eq!(sessions(&cur, 1).len(), 1);
    }

    fn line(v: Value) -> Vec<u8> {
        let mut b = serde_json::to_vec(&v).unwrap();
        b.push(b'\n');
        b
    }

    fn items(v: Value) -> Vec<ChatItem> {
        items_in_line(&line(v), 0)
    }

    #[test]
    fn user_lines() {
        let got = items(json!({"type":"user","uuid":"u1","timestamp":"2026-11-20T04:29:28.542Z","message":{"role":"user","content":"고쳐 줘"}}));
        assert_eq!(got, vec![ChatItem::User { id: "u1".into(), at: 1_795_148_968_542, text: "고쳐 줘".into(), images: vec![], parent: None }]);
        // 동반 줄 · 서브에이전트 · 압축 요약은 뺀다
        assert!(items(json!({"type":"user","uuid":"u","isMeta":true,"message":{"content":"스킬 본문"}})).is_empty());
        assert!(items(json!({"type":"user","uuid":"u","isSidechain":true,"message":{"content":"x"}})).is_empty());
        assert!(items(json!({"type":"user","uuid":"u","isCompactSummary":true,"message":{"content":"요약"}})).is_empty());
        // 슬래시 명령, 출력, 멈춤
        let got = items(json!({"type":"user","uuid":"c","message":{"content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"}}));
        assert_eq!(got, vec![notice("c", 0, "command", "/model opus")]);
        let got = items(json!({"type":"system","subtype":"local_command","uuid":"o","content":"<local-command-stdout>\u{1b}[1mSet model\u{1b}[22m</local-command-stdout>"}));
        assert_eq!(got, vec![notice("o", 0, "command_output", "Set model")]);
        assert!(items(json!({"type":"system","subtype":"local_command","uuid":"o","content":"<local-command-stdout></local-command-stdout>"})).is_empty());
        let got = items(json!({"type":"user","uuid":"i","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}));
        assert_eq!(got, vec![notice("i", 0, "interrupted", "")]);
        // 끼워 넣은 알림 글은 뺀다. 그림 id 는 줄 위치와 content 차례다
        let l = line(json!({"type":"user","uuid":"p","message":{"content":[
            {"type":"text","text":"<system-reminder>몰라도 됨</system-reminder>이것 봐"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}}));
        assert_eq!(items_in_line(&l, 77), vec![ChatItem::User { id: "p".into(), at: 0, text: "이것 봐".into(), images: vec!["77:1".into()], parent: None }]);
        // 팀원이 보낸 글은 알림, 리더가 준 일은 프롬프트
        let got = items(json!({"type":"user","uuid":"m","message":{"content":"Another Claude session sent a message:\n<teammate-message teammate_id=\"scout\" color=\"blue\" summary=\"요약\">\n다 했다\n</teammate-message>\n\nThis came from another Claude session"}}));
        assert_eq!(got, vec![notice("m", 0, "teammate", "scout\n다 했다")]);
        let got = items(json!({"type":"user","uuid":"m","message":{"content":"<teammate-message teammate_id=\"team-lead\">\n읽어라\n</teammate-message>"}}));
        assert_eq!(got, vec![ChatItem::User { id: "m".into(), at: 0, text: "읽어라".into(), images: vec![], parent: None }]);
        // 붙여 넣은 글의 꼬리표는 뺀다
        let got = items(json!({"type":"user","uuid":"pc","message":{"content":"<pasted_content id=\"f3ac\">\n아래를 해 줘.\n1. ls\n</pasted_content id=\"f3ac\">"}}));
        assert_eq!(got, vec![ChatItem::User { id: "pc".into(), at: 0, text: "아래를 해 줘.\n1. ls".into(), images: vec![], parent: None }]);
        // 줄 서 있다가 들어간 글
        let got = items(json!({"type":"attachment","uuid":"q","attachment":{"type":"queued_command","commandMode":"prompt","prompt":"하나 더"}}));
        assert_eq!(got, vec![ChatItem::User { id: "q".into(), at: 0, text: "하나 더".into(), images: vec![], parent: None }]);
        assert!(items(json!({"type":"attachment","uuid":"q","attachment":{"type":"queued_command","commandMode":"task-notification","prompt":"<task-notification>"}})).is_empty());
        // 셸 모드
        let got = items(json!({"type":"user","uuid":"b","parentUuid":"p","message":{"content":"<bash-input>echo hi && ls</bash-input>"}}));
        assert_eq!(got, vec![ChatItem::User { id: "b".into(), at: 0, text: "!echo hi && ls".into(), images: vec![], parent: Some("p".into()) }]);
        let got = items(json!({"type":"user","uuid":"o","message":{"content":"<bash-stdout>hi\na.txt</bash-stdout><bash-stderr>\u{1b}[31mwarn\u{1b}[0m</bash-stderr>"}}));
        assert_eq!(got, vec![notice("o", 0, "shell_output", "hi\na.txt\nwarn")]);
        // 그림을 붙여 보낸 글: 그림은 줄 위치와 조각 차례로 가리킨다
        let got = items(json!({"type":"attachment","uuid":"q","attachment":{"type":"queued_command","commandMode":"prompt","prompt":[
            {"type":"text","text":"[Image #3] 봐"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}]}}));
        assert_eq!(got, vec![ChatItem::User { id: "q".into(), at: 0, text: "[Image #3] 봐".into(), images: vec!["qc:0:1".into()], parent: None }]);
    }

    #[test]
    fn assistant_and_tools() {
        let got = items(json!({"type":"assistant","uuid":"a","message":{"content":[
            {"type":"thinking","thinking":"","signature":"x"},
            {"type":"text","text":"볼게요"},
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls","big":"가".repeat(5000)}}]}}));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], ChatItem::Assistant { id: "a:1".into(), at: 0, text: "볼게요".into() });
        let ChatItem::ToolUse { id, name, input, .. } = &got[1] else { panic!() };
        assert_eq!((id.as_str(), name.as_str(), input["command"].as_str()), ("t1", "Bash", Some("ls")));
        let big = input["big"].as_str().unwrap();
        assert!(big.len() <= INPUT_STR_MAX + 3 && big.ends_with('…'));

        let got = items(json!({"type":"user","uuid":"r","message":{"content":[
            {"type":"text","text":"x"},
            {"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"Exit code 1"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}},{"type":"image","source":{}}]}]}}));
        assert_eq!(got[0], ChatItem::ToolResult { id: "t1".into(), at: 0, text: "Exit code 1".into(), is_error: true, truncated: false, images: vec!["tr:0:1:1".into()] });
        let got = items(json!({"type":"user","uuid":"r","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"나".repeat(9000)}]}}));
        let ChatItem::ToolResult { text, truncated, .. } = &got[0] else { panic!() };
        assert!(*truncated && text.len() <= RESULT_MAX);

        let got = items(json!({"type":"assistant","uuid":"e","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 529"}]}}));
        assert_eq!(got, vec![notice("e", 0, "error", "API Error: 529")]);
        assert_eq!(items(json!({"type":"system","subtype":"turn_duration","uuid":"d","durationMs":2100})), vec![notice("d", 0, "turn", "2100")]);
        assert_eq!(items(json!({"type":"system","subtype":"compact_boundary","uuid":"b","content":"Conversation compacted"})), vec![notice("b", 0, "compact", "")]);
        // 기록용 줄은 풀지 않는다
        assert!(items_in_line(br#"{"type":"api-request-blob","message":{"content":"x"}}"#, 0).is_empty());
    }

    #[test]
    fn reads_status() {
        let mut st = ChatStatus::default();
        let l = line(json!({"type":"assistant","uuid":"a","effort":"high","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":2,"cache_read_input_tokens":23158,"cache_creation_input_tokens":19617,"output_tokens":3},"content":[{"type":"text","text":"2"}]}}));
        line_items(&l, 0, false, &mut st);
        assert_eq!((st.model.as_deref(), st.effort.as_deref(), st.context_tokens, st.context_window), (Some("claude-sonnet-5-5"), Some("high"), Some(42_777), None));
        // 슬래시 명령 출력이 알린 값
        let out = |text: &str| line(json!({"type":"system","subtype":"local_command","uuid":"o","content":format!("<local-command-stdout>{text}</local-command-stdout>")}));
        line_items(&out("Set model to `Opus 5.5` and saved as your default for new sessions"), 0, false, &mut st);
        line_items(&out("Set effort level to low (saved as your default for new sessions): Quick"), 0, false, &mut st);
        line_items(&out("\u{1b}[1mContext usage\u{1b}[22m\n ⛁ ⛁  \u{1b}[38;5;246m30.7k/1m tokens (3%)\u{1b}[39m"), 0, false, &mut st);
        assert_eq!((st.model.as_deref(), st.effort.as_deref(), st.context_tokens, st.context_window), (Some("Opus 5.5"), Some("low"), Some(30_700), Some(1_000_000)));
    }

    #[test]
    fn reads_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let p = path.to_str().unwrap();
        // 파일이 아직 없다
        let c = read(p, None, 0).unwrap();
        assert_eq!((c.offset, c.reset, c.items.len()), (0, true, 0));
        assert!(!read(p, Some((p, 0)), 0).unwrap().reset);

        let user = |n: usize| line(json!({"type":"user","uuid":format!("u{n}"),"message":{"content":format!("글 {n}")}}));
        let mut all: Vec<u8> = (0..5).flat_map(user).collect();
        std::fs::write(&path, &all).unwrap();
        let c = read(p, None, 3).unwrap();
        assert_eq!((c.reset, c.more, c.items.len(), c.offset), (true, true, 3, all.len() as u64));
        let ChatItem::User { id, .. } = &c.items[0] else { panic!() };
        assert_eq!(id, "u2");

        // 덧붙은 줄만 읽는다. 다 쓰지 않은 줄은 다음에 읽는다
        let next = user(5);
        all.extend(&next);
        all.extend(br#"{"type":"user","uuid":"half"#);
        std::fs::write(&path, &all).unwrap();
        let d = read(p, Some((p, c.offset)), 3).unwrap();
        assert_eq!((d.reset, d.more, d.items.len(), d.offset), (false, false, 1, c.offset + next.len() as u64));
        // 서브에이전트 기록: 메타 파일의 도구 호출 id 로 찾고, 서브에이전트 줄만 읽는다
        let sub = dir.path().join("t/subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("agent-a1.meta.json"), br#"{"toolUseId":"toolu_x"}"#).unwrap();
        std::fs::write(sub.join("agent-a1.jsonl"), line(json!({"type":"user","uuid":"s","isSidechain":true,"message":{"content":"찾아 줘"}}))).unwrap();
        let sp = subagent_path(p, "toolu_x").unwrap();
        assert!(sp.ends_with("agent-a1.jsonl") && subagent_path(p, "toolu_y").is_none());
        assert_eq!((read_subagent(&sp, None, 0).unwrap().items.len(), read(&sp, None, 0).unwrap().items.len()), (1, 0));
        // 다른 기록이었거나 파일이 줄었으면 처음부터
        assert!(read(p, Some(("/other.jsonl", 10)), 0).unwrap().reset);
        assert!(read(p, Some((p, all.len() as u64 + 1)), 0).unwrap().reset);
    }
}
