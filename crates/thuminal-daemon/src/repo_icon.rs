//! 저장소 아이콘 찾기 (사이드바 프로젝트 머리에 그린다).
//!
//! Orca 의 `repo-icon-file-detection.ts` 를 따른다: 흔한 자리의 png·webp 파일을 정한 차례로 보고,
//! 없으면 `index.html`·루트 라우트 파일이 `<link rel="icon" href=…>` 로 가리키는 파일을 본다.
//! 파일 종류는 확장자가 아니라 머리 바이트로 가르고, 256KB 를 넘는 파일은 건너뛴다.
//! Orca 에는 없는 것 하나: 맨 위에서 못 찾으면 모노레포 하위 프로젝트(`apps/*`, `packages/*`)에서 같은 차례로 찾는다.
//! Orca 가 그다음에 쓰는 네트워크 아이콘(package.json homepage favicon, GitHub 주인 아바타)은 쓰지 않는다
//! (데몬이 밖에 묻지 않고, 앱 CSP 가 https 그림을 막는다).

use std::path::Path;

/// 차례대로 볼 파일 자리 (확장자 뺀 것). Orca `REPO_ICON_FILE_STEMS` 와 같다
const STEMS: &[&str] = &[
    "favicon",
    "public/favicon",
    "app/favicon",
    "app/icon",
    "src/favicon",
    "src/app/icon",
    "assets/favicon",
    "assets/icon",
    "static/favicon",
    "logo",
    "public/logo",
    "public/icon",
    "src-tauri/icons/icon",
    "app-icon",
    "icon",
];

const EXTENSIONS: &[&str] = &["png", "webp"];

/// 아이콘 href 를 찾아볼 소스 파일. Orca `REPO_ICON_SOURCE_FILE_CANDIDATES` 와 같다
const SOURCES: &[&str] = &["index.html", "public/index.html", "app/routes/__root.tsx", "src/routes/__root.tsx", "app/root.tsx", "src/root.tsx", "src/index.html"];

/// 모노레포 하위 프로젝트를 담는 폴더. 맨 위에서 못 찾았을 때 이 폴더 바로 아래를 이름 차례로 본다
const SUBPROJECT_DIRS: &[&str] = &["apps", "packages"];
/// 하위 프로젝트 폴더마다 볼 수 (너무 많이 뒤지지 않게)
const MAX_SUBPROJECTS: usize = 16;

const MAX_ICON_BYTES: u64 = 256 * 1024;
const MAX_SOURCE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundIcon {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    /// 저장소 기준 상대 경로
    pub file: String,
}

/// 저장소 폴더에서 아이콘을 찾는다
pub fn find(root: &Path) -> Option<FoundIcon> {
    if let Some(icon) = find_in(root, "") {
        return Some(icon);
    }
    for dir in SUBPROJECT_DIRS {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else { continue };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.') && n != "node_modules")
            .collect();
        names.sort();
        for name in names.into_iter().take(MAX_SUBPROJECTS) {
            if let Some(icon) = find_in(root, &format!("{dir}/{name}/")) {
                return Some(icon);
            }
        }
    }
    None
}

/// `prefix`(빈 글 또는 `apps/desktop/` 처럼 `/` 로 끝나는 상대 경로) 아래에서 찾는다
fn find_in(root: &Path, prefix: &str) -> Option<FoundIcon> {
    for stem in STEMS {
        for ext in EXTENSIONS {
            if let Some(icon) = read_icon(root, &format!("{prefix}{stem}.{ext}")) {
                return Some(icon);
            }
        }
    }
    for source in SOURCES {
        let path = root.join(prefix).join(source);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_SOURCE_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Some(href) = extract_icon_href(&text) else { continue };
        for rel in icon_href_candidates(&href, source) {
            if let Some(icon) = read_icon(root, &format!("{prefix}{rel}")) {
                return Some(icon);
            }
        }
    }
    None
}

fn read_icon(root: &Path, rel: &str) -> Option<FoundIcon> {
    let path = root.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let mime = sniff(&bytes)?;
    Some(FoundIcon { mime, bytes, file: rel.to_string() })
}

/// 화면이 그리는 png·webp 만 받는다
fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// `<link rel="icon" href="…">` 또는 (TanStack 같은 루트 라우트의) `{ rel: 'icon', href: '…' }` 의 href.
/// rel 은 `icon`·`shortcut icon` 만 본다 (Orca `extractIconHref` 와 같다)
fn extract_icon_href(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<link") {
        let start = at + i;
        let end = lower[start..].find('>').map_or(lower.len(), |j| start + j);
        let tag = &source[start..end];
        if is_icon_rel(tag, '=')
            && let Some(href) = prop_values(tag, "href", '=').into_iter().find_map(clean_href)
        {
            return Some(href);
        }
        at = end;
    }
    for chunk in source.split('}') {
        if is_icon_rel(chunk, ':')
            && let Some(href) = prop_values(chunk, "href", ':').into_iter().find_map(clean_href)
        {
            return Some(href);
        }
    }
    None
}

fn is_icon_rel(text: &str, sep: char) -> bool {
    prop_values(text, "rel", sep).iter().any(|v| v.eq_ignore_ascii_case("icon") || v.eq_ignore_ascii_case("shortcut icon"))
}

fn clean_href(v: String) -> Option<String> {
    let v = v.split('?').next().unwrap_or_default();
    (!v.is_empty()).then(|| v.to_string())
}

/// `name="값"` (sep `=`) 또는 `name: '값'` (sep `:`) 꼴의 값들. 이름은 대소문자를 가리지 않는다
fn prop_values(text: &str, name: &str, sep: char) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find(name) {
        let start = at + i;
        at = start + name.len();
        let boundary = lower[..start].chars().next_back().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        if !boundary {
            continue;
        }
        let rest = text[at..].trim_start();
        let Some(rest) = rest.strip_prefix(sep) else { continue };
        let rest = rest.trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
        let body = &rest[1..];
        if let Some(close) = body.find(quote) {
            out.push(body[..close].to_string());
        }
    }
    out
}

/// href 를 저장소 기준 상대 경로 후보로 푼다. 밖을 가리키는 주소(`https:`, `//`)와 `..` 는 버린다.
/// 상대 href 는 소스 파일 옆을 먼저 보고, 그다음 `public/`, 맨 위 차례 (Orca `iconHrefCandidates` 와 같다)
fn icon_href_candidates(href: &str, source_file: &str) -> Vec<String> {
    let href = href.trim();
    let has_scheme = href.find(':').is_some_and(|i| {
        let scheme = &href[..i];
        scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if href.is_empty() || href.starts_with("//") || has_scheme {
        return Vec::new();
    }
    let root_relative = href.starts_with('/');
    let path_only = href.split(['?', '#']).next().unwrap_or_default().replace('\\', "/");
    let parts: Vec<&str> = path_only.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() || parts.contains(&"..") {
        return Vec::new();
    }
    let path = parts.join("/");
    let mut out: Vec<String> = Vec::new();
    if !root_relative && let Some((dir, _)) = source_file.rsplit_once('/') {
        out.push(format!("{dir}/{path}"));
    }
    for c in [format!("public/{path}"), path] {
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    const WEBP: &[u8] = b"RIFF\0\0\0\0WEBPVP8 ";

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    fn found(root: &Path) -> Option<String> {
        find(root).map(|i| i.file)
    }

    #[test]
    fn 정한_차례로_첫_아이콘을_고른다() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(found(root), None);

        // 하위 프로젝트 것은 맨 위에 아무것도 없을 때만
        put(root, "apps/web/public/icon.png", PNG);
        put(root, "apps/desktop/src-tauri/icons/icon.png", PNG);
        assert_eq!(found(root).as_deref(), Some("apps/desktop/src-tauri/icons/icon.png"));

        // index.html 이 가리키는 파일은 정한 자리보다 뒤
        put(root, "index.html", br#"<head><link rel="stylesheet" href="a.css"><link href="/brand/mark.webp?v=2" rel="icon"></head>"#);
        put(root, "public/brand/mark.webp", WEBP);
        assert_eq!(found(root).as_deref(), Some("public/brand/mark.webp"));

        put(root, "icon.png", PNG);
        assert_eq!(found(root).as_deref(), Some("icon.png"));
        put(root, "logo.webp", WEBP);
        assert_eq!(found(root).as_deref(), Some("logo.webp"));
        // png 가 webp 보다 앞, favicon 이 logo 보다 앞
        put(root, "public/favicon.webp", WEBP);
        put(root, "public/favicon.png", PNG);
        assert_eq!(found(root).as_deref(), Some("public/favicon.png"));
        let icon = find(root).unwrap();
        assert_eq!(icon.mime, "image/png");

        // 그림이 아니거나 너무 크면 건너뛴다
        put(root, "favicon.png", b"not an image");
        assert_eq!(found(root).as_deref(), Some("public/favicon.png"));
        let mut big = PNG.to_vec();
        big.resize(MAX_ICON_BYTES as usize + 1, 0);
        put(root, "favicon.png", &big);
        assert_eq!(found(root).as_deref(), Some("public/favicon.png"));
        // 머리 바이트로 가른다 (확장자가 png 여도 webp 면 webp)
        put(root, "favicon.png", WEBP);
        assert_eq!(find(root).map(|i| (i.file, i.mime)), Some(("favicon.png".into(), "image/webp")));
    }

    #[test]
    fn href_를_찾아_후보로_푼다() {
        assert_eq!(extract_icon_href(r#"<LINK REL='shortcut icon' HREF='./fav.png'>"#).as_deref(), Some("./fav.png"));
        assert_eq!(extract_icon_href(r#"<link rel="apple-touch-icon" href="a.png">"#), None);
        assert_eq!(extract_icon_href(r#"links: [{ rel: 'icon', href: '/favicon.png' }]"#).as_deref(), Some("/favicon.png"));
        assert_eq!(icon_href_candidates("img/a.png", "app/routes/__root.tsx"), ["app/routes/img/a.png", "public/img/a.png", "img/a.png"]);
        assert_eq!(icon_href_candidates("/a.png", "index.html"), ["public/a.png", "a.png"]);
        assert!(icon_href_candidates("../x.png", "index.html").is_empty());
        assert!(icon_href_candidates("https://x.com/a.png", "index.html").is_empty());
        assert!(icon_href_candidates("//x.com/a.png", "index.html").is_empty());
    }
}
