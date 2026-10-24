//! sounds.json / settings.json persistence (atomic writes, rolling backup).
//! File names, formats and defaults are identical to the Electron version, so
//! an existing library is picked up as-is.

use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

use serde_json::{json, Map, Value};

fn parse_array(path: &Path) -> Option<Vec<Value>> {
    let raw = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&raw).ok()? {
        Value::Array(a) => Some(a),
        _ => None,
    }
}

pub fn read_sounds(dir: &Path) -> Vec<Value> {
    let path = dir.join("sounds.json");
    if !path.exists() {
        return vec![];
    }
    parse_array(&path).unwrap_or_else(|| {
        eprintln!("sounds.json is corrupt, attempting backup");
        parse_array(&dir.join("sounds.json.bak")).unwrap_or_default()
    })
}

pub fn write_sounds(dir: &Path, sounds: &[Value]) -> bool {
    let path = dir.join("sounds.json");
    let bak = dir.join("sounds.json.bak");
    let tmp = dir.join("sounds.json.tmp");

    if path.exists() {
        let stale = fs::metadata(&bak)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age > Duration::from_secs(60))
            .unwrap_or(true);
        // Only back up a file that still parses, so a bad write never overwrites a good .bak
        if stale && parse_array(&path).is_some() {
            let _ = fs::copy(&path, &bak);
        }
    }
    let result = serde_json::to_vec(sounds)
        .map_err(|e| e.to_string())
        .and_then(|bytes| fs::write(&tmp, bytes).map_err(|e| e.to_string()))
        .and_then(|_| fs::rename(&tmp, &path).map_err(|e| e.to_string()));
    match result {
        Ok(()) => true,
        Err(e) => {
            eprintln!("Failed to save sounds.json: {e}");
            let _ = fs::remove_file(&tmp);
            false
        }
    }
}

/// Keep in sync with SETTINGS_DEFAULTS in the original main.js. (The sidecar
/// only reads rvcPythonCommand / rvcCommandTemplate and carries its own copy.)
fn settings_defaults() -> Map<String, Value> {
    let v = json!({
        "theme": "violet",
        "outputDevice": "",
        "virtualMicDeviceId": "",
        "micInputDeviceId": "",
        "masterVolume": 80,
        "micVolume": 100,
        "noiseGateThreshold": 3,
        "localMonitorEnabled": false,
        "monitorMicFeedEnabled": false,
        "micFxEnabled": false,
        "echoCancellation": false,
        "duckEnabled": false,
        "noiseGateEnabled": false,
        "pushToTalkMode": false,
        "stopOnOverlap": false,
        "loopEnabled": false,
        "queueMode": false,
        "activeRvcVoice": null,
        "rvcQuality": "balanced",
        "uiStyle": "standard",
        "setupWizardDone": false,
        "rvcPythonCommand": if cfg!(windows) { "python" } else { "python3" },
        "rvcCommandTemplate": "{python} -m rvc_python cli -i {input} -o {output} -mp {model} -ip {index} -pi {pitch}",
    });
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub fn read_settings(dir: &Path) -> Value {
    let mut merged = settings_defaults();
    if let Some(Value::Object(saved)) = fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        merged.extend(saved);
    }
    Value::Object(merged)
}

pub fn write_settings(dir: &Path, settings: &Map<String, Value>) -> bool {
    let mut merged = settings_defaults();
    merged.extend(settings.clone());
    let path = dir.join("settings.json");
    let tmp = dir.join("settings.json.tmp");
    let result = serde_json::to_vec_pretty(&Value::Object(merged))
        .map_err(|e| e.to_string())
        .and_then(|bytes| fs::write(&tmp, bytes).map_err(|e| e.to_string()))
        .and_then(|_| fs::rename(&tmp, &path).map_err(|e| e.to_string()));
    match result {
        Ok(()) => true,
        Err(e) => {
            eprintln!("Failed to save settings.json: {e}");
            let _ = fs::remove_file(&tmp);
            false
        }
    }
}
