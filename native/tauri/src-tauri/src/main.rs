#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod config;

fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let build = option_env!("HOKAGO_BUILD").unwrap_or("dev");
    let script = bridge::injected_script(version, build);

    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run hokago");
}