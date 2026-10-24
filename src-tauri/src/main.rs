// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod commands;
mod hotkeys;
mod store;
mod updater;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

static LAST_MAXIMIZED: AtomicBool = AtomicBool::new(false);

fn main() {
    let app = tauri::Builder::default()
        // Must be first: a second launch focuses the existing window instead of
        // opening a duplicate (and fighting over global hotkeys).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            // The custom title bar swaps its maximize/restore icon on this event.
            if let WindowEvent::Resized(_) = event {
                let now = window.is_maximized().unwrap_or(false);
                if LAST_MAXIMIZED.swap(now, Ordering::SeqCst) != now {
                    let _ = window.app_handle().emit("window-state-changed", now);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Same folder Electron used (%APPDATA%\Soundboard, ~/Library/Application
            // Support/Soundboard, ~/.config/Soundboard), so an existing library,
            // settings, cached conversions and downloaded tools carry over.
            let data_dir = app.path().config_dir()?.join("Soundboard");
            std::fs::create_dir_all(&data_dir)?;
            app.manage(commands::DataDir(data_dir.clone()));
            app.manage(hotkeys::Hotkeys::default());
            app.manage(updater::UpdateState::default());

            let backend = Arc::new(backend::Backend::new());
            if let Err(e) = backend.start(&handle, &data_dir) {
                // The UI still loads; backend-powered features report an error.
                eprintln!("[backend] {e}");
            }
            app.manage(backend);

            #[cfg(target_os = "linux")]
            {
                // WebKitGTK blocks getUserMedia and gesture-less audio by default.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                        let view = webview.inner();
                        if let Some(settings) = WebViewExt::settings(&view) {
                            settings.set_enable_media_stream(true);
                            settings.set_media_playback_requires_user_gesture(false);
                        }
                        view.connect_permission_request(|_, request| {
                            request.allow();
                            true
                        });
                    });
                }
            }

            // The update check isn't urgent; let the window paint first.
            // (Skipped in dev builds, like electron-updater did when unpackaged.)
            if !cfg!(debug_assertions) {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    let _ = updater::run_check(&handle).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_call,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_close,
            commands::is_window_maximized,
            commands::get_app_version,
            commands::load_sounds,
            commands::save_sounds,
            commands::load_settings,
            commands::save_settings,
            commands::open_file_dialog,
            commands::import_rvc_voice_files,
            commands::youtube_cookies_import_file,
            commands::export_file,
            commands::show_in_folder,
            commands::open_external_link,
            commands::open_rvc_voices_folder,
            commands::get_diagnostics,
            hotkeys::register_hotkey,
            hotkeys::unregister_hotkey,
            updater::check_for_updates,
            updater::install_update_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Soundboard");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            // Only tear things down when the app is actually quitting.
            let _ = app_handle.global_shortcut().unregister_all();
            if let Some(backend) = app_handle.try_state::<Arc<backend::Backend>>() {
                backend.shutdown(); // stops python / demucs / live-voice server
            }
        }
    });
}
