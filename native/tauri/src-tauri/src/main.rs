#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod config;

use std::io::{Read, Seek};
use tauri::Manager;
use tauri::Runtime;

/// Serves `hokago-file://<absolute-path>` bytes (the webview's offline player).
/// Range support so <video> can seek into the file.
fn file_scheme_handler<R: Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let raw_path = request.uri().path().to_string();
    let path = raw_path.replace("%20", " ");

    match std::fs::File::open(&path) {
        Ok(mut file) => {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let range = request.headers().get("range").and_then(|h| h.to_str().ok()).map(|s| s.to_string());
            let (body, status, content_range) = if let Some(range) = range {
                // "bytes=start-end"
                if let Some(rest) = range.strip_prefix("bytes=") {
                    let mut parts = rest.split('-');
                    let start: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                    let end: u64 = parts
                        .next()
                        .and_then(|s| s.parse().ok())
                        .filter(|e| *e >= start)
                        .unwrap_or(len.saturating_sub(1));
                    let end = end.min(len.saturating_sub(1));
                    let count = end.saturating_sub(start).saturating_add(1);
                    let mut buf = vec![0u8; count as usize];
                    // seek to start, then read exactly `count` bytes
                    file.seek(std::io::SeekFrom::Start(start)).ok();
                    (&mut file).take(count).read_exact(&mut buf).ok();
                    (
                        buf,
                        tauri::http::StatusCode::PARTIAL_CONTENT,
                        Some(format!("bytes {start}-{end}/{len}")),
                    )
                } else {
                    let mut buf = Vec::new();
                    file.read_to_end(&mut buf).ok();
                    (buf, tauri::http::StatusCode::OK, None)
                }
            } else {
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).ok();
                (buf, tauri::http::StatusCode::OK, None)
            };

            let mut resp = tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", "video/mp4")
                .header("Accept-Ranges", "bytes")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .header("Cache-Control", "no-store");
            if let Some(cr) = content_range {
                resp = resp.header("Content-Range", cr);
            }
            resp.body(body).unwrap()
        }
        Err(_) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(vec![])
            .unwrap(),
    }
}

/// Serves the bundled SPA (apps/web/dist) from `hokago-spa://` — the offline
/// fallback when the configured server is unreachable. Route fallback to
/// index.html so SPA deep links work.
fn spa_scheme_handler<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::path::PathBuf;
    let root = ctx.app_handle().path().resource_dir().unwrap_or_else(|_| PathBuf::from(".")).join("web-dist");
    let raw_path = request.uri().path().to_string();
    let rel = raw_path.trim_start_matches('/');
    let mut file_path = root.join(rel);
    if !file_path.exists() || !file_path.is_file() {
        // SPA deep link (no physical file) → index.html
        file_path = root.join("index.html");
    }
    match std::fs::read(&file_path) {
        Ok(body) => {
            let mime = match file_path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("woff2") => "font/woff2",
                Some("woff") => "font/woff",
                Some("ttf") => "font/ttf",
                Some("json") => "application/json",
                Some("ico") => "image/x-icon",
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
        .on_page_load(move |webview, _payload| {
            // Re-inject the bridge on every page load (local setup page AND
            // remote SPA, including reloads) so a fresh context always gets it.
            let _ = webview.eval(&format!("if(window.hokagoNative===undefined){{{script}}}"));
        })
        .invoke_handler(tauri::generate_handler![
            bridge::bridge_info,
            bridge::storage_get,
            bridge::storage_set,
            bridge::storage_delete,
            bridge::get_server_url,
            bridge::save_server_url,
            bridge::open_path,
            bridge::show_setup,
            bridge::save_download,
            bridge::downloads_list,
            bridge::downloads_local_url,
            bridge::downloads_read_text,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run hokago");
}