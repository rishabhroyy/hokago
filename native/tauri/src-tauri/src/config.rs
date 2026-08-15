//! Per-install state: server URL + clientKey, persisted in the OS config dir.
//! Everything sensitive (tokens) goes through the keyring-backed storage
//! mirror instead — see bridge.rs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server_url: Option<String>,
    pub client_key: String,
}

fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("hokago")
}

fn config_path() -> PathBuf {
    config_dir().join("server.json")
}

pub fn load() -> AppConfig {
    let mut cfg = AppConfig {
        server_url: None,
        client_key: uuid::Uuid::new_v4().to_string(),
    };
    if let Ok(bytes) = std::fs::read(config_path()) {
        if let Ok(parsed) = serde_json::from_slice::<AppConfig>(&bytes) {
            cfg.server_url = parsed.server_url;
            if !parsed.client_key.is_empty() {
                cfg.client_key = parsed.client_key;
            }
        }
    }
    cfg
}

pub fn save_server_url(url: &str) -> Result<(), String> {
    let mut cfg = load();
    cfg.server_url = Some(url.trim_end_matches('/').to_string());
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), serde_json::to_vec(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn client_key() -> String {
    load().client_key
}

pub fn server_url() -> Option<String> {
    load().server_url
}