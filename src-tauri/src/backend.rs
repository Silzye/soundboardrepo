//! Manages the Node sidecar (everything that needs Python, yt-dlp, ffmpeg or
//! the network). Protocol: one JSON object per line over stdin/stdout.
//!
//!   -> {"id":1,"channel":"check-rvc-backend","args":null}
//!   <- {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"..."}
//!   <- {"event":"rvc-backend-log","payload":"..."}   (re-emitted to the UI)

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

pub struct Backend {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
}

impl Backend {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// `externalBin` binaries are installed next to the main executable (and
    /// copied next to it by `tauri dev`), without the target-triple suffix.
    fn node_path() -> PathBuf {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let p = dir.join(name);
                if p.exists() {
                    return p;
                }
            }
        }
        PathBuf::from(name) // dev fallback: node on PATH
    }

    fn script_path(app: &AppHandle) -> Option<PathBuf> {
        if let Ok(dir) = app.path().resource_dir() {
            let p = dir.join("sidecar-dist").join("server.js");
            if p.exists() {
                return Some(strip_unc(p));
            }
        }
        // `tauri dev` fallback
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar-dist").join("server.js");
        p.exists().then_some(p)
    }

    pub fn start(self: &Arc<Self>, app: &AppHandle, data_dir: &Path) -> Result<(), String> {
        let script = Self::script_path(app)
            .ok_or("sidecar-dist/server.js not found - run `npm run prepare:sidecar`")?;
        let node = Self::node_path();

        let mut cmd = Command::new(&node);
        cmd.arg(&script)
            .env("SOUNDBOARD_DATA_DIR", data_dir)
            .env("SOUNDBOARD_APP_VERSION", app.package_info().version.to_string())
            .env("SOUNDBOARD_PACKAGED", if cfg!(debug_assertions) { "0" } else { "1" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("couldn't start backend ({}): {e}", node.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        *self.stdin.lock().unwrap() = Some(stdin);
        *self.child.lock().unwrap() = Some(child);

        // stdout: responses + pushed events
        let this = Arc::clone(self);
        let app_handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(event) = msg.get("event").and_then(Value::as_str) {
                    let _ = app_handle.emit(event, msg.get("payload").cloned().unwrap_or(Value::Null));
                    continue;
                }
                let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                let reply: Reply = if msg.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(msg.get("error").and_then(Value::as_str).unwrap_or("Backend error").to_string())
                };
                if let Some(tx) = this.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(reply);
                }
            }
            // Sidecar exited: fail everything still waiting instead of hanging the UI.
            *this.stdin.lock().unwrap() = None;
            for (_, tx) in this.pending.lock().unwrap().drain() {
                let _ = tx.send(Err("The background service stopped unexpectedly".into()));
            }
        });

        // stderr: the sidecar's own log (it also writes soundboard.log)
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
            }
        });
        Ok(())
    }

    pub async fn call(&self, channel: &str, args: Value) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let line = json!({ "id": id, "channel": channel, "args": args }).to_string();
        let sent = {
            let mut guard = self.stdin.lock().unwrap();
            match guard.as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()).is_ok(),
                None => false,
            }
        };
        if !sent {
            self.pending.lock().unwrap().remove(&id);
            return Err("The background service isn't running".into());
        }
        rx.await.map_err(|_| "The background service stopped".to_string())?
    }

    /// Ask the sidecar to stop python/demucs/the live-voice server, then make
    /// sure it is gone. Called when the app exits.
    pub fn shutdown(&self) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{}", json!({ "channel": "__shutdown" }));
            let _ = stdin.flush();
        }
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
    }
}

/// Windows resource paths can come back as `\\?\C:\...`, which Node and some
/// child tools handle badly.
fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}
