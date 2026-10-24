#!/usr/bin/env python3
"""One-off migration helper: derive sidecar/server.js from the original Electron
main.js.

Everything that touches Electron (windows, dialogs, hotkeys, updater, shell,
sounds/settings persistence) is removed -- Rust owns those now. Everything else
(yt-dlp, ffmpeg, Python/RVC/demucs, TTS, live voice) is kept verbatim.

usage: extract-sidecar.py <main.js> <out server.js> <header.js> <footer.js>
"""
import sys

src = open(sys.argv[1], encoding="utf-8").read().split("\n")
out_path = sys.argv[2]
drop = [False] * len(src)
repl = {}  # first line of a cut block -> replacement text


def idx(prefix, start=0):
    for i in range(start, len(src)):
        if src[i].startswith(prefix):
            return i
    raise SystemExit(f"marker not found: {prefix!r}")


def cut(a, b):  # inclusive, 0-based
    for i in range(a, b + 1):
        drop[i] = True


# 1. `const { app, BrowserWindow, ... } = require("electron");`
a = idx("const {")
b = idx('} = require("electron");')
cut(a, b)

# 2. ffmpeg path: there is no asar archive in the Tauri bundle
for i, l in enumerate(src):
    if "ffmpegLib.setFfmpegPath(ffmpegPath.replace" in l:
        src[i] = "    if (ffmpegPath) ffmpegLib.setFfmpegPath(ffmpegPath);"
        j = i - 1
        while src[j].strip().startswith("//"):
            drop[j] = True
            j -= 1

# 3. electron-updater lazy loader (Rust uses tauri-plugin-updater)
a = idx("let autoUpdaterInstance = null;")
f = idx("function getAutoUpdater")
b = next(i for i in range(f, len(src)) if src[i] == "}")
cut(a, b)

# 4. Auto-update block up to and including `const userDataPath = ...`
a = idx("   Auto-update") - 1
b = idx("const userDataPath = app.getPath")
cut(a, b)
repl[a] = (
    'const userDataPath = process.env.SOUNDBOARD_DATA_DIR;\n'
    'if (!userDataPath) { console.error("SOUNDBOARD_DATA_DIR is not set"); process.exit(1); }\n'
    'try { fs.mkdirSync(userDataPath, { recursive: true }); } catch {}'
)

# 5. single-instance lock + window-state persistence
a = idx("   Single instance lock") - 1
b = idx("   Atomic JSON writes") - 2
cut(a, b)

# 6. window creation + app lifecycle (keep the unhandledRejection handler)
a = idx("   Window creation") - 1
b = idx('process.on("unhandledRejection"') - 1
cut(a, b)

# 7. window controls .. get-app-version
a = idx("   Window controls") - 1
b = idx('ipcMain.handle("get-app-version"')
cut(a, b)

# 8. manual updater handlers
a = idx("   Manual update controls") - 1
e = idx('ipcMain.on("install-update-now"')
b = next(i for i in range(e, len(src)) if src[i] == "});")
cut(a, b)

# 9. sendToRenderer (re-defined in the header shim)
f = idx("function sendToRenderer")
b = next(i for i in range(f, len(src)) if src[i] == "}")
a = f
while src[a - 1].strip().startswith("//"):
    a -= 1
cut(a, b)

# 10. hotkey registry
i = idx("const registeredHotkeys")
cut(i, i)

# 11. handlers now implemented in Rust (dialogs, shell, hotkeys, files)
REMOVE = [
    "open-external-link", "open-file-dialog", "show-in-folder",
    "load-sounds", "save-sounds", "load-settings", "save-settings",
    "import-rvc-voice-files", "open-rvc-voices-folder",
    "youtube-cookies-import-file", "export-file",
    "register-hotkey", "unregister-hotkey",
]
for ch in REMOVE:
    s = idx(f'ipcMain.handle("{ch}"')
    single = src[s].rstrip().endswith(");") and src[s].count("(") == src[s].count(")")
    e = s if single else next(i for i in range(s, len(src)) if src[i] == "});")
    a = s
    while src[a - 1].strip().startswith("//"):
        a -= 1
    cut(a, e)

lines = []
for i, l in enumerate(src):
    if i in repl:
        lines.append(repl[i])
    elif not drop[i]:
        lines.append(l)
body = "\n".join(lines)

body = body.replace(
    "versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },",
    "versions: { node: process.versions.node },",
)

header = open(sys.argv[3], encoding="utf-8").read()
footer = open(sys.argv[4], encoding="utf-8").read()
open(out_path, "w", encoding="utf-8").write(header + "\n" + body + "\n" + footer)
print("wrote", out_path)
