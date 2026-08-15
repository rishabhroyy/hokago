//! The platform bridge: secure storage mirror (tokens stay in the OS keyring
//! so a webview data wipe never kills a session), native downloads, version
//! reporting, and the injected `window.hokagoNative` shim.

use keyring::Entry;
use serde_json::json;

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

const SERVICE: &str = "com.hokago.app";

/// Keyring-backed mirror. Falls back to a plain file when no keyring daemon
/// is available (e.g. headless Linux without gnome-keyring) so the app still
/// works — tokens land in the keyring wherever one exists.
fn get_secure(key: &str) -> Option<String> {
    if let Ok(entry) = Entry::new(SERVICE, key) {
        if let Ok(v) = entry.get_password() {
            return Some(v);
        }
    }
    fallback_file(key).ok().flatten()
}

fn set_secure(key: &str, value: &str) {
    if let Ok(entry) = Entry::new(SERVICE, key) {
        match entry.set_password(value) {
            Ok(()) => {
                let _ = std::fs::remove_file(fallback_path(key));
                return;
            }
            Err(_) => {}
        }
    }
    let _ = fallback_dir();
    let _ = std::fs::write(fallback_path(key), value);
}

fn delete_secure(key: &str) {
    if let Ok(entry) = Entry::new(SERVICE, key) {
        let _ = entry.delete_password();
    }
    let _ = std::fs::remove_file(fallback_path(key));
}

fn fallback_dir() -> std::io::Result<std::path::PathBuf> {
    let dir = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join("hokago").join("secure");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn fallback_path(key: &str) -> std::path::PathBuf {
    fallback_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join(format!("{}.txt", key.replace(['/', '\\'], "_")))
}

fn fallback_file(key: &str) -> std::io::Result<Option<String>> {
    let p = fallback_path(key);
    if !p.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(p)?))
}

/// The script injected into every page load (local setup page AND the remote
/// SPA) — declares `window.hokagoNative` backed by the Tauri IPC bridge.
/// Per-app versions are baked in so the web's MIN_NATIVE_VERSION gate works.
pub fn injected_script(app_version: &str, app_build: &str) -> String {
    format!(
        r#"(function(){{
  if (window.__hokagoBridge) return;
  window.__hokagoBridge = true;
  const inv = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ? window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__) : null;
  if (!inv) return;
  inv("bridge_info").then(function (info) {{
    window.hokagoNative = {{
      platform: info.platform,
      appVersion: "{app_version}",
      appBuild: "{app_build}",
      clientKey: info.clientKey,
      storage: {{
        get: function (k) {{ return inv("storage_get", {{ key: k }}); }},
        set: function (k, v) {{ try {{ inv("storage_set", {{ key: k, value: v }}); }} catch (e) {{}} }},
        delete: function (k) {{ try {{ inv("storage_delete", {{ key: k }}); }} catch (e) {{}} }}
      }},
      downloads: {{
        save: function (url, filename) {{
          return inv("save_download", {{ url: url, filename: filename }}).then(function (r) {{
            const out = JSON.parse(r);
            if (!out.ok) return Promise.reject(new Error(out.error || "download failed"));
            return {{ localPath: out.localPath, sizeBytes: out.sizeBytes }};
          }});
        }},
        open: function (localPath) {{ try {{ inv("open_path", {{ path: localPath }}); }} catch (e) {{}} }}
      }}
    }};
    document.dispatchEvent(new CustomEvent("hokago-bridge-ready"));
  }}).catch(function () {{}});
}})();"#,
        app_version = app_version,
        app_build = app_build
    )
}

#[tauri::command]
pub fn bridge_info(app: tauri::AppHandle) -> serde_json::Value {
    let _ = app;
    json!({ "platform": platform(), "clientKey": crate::config::client_key() })
}

/// Wraps a synchronous helper for the async IPC surface; serde_json::Value
/// carries null for a missing key.
#[tauri::command]
pub fn storage_get(key: String) -> serde_json::Value {
    match get_secure(&key) {
        Some(v) => json!(v),
        None => json!(null),
    }
}

#[tauri::command]
pub fn storage_set(key: String, value: String) {
    set_secure(&key, &value);
}

#[tauri::command]
pub fn storage_delete(key: String) {
    delete_secure(&key);
}

#[tauri::command]
pub fn get_server_url() -> Option<String> {
    crate::config::server_url()
}

#[tauri::command]
pub fn save_server_url(url: String) -> Result<(), String> {
    crate::config::save_server_url(&url)
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| e.to_string())
}

/// Navigate the window back to the local server-setup page.
#[tauri::command]
pub fn show_setup(window: tauri::WebviewWindow) -> Result<(), String> {
    let url: tauri::Url = "tauri://localhost/index.html".parse().map_err(|_| "invalid url")?;
    window.navigate(url).map_err(|e| e.to_string())
}

// ── Downloads ──────────────────────────────────────────────────────────────
// The web UI drives everything; this only moves bytes from the server's
// artifact URLs into platform downloads, authenticating with the access
// token mirrored into the keyring by storage_set.

#[tauri::command]
pub async fn save_download(url: String, filename: String) -> Result<String, String> {
    let token = get_secure("hokago_access_token").ok_or_else(|| "no session — sign in first".to_string())?;

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(json!({ "ok": false, "error": "session expired — reopen hokago to refresh" }).to_string());
    }
    if !resp.status().is_success() {
        return Ok(json!({ "ok": false, "error": format!("the server answered {}", resp.status()) }).to_string());
    }

    let dir = dirs::download_dir()
        .or_else(dirs::desktop_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("hokago");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create downloads dir: {e}"))?;
    let safe: String = filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    let path = dir.join(safe);

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("could not create file: {e}"))?;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&chunk).await.map_err(|e| format!("could not write file: {e}"))?;
    }

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(json!({ "ok": true, "localPath": path.display().to_string(), "sizeBytes": size }).to_string())
}