//! 배치 한 줄 문법: `row(claude, col(zsh, "npm run dev"):40%)`.
//!
//! ```text
//! spec   := split | leaf
//! split  := ("row" | "col") "(" item ("," item)* ")"
//! item   := spec [":" size]            size := 숫자 "%" | 0~1 소수
//! leaf   := paneid [title] | command
//! paneid := "p" 숫자                    이미 있는 칸 (뒤의 제목 글은 무시한다)
//! command:= 따옴표 글 | 맨 낱말들       "zsh" "shell" "sh" "_" 은 그냥 셸, 그 밖은 셸에 입력할 명령
//! ```
//!
//! 크기를 일부만 주면 나머지 칸이 남는 몫을 똑같이 나눈다. [`print`] 의 출력은 [`parse`] 에 그대로 다시 넣을 수 있다.

use thuminal_protocol::{Axis, LayoutSpec, Pane, PaneId, PaneNode, PaneRef, Spawn};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("배치 글 {pos}번째 글자: {msg}")]
pub struct ParseError {
    pub pos: usize,
    pub msg: String,
}

/// 그냥 셸을 뜻하는 낱말
const PLAIN_SHELL: &[&str] = &["zsh", "shell", "sh", "_"];

pub fn parse(text: &str) -> Result<LayoutSpec, ParseError> {
    let mut p = Parser { s: text.chars().collect(), i: 0 };
    let (spec, size) = p.item()?;
    p.ws();
    if p.i < p.s.len() {
        return p.err("여기서 끝나야 한다");
    }
    if size.is_some() {
        return Err(ParseError { pos: 0, msg: "맨 바깥 칸에는 크기를 줄 수 없다".into() });
    }
    Ok(spec)
}

struct Parser {
    s: Vec<char>,
    i: usize,
}

impl Parser {
    fn err<T>(&self, msg: &str) -> Result<T, ParseError> {
        Err(ParseError { pos: self.i + 1, msg: msg.into() })
    }

    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.i += 1;
        }
    }

    /// `row(` / `col(` 이면 축
    fn split_head(&mut self) -> Option<Axis> {
        for (word, axis) in [("row", Axis::Row), ("col", Axis::Column), ("column", Axis::Column)] {
            let n = word.chars().count();
            if self.s.len() >= self.i + n && self.s[self.i..self.i + n].iter().copied().eq(word.chars()) {
                let mut j = self.i + n;
                while self.s.get(j).is_some_and(|c| c.is_whitespace()) {
                    j += 1;
                }
                if self.s.get(j) == Some(&'(') {
                    self.i = j + 1;
                    return Some(axis);
                }
            }
        }
        None
    }

    fn item(&mut self) -> Result<(LayoutSpec, Option<f32>), ParseError> {
        self.ws();
        if let Some(axis) = self.split_head() {
            let mut items = vec![self.item()?];
            loop {
                self.ws();
                match self.peek() {
                    Some(',') => {
                        self.i += 1;
                        items.push(self.item()?);
                    }
                    Some(')') => {
                        self.i += 1;
                        break;
                    }
                    _ => return self.err("`,` 나 `)` 가 와야 한다"),
                }
            }
            let at = self.i;
            let sizes = resolve_sizes(&items.iter().map(|(_, s)| *s).collect::<Vec<_>>()).map_err(|msg| ParseError { pos: at, msg })?;
            let spec = LayoutSpec::Split { axis, children: items.into_iter().map(|(c, _)| c).collect(), sizes };
            self.ws();
            let size = if self.peek() == Some(':') {
                self.i += 1;
                Some(self.size_token()?)
            } else {
                None
            };
            return Ok((spec, size));
        }
        self.leaf()
    }

    /// 칸 하나: `p7 제목:30%`, `"npm run dev":40%`, `claude`
    fn leaf(&mut self) -> Result<(LayoutSpec, Option<f32>), ParseError> {
        let start = self.i;
        if let Some(id) = self.pane_id() {
            // 뒤의 제목은 읽기용이라 버린다
            self.ws();
            let (_, size) = self.text()?;
            return Ok((LayoutSpec::Pane { pane: PaneRef::Id(PaneId(id)) }, size));
        }
        let (cmd, size) = self.text()?;
        let cmd = cmd.trim();
        if cmd.is_empty() {
            self.i = start;
            return self.err("빈 칸이다 (셸은 zsh 나 _ 로 쓴다)");
        }
        let spawn = if PLAIN_SHELL.contains(&cmd) { Spawn::default() } else { Spawn { input: Some(cmd.to_string()), ..Default::default() } };
        Ok((LayoutSpec::Spawn { spawn }, size))
    }

    fn pane_id(&mut self) -> Option<u64> {
        if self.peek() != Some('p') {
            return None;
        }
        let mut j = self.i + 1;
        while self.s.get(j).is_some_and(char::is_ascii_digit) {
            j += 1;
        }
        if j == self.i + 1 {
            return None;
        }
        if self.s.get(j).is_some_and(|c| !(c.is_whitespace() || matches!(c, ',' | ')' | ':'))) {
            return None;
        }
        let id = self.s[self.i + 1..j].iter().collect::<String>().parse().ok()?;
        self.i = j;
        Some(id)
    }

    /// 따옴표 글이나 `,` `)` 앞까지의 맨 글, 그리고 뒤에 붙은 `:크기`
    fn text(&mut self) -> Result<(String, Option<f32>), ParseError> {
        if let Some(q @ ('"' | '\'')) = self.peek() {
            self.i += 1;
            let mut out = String::new();
            loop {
                match self.peek() {
                    None => return self.err("따옴표가 닫히지 않았다"),
                    Some(c) if c == q => {
                        self.i += 1;
                        break;
                    }
                    Some('\\') if q == '"' => {
                        self.i += 1;
                        match self.peek() {
                            Some(c) => out.push(c),
                            None => return self.err("따옴표가 닫히지 않았다"),
                        }
                        self.i += 1;
                    }
                    Some(c) => {
                        out.push(c);
                        self.i += 1;
                    }
                }
            }
            self.ws();
            let size = if self.peek() == Some(':') {
                self.i += 1;
                Some(self.size_token()?)
            } else {
                None
            };
            return Ok((out, size));
        }
        let start = self.i;
        while self.peek().is_some_and(|c| c != ',' && c != ')') {
            self.i += 1;
        }
        let raw: String = self.s[start..self.i].iter().collect();
        // 끝의 `:크기` 만 크기로 본다 (명령 안의 `:` 는 그대로 둔다)
        if let Some(k) = raw.rfind(':') {
            let tok = raw[k + 1..].trim();
            if !tok.is_empty() && tok.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '%') {
                let size = parse_size(tok).map_err(|msg| ParseError { pos: start + k + 2, msg })?;
                return Ok((raw[..k].trim().to_string(), Some(size)));
            }
        }
        Ok((raw.trim().to_string(), None))
    }

    fn size_token(&mut self) -> Result<f32, ParseError> {
        self.ws();
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_digit() || c == '.' || c == '%') {
            self.i += 1;
        }
        let tok: String = self.s[start..self.i].iter().collect();
        parse_size(&tok).map_err(|msg| ParseError { pos: start + 1, msg })
    }
}

/// `40%`, `33.3%`, `0.4`
pub fn parse_size(tok: &str) -> Result<f32, String> {
    let bad = || format!("크기는 40% 나 0.4 처럼 쓴다: {tok:?}");
    let v = match tok.strip_suffix('%') {
        Some(n) => n.trim().parse::<f32>().map_err(|_| bad())? / 100.0,
        None => tok.parse::<f32>().map_err(|_| bad())?,
    };
    if !(v > 0.0 && v < 1.0) {
        return Err(format!("크기는 0 과 100% 사이다: {tok}"));
    }
    Ok(v)
}

/// 일부만 준 크기를 채운다. 하나도 없으면 None (똑같이 나눈다)
fn resolve_sizes(given: &[Option<f32>]) -> Result<Option<Vec<f32>>, String> {
    if given.iter().all(Option::is_none) {
        return Ok(None);
    }
    let sum: f32 = given.iter().flatten().sum();
    let missing = given.iter().filter(|s| s.is_none()).count();
    if missing == 0 {
        return Ok(Some(given.iter().map(|s| s.expect("모두 있다") / sum).collect()));
    }
    if sum >= 1.0 - 1e-6 {
        return Err("크기 합이 100% 를 넘어 남은 칸에 줄 자리가 없다".into());
    }
    let rest = (1.0 - sum) / missing as f32;
    Ok(Some(given.iter().map(|s| s.unwrap_or(rest)).collect()))
}

/// 칸 트리를 한 줄로. `label` 은 칸 뒤에 붙일 읽기용 제목 (빈 글이면 붙이지 않는다)
pub fn print(node: &PaneNode, label: &dyn Fn(&Pane) -> String) -> String {
    match node {
        PaneNode::Pane { pane } => {
            let title = label(pane).replace(['\n', '\r', '\t'], " ");
            if title.trim().is_empty() { format!("{}", pane.id) } else { format!("{} {}", pane.id, quote(&title)) }
        }
        PaneNode::Split { axis, children, sizes } => {
            let head = match axis {
                Axis::Row => "row",
                Axis::Column => "col",
            };
            let items: Vec<String> = children.iter().zip(sizes).map(|(c, s)| format!("{}:{}", print(c, label), percent(*s))).collect();
            format!("{head}({})", items.join(", "))
        }
    }
}

fn percent(s: f32) -> String {
    let v = (s * 1000.0).round() / 10.0;
    let t = format!("{v:.1}");
    format!("{}%", t.strip_suffix(".0").unwrap_or(&t))
}

fn quote(t: &str) -> String {
    let plain = !t.starts_with(['"', '\'', ' ']) && !t.ends_with(' ') && !t.contains([',', '(', ')', ':', '"', '\\']);
    if plain { t.to_string() } else { format!("\"{}\"", t.replace('\\', "\\\\").replace('"', "\\\"")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use thuminal_protocol::{PaneContent, SessionId};

    fn spawn(input: Option<&str>) -> LayoutSpec {
        LayoutSpec::Spawn { spawn: Spawn { input: input.map(str::to_string), ..Default::default() } }
    }

    fn pref(id: u64) -> LayoutSpec {
        LayoutSpec::Pane { pane: PaneRef::Id(PaneId(id)) }
    }

    #[test]
    fn parses_example() {
        let spec = parse(r#"row(claude, col(zsh, "npm run dev"):40%)"#).unwrap();
        assert_eq!(
            spec,
            LayoutSpec::Split {
                axis: Axis::Row,
                children: vec![
                    spawn(Some("claude")),
                    LayoutSpec::Split { axis: Axis::Column, children: vec![spawn(None), spawn(Some("npm run dev"))], sizes: None }
                ],
                sizes: Some(vec![0.6, 0.4]),
            }
        );
    }

    #[test]
    fn parses_pane_ids_titles_and_sizes() {
        let spec = parse(r#"row(p1 claude:60%, col(p2 zsh:50%, p3 "npm run dev":50%):40%)"#).unwrap();
        assert_eq!(
            spec,
            LayoutSpec::Split {
                axis: Axis::Row,
                children: vec![pref(1), LayoutSpec::Split { axis: Axis::Column, children: vec![pref(2), pref(3)], sizes: Some(vec![0.5, 0.5]) }],
                sizes: Some(vec![0.6, 0.4]),
            }
        );
        // 0~1 소수, 맨 낱말 명령 안의 `:` , 작은따옴표
        let spec = parse("col(echo a:b:0.25, 'x, y', _)").unwrap();
        let LayoutSpec::Split { children, sizes, .. } = spec else { panic!() };
        assert_eq!(children, vec![spawn(Some("echo a:b")), spawn(Some("x, y")), spawn(None)]);
        let sizes = sizes.unwrap();
        assert!((sizes[0] - 0.25).abs() < 1e-6 && (sizes[1] - 0.375).abs() < 1e-6);
        assert_eq!(parse("p12").unwrap(), pref(12));
        assert_eq!(parse("  p3 ~/wt/a  ").unwrap(), pref(3));
        assert_eq!(parse("pnpm dev").unwrap(), spawn(Some("pnpm dev")));
        assert_eq!(parse("rowdy").unwrap(), spawn(Some("rowdy")));
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["row(a, b", "row(a,, b)", "row(a:70%, b:40%, c)", "row(a:150%)", "a:50%", "row(a) x", r#""open"#, ""] {
            assert!(parse(bad).is_err(), "{bad:?} 를 받았다");
        }
    }

    fn term(id: u64) -> PaneNode {
        PaneNode::Pane { pane: Pane { id: PaneId(id), content: PaneContent::Terminal { session: SessionId(id + 10) } } }
    }

    #[test]
    fn print_round_trips_through_parse() {
        let tree = PaneNode::Split {
            axis: Axis::Row,
            children: vec![term(1), PaneNode::Split { axis: Axis::Column, children: vec![term(2), term(3)], sizes: vec![0.5, 0.5] }],
            sizes: vec![0.6, 0.4],
        };
        let titles = |p: &Pane| match p.id.0 {
            1 => "claude".to_string(),
            2 => "zsh".to_string(),
            _ => "npm run dev: (watch), \"x\"".to_string(),
        };
        let line = print(&tree, &titles);
        assert_eq!(line, r#"row(p1 claude:60%, col(p2 zsh:50%, p3 "npm run dev: (watch), \"x\"":50%):40%)"#);
        let spec = parse(&line).unwrap();
        assert_eq!(
            spec,
            LayoutSpec::Split {
                axis: Axis::Row,
                children: vec![pref(1), LayoutSpec::Split { axis: Axis::Column, children: vec![pref(2), pref(3)], sizes: Some(vec![0.5, 0.5]) }],
                sizes: Some(vec![0.6, 0.4]),
            }
        );
        // 3등분 같은 끝자리도 다시 읽힌다
        let thirds = PaneNode::Split { axis: Axis::Column, children: vec![term(1), term(2), term(3)], sizes: vec![1.0 / 3.0; 3] };
        let line = print(&thirds, &|_| String::new());
        assert_eq!(line, "col(p1:33.3%, p2:33.3%, p3:33.3%)");
        assert!(parse(&line).is_ok());
    }
}
