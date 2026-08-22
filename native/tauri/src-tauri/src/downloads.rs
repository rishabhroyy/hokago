use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::json;
use tauri::Emitter;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const MAX_CONCURRENT: usize = 2;

struct JobState {
    cancelled: bool,
}

type Registry = Arc<Mutex<HashMap<String, Arc<Mutex<JobState>>>>>;
type Semaphore = Arc<tokio::sync::Semaphore>;

pub struct DownloadManager {
    registry: Registry,
    sem: Semaphore,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self {
            registry: Arc::new(Mutex::new(HashMap::new())),
            sem: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

fn downloads_dir() -> std::path::PathBuf {
    dirs::download_dir()
        .or_else(dirs::desktop_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("hokago")
}

fn safe_name(filename: &str) -> String {
    filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect()
}

fn index_path() -> std::path::PathBuf {
    downloads_dir().join(".hokago-index.json")
}

fn index_download(path: &std::path::Path, size: u64) {
    let mut index: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(index_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    index.insert(
        path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
        json!({ "localPath": path.display().to_string(), "sizeBytes": size }),
    );
    let _ = std::fs::create_dir_all(downloads_dir());
    let _ = std::fs::write(index_path(), serde_json::to_vec(&index).unwrap_or_default());
}

fn get_token() -> Option<String> {
    if let Ok(entry) = keyring::Entry::new("com.hokago.app", "hokago_access_token") {
        if let Ok(v) = entry.get_password() {
            return Some(v);
        }
    }
    // fallback file
    let dir = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join("hokago").join("secure");
    let p = dir.join("hokago_access_token.txt");
    std::fs::read_to_string(p).ok()
}

#[tauri::command]
pub async fn save_download_managed(
    manager: tauri::State<'_, DownloadManager>,
    window: tauri::WebviewWindow,
    url: String,
    filename: String,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let job_state = Arc::new(Mutex::new(JobState { cancelled: false }));
    manager.registry.lock().unwrap().insert(id.clone(), job_state.clone());
    let sem = manager.sem.clone();
    let registry = manager.registry.clone();
    let id2 = id.clone();
    tokio::spawn(async move {
        let _permit = sem.acquire().await.unwrap();
        let result = do_download(&window, &id2, &url, &filename, job_state.clone()).await;
        registry.lock().unwrap().remove(&id2);
        let payload = match result {
            Ok((path, size)) => json!({ "type": "download-done", "id": id2, "ok": true, "localPath": path, "sizeBytes": size }),
            Err(e) if e == "cancelled" => json!({ "type": "download-done", "id": id2, "ok": false, "error": "cancelled", "cancelled": true }),
            Err(e) => json!({ "type": "download-done", "id": id2, "ok": false, "error": e }),
        };
        let _ = window.emit("hokago-native", payload);
    });
    // Return id immediately so web can correlate progress events
    Ok(json!({ "ok": true, "id": id }).to_string())
}

async fn do_download(
    window: &tauri::WebviewWindow,
    id: &str,
    url: &str,
    filename: &str,
    job_state: Arc<Mutex<JobState>>,
) -> Result<(String, u64), String> {
    let dir = downloads_dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("could not create downloads dir: {e}"))?;
    let safe = safe_name(filename);
    let dest = dir.join(&safe);
    let part = dir.join(format!("{}.part", safe));

    let existing = tokio::fs::metadata(&part).await.ok().map(|m| m.len()).unwrap_or(0);

    let token = get_token().ok_or_else(|| "no session — sign in first".to_string())?;

    let client = reqwest::Client::new();
    let mut req = client.get(url).header("Authorization", format!("Bearer {token}"));
    if existing > 0 {
        req = req.header("Range", format!("bytes={existing}-"));
    }
    let mut resp = req.send().await.map_err(|e| format!("network error: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        if let Some(t2) = get_token() {
            if t2 != token {
                let mut req2 = client.get(url).header("Authorization", format!("Bearer {t2}"));
                if existing > 0 { req2 = req2.header("Range", format!("bytes={existing}-")); }
                resp = req2.send().await.map_err(|e| format!("network error: {e}"))?;
            }
        }
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("session expired — reopen hokago to refresh".to_string());
        }
    }
    if !resp.status().is_success() && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("the server answered {}", resp.status()));
    }

    // If server ignored Range, restart from zero
    let resume_offset = if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT { existing } else {
        if existing > 0 { let _ = tokio::fs::remove_file(&part).await; }
        0
    };

    let total: Option<u64> = resp.headers().get(reqwest::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).map(|c: u64| c + resume_offset);
    // Also try Content-Range for total
    let total = total.or_else(|| {
        resp.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(|s| s.split('/').last()).and_then(|v| v.parse().ok())
    });

    let mut file = tokio::fs::OpenOptions::new().create(true).append(resume_offset > 0).write(true).truncate(resume_offset == 0).open(&part).await.map_err(|e| format!("could not create file: {e}"))?;
    if resume_offset > 0 {
        file.seek(std::io::SeekFrom::Start(resume_offset)).await.map_err(|e| e.to_string())?;
    }

    let mut received = resume_offset;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if job_state.lock().unwrap().cancelled {
            return Err("cancelled".to_string());
        }
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("could not write file: {e}"))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(150) {
            last_emit = Instant::now();
            let _ = window.emit("hokago-native", json!({ "type": "download-progress", "id": id, "receivedBytes": received, "totalBytes": total }));
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&part, &dest).await.map_err(|e| format!("could not finalize file: {e}"))?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(received);
    index_download(&dest, size);
    // final progress
    let _ = window.emit("hokago-native", json!({ "type": "download-progress", "id": id, "receivedBytes": size, "totalBytes": total.unwrap_or(size) }));
    Ok((dest.display().to_string(), size))
}

#[tauri::command]
pub fn cancel_download(manager: tauri::State<'_, DownloadManager>, id: String) -> Result<(), String> {
    if let Some(job) = manager.registry.lock().unwrap().get(&id) {
        job.lock().unwrap().cancelled = true;
    }
    Ok(())
}
