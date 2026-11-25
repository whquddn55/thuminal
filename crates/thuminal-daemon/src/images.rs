//! claude 대화 기록(transcript jsonl)에서 사용자가 붙여 보낸 그림을 찾는다. 칸 머리 [그림 N] 갤러리가 쓴다.
//!
//! claude 는 붙인 그림을 `type:"user"` 줄의 `message.content` 에 `{"type":"image","source":{"type":"base64",…}}` 로
//! 원본 그대로 남긴다 (긴 변 2000px 까지 줄인 판). 원본 파일(임시 폴더)은 곧 지워지므로 기록이 출처다.
//! 넣지 않는 것:
//! - 도구 결과 그림(Read 등): content 안 `tool_result` 조각 속에 들어 있다. 맨 위 조각만 보므로 저절로 빠진다
//! - `api-request-blob` 줄: API 로 보낸 요청 사본이라 같은 그림이 또 들어 있다
//! - `isSidechain`(서브에이전트), `isMeta`(동반 줄) 줄
//!
//! 기록은 뒤에 덧붙기만 하므로 세션마다 읽은 자리를 기억해 늘어난 부분만 읽는다. 경로가 바뀌거나(/clear) 파일이
//! 줄면 처음부터 다시 읽는다. 목록에는 줄 위치만 두고, 그림을 달라고 할 때 그 줄 하나만 다시 읽는다.
//!
//! 보내기 전 그림: 기록에는 보낸 뒤에야 남으므로, 앱이 붙여 넣은 그림 파일(`paste_dir`)과 claude 입력창의
//! `[Image #N]` 을 짝지어 따로 센다 ([`Drafts`]). 입력창에서 지우면 화면에서 사라지므로 빼고, 보내면 기록 쪽으로 넘어간다.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::Value;
use thuminal_protocol::{AgentImage, SessionId};

/// 썸네일 긴 변 (px)
pub const THUMB_SIZE: u32 = 256;
/// 썸네일 메모리 캐시 한도 (바이트)
const THUMB_CACHE_BYTES: usize = 32 * 1024 * 1024;
/// 한 줄이 이보다 길면 그림을 찾지 않고 건너뛴다 (줄 하나를 메모리에 올리므로)
const MAX_LINE: usize = 64 * 1024 * 1024;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// 붙여 넣은 파일이 이 안에 입력창의 `[Image #N]` 으로 나타나지 않으면 버린다 (claude 가 아니거나 글로 남았다)
const DRAFT_WAIT: Duration = Duration::from_secs(10);
/// 화면에서 이만큼 안 보인 보내기 전 그림은 잊는다. 권한 묻기 창 등이 입력창을 가렸다 돌아와도 남게 넉넉히 둔다
const DRAFT_FORGET: Duration = Duration::from_secs(30 * 60);

/// 기록 파일 하나를 읽은 상태
#[derive(Debug, Default)]
pub struct Scan {
    path: PathBuf,
    /// 여기까지 읽었다 (마지막으로 다 읽은 줄 끝 다음 바이트)
    offset: u64,
    images: Vec<Found>,
    /// 아직 끝나지 않은 백그라운드 작업 (번호 → 시작한 줄 위치, background.rs)
    pending: HashMap<String, u64>,
    /// 이 위치 앞에서 시작한 백그라운드 작업은 세지 않는다 (claude 가 다시 떠서 앞 프로세스의 작업은 이미 없다)
    background_from: u64,
}

#[derive(Debug, Clone)]
struct Found {
    /// 줄이 시작하는 바이트 위치
    line: u64,
    /// 줄 안 content 조각 차례 (그림만 센 것이 아니라 content 배열 차례)
    index: usize,
    info: AgentImage,
}

impl Scan {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), offset: 0, images: Vec::new(), pending: HashMap::new(), background_from: 0 }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn images(&self) -> Vec<AgentImage> {
        self.images.iter().map(|f| f.info.clone()).collect()
    }

    pub fn count(&self) -> usize {
        self.images.len()
    }

    /// 아직 끝나지 않은 백그라운드 작업 수
    pub fn background(&self) -> usize {
        self.pending.len()
    }

    /// 지금까지 쓰인 줄에서 시작한 백그라운드 작업을 잊는다 (claude 가 새로 떴다). 파일 크기만 본다
    pub fn forget_background(&mut self) {
        self.background_from = std::fs::metadata(&self.path).map_or(0, |m| m.len());
        self.pending.clear();
    }

    /// 파일에서 늘어난 부분을 읽는다. 파일이 줄었으면 처음부터 다시 읽는다. 없으면 빈 목록이 된다
    pub fn update(&mut self) -> std::io::Result<()> {
        let len = match std::fs::metadata(&self.path) {
            Ok(m) => m.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.offset = 0;
                self.images.clear();
                self.pending.clear();
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        if len < self.offset {
            self.offset = 0;
            self.images.clear();
            self.pending.clear();
            self.background_from = 0;
        }
        if len == self.offset {
            return Ok(());
        }
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut rd = BufReader::with_capacity(256 * 1024, file);
        let mut buf = Vec::new();
        let mut pos = self.offset;
        let mut next_n = self.images.last().map_or(1, |f| f.info.n + 1);
        loop {
            buf.clear();
            let n = rd.read_until(b'\n', &mut buf)?;
            // 끝까지 읽었거나 아직 다 쓰지 않은 줄: 다음에 다시 읽는다
            if n == 0 || buf.last() != Some(&b'\n') {
                break;
            }
            if buf.len() <= MAX_LINE {
                for (index, mut info) in images_in_line(&buf) {
                    if info.n == 0 {
                        info.n = next_n;
                    }
                    next_n = info.n + 1;
                    info.id = format!("{pos}:{index}");
                    self.images.push(Found { line: pos, index, info });
                }
                for t in crate::background::tasks_in_line(&buf) {
                    match t {
                        crate::background::Task::Start(id) if pos >= self.background_from => {
                            self.pending.insert(id, pos);
                        }
                        crate::background::Task::Start(_) => {}
                        crate::background::Task::End(id) => {
                            self.pending.remove(&id);
                        }
                    }
                }
            }
            pos += n as u64;
        }
        self.offset = pos;
        Ok(())
    }

    /// 그림 하나의 원본 바이트와 형식. 목록에 없는 id 면 None
    pub fn read(&self, id: &str) -> std::io::Result<Option<(String, Vec<u8>)>> {
        let Some(f) = self.images.iter().find(|f| f.info.id == id) else { return Ok(None) };
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(f.line))?;
        let mut buf = Vec::new();
        BufReader::new(file).read_until(b'\n', &mut buf)?;
        let v: Value = serde_json::from_slice(&buf).map_err(std::io::Error::other)?;
        let Some(part) = v.pointer("/message/content").and_then(Value::as_array).and_then(|c| c.get(f.index)) else { return Ok(None) };
        let Some(data) = part.pointer("/source/data").and_then(Value::as_str) else { return Ok(None) };
        let bytes = B64.decode(data.trim()).map_err(std::io::Error::other)?;
        Ok(Some((f.info.media_type.clone(), bytes)))
    }
}

/// 한 줄에서 사용자가 붙인 그림들 (content 차례, 정보). id 는 비워 두고, 번호를 모르면 n 은 0
fn images_in_line(line: &[u8]) -> Vec<(usize, AgentImage)> {
    // 대부분의 줄은 그림이 없다. 풀기 전에 바이트로 거른다 (claude 는 빈칸 없는 JSON 을 쓰지만 빈칸이 있어도 걸리게
    // `"image"` 만 찾는다. 요청 사본 줄은 크므로 앞머리로 먼저 뺀다. 종류는 푼 뒤에 다시 본다)
    if line.starts_with(br#"{"type":"api-request-blob""#) || memchr::memmem::find(line, br#""image""#).is_none() {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return Vec::new() };
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if v.get("type").and_then(Value::as_str) != Some("user") || flag("isSidechain") || flag("isMeta") {
        return Vec::new();
    }
    let Some(content) = v.pointer("/message/content").and_then(Value::as_array) else { return Vec::new() };
    let ids: Vec<u32> = v
        .get("imagePasteIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
        .unwrap_or_default();
    let at = v.get("timestamp").and_then(Value::as_str).and_then(parse_time_ms).unwrap_or(0);
    let mut out = Vec::new();
    for (index, part) in content.iter().enumerate() {
        if part.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let Some(src) = part.get("source") else { continue };
        if src.get("type").and_then(Value::as_str) != Some("base64") {
            continue;
        }
        let Some(data) = src.get("data").and_then(Value::as_str) else { continue };
        let data = data.trim();
        let media_type = src.get("media_type").and_then(Value::as_str).unwrap_or("image/png").to_string();
        let (width, height) = dimensions(data).unwrap_or((0, 0));
        let pad = data.bytes().rev().take_while(|&b| b == b'=').count();
        let bytes = (data.len() / 4 * 3).saturating_sub(pad) as u64;
        let n = ids.get(out.len()).copied().unwrap_or(0);
        out.push((index, AgentImage { id: String::new(), n, media_type, width, height, bytes, at, pending: false }));
    }
    out
}

/// base64 그림 머리에서 크기를 읽는다 (PNG IHDR, GIF, JPEG SOF). 그림을 풀지 않는다
fn dimensions(data: &str) -> Option<(u32, u32)> {
    // PNG·GIF 는 앞 32바이트면 된다. JPEG 은 SOF 앞에 EXIF 등이 올 수 있어 넉넉히 푼다
    let head_len = if data.starts_with("/9j/") { 256 * 1024 } else { 64 }.min(data.len());
    let head_len = head_len - head_len % 4;
    let head = B64.decode(&data[..head_len]).ok()?;
    if head.starts_with(b"\x89PNG\r\n\x1a\n") && head.len() >= 24 && &head[12..16] == b"IHDR" {
        let be = |i: usize| u32::from_be_bytes([head[i], head[i + 1], head[i + 2], head[i + 3]]);
        return Some((be(16), be(20)));
    }
    if head.starts_with(b"GIF8") && head.len() >= 10 {
        return Some((u16::from_le_bytes([head[6], head[7]]) as u32, u16::from_le_bytes([head[8], head[9]]) as u32));
    }
    if head.starts_with(&[0xff, 0xd8]) {
        return jpeg_size(&head);
    }
    None
}

/// JPEG 조각을 따라가며 SOF(0xC0~0xCF, 0xC4·0xC8·0xCC 빼고)의 높이·폭을 읽는다
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if marker == 0xd8 || (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            if i + 9 > b.len() {
                return None;
            }
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// `2026-10-26T05:58:44.486Z` 꼴 (UTC) 을 유닉스 시간 ms 로
pub(crate) fn parse_time_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = match s.get(19..20) {
        Some(".") => {
            let frac: String = s[20..].chars().take_while(char::is_ascii_digit).take(3).collect();
            format!("{frac:0<3}").parse::<i64>().ok()?
        }
        _ => 0,
    };
    // 그레고리력 날짜 → 1970-01-01 부터 날 수 (Howard Hinnant 의 days_from_civil)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let t = ((days * 24 + h) * 60 + mi) * 60 + sec;
    u64::try_from(t * 1000 + ms).ok()
}

/// 원본을 긴 변 [`THUMB_SIZE`] 로 줄인다. 투명이 있으면 PNG, 없으면 JPEG
pub fn thumbnail(bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("그림을 풀지 못했어요: {e}"))?;
    let small = if img.width() > THUMB_SIZE || img.height() > THUMB_SIZE { img.thumbnail(THUMB_SIZE, THUMB_SIZE) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    if small.color().has_alpha() {
        small.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(("image/png".into(), out.into_inner()))
    } else {
        let rgb = small.into_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&rgb).map_err(|e| e.to_string())?;
        Ok(("image/jpeg".into(), out.into_inner()))
    }
}

/// 앱이 붙여넣은 그림을 쓰는 폴더 (server `save_paste_image`)
pub fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("thuminal-paste")
}

/// 입력에 든 붙여넣은 그림 파일 경로들. 앱은 그림을 [`paste_dir`] 에 쓰고 그 경로를 붙여 넣는다
pub fn pasted_paths(input: &[u8]) -> Vec<PathBuf> {
    const DIR: &str = "thuminal-paste";
    let text = String::from_utf8_lossy(input);
    let dir = paste_dir();
    let mut out = Vec::new();
    for (i, _) in text.match_indices(DIR) {
        let Some(rest) = text[i + DIR.len()..].strip_prefix(['/', '\\']) else { continue };
        let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
        let path = dir.join(&name);
        if name.starts_with("paste-") && path.is_file() {
            out.push(path);
        }
    }
    out
}

/// 화면 글에 나온 `[Image #N]` 번호들
fn image_refs(screen: &str) -> BTreeSet<u32> {
    const HEAD: &str = "[Image #";
    let mut out = BTreeSet::new();
    for (i, _) in screen.match_indices(HEAD) {
        let rest = &screen[i + HEAD.len()..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest[digits..].starts_with(']') && let Ok(n) = rest[..digits].parse() {
            out.insert(n);
        }
    }
    out
}

/// 세션 하나의 보내기 전 그림. claude 는 붙인 그림에 세션 안에서 늘기만 하는 번호를 매기므로(지운 번호를 다시 쓰지 않는다),
/// 붙여 넣은 뒤 화면에 새로 나온 번호를 붙여 넣은 차례대로 파일과 짝짓는다
#[derive(Debug, Default)]
struct Drafts {
    /// 붙여 넣었지만 아직 번호를 모르는 파일 (붙인 때)
    waiting: VecDeque<(PathBuf, Instant)>,
    /// 번호를 안 파일
    known: BTreeMap<u32, Draft>,
    /// 지금까지 화면에서 본 가장 큰 번호. 이보다 큰 번호만 새로 붙인 그림이다
    seen_max: u32,
}

#[derive(Debug)]
struct Draft {
    path: PathBuf,
    /// 마지막으로 화면에서 본 때
    seen: Instant,
    /// 지금 화면(입력창)에 있다
    visible: bool,
}

impl Drafts {
    fn is_empty(&self) -> bool {
        self.waiting.is_empty() && self.known.is_empty()
    }

    /// 화면 글로 고친다. `sent_max` 이하 번호는 이미 보내 기록에 있는 그림이다
    fn update(&mut self, screen: &str, sent_max: u32, now: Instant) {
        let refs: BTreeSet<u32> = image_refs(screen).into_iter().filter(|&n| n > sent_max).collect();
        self.waiting.retain(|(_, at)| now.duration_since(*at) < DRAFT_WAIT);
        let fresh: Vec<u32> = refs.iter().copied().filter(|&n| n > self.seen_max && !self.known.contains_key(&n)).collect();
        for n in fresh {
            let Some((path, _)) = self.waiting.pop_front() else { break };
            self.known.insert(n, Draft { path, seen: now, visible: true });
        }
        self.seen_max = self.seen_max.max(refs.last().copied().unwrap_or(0));
        self.known.retain(|&n, d| {
            d.visible = refs.contains(&n);
            if d.visible {
                d.seen = now;
            }
            n > sent_max && now.duration_since(d.seen) < DRAFT_FORGET
        });
    }

    fn visible(&self) -> impl Iterator<Item = (u32, &Draft)> {
        self.known.iter().filter(|(_, d)| d.visible).map(|(&n, d)| (n, d))
    }
}

fn draft_id(n: u32, path: &Path) -> String {
    format!("draft:{n}:{}", path.file_name().map(|f| f.to_string_lossy()).unwrap_or_default())
}

fn media_type_of(path: &Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tiff") => "image/tiff",
        Some("heic") => "image/heic",
        _ => "image/png",
    }
}

fn draft_info(n: u32, d: &Draft) -> AgentImage {
    let meta = std::fs::metadata(&d.path).ok();
    let at = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |t| t.as_millis() as u64);
    let (width, height) = image::image_dimensions(&d.path).unwrap_or((0, 0));
    AgentImage {
        id: draft_id(n, &d.path),
        n,
        media_type: media_type_of(&d.path).into(),
        width,
        height,
        bytes: meta.map_or(0, |m| m.len()),
        at,
        pending: true,
    }
}

/// 세션마다 읽은 기록과 썸네일 캐시
#[derive(Default)]
pub struct Images {
    scans: Mutex<HashMap<SessionId, Scan>>,
    drafts: Mutex<HashMap<SessionId, Drafts>>,
    thumbs: Mutex<ThumbCache>,
}

impl Images {
    /// 세션 기록을 늘어난 만큼 읽고 (그림 수, 끝나지 않은 백그라운드 작업 수) 를 돌려준다. 경로가 바뀌었으면 처음부터 읽는다
    pub fn refresh(&self, session: SessionId, path: &str) -> (usize, usize) {
        let mut scans = self.scans.lock().unwrap();
        let scan = scans.entry(session).or_insert_with(|| Scan::new(path));
        if scan.path() != Path::new(path) {
            *scan = Scan::new(path);
        }
        if let Err(e) = scan.update() {
            tracing::warn!(event = "transcript_images_read_failed", session = session.0, error = %e);
        }
        (scan.count(), scan.background())
    }

    /// claude 가 새로 떴다: 기록에 지금까지 남은 백그라운드 작업은 앞 프로세스 것이라 잊는다
    pub fn forget_background(&self, session: SessionId, path: &str) {
        let mut scans = self.scans.lock().unwrap();
        let scan = scans.entry(session).or_insert_with(|| Scan::new(path));
        if scan.path() != Path::new(path) {
            *scan = Scan::new(path);
        }
        scan.forget_background();
    }

    pub fn list(&self, session: SessionId, path: &str) -> Vec<AgentImage> {
        self.refresh(session, path);
        let mut out = self.scans.lock().unwrap().get(&session).map(Scan::images).unwrap_or_default();
        if let Some(d) = self.drafts.lock().unwrap().get(&session) {
            out.extend(d.visible().map(|(n, d)| draft_info(n, d)));
        }
        out
    }

    /// 세션 입력에 붙여 넣은 그림 파일들을 적어 둔다. 입력창에 `[Image #N]` 으로 나타나면 보내기 전 그림이 된다
    pub fn note_paste(&self, session: SessionId, paths: Vec<PathBuf>) {
        let now = Instant::now();
        self.drafts.lock().unwrap().entry(session).or_default().waiting.extend(paths.into_iter().map(|p| (p, now)));
    }

    /// 보내기 전 그림을 지켜보는 중이다 (그럴 때만 화면을 읽는다)
    pub fn has_drafts(&self, session: SessionId) -> bool {
        self.drafts.lock().unwrap().get(&session).is_some_and(|d| !d.is_empty())
    }

    /// 화면 글로 보내기 전 그림을 고치고, 화면(입력창)에 있는 수를 돌려준다. 기록은 먼저 `refresh` 해 둔다
    pub fn update_drafts(&self, session: SessionId, screen: &str) -> usize {
        let sent_max = self.scans.lock().unwrap().get(&session).and_then(|s| s.images.last().map(|f| f.info.n)).unwrap_or(0);
        let mut drafts = self.drafts.lock().unwrap();
        let Some(d) = drafts.get_mut(&session) else { return 0 };
        d.update(screen, sent_max, Instant::now());
        let n = d.visible().count();
        if d.is_empty() {
            drafts.remove(&session);
        }
        n
    }

    /// 보내기 전 그림 하나 (형식, 바이트)
    fn draft_image(&self, session: SessionId, id: &str) -> Result<(String, Vec<u8>, PathBuf), String> {
        let path = {
            let drafts = self.drafts.lock().unwrap();
            let found = drafts.get(&session).and_then(|d| d.known.iter().find(|(n, d)| draft_id(**n, &d.path) == id));
            let Some((_, d)) = found else { return Err(format!("그림을 찾지 못했어요: {id}")) };
            d.path.clone()
        };
        let bytes = std::fs::read(&path).map_err(|e| format!("붙인 그림을 읽지 못했어요: {e}"))?;
        Ok((media_type_of(&path).into(), bytes, path))
    }

    /// 그림 하나 (형식, 바이트). 썸네일은 캐시에서 먼저 찾는다
    pub fn image(&self, session: SessionId, path: &str, id: &str, thumb: bool) -> Result<(String, Vec<u8>), String> {
        if id.starts_with("draft:") {
            let (media_type, bytes, file) = self.draft_image(session, id)?;
            if !thumb {
                return Ok((media_type, bytes));
            }
            let key = (file.to_string_lossy().into_owned(), id.to_string());
            if let Some(hit) = self.thumbs.lock().unwrap().get(&key) {
                return Ok(hit);
            }
            let small = thumbnail(&bytes)?;
            self.thumbs.lock().unwrap().put(key, small.clone());
            return Ok(small);
        }
        let key = (path.to_string(), id.to_string());
        if thumb && let Some(hit) = self.thumbs.lock().unwrap().get(&key) {
            return Ok(hit);
        }
        let found = {
            let mut scans = self.scans.lock().unwrap();
            let scan = scans.entry(session).or_insert_with(|| Scan::new(path));
            if scan.path() != Path::new(path) {
                *scan = Scan::new(path);
            }
            if scan.images.iter().all(|f| f.info.id != id) {
                let _ = scan.update();
            }
            scan.read(id).map_err(|e| format!("대화 기록을 읽지 못했어요: {e}"))?
        };
        let Some((media_type, bytes)) = found else { return Err(format!("그림을 찾지 못했어요: {id}")) };
        if !thumb {
            return Ok((media_type, bytes));
        }
        let small = thumbnail(&bytes)?;
        self.thumbs.lock().unwrap().put(key, small.clone());
        Ok(small)
    }

    /// 없어진 세션의 기록 상태를 지운다
    pub fn retain(&self, alive: impl Fn(SessionId) -> bool) {
        self.scans.lock().unwrap().retain(|&id, _| alive(id));
        self.drafts.lock().unwrap().retain(|&id, _| alive(id));
    }
}

/// 넣은 차례로 내보내는 썸네일 캐시 (바이트 한도)
#[derive(Default)]
struct ThumbCache {
    map: HashMap<(String, String), (String, Vec<u8>)>,
    order: VecDeque<(String, String)>,
    bytes: usize,
}

impl ThumbCache {
    fn get(&self, key: &(String, String)) -> Option<(String, Vec<u8>)> {
        self.map.get(key).cloned()
    }

    fn put(&mut self, key: (String, String), value: (String, Vec<u8>)) {
        if self.map.contains_key(&key) {
            return;
        }
        self.bytes += value.1.len();
        self.map.insert(key.clone(), value);
        self.order.push_back(key);
        while self.bytes > THUMB_CACHE_BYTES {
            let Some(old) = self.order.pop_front() else { break };
            if let Some((_, b)) = self.map.remove(&old) {
                self.bytes -= b.len();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 크기가 w×h 인 PNG (base64)
    fn png(w: u32, h: u32, alpha: bool) -> String {
        let mut out = std::io::Cursor::new(Vec::new());
        if alpha {
            image::DynamicImage::new_rgba8(w, h).write_to(&mut out, image::ImageFormat::Png).unwrap();
        } else {
            image::DynamicImage::new_rgb8(w, h).write_to(&mut out, image::ImageFormat::Png).unwrap();
        }
        B64.encode(out.into_inner())
    }

    fn jpeg(w: u32, h: u32) -> String {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(w, h).write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
        B64.encode(out.into_inner())
    }

    /// 사용자가 붙인 그림 줄 (claude 2.1.3xx 모양)
    fn pasted(ids: &[u32], images: &[(&str, &str)], ts: &str) -> String {
        let mut content = vec![serde_json::json!({"type":"text","text": ids.iter().map(|n| format!("[Image #{n}]")).collect::<Vec<_>>().join(" ") + "\n이것 봐"})];
        for (mt, data) in images {
            content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":mt,"data":data}}));
        }
        serde_json::json!({"parentUuid":"a","isSidechain":false,"promptId":"p","type":"user","message":{"role":"user","content":content},
            "uuid":"u","timestamp":ts,"imagePasteIds":ids,"origin":{"kind":"human"},"promptSource":"typed","sessionId":"s"})
        .to_string()
    }

    fn companion(path: &str) -> String {
        serde_json::json!({"type":"user","isMeta":true,"turnCompanion":true,"promptId":"p",
            "message":{"role":"user","content":[{"type":"text","text":format!("[Image: source: {path}]")}]}})
        .to_string()
    }

    fn read_result(data: &str) -> String {
        serde_json::json!({"parentUuid":"b","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result",
            "content":[{"type":"image","source":{"type":"base64","data":data,"media_type":"image/png"}}]}]},
            "toolUseResult":{"type":"image","file":{"base64":data,"type":"image/png"}},"timestamp":"2026-10-26T06:00:00.000Z"})
        .to_string()
    }

    fn blob(data: &str) -> String {
        format!(
            r#"{{"type":"api-request-blob","sessionId":"s","hash":"h","message":{{"role":"user","content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{data}"}}}}]}}}}"#
        )
    }

    fn sidechain(data: &str) -> String {
        serde_json::json!({"isSidechain":true,"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":data}}]}})
            .to_string()
    }

    fn write_lines(f: &mut File, lines: &[String]) {
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn finds_only_pasted_images_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut f = File::create(&path).unwrap();
        let (a, b, c) = (png(40, 30, false), png(8, 8, true), jpeg(64, 48));
        write_lines(
            &mut f,
            &[
                r#"{"type":"system","subtype":"init"}"#.into(),
                pasted(&[1], &[("image/png", &a)], "2026-10-26T05:58:44.486Z"),
                companion("/tmp/a.png"),
                read_result(&b),
                blob(&a),
                sidechain(&b),
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"\"type\":\"image\""}]}}"#.into(),
            ],
        );
        let mut scan = Scan::new(&path);
        scan.update().unwrap();
        let list = scan.images();
        assert_eq!(list.len(), 1, "Read 결과·blob·서브에이전트 그림은 빠진다: {list:?}");
        let first = &list[0];
        assert_eq!((first.n, first.width, first.height, first.media_type.as_str()), (1, 40, 30, "image/png"));
        assert_eq!(first.at, 1_792_994_324_486);
        let (mt, bytes) = scan.read(&first.id).unwrap().unwrap();
        assert_eq!((mt.as_str(), bytes.len() as u64), ("image/png", first.bytes));
        assert_eq!(B64.encode(&bytes), a);

        // 덧붙인 줄만 읽는다. 끝나지 않은 줄은 다음에 읽는다
        write_lines(&mut f, &[pasted(&[2, 3], &[("image/png", &b), ("image/jpeg", &c)], "2026-10-26T06:01:00Z")]);
        let tail = pasted(&[4], &[("image/png", &a)], "2026-10-26T06:02:00Z");
        write!(f, "{}", &tail[..tail.len() / 2]).unwrap();
        f.flush().unwrap();
        scan.update().unwrap();
        let list = scan.images();
        assert_eq!(list.iter().map(|i| (i.n, i.width, i.height)).collect::<Vec<_>>(), vec![(1, 40, 30), (2, 8, 8), (3, 64, 48)]);
        assert_ne!(list[1].id, list[2].id, "한 줄의 두 그림은 id 가 다르다");
        assert_eq!(scan.read(&list[2].id).unwrap().unwrap().0, "image/jpeg");
        writeln!(f, "{}", &tail[tail.len() / 2..]).unwrap();
        scan.update().unwrap();
        assert_eq!(scan.count(), 4);

        // 파일이 줄면(덮어쓰기) 처음부터
        drop(f);
        let mut f = File::create(&path).unwrap();
        write_lines(&mut f, &[pasted(&[1], &[("image/png", &b)], "2026-10-26T07:00:00Z")]);
        scan.update().unwrap();
        assert_eq!(scan.images().iter().map(|i| (i.n, i.width)).collect::<Vec<_>>(), vec![(1, 8)]);
        assert!(scan.read("0:9").unwrap().is_none());
    }

    #[test]
    fn images_follow_transcript_path_and_make_thumbnails() {
        let dir = tempfile::tempdir().unwrap();
        let (p1, p2) = (dir.path().join("1.jsonl"), dir.path().join("2.jsonl"));
        let big = png(1000, 500, false);
        // 빈칸이 든 JSON (`"type": "image"`) 도 읽는다
        std::fs::write(&p1, pasted(&[1], &[("image/png", &big)], "2026-10-26T05:00:00Z").replace("\":", "\": ") + "\n").unwrap();
        std::fs::write(&p2, "").unwrap();
        let images = Images::default();
        let s = SessionId(1);
        let (p1s, p2s) = (p1.to_str().unwrap(), p2.to_str().unwrap());
        assert_eq!(images.refresh(s, p1s).0, 1);
        let id = images.list(s, p1s)[0].id.clone();
        let (mt, thumb) = images.image(s, p1s, &id, true).unwrap();
        let t = image::load_from_memory(&thumb).unwrap();
        assert_eq!((mt.as_str(), t.width(), t.height()), ("image/jpeg", THUMB_SIZE, THUMB_SIZE / 2));
        let (_, full) = images.image(s, p1s, &id, false).unwrap();
        assert_eq!(B64.encode(full), big);
        // 투명이 있으면 PNG 로 줄인다
        assert_eq!(thumbnail(&B64.decode(png(300, 300, true)).unwrap()).unwrap().0, "image/png");
        // /clear: 새 기록으로 바뀌면 빈다
        assert_eq!(images.refresh(s, p2s).0, 0);
        assert!(images.image(s, p2s, &id, false).is_err());
        // 없는 파일은 빈 목록
        assert_eq!(images.refresh(s, "/nonexistent/t.jsonl").0, 0);
    }

    #[test]
    fn counts_background_tasks_until_notified() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let ps = p.to_str().unwrap();
        let start = |id: &str| format!(r#"{{"type":"user","message":{{"content":[]}},"toolUseResult":{{"backgroundTaskId":"{id}"}}}}"#);
        let end = |id: &str| format!(r#"{{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>{id}</task-id><status>completed</status></task-notification>"}}"#);
        let append = |line: String| writeln!(std::fs::OpenOptions::new().append(true).create(true).open(&p).unwrap(), "{line}").unwrap();
        let images = Images::default();
        let s = SessionId(1);
        append(start("b1"));
        append(start("b2"));
        append(end("b1"));
        assert_eq!(images.refresh(s, ps).1, 1);
        // claude 가 다시 떴다: 앞 프로세스의 작업은 잊고, 그 뒤에 시작한 것만 센다
        images.forget_background(s, ps);
        assert_eq!(images.refresh(s, ps).1, 0);
        append(start("b3"));
        assert_eq!(images.refresh(s, ps).1, 1);
        append(end("b3"));
        assert_eq!(images.refresh(s, ps).1, 0);
    }

    #[test]
    fn reads_sizes_and_times() {
        assert_eq!(dimensions(&png(3, 7, false)), Some((3, 7)));
        assert_eq!(dimensions(&jpeg(33, 21)), Some((33, 21)));
        assert_eq!(dimensions("AAAA"), None);
        assert_eq!(parse_time_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_time_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
        assert_eq!(parse_time_ms("nope"), None);
        let mut c = ThumbCache::default();
        for i in 0..5 {
            c.put((i.to_string(), String::new()), ("x".into(), vec![0; THUMB_CACHE_BYTES / 3]));
        }
        assert!(c.bytes <= THUMB_CACHE_BYTES && c.get(&("0".into(), String::new())).is_none() && c.get(&("4".into(), String::new())).is_some());
    }

    #[test]
    fn reads_image_refs_from_screen() {
        let refs = image_refs("❯ [Image #1] [Image #12]x [Image #] [Image #3 [Image #4]");
        assert_eq!(refs.into_iter().collect::<Vec<_>>(), vec![1, 4, 12]);
    }

    #[test]
    fn finds_pasted_paths_in_input() {
        let dir = paste_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join(format!("paste-test-{}-a.png", std::process::id()));
        std::fs::write(&a, b"x").unwrap();
        let input = format!("\x1b[200~{} {}\x1b[201~", a.display(), dir.join("paste-none.png").display());
        assert_eq!(pasted_paths(input.as_bytes()), vec![a.clone()]);
        assert!(pasted_paths(b"thuminal-paste/other.png").is_empty());
        std::fs::remove_file(a).unwrap();
    }

    #[test]
    fn drafts_follow_input_box() {
        let t0 = Instant::now();
        let mut d = Drafts::default();
        d.waiting.extend([(PathBuf::from("/a.png"), t0), (PathBuf::from("/b.png"), t0)]);
        // 붙여 넣은 두 파일이 차례대로 #1 · #2 가 된다
        d.update("❯ [Image #1] [Image #2] ", 0, t0);
        assert_eq!(d.visible().map(|(n, d)| (n, d.path.clone())).collect::<Vec<_>>(), vec![(1, "/a.png".into()), (2, "/b.png".into())]);
        // 입력창에서 지우면 빠진다
        d.update("❯ [Image #1] ", 0, t0);
        assert_eq!(d.visible().map(|(n, _)| n).collect::<Vec<_>>(), vec![1]);
        // 권한 창 등으로 잠깐 가려졌다 돌아오면 다시 보인다
        d.update("Do you want to proceed?", 0, t0);
        assert_eq!(d.visible().count(), 0);
        d.update("❯ [Image #1] ", 0, t0);
        assert_eq!(d.visible().count(), 1);
        // 보내면(기록에 #1 이 남으면) 화면에 남아 있어도 보내기 전 그림이 아니다
        d.update("❯ [Image #1] 이것 봐", 1, t0);
        assert_eq!(d.visible().count(), 0);
        // 지운 #2 는 한동안 남아 있다가 잊는다
        d.update("", 1, t0 + DRAFT_FORGET);
        assert!(d.is_empty());
    }

    #[test]
    fn drafts_ignore_old_numbers_and_stale_pastes() {
        let t0 = Instant::now();
        let mut d = Drafts::default();
        d.waiting.push_back((PathBuf::from("/a.png"), t0));
        d.update("❯ [Image #1] ", 0, t0);
        // ⌃V 로 붙인 #2 (파일 없음) 뒤에 붙여 넣은 파일은 그다음 새 번호 #3 과 짝짓는다
        d.update("❯ [Image #1] [Image #2] ", 0, t0);
        d.waiting.push_back((PathBuf::from("/c.png"), t0));
        d.update("❯ [Image #1] [Image #2] [Image #3] ", 0, t0);
        assert_eq!(d.visible().map(|(n, d)| (n, d.path.clone())).collect::<Vec<_>>(), vec![(1, "/a.png".into()), (3, "/c.png".into())]);
        // 번호로 나타나지 않은 파일(글로 남았다)은 시간이 지나면 버린다
        d.waiting.push_back((PathBuf::from("/d.png"), t0));
        d.update("❯ [Image #1] [Image #2] [Image #3] ", 0, t0 + DRAFT_WAIT);
        assert!(d.waiting.is_empty());
    }
}
