#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod config;
mod downloads;

use std::io::{Read, Seek};
use tauri::Manager;
use tauri::Runtime;

fn video_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
        Some(ext) => match ext.as_str() {
            "mp4" | "m4v" => "video/mp4",
            "mkv" => "video/x-matroska",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "avi" => "video/x-msvideo",
            "ts" | "m2ts" => "video/mp2t",
            "mp3" => "audio/mpeg",
            "aac" => "audio/aac",
            "flac" => "audio/flac",
            "ogg" | "opus" => "audio/ogg",
            "ass" | "ssa" | "srt" | "vtt" => "text/plain; charset=utf-8",
            _ => "application/octet-stream",
        },
        None => "application/octet-stream",
    }
}

/// Serves `hokago-file://<percent-encoded-absolute-path>` bytes (the webview's
/// offline player). Range support so <video> can seek into the file.
///
/// The URL is not a `file:` URL, and `Url::to_file_path()` refuses non-file
/// schemes, so the custom-scheme URL is first rewritten to `file://` (the
/// shim's `hokago-file://` + percent-encoded path parses cleanly as one) and
/// decoded by the URL parser — this is also what makes Windows drive letters
/// (`hokago-file://C:/...`) and spaces/non-ASCII characters work everywhere.
fn file_scheme_handler<R: Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // Proper percent-decoding + Windows drive-letter handling via Url.
    let path = tauri::Url::parse(&request.uri().to_string())
        .ok()
        .and_then(|u| {
            // file:// <-> to_file_path handles percent-decoding, Windows drive
            // letters, and backslash-on-windows; the shim percent-encodes
            // every segment, so the rewritten URL always parses.
            let rest = u.as_str().trim_start_matches("hokago-file://");
            tauri::Url::parse(&format!("file://{rest}"))
                .ok()
                .and_then(|f| f.to_file_path().ok())
        })
        .unwrap_or_default();

    let not_found = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(vec![])
            .unwrap()
    };

    if path.as_os_str().is_empty() {
        return not_found();
    }

    match std::fs::File::open(&path) {
        Ok(mut file) => {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let range = request.headers().get("range").and_then(|h| h.to_str().ok()).map(|s| s.to_string());

            // Parse "bytes=start-end" / "bytes=start-" / "bytes=-suffix".
            let (mut start, mut status, mut content_range) = (0u64, tauri::http::StatusCode::OK, None::<String>);
            if let (Some(range), true) = (&range, len > 0) {
                if let Some(rest) = range.strip_prefix("bytes=") {
                    let mut parts = rest.splitn(2, '-');
                    let first = parts.next().unwrap_or("");
                    let second = parts.next();
                    if first.is_empty() {
                        // suffix range: last N bytes
                        let suffix: u64 = second.and_then(|s| s.parse().ok()).unwrap_or(0).min(len);
                        start = len - suffix;
                    } else {
                        start = first.parse().unwrap_or(0).min(len.saturating_sub(1));
                        // An explicit end is advisory — responses are capped at
                        // MAX_CHUNK below and Content-Range reports actual bytes.
                    }
                    status = tauri::http::StatusCode::PARTIAL_CONTENT;
                }
            }

            let mut body = Vec::new();
            if len > 0 {
                if file.seek(std::io::SeekFrom::Start(start)).is_ok() {
                    // Cap single responses so a whole-file <video> request doesn't
                    // balloon memory; the player re-ranges for the next window.
                    const MAX_CHUNK: u64 = 64 * 1024 * 1024;
                    let count = (len - start).min(MAX_CHUNK);
                    let mut limited = (&mut file).take(count);
                    let _ = limited.read_to_end(&mut body);
                }
            }
            if status == tauri::http::StatusCode::PARTIAL_CONTENT {
                let end = start + body.len() as u64;
                content_range = Some(format!("bytes {}-{}/{}", start, end.saturating_sub(1), len));
            }

            let mut resp = tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", video_mime(&path))
                .header("Content-Length", body.len().to_string())
                .header("Accept-Ranges", "bytes")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .header("Cache-Control", "no-store");
            if let Some(cr) = content_range {
                resp = resp.header("Content-Range", cr);
            }
            resp.body(body).unwrap()
        }
        Err(_) => not_found(),
    }
}

/// Serves the bundled SPA (apps/web/dist) from `hokago-spa://` — the offline
/// fallback when the configured server is unreachable. Route fallback to
/// index.html so SPA deep links work.
fn spa_scheme_handler<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::path::{Component, PathBuf};
    let root = ctx.app_handle().path().resource_dir().unwrap_or_else(|_| PathBuf::from(".")).join("web-dist");
    let raw_path = request.uri().path().to_string();
    let rel = raw_path.trim_start_matches('/');
    // Reject anything that would escape web-dist (no `..` components).
    let mut file_path = root.clone();
    let mut traversal = false;
    for comp in std::path::Path::new(rel).components() {
        match comp {
            Component::Normal(part) => file_path.push(part),
            Component::RootDir | Component::CurDir => {}
            _ => {
                traversal = true;
                break;
            }
        }
    }
    if traversal || !file_path.is_file() {
        // SPA deep link (no physical file) → index.html
        file_path = root.join("index.html");
    }
    match std::fs::read(&file_path) {
        Ok(body) => {
            let mime = match file_path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html",
                Some("js") | Some("mjs") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                Some("avif") => "image/avif",
                Some("gif") => "image/gif",
                Some("wasm") => "application/wasm",
                Some("woff2") => "font/woff2",
                Some("woff") => "font/woff",
                Some("ttf") => "font/ttf",
                Some("otf") => "font/otf",
                Some("json") | Some("map") => "application/json",
                Some("webmanifest") => "application/manifest+json",
                Some("ico") => "image/x-icon",
                Some("txt") | Some("vtt") | Some("ass") | Some("srt") => "text/plain; charset=utf-8",
                _ => "application/octet-stream",
            };
            tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header("Content-Type", mime)
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .header("Cross-Origin-Opener-Policy", "same-origin")
                .header("Cross-Origin-Embedder-Policy", "require-corp")
                .body(body)
                .unwrap()
        }
        Err(_) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(vec![])
            .unwrap(),
    }
}

fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let build = option_env!("HOKAGO_BUILD").unwrap_or("dev");
    let script = bridge::injected_script(version, build);

    tauri::Builder::default()
        .register_uri_scheme_protocol("hokago-file", |ctx, request| file_scheme_handler(ctx, request))
        .register_uri_scheme_protocol("hokago-spa", |ctx, request| spa_scheme_handler(ctx, request))
        // Document-start injection on every page load (local setup page AND
        // the remote SPA, including reloads) — the bridge must exist before
        // the page's own scripts run. Appended to Tauri's own IPC init
        // script, which is injected at document start in every frame.
        .append_invoke_initialization_script(&script)
        .manage(downloads::DownloadManager::default())
        .invoke_handler(tauri::generate_handler![
            bridge::bridge_info,
            bridge::storage_get,
            bridge::storage_set,
            bridge::storage_delete,
            bridge::storage_hydrate,
            bridge::get_server_url,
            bridge::save_server_url,
            bridge::probe_server,
            bridge::open_path,
            bridge::show_setup,
            bridge::save_download,
            downloads::save_download_managed,
            downloads::cancel_download,
            bridge::downloads_list,
            bridge::downloads_local_url,
            bridge::downloads_read_text,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run hokago");
}
