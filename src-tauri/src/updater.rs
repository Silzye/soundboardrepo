//! Auto-update via tauri-plugin-updater. Emits the same "update-status"
//! events the Settings > Updates tab already listens for:
//! checking | available | not-available | downloading | downloaded | error.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

struct Pending {
    update: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Pending>>,
    busy: AtomicBool,
}

fn emit_status(app: &AppHandle, status: &str, extra: Value) {
    let mut payload = json!({ "status": status });
    if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
        p.extend(e.clone());
    }
    let _ = app.emit("update-status", payload);
}

/// Checks for an update and, like electron-updater's autoDownload, downloads
/// it right away. Returns the available version, if any.
pub async fn run_check(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Ok(None); // a check/download is already running
    }
    let result = check_and_download(app, &state).await;
    state.busy.store(false, Ordering::SeqCst);
    result
}

async fn check_and_download(app: &AppHandle, state: &UpdateState) -> Result<Option<String>, String> {
    emit_status(app, "checking", json!({}));
    let fail = |e: String| {
        emit_status(app, "error", json!({ "error": e }));
        e
    };

    let updater = app.updater().map_err(|e| fail(e.to_string()))?;
    let update = match updater.check().await.map_err(|e| fail(e.to_string()))? {
        Some(u) => u,
        None => {
            emit_status(app, "not-available", json!({ "version": app.package_info().version.to_string() }));
            return Ok(None);
        }
    };

    let version = update.version.clone();
    emit_status(app, "available", json!({ "version": version }));

    let (mut downloaded, mut last_pct) = (0u64, -1i64);
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = (downloaded * 100 / total) as i64;
                    if pct != last_pct {
                        last_pct = pct;
                        emit_status(&progress_app, "downloading", json!({ "percent": pct }));
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| fail(e.to_string()))?;

    *state.pending.lock().unwrap() = Some(Pending { update, bytes: Some(bytes) });
    emit_status(app, "downloaded", json!({ "version": version }));
    Ok(Some(version))
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Value {
    match run_check(&app).await {
        Ok(Some(version)) => json!({ "success": true, "version": version }),
        Ok(None) => json!({ "success": true, "version": app.package_info().version.to_string() }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
pub fn install_update_now(app: AppHandle, state: State<UpdateState>) {
    let pending = state.pending.lock().unwrap().take();
    if let Some(Pending { update, bytes: Some(bytes) }) = pending {
        match update.install(bytes) {
            Ok(()) => app.restart(), // on Windows the installer ends the process itself
            Err(e) => emit_status(&app, "error", json!({ "error": e.to_string() })),
        }
    }
}
