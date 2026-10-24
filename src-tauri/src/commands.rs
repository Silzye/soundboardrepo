//! Tauri commands. Window / dialogs / files live here; anything needing
//! Python, yt-dlp, ffmpeg or the network is forwarded to the Node sidecar.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{backend::Backend, store};

pub struct DataDir(pub PathBuf);

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<DataDir>().0.clone()
}

fn backend(app: &AppHandle) -> Arc<Backend> {
    app.state::<Arc<Backend>>().inner().clone()
}

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "webm", "aiff", "aif", "wma"];

fn path_strings(files: Option<Vec<tauri_plugin_dialog::FilePath>>) -> Vec<String> {
    files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/* ----------------------------- backend bridge ---------------------------- */

#[tauri::command]
pub async fn backend_call(app: AppHandle, channel: String, args: Option<Value>) -> Result<Value, String> {
    if channel.starts_with("__") {
        return Err("Reserved channel".into());
    }
    backend(&app).call(&channel, args.unwrap_or(Value::Null)).await
}

/* ------------------------------ window controls --------------------------- */

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn is_window_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/* ------------------------- sounds / settings persistence ------------------- */

#[tauri::command]
pub async fn load_sounds(app: AppHandle) -> Value {
    Value::Array(store::read_sounds(&data_dir(&app)))
}

#[tauri::command]
pub async fn save_sounds(app: AppHandle, sounds: Value) -> Value {
    match sounds {
        Value::Array(list) => json!({ "success": store::write_sounds(&data_dir(&app), &list) }),
        _ => json!({ "success": false, "error": "Invalid data" }),
    }
}

#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Value {
    store::read_settings(&data_dir(&app))
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Value) -> Value {
    match settings {
        Value::Object(map) => json!({ "success": store::write_settings(&data_dir(&app), &map) }),
        _ => json!({ "success": false, "error": "Invalid data" }),
    }
}

/* --------------------------------- dialogs -------------------------------- */

#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Vec<String> {
    path_strings(app.dialog().file().add_filter("Audio Files", AUDIO_EXTENSIONS).blocking_pick_files())
}

#[tauri::command]
pub async fn import_rvc_voice_files(app: AppHandle) -> Result<Value, String> {
    let picked = path_strings(app.dialog().file().add_filter("RVC Model Files", &["pth", "index"]).blocking_pick_files());
    let b = backend(&app);
    if picked.is_empty() {
        let voices = b.call("list-rvc-voices", Value::Null).await?;
        return Ok(json!({ "success": true, "voices": voices }));
    }
    b.call("import-rvc-voice-file-paths", json!(picked)).await
}

#[tauri::command]
pub async fn youtube_cookies_import_file(app: AppHandle) -> Result<Value, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Select a Netscape-format cookies.txt")
        .add_filter("Cookies (cookies.txt)", &["txt"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok());
    match picked {
        None => Ok(json!({ "success": false, "canceled": true })),
        Some(p) => {
            backend(&app)
                .call("youtube-cookies-import-path", json!(p.to_string_lossy()))
                .await
        }
    }
}

#[tauri::command]
pub async fn export_file(app: AppHandle, file_path: String, suggested_name: Option<String>) -> Value {
    let src = Path::new(&file_path);
    if file_path.is_empty() || !src.is_file() {
        return json!({ "success": false, "error": "File not found" });
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav").to_string();
    let default_name = suggested_name
        .filter(|n| !n.is_empty())
        .or_else(|| src.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| format!("export.{ext}"));

    let dest = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("Audio", &[ext.as_str()])
        .blocking_save_file()
        .and_then(|f| f.into_path().ok());
    match dest {
        None => json!({ "success": false, "canceled": true }),
        Some(dest) => match fs::copy(src, &dest) {
            Ok(_) => json!({ "success": true, "savedTo": dest.to_string_lossy() }),
            Err(e) => json!({ "success": false, "error": e.to_string() }),
        },
    }
}

/* ------------------------------ shell / opener ----------------------------- */

#[tauri::command]
pub fn show_in_folder(path: String) {
    if !path.is_empty() {
        let _ = tauri_plugin_opener::reveal_item_in_dir(path);
    }
}

/// Opens a link in the real browser. Restricted to https:// so this can't be
/// used to open arbitrary local paths or other schemes.
#[tauri::command]
pub fn open_external_link(app: AppHandle, url: String) -> Value {
    if url.starts_with("https://") && app.opener().open_url(url, None::<&str>).is_ok() {
        json!({ "success": true })
    } else {
        json!({ "success": false })
    }
}

#[tauri::command]
pub fn open_rvc_voices_folder(app: AppHandle) {
    let dir = data_dir(&app).join("rvc_voices");
    let _ = fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

/* -------------------------------- diagnostics ------------------------------ */

#[tauri::command]
pub async fn get_diagnostics(app: AppHandle) -> Value {
    let mut report = match backend(&app).call("get-diagnostics", Value::Null).await {
        Ok(v) => v,
        // The report is most useful exactly when something is broken.
        Err(e) => json!({
            "app": { "version": app.package_info().version.to_string() },
            "backendError": e,
        }),
    };
    if let Some(obj) = report.as_object_mut() {
        let mut versions = obj
            .get("versions")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(Map::new);
        versions.insert("tauri".into(), json!(tauri::VERSION));
        versions.insert(
            "webview".into(),
            json!(tauri::webview_version().unwrap_or_else(|_| "unknown".into())),
        );
        obj.insert("versions".into(), Value::Object(versions));
    }
    report
}
