//! `thuminal-file://` 주소: 화면의 `<img>` · `<video>` · `<audio>` 가 워크트리 파일을 주소로 받는다.
//!
//! 주소는 `thuminal-file://localhost/?worktree=<경로>&file=<경로>[&host=<원격 id>]` 다 (host 가 없으면 이 컴퓨터 데몬).
//! 데몬 요청 `read_file_bytes` 로 조각씩 읽어 영상 플레이어의 `Range` 요청에 206 으로 답하므로,
//! 큰 영상도 받으면서 재생하고 아무 곳으로나 건너뛴다. 원격 컴퓨터 파일은 그 데몬 연결로 받는다.
//! 경로 검사(워크트리 밖 거절)는 데몬이 한다.

use base64::Engine;
use tauri::http::{Request as HttpRequest, Response as HttpResponse, StatusCode, header};
use tauri::{AppHandle, Manager};
use thuminal_protocol::media::{content_type, parse_range};
use thuminal_protocol::{Request, Response};

use crate::AppState;

pub const SCHEME: &str = "thuminal-file";

/// 데몬이 한 번에 돌려주는 최대 크기 (`thuminal-workspace` 의 `MAX_READ_BYTES` 와 같다)
const CHUNK: u64 = 4 * 1024 * 1024;
/// Range 없이 받을 때 한 번에 내는 최대 크기 (그림). 영상 플레이어는 늘 Range 로 받는다
const WHOLE_FILE_MAX: u64 = 64 * 1024 * 1024;

fn plain(status: StatusCode, text: impl Into<String>) -> HttpResponse<Vec<u8>> {
    HttpResponse::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(text.into().into_bytes())
        .unwrap()
}

/// 한 조각. (바이트, 파일 전체 크기)
async fn read(app: &AppHandle, host: Option<&str>, worktree: &str, file: &str, offset: u64, len: u64) -> Result<(Vec<u8>, u64), String> {
    let state = app.state::<AppState>();
    let c = state.client(host).await?;
    let req = Request::ReadFileBytes { worktree: worktree.into(), file: file.into(), offset, len };
    match c.request(req).await.map_err(|e| e.to_string())? {
        Response::FileBytes { bytes } => {
            let data = base64::engine::general_purpose::STANDARD.decode(bytes.data).map_err(|e| e.to_string())?;
            Ok((data, bytes.size))
        }
        other => Err(format!("예상하지 못한 응답: {other:?}")),
    }
}

pub async fn serve(app: AppHandle, req: HttpRequest<Vec<u8>>) -> HttpResponse<Vec<u8>> {
    let Ok(url) = tauri::Url::parse(&req.uri().to_string()) else { return plain(StatusCode::BAD_REQUEST, "주소를 읽지 못했어요") };
    let q = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let (Some(worktree), Some(file)) = (q("worktree"), q("file")) else { return plain(StatusCode::BAD_REQUEST, "worktree, file 이 없어요") };
    let host = q("host").filter(|h| !h.is_empty());
    let host = host.as_deref();
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);

    // 크기부터 안다 (0 바이트 읽기)
    let (_, size) = match read(&app, host, &worktree, &file, 0, 0).await {
        Ok(v) => v,
        Err(e) => return plain(StatusCode::NOT_FOUND, e),
    };
    let (start, end, partial) = match range.as_deref() {
        Some(r) => match parse_range(r, size) {
            Some((a, b)) => (a, b.min(a + CHUNK - 1), true),
            None => {
                return HttpResponse::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                    .body(Vec::new())
                    .unwrap();
            }
        },
        None if size > WHOLE_FILE_MAX => return plain(StatusCode::PAYLOAD_TOO_LARGE, "파일이 커서 Range 로 나눠 받아야 해요"),
        None => (0, size.saturating_sub(1), false),
    };
    let want = if size == 0 { 0 } else { end + 1 - start };
    let mut body = Vec::with_capacity(want as usize);
    while (body.len() as u64) < want {
        let at = start + body.len() as u64;
        match read(&app, host, &worktree, &file, at, (want - body.len() as u64).min(CHUNK)).await {
            Ok((chunk, _)) if !chunk.is_empty() => body.extend_from_slice(&chunk),
            Ok(_) => break,
            Err(e) => return plain(StatusCode::NOT_FOUND, e),
        }
    }
    let last = start + (body.len() as u64).max(1) - 1;
    let mut res = HttpResponse::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, content_type(&file))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache");
    if partial {
        res = res.header(header::CONTENT_RANGE, format!("bytes {start}-{last}/{size}"));
    }
    res.body(body).unwrap()
}
