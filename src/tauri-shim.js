"use strict";

/*
 * Replaces preload.js. Recreates `window.electronAPI` on top of Tauri so
 * renderer.js keeps working with the same calls it always made.
 *
 *  - Window / dialogs / files / hotkeys / updater  -> Rust commands (src-tauri/src/commands.rs)
 *  - yt-dlp / ffmpeg / Python / RVC / TTS          -> Node sidecar, via the `backend_call` command
 *  - Events pushed from either side                -> Tauri events
 */
(function () {
  const tauri = window.__TAURI__;
  if (!tauri) {
    console.error("window.__TAURI__ is missing - is app.withGlobalTauri enabled in tauri.conf.json?");
    return;
  }
  const { invoke, convertFileSrc } = tauri.core;
  const { listen } = tauri.event;

  // ipcRenderer.invoke rejected with an Error; Tauri rejects with a bare string.
  const toError = (e) => (e instanceof Error ? e : new Error(String(e)));
  const rust = (command, args) => invoke(command, args).catch((e) => { throw toError(e); });
  const backend = (channel, args) =>
    invoke("backend_call", { channel, args: args === undefined ? null : args }).catch((e) => { throw toError(e); });
  const on = (event, callback) => { listen(event, (e) => callback(e.payload)); };

  window.electronAPI = {
    // Files / dialogs
    // Tauri hands us real paths for dropped files (see the drag-drop bridge below).
    getPathForFile: (file) => (file && file.__tauriPath) || "",
    // Asset-protocol URL for a local file (replaces file:// URLs).
    toFileUrl: (filePath) => convertFileSrc(filePath),
    openFileDialog: () => rust("open_file_dialog"),
    transcodeToWav: (filePath) => backend("transcode-to-wav", filePath),
    showInFolder: (filePath) => rust("show_in_folder", { path: filePath }),

    // Sounds / settings persistence
    loadSounds: () => rust("load_sounds"),
    saveSounds: (sounds) => rust("save_sounds", { sounds }),
    loadSettings: () => rust("load_settings"),
    saveSettings: (settings) => rust("save_settings", { settings }),

    // AI Voices (RVC)
    listRvcVoices: () => backend("list-rvc-voices"),
    importRvcVoiceFiles: () => rust("import_rvc_voice_files"),
    importRvcVoiceFilePaths: (filePaths) => backend("import-rvc-voice-file-paths", filePaths),
    deleteRvcVoice: (voiceId) => backend("delete-rvc-voice", voiceId),
    openRvcVoicesFolder: () => rust("open_rvc_voices_folder"),
    convertRvcFile: (inputPath, soundId, voiceId, pitch, separateVocals) =>
      backend("convert-rvc-file", { inputPath, soundId, voiceId, pitch, separateVocals }),
    cancelRvcConversion: (soundId) => backend("cancel-rvc-conversion", soundId),
    onRvcConversionProgress: (callback) => on("rvc-conversion-progress", callback),
    clearRvcConversion: (soundId, voiceId, pitch, separateVocals) =>
      backend("clear-rvc-conversion", { soundId, voiceId, pitch, separateVocals }),
    checkRvcBackend: () => backend("check-rvc-backend"),
    installRvcBackend: () => backend("install-rvc-backend"),
    installBundledPython: () => backend("install-bundled-python"),
    cancelRvcSetup: () => backend("cancel-rvc-setup"),
    checkRvcGpu: () => backend("check-rvc-gpu"),
    installRvcGpu: () => backend("install-rvc-gpu"),
    onRvcSetupProgress: (callback) => on("rvc-setup-progress", callback),
    onRvcBackendLog: (callback) => on("rvc-backend-log", callback),
    onRvcConversionLog: (callback) => on("rvc-conversion-log", callback),

    // YouTube import
    getYoutubeInfo: (url) => backend("youtube-get-info", url),
    importYoutubeClip: (payload) => backend("youtube-import", payload),
    getYoutubeCookieStatus: () => backend("youtube-cookies-status"),
    importYoutubeCookiesFile: () => rust("youtube_cookies_import_file"),
    useYoutubeCookiesFromBrowser: (browser) => backend("youtube-cookies-use-browser", browser),
    clearYoutubeCookies: () => backend("youtube-cookies-clear"),

    // Hotkeys
    registerHotkey: (data) => rust("register_hotkey", { id: data && data.id, accelerator: (data && data.accelerator) || null }),
    unregisterHotkey: (id) => rust("unregister_hotkey", { id }),
    onHotkeyTriggered: (callback) => on("hotkey-triggered", callback),

    // Window controls
    windowMinimize: () => { rust("window_minimize"); },
    windowMaximize: () => { rust("window_maximize"); },
    windowClose: () => { rust("window_close"); },
    isWindowMaximized: () => rust("is_window_maximized"),
    onWindowStateChanged: (callback) => on("window-state-changed", callback),

    // Misc
    getAppVersion: () => rust("get_app_version"),
    getDiagnostics: () => rust("get_diagnostics"),

    // Updates
    checkForUpdates: () => rust("check_for_updates"),
    installUpdateNow: () => { rust("install_update_now"); },
    onUpdateStatus: (callback) => on("update-status", callback),

    // Setup / requirements check
    checkYtDlpStatus: () => backend("check-ytdlp-status"),
    prepareYtDlp: () => backend("prepare-ytdlp"),
    openExternalLink: (url) => rust("open_external_link", { url }),

    // Text-to-Speech
    listTtsVoices: () => backend("tts-list-voices"),
    generateTts: (opts) => backend("tts-generate", opts),

    // Music Converter
    exportFile: (filePath, suggestedName) => rust("export_file", { filePath, suggestedName: suggestedName || null }),
    musicImportYoutube: (payload) => backend("music-import-youtube", payload),

    // Live Voice Changer
    startLiveVoice: (opts) => backend("live-voice-start", opts),
    stopLiveVoice: () => backend("live-voice-stop"),
    convertLiveVoiceChunk: (payload) => backend("live-voice-convert-chunk", payload),
  };

  /* -----------------------------------------------------------------------
     File drag-and-drop bridge.
     With dragDropEnabled (needed to get real file paths), the webview swallows
     OS file drags and the page never sees HTML5 `drop` events. Re-create them
     here at the element under the pointer, carrying paths, so the existing
     handlers in renderer.js (which read e.dataTransfer.files) work unchanged.
     ----------------------------------------------------------------------- */
  let lastTarget = null;

  function elementAt(position) {
    const r = window.devicePixelRatio || 1; // Tauri reports physical pixels
    return document.elementFromPoint(position.x / r, position.y / r);
  }

  function fire(type, el, paths) {
    if (!el) return;
    const ev = new Event(type, { bubbles: true, cancelable: true });
    ev.dataTransfer = {
      types: ["Files"],
      dropEffect: "copy",
      effectAllowed: "all",
      items: [],
      files: (paths || []).map((p) => ({ name: p.split(/[\\/]/).pop(), path: p, __tauriPath: p })),
    };
    el.dispatchEvent(ev);
  }

  const leave = (paths) => {
    if (lastTarget) fire("dragleave", lastTarget, paths);
    lastTarget = null;
  };

  listen("tauri://drag-over", (e) => {
    const el = elementAt(e.payload.position);
    if (el !== lastTarget) leave();
    lastTarget = el;
    fire("dragover", el);
  });
  listen("tauri://drag-leave", () => leave());
  listen("tauri://drag-drop", (e) => {
    const { paths, position } = e.payload;
    const el = elementAt(position);
    leave();
    fire("drop", el, paths);
  });
})();
