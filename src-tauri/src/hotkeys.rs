//! Global hotkeys. The UI records Electron-style accelerators ("Ctrl+Shift+1",
//! "Return", "num5", "Super+K"); `normalize` turns those into names the
//! global-hotkey crate parses.

use std::{collections::HashMap, str::FromStr, sync::Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct Hotkeys(Mutex<HashMap<String, Shortcut>>);

pub fn normalize(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| {
            let p = part.trim();
            let lower = p.to_ascii_lowercase();
            match lower.as_str() {
                "ctrl" | "control" => "Control".into(),
                "commandorcontrol" | "cmdorctrl" | "commandorctrl" | "cmdorcontrol" => "CommandOrControl".into(),
                "command" | "cmd" | "super" | "meta" | "win" | "windows" => "Super".into(),
                "alt" | "option" => "Alt".into(),
                "shift" => "Shift".into(),
                "return" | "enter" => "Enter".into(),
                "up" => "ArrowUp".into(),
                "down" => "ArrowDown".into(),
                "left" => "ArrowLeft".into(),
                "right" => "ArrowRight".into(),
                "esc" | "escape" => "Escape".into(),
                "space" => "Space".into(),
                "-" => "Minus".into(),
                "=" => "Equal".into(),
                "," => "Comma".into(),
                "." => "Period".into(),
                "/" => "Slash".into(),
                ";" => "Semicolon".into(),
                "'" => "Quote".into(),
                "[" => "BracketLeft".into(),
                "]" => "BracketRight".into(),
                "\\" => "Backslash".into(),
                "`" => "Backquote".into(),
                _ => {
                    let chars: Vec<char> = p.chars().collect();
                    if chars.len() == 1 && chars[0].is_ascii_alphabetic() {
                        format!("Key{}", chars[0].to_ascii_uppercase())
                    } else if chars.len() == 1 && chars[0].is_ascii_digit() {
                        format!("Digit{}", chars[0])
                    } else if lower.len() == 4 && lower.starts_with("num") && lower.as_bytes()[3].is_ascii_digit() {
                        format!("Numpad{}", &lower[3..])
                    } else {
                        p.to_string() // F1.., Tab, Backspace, Delete, Home, PageUp, ...
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn bind(app: &AppHandle, id: &str, shortcut: Shortcut) -> Result<(), String> {
    let id = id.to_string();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit("hotkey-triggered", id.clone());
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn register_hotkey(app: AppHandle, state: State<Hotkeys>, id: String, accelerator: Option<String>) -> Value {
    if id.is_empty() {
        return json!({ "success": false, "error": "Invalid hotkey id" });
    }
    let gs = app.global_shortcut();
    let mut map = state.0.lock().unwrap();

    let previous = map.remove(&id);
    if let Some(p) = previous.clone() {
        let _ = gs.unregister(p);
    }
    let accelerator = accelerator.unwrap_or_default();
    if accelerator.trim().is_empty() {
        return json!({ "success": true });
    }

    // Put the old hotkey back if the new one can't be registered, so a failed
    // edit (key already in use) doesn't silently remove a working shortcut.
    let restore = |map: &mut HashMap<String, Shortcut>| {
        if let Some(p) = previous.clone() {
            if bind(&app, &id, p.clone()).is_ok() {
                map.insert(id.clone(), p);
            }
        }
    };

    let shortcut = match Shortcut::from_str(&normalize(&accelerator)) {
        Ok(s) => s,
        Err(e) => {
            restore(&mut *map);
            return json!({ "success": false, "error": format!("Unsupported hotkey: {e}") });
        }
    };
    if gs.is_registered(shortcut.clone()) {
        restore(&mut *map);
        return json!({ "success": false, "error": "Hotkey already in use" });
    }
    match bind(&app, &id, shortcut.clone()) {
        Ok(()) => {
            map.insert(id, shortcut);
            json!({ "success": true })
        }
        Err(e) => {
            restore(&mut *map);
            json!({ "success": false, "error": e })
        }
    }
}

#[tauri::command]
pub fn unregister_hotkey(app: AppHandle, state: State<Hotkeys>, id: String) {
    if let Some(s) = state.0.lock().unwrap().remove(&id) {
        let _ = app.global_shortcut().unregister(s);
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;
    #[test]
    fn translates_electron_accelerators() {
        assert_eq!(normalize("Ctrl+Shift+1"), "Control+Shift+Digit1");
        assert_eq!(normalize("Alt+Return"), "Alt+Enter");
        assert_eq!(normalize("Super+K"), "Super+KeyK");
        assert_eq!(normalize("Command+Space"), "Super+Space");
        assert_eq!(normalize("Ctrl+num5"), "Control+Numpad5");
        assert_eq!(normalize("Ctrl+Up"), "Control+ArrowUp");
        assert_eq!(normalize("Ctrl+F12"), "Control+F12");
        assert_eq!(normalize("Ctrl+-"), "Control+Minus");
    }
}
