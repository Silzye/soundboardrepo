
/* =========================================================================
   Handlers that replace Electron dialog-based ones. Rust shows the dialog
   and hands the chosen path over.
   ========================================================================= */
ipcMain.handle("youtube-cookies-import-path", (_, filePath) => {
  try {
    if (typeof filePath !== "string" || !filePath) return { success: false, canceled: true };
    const raw = fs.readFileSync(filePath, "utf8");
    const kept = filterNetscapeCookies(raw);
    if (!kept.length) {
      return {
        success: false,
        error: "No YouTube/Google cookies found in that file. Export a Netscape-format cookies.txt while signed in to YouTube.",
      };
    }
    fs.writeFileSync(ytCookiesFilePath, "# Netscape HTTP Cookie File\n" + kept.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    writeYtCookieConfig({ mode: "file", browser: "" });
    return { success: true, status: getYtCookieStatus() };
  } catch (e) {
    console.error("youtube-cookies-import-path failed:", e);
    return { success: false, error: e?.message || "Couldn't import that cookies file" };
  }
});

/* =========================================================================
   Request loop + shutdown
   ========================================================================= */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Don't leave python / demucs / the live-voice server running after the app closes.
  try { stopLiveVoiceProcess(); } catch {}
  try { cancelActiveSetup(); } catch {}
  try { if (currentRvcJob) { currentRvcJob.cancelled = true; killProcessTree(currentRvcJob.proc); } } catch {}
}

async function handleMessage(msg) {
  const { id, channel, args } = msg;
  if (channel === "__shutdown") { shutdown(); setTimeout(() => process.exit(0), 150); return; }
  const handler = handlers.get(channel);
  if (!handler) { writeLine({ id, ok: false, error: `Unknown channel: ${channel}` }); return; }
  try {
    const result = await handler(null, args);
    writeLine({ id, ok: true, result: result === undefined ? null : result });
  } catch (e) {
    console.error(`[${channel}]`, e);
    writeLine({ id, ok: false, error: e?.message || String(e) });
  }
}

const rl = require("readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handleMessage(msg);
});
// Rust went away (or crashed): clean up and leave.
rl.on("close", () => { shutdown(); setTimeout(() => process.exit(0), 150); });
process.on("SIGTERM", () => { shutdown(); setTimeout(() => process.exit(0), 150); });
process.on("SIGINT", () => { shutdown(); setTimeout(() => process.exit(0), 150); });

writeLine({ event: "backend-ready", payload: null });
