# Electron → Tauri 2 migration

## Architecture (hybrid)

```
┌─ webview (src/) ────────────────────────────────────────────────┐
│ index.html, style.css, renderer.js, pitch-shifter-worklet.js    │
│ tauri-shim.js  → recreates window.electronAPI (replaces preload)│
└───────────────┬───────────────────────────────┬─────────────────┘
        invoke  │ (Rust commands)               │ invoke("backend_call")
┌───────────────▼──────────────┐   JSON lines   ┌▼────────────────────────────┐
│ Rust (src-tauri/src)         │ ◄────────────► │ Node sidecar (sidecar/)     │
│ window, hotkeys, dialogs,    │  stdin/stdout  │ yt-dlp, ffmpeg, Python/RVC/ │
│ sounds/settings files,       │                │ demucs, TTS, live voice     │
│ updater, sidecar lifecycle   │                │ (= original main.js logic)  │
└──────────────────────────────┘                └─────────────────────────────┘
```

| Was (Electron) | Now |
|---|---|
| `BrowserWindow`, frameless, window controls | `tauri.conf.json` (`decorations: false`) + `window_*` commands, `data-tauri-drag-region` |
| window size/position persistence | `tauri-plugin-window-state` |
| `globalShortcut` | `tauri-plugin-global-shortcut` (`hotkeys.rs`, translates Electron-style accelerators) |
| `dialog`, `shell` | `tauri-plugin-dialog`, `tauri-plugin-opener` |
| `electron-updater` | `tauri-plugin-updater` (same `update-status` events) |
| single instance lock | `tauri-plugin-single-instance` |
| sounds.json / settings.json | `store.rs` (same files, formats, atomic write + `.bak`) |
| everything else in `main.js` | `sidecar/server.js`, generated from `main.js` by `scripts/migration/extract-sidecar.py` and otherwise unchanged |
| `preload.js` | `src/tauri-shim.js` |
| `file://` URLs | asset protocol (`convertFileSrc`) |
| HTML5 card drag-reorder | pointer-event reorder (Tauri's file-drop handler disables HTML5 DnD on Windows) |

`renderer.js` changed in exactly two places (`toFileUrl`, `makeCardDraggable`). `main.js`, `preload.js` and `package-lock.json` can be deleted from the repo; `sidecar/server.js` is now the source of truth.

The data folder is the same one Electron used, so existing libraries, settings, cached conversions and downloaded tools carry over.

## First-time setup

```
npm install
npx tauri icon assets/icon.png               # generates src-tauri/icons/*
npx tauri signer generate -w ~/.tauri/soundboard.key
#   → paste the public key into plugins.updater.pubkey in src-tauri/tauri.conf.json
#   → add the private key as the TAURI_SIGNING_PRIVATE_KEY secret in GitHub
npm start
```

Tag a release (`git tag v1.9.0 && git push --tags`) and `.github/workflows/release.yml` builds Windows, macOS (arm64 + x64) and Linux and uploads them with the `latest.json` the updater reads.

## What was and wasn't verified

**Verified here:** `sidecar/server.js` passes a syntax check and was exercised over the real stdin/stdout protocol (requests, error paths, out-of-order replies, path-traversal rejection, clean shutdown). All 47 original IPC channels are accounted for: 27 stay in the sidecar, 20 moved to Rust, plus 1 new sidecar channel (`youtube-cookies-import-path`). Every call in `tauri-shim.js` maps to a real handler. `renderer.js`, `tauri-shim.js` and the staging script pass syntax checks, and the staging script ran end to end with a stand-in `rustc`.

**Not verified: the Rust code has never been compiled.** There's no Rust toolchain in the environment I built this in. It's written against the Tauri 2 plugin APIs, but expect to fix a few compile errors on the first `cargo check`. Nothing has been run inside a real webview either.

## Test these first

1. Title bar: drag, minimize, maximize/restore icon, close, double-click to maximize.
2. Library loads, a sound plays through the right output device, waveforms render (asset protocol + `fetch`).
3. Virtual mic routing and mic input (`setSinkId`, `getUserMedia`).
4. Live Voice → Instant effects (AudioWorklet).
5. Global hotkeys, including the panic key, with the window minimized.
6. Drop audio files onto the grid; drop `.pth` files on the AI Voices tab; reorder cards.
7. YouTube import, then AI Voices backend install (long-running, streams logs).
8. Settings → Updates against a real signed release.

## Known differences and risks

* **macOS and Linux webviews are not Chromium.** The app leans on `setSinkId` (virtual mic and output device), `AudioWorklet` and gesture-less audio. WebView2 (Windows) supports all of it. WebKit's support for each needs checking on real machines; if `setSinkId` is missing, device routing has to move into Rust (e.g. `cpal`). Linux also needs the WebKitGTK permission block in `main.rs` to work for the mic.
* **Background throttling:** Electron's `backgroundThrottling: false` is reproduced on Windows through WebView2 flags in `tauri.conf.json`. macOS/Linux have no equivalent switch, so timers may slow while the window is minimized.
* **Existing users must reinstall once.** The Tauri installer is a different package from the Electron one, so `electron-updater` can't upgrade to it. Uninstall the old version, install the new one; data carries over.
* **Mic permission** is requested by the webview the first time (WebView2 and WebKit prompt differently from Electron's auto-grant).
* **macOS signing/notarization:** the bundled `node` and `ffmpeg` binaries must be signed too. Entitlements for the sidecar's JIT are in `Entitlements.plist`; the nested `ffmpeg` in `Resources/` may need an extra signing step.
* **Size:** the app bundles a Node runtime (~120 MB on disk, much less compressed). Moving more handlers from `sidecar/server.js` into Rust shrinks it; the YouTube/ffmpeg/Python ones are the heavy dependencies.
* **Asset protocol scope is `**`** (the webview can read any local file by path) because sounds are referenced from wherever the user imported them. Electron's `file://` had the same reach; the CSP still blocks remote content.
* **Settings defaults live in two places** (`store.rs` and `sidecar/server.js`); keep them in sync.
* **`localStorage`** (collapsed categories/theme groups) starts fresh because the webview origin changed.
* `sidecar/package-lock.json` doesn't exist yet; run `npm install` once in `sidecar/` and commit it so builds are reproducible.

## Publishing a release (GitHub Actions)

One-time setup:

1. `npx tauri signer generate -w ~/.tauri/soundboard.key`
2. Paste the **public** key into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. GitHub repo → Settings → Secrets and variables → Actions → add `TAURI_SIGNING_PRIVATE_KEY` (contents of the key file) and, if you set a password, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. GitHub repo → Settings → Actions → General → Workflow permissions → **Read and write**.
5. Commit `src-tauri/icons/` (already generated) and `assets/icon.png`.

Release: bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (keep them equal), then `git tag v1.9.0 && git push --tags`. The workflow only runs on tags starting with `v`. The release is published automatically (not a draft), because the updater reads `releases/latest/download/latest.json`, which doesn't exist for drafts.

## AI voice conversion quality

Conversion (sounds, TTS and the music converter all share it) now goes through `sidecar/rvc-audio.js`:

* **Quality presets** (Settings → AI Voices): Fast / Balanced / High set rvc-python's pitch tracker (`rmvpe`), index rate, consonant protection, volume-envelope mix and filter radius. The flags are read from `rvc_python cli --help`, so a build that lacks one is never handed an unknown argument, and flags you put in the command template take priority.
* **Input preparation** (every preset): mono 44.1 kHz WAV, rumble removed, very quiet clips lifted. This also stops mp3/m4a inputs from failing in the CLI.
* **Output polish** (Balanced/High): level-matched to the source (max ±12 dB), DC/rumble removed, peaks limited. The vocal-separation mix no longer drops 6 dB (`amix` was normalising).
* Results are cached **per preset**, so changing the setting re-converts. Files cached by older versions are simply not used.

`npm test` in `sidecar/` runs the audio tests against a real ffmpeg. The preset values are commonly used RVC settings, not something I could judge by ear here, so compare Fast/Balanced/High on a voice you know and adjust `QUALITY_PRESETS` in `rvc-audio.js` to taste.

## Building an installer locally

Prerequisites: Rust (rustup.rs), Node 22 from nodejs.org, and on Windows the "Desktop development with C++" workload from Visual Studio Build Tools (WebView2 is already on Windows 10/11).

* `npm run build:local` - installer for testing on your own machine. Skips the signed-update files, so no signing key is needed.
* `npm run build` - release build including the signed update files the in-app updater uses. Needs `TAURI_SIGNING_PRIVATE_KEY` set (see "Publishing a release").

Output is in `src-tauri/target/release/bundle/`:

| OS | Installer |
|---|---|
| Windows | `nsis/Soundboard_<version>_x64-setup.exe` |
| macOS | `dmg/Soundboard_<version>_<arch>.dmg` |
| Linux | `appimage/Soundboard_<version>_amd64.AppImage` |

A build only produces the installer for the OS it runs on. Use the GitHub Actions workflow to get all three. The first build compiles all the Rust dependencies and takes a while; later ones are much faster. Unsigned Windows installers show a SmartScreen warning ("More info" > "Run anyway") until you buy a code-signing certificate.
