"use strict";

/* =========================================================================
   STATE
   ========================================================================= */
let sounds = [];
let playingNodes = {};
let bufferCache = new Map();
const BUFFER_CACHE_MAX = 80;
// Decoded audio is big (a 3-minute stereo song is ~60MB), so an entry-count
// cap alone lets a few long tracks eat gigabytes. Cap total decoded bytes too.
const BUFFER_CACHE_MAX_BYTES = 300 * 1024 * 1024;
function bufferByteSize(buf) { return buf.length * buf.numberOfChannels * 4; }
function cacheBufferGet(key) {
  if (!bufferCache.has(key)) return undefined;
  // Bump recency: delete + re-set moves this entry to the end of Map's
  // insertion order, which is what the eviction loop below reads from.
  const val = bufferCache.get(key);
  bufferCache.delete(key);
  bufferCache.set(key, val);
  return val;
}
function cacheBufferSet(key, val) {
  bufferCache.set(key, val);
  let total = 0;
  for (const b of bufferCache.values()) total += bufferByteSize(b);
  while (bufferCache.size > 1 && (bufferCache.size > BUFFER_CACHE_MAX || total > BUFFER_CACHE_MAX_BYTES)) {
    const oldestKey = bufferCache.keys().next().value;
    if (oldestKey === key) break; // never evict what was just added
    total -= bufferByteSize(bufferCache.get(oldestKey));
    bufferCache.delete(oldestKey);
  }
}
let audioCtx = null;

let monitorGain = null;
let titlebarAnalyser = null;
let titlebarVizRunning = false;
let micSendGain = null;
let micMakeupGain = null;
let micHighpass, micLowShelf, micMidPeak, micHighShelf, micCompressor;
let virtualMicDest = null;
let virtualMicStream = null;

let liveMicStream = null;
let liveMicSource = null;
let micGateGain = null;
let micMuteGain = null;
let liveVoiceActive = false;
// Live Voice > Instant effects (real-time, worklet-based; no Python involved)
let liveFxActive = false;
let liveFxWorkletReady = false;
let livePitchNode = null;
let liveFxChain = null;
let liveFxChainFade = null;
let liveFxMix = null;
let liveFxLevel = null;
let liveFxLimiter = null;
let liveFxInAnalyser = null;
let liveFxOutAnalyser = null;
let liveFxLevelTimer = null;
let liveFxLevelSmooth = 1;
let liveFxAutoLevel = true;
let liveFxOut = null;
let liveVoiceProcessor = null;
let liveVoiceSilentGain = null;
let liveVoiceDelayAvg = 0;
let liveVoiceOutGain = null;
let liveVoiceNextPlayTime = 0;
let liveVoiceChunkQueue = [];
let liveVoiceProcessing = false;
let micMeterAnalyser = null;
let micGateAnalyser = null;
let meterLoopStarted = false;

let outputDevice = "";
let virtualMicDeviceId = "";
let micInputDeviceId = "";
let localMonitorEnabled = false;
let monitorMicFeedEnabled = false;
let micFxEnabled = false;
let duckEnabled = false;
let duckAmount = 0.35;

let noiseGateEnabled = false;
let noiseGateThreshold = 0.03;
let micGateDelay = null;
let gateOpen = false;
let gateHoldUntil = 0;
let gateLookaheadOn = false;
const GATE_LOOKAHEAD_S = 0.03;
const GATE_HOLD_MS = 250;
const GATE_CLOSE_RATIO = 0.7;
let micMuted = false;
let pushToTalkMode = false;

// AI Voice (RVC) conversion is applied per sound clip (see Edit Sound
// modal), not to the live mic. editingRvcVoice tracks the in-progress
// selection while the Edit modal is open, saved to sound.rvcVoice on Save.
let editingRvcVoice = null;
let editingRvcPitch = 0;
let editingRvcSeparate = false;
let rvcPreviewAudio = null;

let stopOnOverlap = false;
let loopEnabled = false;
let queueMode = false;
let queue = [];
let queuePlaying = false;

let editingId = null;
let recordingHotkey = false;
let recordingHotkeyTarget = "edit-hotkey";
let currentCategory = "";
let trashBin = null;
let previewNode = null;
let previewToken = 0;
let saveTimer = null;
let recordingHotkeyPrev = "";
let noiseGateLoopStarted = false;

// Persisted app settings (device routing, mic mixer, playback prefs) —
// loaded once at boot, then kept in sync with the Settings modal.
let appSettings = {};
let settingsSaveTimer = null;

let collapsedCategories = new Set();
try {
  collapsedCategories = new Set(JSON.parse(localStorage.getItem("soundboard:collapsedCategories") || "[]"));
} catch {}

// Which theme-picker groups (dark/light) are collapsed in the Appearance
// tab. Both start expanded; collapsing one is remembered across launches
// the same way collapsed sound categories are.
let collapsedThemeGroups = new Set();
try {
  collapsedThemeGroups = new Set(JSON.parse(localStorage.getItem("soundboard:collapsedThemeGroups") || "[]"));
} catch {}

const COLORS = [
  "#a78bfa", "#60a5fa", "#34d399", "#fb923c", "#f472b6", "#facc15",
  "#f87171", "#38bdf8", "#a3e635", "#c084fc", "#fb7185", "#4ade80",
];

// Must match settings_defaults() in src-tauri/src/store.rs — used to
// pre-fill the Command Template field and for the Reset button.
const RVC_DEFAULT_COMMAND_TEMPLATE = "{python} -m rvc_python cli -i {input} -o {output} -mp {model} -ip {index} -pi {pitch}";

// Every theme defined in style.css, grouped by mode so the Appearance tab
// can render a "Dark themes" section and a "Light themes" section.
// swatch mirrors each theme's --gradient value from style.css.
const THEMES = [
  // --- Dark themes ---
  { id: "crimson",    name: "Crimson",    mode: "dark",  swatch: "linear-gradient(135deg, #ef4444, #b91c1c)" },
  { id: "violet",     name: "Violet",     mode: "dark",  swatch: "linear-gradient(135deg, #a78bfa, #7c3aed)" },
  { id: "ocean",      name: "Ocean",      mode: "dark",  swatch: "linear-gradient(135deg, #38bdf8, #0284c7)" },
  { id: "emerald",    name: "Emerald",    mode: "dark",  swatch: "linear-gradient(135deg, #34d399, #059669)" },
  { id: "sunset",     name: "Sunset",     mode: "dark",  swatch: "linear-gradient(135deg, #fb923c, #c2410c)" },
  { id: "rose",       name: "Rose",       mode: "dark",  swatch: "linear-gradient(135deg, #fb7185, #e11d48)" },
  { id: "indigo",     name: "Indigo",     mode: "dark",  swatch: "linear-gradient(135deg, #818cf8, #4f46e5)" },
  { id: "teal",       name: "Teal",       mode: "dark",  swatch: "linear-gradient(135deg, #2dd4bf, #0d9488)" },
  { id: "amber",      name: "Amber",      mode: "dark",  swatch: "linear-gradient(135deg, #fbbf24, #d97706)" },
  { id: "slate",      name: "Slate",      mode: "dark",  swatch: "linear-gradient(135deg, #94a3b8, #475569)" },
  { id: "magma",      name: "Magma",      mode: "dark",  swatch: "linear-gradient(135deg, #ff7849, #c2340a)" },
  { id: "cyberpunk",  name: "Cyberpunk",  mode: "dark",  swatch: "linear-gradient(135deg, #f472b6, #a21caf 55%, #0891b2)" },
  { id: "forest",     name: "Forest",     mode: "dark",  swatch: "linear-gradient(135deg, #84cc16, #3f6212)" },
  { id: "midnight",   name: "Midnight",   mode: "dark",  swatch: "linear-gradient(135deg, #60a5fa, #1d4ed8)" },
  { id: "plum",       name: "Plum",       mode: "dark",  swatch: "linear-gradient(135deg, #c084fc, #7e22ce)" },
  { id: "copper",     name: "Copper",     mode: "dark",  swatch: "linear-gradient(135deg, #d99a6c, #9a5228)" },
  { id: "aurora",     name: "Aurora",     mode: "dark",  swatch: "linear-gradient(135deg, #86efac, #22d3ee 45%, #a78bfa)" },
  { id: "bloodmoon",  name: "Bloodmoon",  mode: "dark",  swatch: "linear-gradient(135deg, #e85d04, #9d0208)" },
  { id: "neonlime",   name: "Neon Lime",  mode: "dark",  swatch: "linear-gradient(135deg, #d9f99d, #65a30d)" },
  { id: "graphite",   name: "Graphite",   mode: "dark",  swatch: "linear-gradient(135deg, #d1d5db, #6b7280)" },
  // --- Light themes (one paired to each dark theme above, so the two
  //     groups in the Appearance tab always show equal counts) ---
  { id: "daylight",    name: "Daylight",     mode: "light", swatch: "linear-gradient(135deg, #f4845f, #e4572e)" },
  { id: "lavender",    name: "Lavender",     mode: "light", swatch: "linear-gradient(135deg, #c4b5fd, #7c3aed)" },
  { id: "sky",         name: "Sky",          mode: "light", swatch: "linear-gradient(135deg, #48bff4, #0d9ddd)" },
  { id: "mint",        name: "Mint",         mode: "light", swatch: "linear-gradient(135deg, #4df0ba, #13d897)" },
  { id: "coral",       name: "Coral",        mode: "light", swatch: "linear-gradient(135deg, #e45858, #ca2121)" },
  { id: "blush",       name: "Blush",        mode: "light", swatch: "linear-gradient(135deg, #fd663f, #e83202)" },
  { id: "periwinkle",  name: "Periwinkle",   mode: "light", swatch: "linear-gradient(135deg, #4d51ef, #1317d7)" },
  { id: "seafoam",     name: "Seafoam",      mode: "light", swatch: "linear-gradient(135deg, #5eead4, #0f766e)" },
  { id: "sunbeam",     name: "Sunbeam",      mode: "light", swatch: "linear-gradient(135deg, #fcd34d, #d97706)" },
  { id: "cloud",       name: "Cloud",        mode: "light", swatch: "linear-gradient(135deg, #6e95cf, #356ab6)" },
  { id: "peach",       name: "Peach",        mode: "light", swatch: "linear-gradient(135deg, #ff673d, #eb3300)" },
  { id: "candy",       name: "Candy",        mode: "light", swatch: "linear-gradient(135deg, #ed4f9d, #d51674)" },
  { id: "sage",        name: "Sage",         mode: "light", swatch: "linear-gradient(135deg, #a9ea52, #82d119)" },
  { id: "powderblue",  name: "Powder Blue",  mode: "light", swatch: "linear-gradient(135deg, #4689f6, #0a5ce0)" },
  { id: "blossom",     name: "Blossom",      mode: "light", swatch: "linear-gradient(135deg, #f9a8d4, #be185d)" },
  { id: "orchid",      name: "Orchid",       mode: "light", swatch: "linear-gradient(135deg, #a046f6, #780be0)" },
  { id: "sand",        name: "Sand",         mode: "light", swatch: "linear-gradient(135deg, #d1926c, #b66635)" },
  { id: "aqua",        name: "Aqua",         mode: "light", swatch: "linear-gradient(135deg, #4bdbf1, #11bfda)" },
  { id: "citrus",      name: "Citrus",       mode: "light", swatch: "linear-gradient(135deg, #b0ea53, #8cd11a)" },
  { id: "linen",       name: "Linen",        mode: "light", swatch: "linear-gradient(135deg, #6e91cf, #3564b6)" },
];

/* =========================================================================
   VOICE FX PRESETS
   rate       — playback speed → pitch
   low/high   — shelf EQ gain (dB), gives the "character"
   ring       — ring-modulation (robot/demon buzz)
   bandpass   — { low, high } cutoffs, narrows the band (telephone/radio)
   lowpassFreq— single lowpass cutoff (muffled/underwater)
   distortion — waveshaper drive amount (grit/demon growl)
   delay      — { time, feedback, mix } echo effect (ghost/echo)
   volumeMult — extra gain multiplier baked into the preset (whisper is quieter)
   ========================================================================= */
const VOICE_PRESETS = {
  normal:     { rate: 1.00, low: 0,  high: 0,  ring: false },
  deep:       { rate: 0.75, low: 7,  high: -5, ring: false },
  male:       { rate: 0.88, low: 4,  high: -2, ring: false },
  female:     { rate: 1.22, low: -3, high: 4,  ring: false },
  chipmunk:   { rate: 1.65, low: -6, high: 7,  ring: false },
  helium:     { rate: 2.00, low: -8, high: 9,  ring: false },
  baby:       { rate: 1.80, low: -5, high: 6,  ring: false },
  giant:      { rate: 0.60, low: 9,  high: -7, ring: false },
  demon:      { rate: 0.65, low: 8,  high: -4, ring: true, ringFreq: 14, distortion: 18 },
  robot:      { rate: 1.00, low: 0,  high: 2,  ring: true, ringFreq: 32 },
  alien:      { rate: 1.15, low: -2, high: 3,  ring: true, ringFreq: 55, distortion: 6 },
  telephone:  { rate: 1.00, low: 0,  high: 0,  ring: false, bandpass: { low: 300, high: 3400 } },
  radio:      { rate: 1.00, low: 0,  high: 0,  ring: false, bandpass: { low: 500, high: 2600 }, distortion: 10 },
  underwater: { rate: 0.95, low: 3,  high: -6, ring: false, lowpassFreq: 800 },
  ghost:      { rate: 0.85, low: 2,  high: 1,  ring: false, delay: { time: 0.22, feedback: 0.35, mix: 0.4 } },
  echo:       { rate: 1.00, low: 0,  high: 0,  ring: false, delay: { time: 0.18, feedback: 0.3, mix: 0.35 } },
  whisper:    { rate: 1.05, low: -4, high: 5,  ring: false, volumeMult: 0.6 },

  // ---- Added in the expanded library -----------------------------------
  // New fields: peaks [{f,q,gain}] (formant-style colouring), highpassFreq,
  // crush (bit depth), tremolo {rate,depth}, chorus {rate,depth(ms),mix}
  // (mix 1 = pure vibrato), reverb {seconds,mix}.
  // Pitch & age
  child:      { rate: 1.42, low: -4, high: 5,  peaks: [{ f: 1800, q: 0.9, gain: 3 }] },
  oldman:     { rate: 0.84, low: 2,  high: -5, lowpassFreq: 4800, chorus: { rate: 5, depth: 0.45, mix: 1 } },
  ogre:       { rate: 0.66, low: 8,  high: -7, lowpassFreq: 3600, distortion: 6 },
  // Creatures & characters
  monster:    { rate: 0.55, low: 10, high: -6, lowpassFreq: 4200, distortion: 24, reverb: { seconds: 0.9, mix: 0.2 } },
  zombie:     { rate: 0.78, low: 3,  high: -6, lowpassFreq: 2800, distortion: 3, chorus: { rate: 0.6, depth: 5, mix: 1 } },
  darklord:   { rate: 0.70, low: 7,  high: -3, bandpass: { low: 120, high: 6000 }, distortion: 4, peaks: [{ f: 900, q: 1.2, gain: 4 }], reverb: { seconds: 0.5, mix: 0.18 } },
  fairy:      { rate: 1.50, low: -5, high: 8,  chorus: { rate: 1.1, depth: 2.5, mix: 0.5 }, reverb: { seconds: 1.2, mix: 0.25 } },
  cartoon:    { rate: 1.32, low: -3, high: 4,  peaks: [{ f: 1250, q: 1.4, gain: 8 }] },
  nasal:      { rate: 1.00, low: -5, high: 0,  peaks: [{ f: 1100, q: 1.3, gain: 9 }, { f: 300, q: 1, gain: -5 }] },
  announcer:  { rate: 0.86, low: 6,  high: 1,  peaks: [{ f: 3000, q: 0.9, gain: 3 }], reverb: { seconds: 0.35, mix: 0.12 } },
  // Robots & radio
  cyborg:     { rate: 0.92, low: 2,  high: 2,  ring: true, ringFreq: 70, bandpass: { low: 200, high: 4500 }, distortion: 8, reverb: { seconds: 0.25, mix: 0.15 } },
  megaphone:  { rate: 1.00, low: -4, high: 2,  bandpass: { low: 500, high: 4000 }, distortion: 14, peaks: [{ f: 1500, q: 1.2, gain: 6 }] },
  walkie:     { rate: 1.00, low: -4, high: 0,  bandpass: { low: 400, high: 3000 }, distortion: 12, crush: 6 },
  lofi:       { rate: 1.00, low: -3, high: -4, highpassFreq: 180, lowpassFreq: 3800, crush: 5 },
  // Spaces & atmosphere
  cave:       { rate: 0.97, low: 2,  high: -3, reverb: { seconds: 2.4, mix: 0.5 }, delay: { time: 0.28, feedback: 0.3, mix: 0.2 } },
  cathedral:  { rate: 1.00, low: 1,  high: -1, reverb: { seconds: 3.6, mix: 0.45 } },
  bathroom:   { rate: 1.00, low: -1, high: 2,  highpassFreq: 150, reverb: { seconds: 0.9, mix: 0.4 } },
  stadium:    { rate: 1.00, low: 0,  high: 0,  bandpass: { low: 300, high: 5500 }, distortion: 5, reverb: { seconds: 1.8, mix: 0.3 }, delay: { time: 0.32, feedback: 0.4, mix: 0.3 } },
  haunted:    { rate: 0.80, low: 2,  high: -2, lowpassFreq: 5000, chorus: { rate: 0.4, depth: 8, mix: 1 }, reverb: { seconds: 2.6, mix: 0.5 } },
  // Singing & mood
  choir:      { rate: 1.00, low: 1,  high: 0,  chorus: { rate: 0.8, depth: 4, mix: 0.55 }, reverb: { seconds: 1.6, mix: 0.35 } },
  opera:      { rate: 1.00, low: 2,  high: 1,  chorus: { rate: 5.5, depth: 0.55, mix: 1 }, reverb: { seconds: 1.4, mix: 0.25 } },
  drunk:      { rate: 0.92, low: 2,  high: -4, lowpassFreq: 4500, chorus: { rate: 0.7, depth: 6, mix: 1 } },
  scared:     { rate: 1.08, low: -2, high: 2,  tremolo: { rate: 11, depth: 0.4 } },
};

// Display names and picker groups for the library. Any preset not listed
// here still works: it gets a capitalised name and lands under "Other".
const VOICE_LABELS = {
  oldman: "Old Man", darklord: "Dark Lord", lofi: "Lo-Fi", walkie: "Walkie-Talkie",
};
const VOICE_GROUPS = [
  ["Pitch & age", ["normal", "deep", "male", "female", "child", "baby", "chipmunk", "helium", "oldman", "giant", "ogre"]],
  ["Creatures & characters", ["demon", "monster", "zombie", "darklord", "alien", "fairy", "cartoon", "nasal", "announcer"]],
  ["Robots & radio", ["robot", "cyborg", "telephone", "radio", "walkie", "megaphone", "lofi"]],
  ["Spaces & atmosphere", ["echo", "ghost", "haunted", "underwater", "cave", "cathedral", "bathroom", "stadium"]],
  ["Singing & mood", ["choir", "opera", "drunk", "scared", "whisper"]],
];
function voiceLabel(id) {
  if (id === "normal") return "Normal";
  return VOICE_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "webm", "aiff", "aif", "wma"];

/* =========================================================================
   BOOT
   ========================================================================= */
window.addEventListener("DOMContentLoaded", async () => {
  // Each step is isolated: if one throws (no audio device, IPC hiccup, a
  // missing element) the rest of the app still comes up instead of leaving
  // a half-bound UI where buttons silently do nothing.
  const step = async (label, fn) => {
    try { await fn(); } catch (e) { console.error(`[boot] ${label} failed:`, e); }
  };
  await step("settings", loadAppSettings);
  await step("theme", () => applyTheme(appSettings.theme));
  await step("ui style", () => applyUiStyle(appSettings.uiStyle));
  await step("performance mode", applyPerformanceMode);
  await step("audio engine", initAudio);
  // Device discovery (mic permission, enumeration) and loading the library
  // don't depend on each other, so the grid no longer waits on audio devices.
  await Promise.all([step("devices", loadDevices), step("sounds", loadSounds)]);
  await step("setup progress", initSetupProgress);
  await step("conversion progress", initConversionProgress);
  if (appSettings.panicHotkey) {
    await step("panic hotkey", () => window.electronAPI.registerHotkey({ id: "__panic__", accelerator: appSettings.panicHotkey }));
  }
  await step("UI", bindUI);
  await step("titlebar viz idle state", drawTitlebarIdleBars);
  await step("hotkey listener", bindHotkeyListener);
  await step("keyboard shortcuts", bindKeyboardShortcuts);
  await step("modal tabs", bindModalTabs);
  await step("voice presets", bindVoicePresets);
  await step("window state", bindWindowStateSync);
  await step("drag and drop", bindDragAndDrop);
  await step("settings modal", bindSettingsModal);
  await step("youtube modal", bindYoutubeImportModal);
  await step("app version", loadAppVersion);
  await step("device watcher", bindDeviceChangeWatcher);
  await step("setup guide", () => { bindSetupWizard(); maybeShowSetupWizard(); });
  await step("empty state", () => updateEmptyState());
});

/* =========================================================================
   APP SETTINGS
   Everything the person configures in the Settings modal — device
   selection, mic mixer toggles, and playback toggles — is persisted here
   so it stays exactly as they left it until they change it again.
   ========================================================================= */
async function loadAppSettings() {
  try {
    appSettings = (await window.electronAPI.loadSettings()) || {};
  } catch {
    appSettings = {};
  }
}
function saveAppSettingsDebounced() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    window.electronAPI.saveSettings(appSettings);
  }, 300);
}
// Writes anything still waiting on a debounce timer — called as the window
// closes/hides so a change made in the last fraction of a second isn't lost.
function flushPendingSaves() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { window.electronAPI.saveSounds(sounds); } catch {}
  }
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    try { window.electronAPI.saveSettings(appSettings); } catch {}
  }
}
window.addEventListener("beforeunload", flushPendingSaves);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSaves();
});
function updateSetting(key, value) {
  appSettings[key] = value;
  saveAppSettingsDebounced();
}
function detectLowEnd() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;
  let reduced = false;
  try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
  return cores <= 2 || mem <= 4 || reduced;
}
function applyPerformanceMode() {
  const low = typeof appSettings.lowPowerMode === "boolean" ? appSettings.lowPowerMode : detectLowEnd();
  document.documentElement.dataset.perf = low ? "low" : "full";
  return low;
}
const UI_STYLES = [
  {
    "id": "standard",
    "name": "Standard",
    "desc": "Smooth, rounded, glassy"
  },
  {
    "id": "gothic",
    "name": "Gothic",
    "desc": "Sharp, ornate, candlelit"
  },
  {
    "id": "brutalist",
    "name": "Brutalist",
    "desc": "Thick borders, hard shadows"
  },
  {
    "id": "terminal",
    "name": "Terminal",
    "desc": "Monospace, scanlines, phosphor glow"
  },
  {
    "id": "pixel",
    "name": "Pixel",
    "desc": "Chunky 8-bit blocks"
  },
  {
    "id": "neon",
    "name": "Neon",
    "desc": "Glowing edges on a dark grid"
  },
  {
    "id": "minimal",
    "name": "Minimal",
    "desc": "Flat, quiet, no decoration"
  },
  {
    "id": "frosted",
    "name": "Frosted",
    "desc": "Heavy glass over vivid color"
  },
  {
    "id": "neumorphic",
    "name": "Soft UI",
    "desc": "Pillowy extruded surfaces"
  },
  {
    "id": "steampunk",
    "name": "Steampunk",
    "desc": "Brass, rivets and warm iron"
  },
  {
    "id": "artdeco",
    "name": "Art Deco",
    "desc": "Gilded geometry, double frames"
  },
  {
    "id": "hud",
    "name": "Sci-Fi HUD",
    "desc": "Corner brackets and cut edges"
  },
  {
    "id": "paper",
    "name": "Paper",
    "desc": "Hand-drawn lines on notebook paper"
  },
  {
    "id": "vaporwave",
    "name": "Vaporwave",
    "desc": "Pink and cyan sunset (fixed palette)"
  },
  {
    "id": "soft",
    "name": "Soft",
    "desc": "Round, warm and friendly"
  },
  {
    "id": "blueprint",
    "name": "Blueprint",
    "desc": "Technical drawing on cyan-blue"
  },
  {
    "id": "comic",
    "name": "Comic",
    "desc": "Bold outlines and halftone dots"
  }
];
const FORCE_DARK_STYLES = new Set(["terminal", "neon", "hud", "steampunk", "blueprint", "vaporwave"]);
let themeMode = "dark";
function applyEffectiveMode() {
  const root = document.documentElement;
  root.dataset.mode = FORCE_DARK_STYLES.has(root.dataset.ui) ? "dark" : themeMode;
}
function applyUiStyle(style) {
  const valid = UI_STYLES.some((u) => u.id === style) ? style : "standard";
  const root = document.documentElement;
  root.dataset.ui = valid;
  applyEffectiveMode();
  if (valid === "standard" || valid === "gothic") delete root.dataset.uiGen;
  else root.dataset.uiGen = "1";
  document.querySelectorAll(".ui-style-card").forEach((c) => {
    c.classList.toggle("selected", c.dataset.uiStyle === valid);
  });
  try { redrawAllWaveforms(); } catch {}
  try { if (!titlebarVizRunning) drawTitlebarIdleBars(); } catch {}
  return valid;
}
function bindUiStyleCards() {
  const grid = document.getElementById("ui-style-grid");
  if (grid && !grid.children.length) {
    UI_STYLES.forEach((u) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "ui-style-card";
      card.dataset.uiStyle = u.id;
      const previewAttr = u.id === "standard" || u.id === "gothic" ? `class="ui-style-preview ui-style-preview-${u.id}"` : `class="ui-style-preview" data-ui-preview="${u.id}"`;
      card.innerHTML = `<span ${previewAttr}><i></i><i></i><i></i></span><span class="ui-style-name">${u.name}</span><span class="ui-style-desc">${u.desc}</span>`;
      card.addEventListener("click", () => {
        updateSetting("uiStyle", applyUiStyle(u.id));
      });
      grid.appendChild(card);
    });
  }
  applyUiStyle(appSettings.uiStyle);
}
function applyTheme(themeId) {
  const theme = THEMES.find((t) => t.id === themeId) || THEMES.find((t) => t.id === "violet");
  document.documentElement.dataset.theme = theme.id;
  themeMode = theme.mode;
  applyEffectiveMode();
  try { redrawAllWaveforms(); } catch {}
  try { if (!titlebarVizRunning) drawTitlebarIdleBars(); } catch {}
}

/* =========================================================================
   AUDIO ENGINE
   ========================================================================= */
async function initAudio() {
  audioCtx = new AudioContext({ latencyHint: "interactive" });

  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = 0.8;

  titlebarAnalyser = audioCtx.createAnalyser();
  titlebarAnalyser.fftSize = 64;
  titlebarAnalyser.smoothingTimeConstant = 0.75;
  monitorGain.connect(titlebarAnalyser); // parallel tap — doesn't affect existing routing/volume

  micSendGain = audioCtx.createGain();
  micSendGain.gain.value = 1;

  micMakeupGain = audioCtx.createGain();
  micMakeupGain.gain.value = 1.0;

  micHighpass = audioCtx.createBiquadFilter();
  micHighpass.type = "highpass";
  micHighpass.frequency.value = 40;

  micLowShelf = audioCtx.createBiquadFilter();
  micLowShelf.type = "lowshelf";
  micLowShelf.frequency.value = 200;
  micLowShelf.gain.value = 0;

  micMidPeak = audioCtx.createBiquadFilter();
  micMidPeak.type = "peaking";
  micMidPeak.frequency.value = 1500;
  micMidPeak.Q.value = 0.9;
  micMidPeak.gain.value = 0;

  micHighShelf = audioCtx.createBiquadFilter();
  micHighShelf.type = "highshelf";
  micHighShelf.frequency.value = 6000;
  micHighShelf.gain.value = 0;

  micCompressor = audioCtx.createDynamicsCompressor();
  micCompressor.threshold.value = -18;
  micCompressor.knee.value = 20;
  micCompressor.ratio.value = 4;
  micCompressor.attack.value = 0.003;
  micCompressor.release.value = 0.25;

  virtualMicDest = audioCtx.createMediaStreamDestination();
  rebuildMicChain();
}

function rebuildMicChain() {
  [micSendGain, micHighpass, micLowShelf, micMidPeak, micHighShelf, micCompressor, micMakeupGain].forEach((n) => {
    try { n.disconnect(); } catch {}
  });
  if (micFxEnabled) {
    micSendGain.connect(micHighpass).connect(micLowShelf).connect(micMidPeak)
      .connect(micHighShelf).connect(micCompressor).connect(micMakeupGain).connect(virtualMicDest);
    micMakeupGain.gain.value = 1.6;
  } else {
    micSendGain.connect(micMakeupGain).connect(virtualMicDest);
    micMakeupGain.gain.value = 1.0;
  }
  refreshMonitorRouting();
}

function setLocalMonitorEnabled(enabled) {
  localMonitorEnabled = enabled;
  refreshMonitorRouting();
  refreshLiveFxMonitor();
}
function setMonitorMicFeed(enabled) {
  monitorMicFeedEnabled = enabled;
  refreshMonitorRouting();
  refreshLiveFxMonitor();
}
// True when the post-FX mic bus is already being sent to the speakers, so
// live-voice outputs must not also be sent there (you'd hear a delayed copy).
function micFeedMonitorActive() {
  return localMonitorEnabled && monitorMicFeedEnabled;
}
function refreshMonitorRouting() {
  if (!audioCtx) return;
  try { monitorGain.disconnect(audioCtx.destination); } catch {}
  try { micMakeupGain.disconnect(audioCtx.destination); } catch {}
  if (!localMonitorEnabled) return;
  if (monitorMicFeedEnabled) micMakeupGain.connect(audioCtx.destination);
  else monitorGain.connect(audioCtx.destination);
}
function refreshLiveFxMonitor() {
  if (!liveFxOut) return;
  try { liveFxOut.disconnect(audioCtx.destination); } catch {}
  const on = document.getElementById("live-fx-monitor-toggle")?.classList.contains("active");
  if (on && !micFeedMonitorActive()) liveFxOut.connect(audioCtx.destination);
}

async function applyOutputSink() {
  if (typeof audioCtx.setSinkId === "function" && outputDevice) {
    try { await audioCtx.setSinkId(outputDevice); } catch (e) { console.warn("setSinkId (ctx) failed:", e); }
  }
}

async function connectVirtualMic() {
  if (!virtualMicDest) return;
  if (!virtualMicStream) {
    virtualMicStream = new Audio();
    virtualMicStream.srcObject = virtualMicDest.stream;
    virtualMicStream.volume = 1;
  }
  // Never let the mic bus play on the default speakers: it is your own voice,
  // so it would come straight back in through the mic as echo. Only play once a
  // virtual device is chosen, and never on the same device as the speakers.
  const usable = virtualMicDeviceId && virtualMicStream.setSinkId &&
    !(outputDevice && virtualMicDeviceId === outputDevice);
  if (!usable) {
    virtualMicStream.pause();
    return;
  }
  try {
    await virtualMicStream.setSinkId(virtualMicDeviceId);
    await virtualMicStream.play();
  } catch (e) {
    console.warn("setSinkId (mic) failed:", e);
    virtualMicStream.pause(); // a failed sink change falls back to the default speakers
  }
}

/* =========================================================================
   LIVE MICROPHONE
   ========================================================================= */
let micConnectSeq = 0;
let lastGoodMicDeviceId = "";

function isVirtualCableCapture(label) {
  const l = (label || "").toLowerCase();
  return l.includes("cable output") || l.includes("cable in 16ch") || l.includes("vb-audio") ||
    l.includes("voicemeeter") || l.includes("virtual cable");
}

function realMicInputs(devices) {
  return devices.filter((d) => d.kind === "audioinput" && !isVirtualCableCapture(d.label));
}

function pickDefaultRealMic(mics, savedId, savedLabel) {
  return mics.find((d) => d.deviceId === savedId) ||
    (savedLabel ? mics.find((d) => d.label === savedLabel) : null) ||
    mics.find((d) => d.deviceId === "default") ||
    mics.find((d) => d.deviceId !== "communications") ||
    mics[0];
}

function routeMicInput() {
  if (!micMuteGain) return;
  try { micMuteGain.disconnect(); } catch {}
  if (liveVoiceActive && liveVoiceProcessor) micMuteGain.connect(liveVoiceProcessor);
  else if (liveFxActive && livePitchNode) micMuteGain.connect(livePitchNode);
  else micMuteGain.connect(micSendGain);
  if (liveFxActive && liveFxInAnalyser) micMuteGain.connect(liveFxInAnalyser);
}

async function connectLiveMic(deviceId, isRevert = false) {
  const seq = ++micConnectSeq;
  try { liveMicStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { liveMicSource?.disconnect(); } catch {}
  liveMicSource = null;
  liveMicStream = null;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: !!appSettings.echoCancellation,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
  } catch (e) {
    console.warn("Could not open live mic:", e);
    if (seq === micConnectSeq) showToast("⚠️ Could not access microphone");
    return false;
  }

  if (seq !== micConnectSeq) {
    stream.getTracks().forEach((t) => t.stop());
    return false;
  }

  const trackLabel = stream.getAudioTracks()[0]?.label || "";
  if (!isRevert && isVirtualCableCapture(trackLabel)) {
    stream.getTracks().forEach((t) => t.stop());
    showToast("⚠️ That's the virtual cable's output — it carries what Discord hears. Pick your real microphone here, and set Discord's input to CABLE Output");
    const fallback = lastGoodMicDeviceId;
    micInputDeviceId = fallback;
    const sel = document.getElementById("mic-input-device");
    if (sel && fallback) sel.value = fallback;
    updateSetting("micInputDeviceId", fallback);
    if (fallback) return connectLiveMic(fallback, true);
    return false;
  }

  liveMicStream = stream;
  lastGoodMicDeviceId = deviceId || lastGoodMicDeviceId;
  if (trackLabel && appSettings.micInputLabel !== trackLabel) updateSetting("micInputLabel", trackLabel);
  liveMicSource = audioCtx.createMediaStreamSource(liveMicStream);

  micGateGain = micGateGain || audioCtx.createGain();
  micMuteGain = micMuteGain || audioCtx.createGain();
  micGateGain.gain.value = 1;
  gateLastTarget = null;
  micMuteGain.gain.value = micMuted ? 0 : 1;

  micGateDelay = micGateDelay || audioCtx.createDelay(0.1);
  micGateDelay.delayTime.value = noiseGateEnabled ? GATE_LOOKAHEAD_S : 0;
  try { micGateGain.disconnect(); } catch {}
  try { micGateDelay.disconnect(); } catch {}
  liveMicSource.connect(micGateDelay).connect(micGateGain).connect(micMuteGain);
  routeMicInput();

  setupMicMeter();
  setupNoiseGate();

  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  await connectVirtualMic();
  return true;
}

function setMicMuted(muted) {
  micMuted = muted;
  micMuteGain?.gain.setTargetAtTime(muted ? 0 : 1, audioCtx.currentTime, 0.01);
  document.getElementById("mic-mute-toggle")?.classList.toggle("active", muted);
}

function setupMicMeter() {
  if (!liveMicSource) return;
  micMeterAnalyser = audioCtx.createAnalyser();
  micMeterAnalyser.fftSize = 512;
  liveMicSource.connect(micMeterAnalyser);
  if (meterLoopStarted) return;
  meterLoopStarted = true;
  const data = new Uint8Array(micMeterAnalyser.frequencyBinCount);
  const settingsOverlay = document.getElementById("settings-modal-overlay");
  const fill = document.getElementById("mic-vu-fill");
  // The meter lives in Settings, so it only needs to run while Settings is
  // open. It used to read the analyser 60 times a second forever.
  setInterval(() => {
    if (!micMeterAnalyser || !fill || !settingsOverlay?.classList.contains("visible")) return;
    micMeterAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
    fill.style.width = Math.min(100, (peak / 128) * 100) + "%";
  }, 50);
}

let gateLastTarget = null; // last gain target the gate asked for (null = none yet)
function setupNoiseGate() {
  if (!liveMicSource) return;
  micGateAnalyser = audioCtx.createAnalyser();
  micGateAnalyser.fftSize = 1024;
  liveMicSource.connect(micGateAnalyser);
  // The poll loop reads the shared micGateAnalyser, so one loop is enough —
  // every mic change used to stack another one on top.
  if (noiseGateLoopStarted) return;
  noiseGateLoopStarted = true;
  const data = new Float32Array(micGateAnalyser.fftSize);
  // A timer rather than requestAnimationFrame: frames stop while the window
  // is minimized, which used to freeze the gate mid-game. It also only
  // schedules a gain change when the gate actually opens or closes.
  setInterval(() => {
    if (noiseGateEnabled && micGateGain && micGateAnalyser) {
      micGateAnalyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const nowMs = performance.now();
      if (!gateOpen && rms > noiseGateThreshold) gateOpen = true;
      if (gateOpen) {
        if (rms > noiseGateThreshold * GATE_CLOSE_RATIO) gateHoldUntil = nowMs + GATE_HOLD_MS;
        else if (nowMs > gateHoldUntil) gateOpen = false;
      }
      const target = gateOpen ? 1 : 0;
      if (!gateLookaheadOn && micGateDelay) {
        micGateDelay.delayTime.setTargetAtTime(GATE_LOOKAHEAD_S, audioCtx.currentTime, 0.02);
        gateLookaheadOn = true;
      }
      if (target !== gateLastTarget) {
        gateLastTarget = target;
        micGateGain.gain.setTargetAtTime(target, audioCtx.currentTime, target ? 0.006 : 0.06);
      }
    } else {
      gateLastTarget = null;
      gateOpen = false;
      if (gateLookaheadOn && micGateDelay) {
        micGateDelay.delayTime.setTargetAtTime(0, audioCtx.currentTime, 0.02);
        gateLookaheadOn = false;
      }
      if (micGateGain && Math.abs(micGateGain.gain.value - 1) > 0.001 && !noiseGateEnabled) {
        micGateGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.03);
      }
    }
  }, 25);
}

/* =========================================================================
   DEVICES
   ========================================================================= */
async function loadDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioOut = devices.filter((d) => d.kind === "audiooutput");
  const audioIn = realMicInputs(devices);

  const outSel = document.getElementById("output-device");
  const inSel = document.getElementById("virtual-mic-device");
  const micInSel = document.getElementById("mic-input-device");

  if (outSel) {
    outSel.innerHTML = audioOut
      .map((d) => `<option value="${escHtml(d.deviceId)}">${escHtml(d.label || "Speaker " + d.deviceId.slice(0, 6))}</option>`)
      .join("");
  }
  if (inSel) {
    inSel.innerHTML =
      `<option value="">-- Select CABLE Input --</option>` +
      audioOut
        .map((d) => `<option value="${escHtml(d.deviceId)}">${escHtml(d.label || "Output " + d.deviceId.slice(0, 6))}</option>`)
        .join("");
  }
  if (micInSel) {
    micInSel.innerHTML = audioIn
      .map((d) => `<option value="${escHtml(d.deviceId)}">${escHtml(d.label || "Mic " + d.deviceId.slice(0, 6))}</option>`)
      .join("");
  }

  // Prefer whatever the person picked last time (if that device still
  // exists on this machine); otherwise fall back to the original
  // auto-detection heuristics.
  const savedOut = audioOut.find((d) => d.deviceId === appSettings.outputDevice);
  const defaultOut = savedOut || audioOut.find((d) => d.deviceId === "default") || audioOut[0];
  if (defaultOut && outSel) outSel.value = defaultOut.deviceId;

  const cableInputGuess = audioOut.find((d) => {
    const lbl = d.label.toLowerCase();
    return lbl.includes("cable input") || (lbl.includes("cable") && !lbl.includes("output"));
  });
  const savedCableInput = audioOut.find((d) => d.deviceId === appSettings.virtualMicDeviceId);
  const cableInput = savedCableInput || cableInputGuess;
  if (cableInput && inSel) inSel.value = cableInput.deviceId;

  const defaultIn = pickDefaultRealMic(audioIn, appSettings.micInputDeviceId, appSettings.micInputLabel);
  if (defaultIn && micInSel) micInSel.value = defaultIn.deviceId;

  outSel?.addEventListener("change", async () => {
    outputDevice = outSel.value;
    updateSetting("outputDevice", outputDevice);
    await applyOutputSink();
    await connectVirtualMic();
  });
  inSel?.addEventListener("change", () => {
    virtualMicDeviceId = inSel.value;
    updateSetting("virtualMicDeviceId", virtualMicDeviceId);
    connectVirtualMic();
  });
  micInSel?.addEventListener("change", () => {
    micInputDeviceId = micInSel.value;
    updateSetting("micInputDeviceId", micInputDeviceId);
    connectLiveMic(micInputDeviceId).then((ok) => {
      if (ok && !virtualMicDeviceId) showToast("⚠️ Discord can't hear this yet — pick your CABLE Input under Virtual Mic Output and set Discord's input to CABLE Output");
    });
  });

  if (defaultOut) { outputDevice = defaultOut.deviceId; await applyOutputSink(); }
  if (cableInput) {
    virtualMicDeviceId = cableInput.deviceId;
    await connectVirtualMic();
  } else {
    showToast("⚠️ No VB-Cable-style device found — virtual mic routing is off until you pick one");
    await connectVirtualMic();
  }

  if (defaultIn) {
    micInputDeviceId = defaultIn.deviceId;
    await connectLiveMic(micInputDeviceId);
  } else {
    showToast("⚠️ No real microphone found — plug one in, then pick it under Live Microphone");
  }
}

/* =========================================================================
   VOICE FX ENGINE
   ========================================================================= */
function semitoneRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

function computeVoiceParams(sound) {
  const preset = VOICE_PRESETS[sound.voicePreset || "normal"] || VOICE_PRESETS.normal;
  const manualPitch = sound.pitchOffset || 0;
  const tilt = sound.formantTilt || 0;
  return {
    rate: preset.rate * semitoneRatio(manualPitch),
    lowGain: preset.low + tilt * 6,
    highGain: preset.high - tilt * 6,
    ring: !!preset.ring,
    ringFreq: preset.ringFreq || 30,
    bandpass: preset.bandpass || null,
    lowpassFreq: preset.lowpassFreq || null,
    distortion: preset.distortion || 0,
    delay: preset.delay || null,
    volumeMult: preset.volumeMult ?? 1,
    peaks: preset.peaks || null,
    highpassFreq: preset.highpassFreq || 0,
    crush: preset.crush || 0,
    tremolo: preset.tremolo || null,
    chorus: preset.chorus || null,
    reverb: preset.reverb || null,
  };
}

// Standard soft-clip waveshaper curve for the distortion/grit effect.
function makeDistortionCurve(amount) {
  const k = amount;
  const n = 44100;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// Bit-crusher: snaps the waveform to 2^bits amplitude levels.
function makeCrushCurve(bits) {
  const n = 8192, half = Math.pow(2, bits) / 2;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.max(-1, Math.min(1, Math.round(x * half) / half));
  }
  return curve;
}

// Synthetic room: stereo noise that fades out, with the highs dying faster
// than the lows the way a real space does. Built once per length and shared.
const reverbImpulseCache = new Map();
function getReverbImpulse(seconds) {
  const key = seconds.toFixed(2);
  if (reverbImpulseCache.has(key)) return reverbImpulseCache.get(key);
  const len = Math.max(1, Math.floor(audioCtx.sampleRate * seconds));
  const buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const damp = 0.65 - 0.5 * t; // one-pole lowpass that closes as the tail ages
      lp += damp * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - t, 3);
    }
  }
  reverbImpulseCache.set(key, buf);
  return buf;
}

/*
 * Builds the per-play FX chain. Nodes are chained conditionally based on
 * which fields the preset sets, so simple presets (deep/male/female) stay
 * cheap and only the fancier ones (telephone, ghost, demon) pay for the
 * extra filters/distortion/delay.
 */
function buildVoiceChain(voice) {
  const lowShelf = audioCtx.createBiquadFilter();
  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = 250;
  lowShelf.gain.value = voice.lowGain;

  const highShelf = audioCtx.createBiquadFilter();
  highShelf.type = "highshelf";
  highShelf.frequency.value = 3500;
  highShelf.gain.value = voice.highGain;

  lowShelf.connect(highShelf);
  let chainEnd = highShelf;

  // Telephone / radio: narrow the band to only mid frequencies.
  if (voice.bandpass) {
    const hp = audioCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = voice.bandpass.low;
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = voice.bandpass.high;
    chainEnd.connect(hp);
    hp.connect(lp);
    chainEnd = lp;
  }

  // Underwater: single lowpass to muffle everything above the cutoff.
  if (voice.lowpassFreq) {
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = voice.lowpassFreq;
    chainEnd.connect(lp);
    chainEnd = lp;
  }

  // Demon / alien / radio grit.
  if (voice.distortion > 0) {
    const shaper = audioCtx.createWaveShaper();
    shaper.curve = makeDistortionCurve(voice.distortion);
    shaper.oversample = "2x";
    chainEnd.connect(shaper);
    chainEnd = shaper;
  }

  // Robot / demon / alien buzz.
  let ringOsc = null;
  if (voice.ring) {
    const ringGain = audioCtx.createGain();
    ringGain.gain.value = 0;
    ringOsc = audioCtx.createOscillator();
    ringOsc.type = "sine";
    ringOsc.frequency.value = voice.ringFreq;
    ringOsc.connect(ringGain.gain);
    chainEnd.connect(ringGain);
    chainEnd = ringGain;
  }

  // ---- Voice colouring added with the expanded library -------------------
  // Every oscillator here is collected in `lfos` so start()/stop() manage
  // them together with the ring-mod oscillator.
  const lfos = ringOsc ? [ringOsc] : [];
  const addLfo = (freq, amount, targetParam) => {
    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const amt = audioCtx.createGain();
    amt.gain.value = amount;
    osc.connect(amt);
    amt.connect(targetParam);
    lfos.push(osc);
  };

  if (voice.highpassFreq) {
    const hp = audioCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = voice.highpassFreq;
    chainEnd.connect(hp);
    chainEnd = hp;
  }

  // Resonant peaks/dips: nasal, megaphone, announcer presence, cartoon.
  if (voice.peaks) {
    for (const pk of voice.peaks) {
      const f = audioCtx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = pk.f;
      f.Q.value = pk.q ?? 1;
      f.gain.value = pk.gain;
      chainEnd.connect(f);
      chainEnd = f;
    }
  }

  if (voice.crush) {
    const shaper = audioCtx.createWaveShaper();
    shaper.curve = makeCrushCurve(voice.crush);
    chainEnd.connect(shaper);
    chainEnd = shaper;
  }

  if (voice.tremolo) {
    const trem = audioCtx.createGain();
    trem.gain.value = 1 - voice.tremolo.depth / 2;
    addLfo(voice.tremolo.rate, voice.tremolo.depth / 2, trem.gain);
    chainEnd.connect(trem);
    chainEnd = trem;
  }

  // Chorus (mix < 1) or pure vibrato (mix 1): a short delay whose time
  // wobbles. The wobble is what detunes the copy.
  if (voice.chorus) {
    const { rate, depth, mix = 0.5 } = voice.chorus;
    const dly = audioCtx.createDelay(0.05);
    dly.delayTime.value = 0.012;
    addLfo(rate, depth / 1000, dly.delayTime);
    const wet = audioCtx.createGain();
    wet.gain.value = mix;
    const dry = audioCtx.createGain();
    dry.gain.value = mix >= 1 ? 0 : 1 - mix / 2;
    const out = audioCtx.createGain();
    chainEnd.connect(dly);
    dly.connect(wet).connect(out);
    chainEnd.connect(dry).connect(out);
    chainEnd = out;
  }

  if (voice.reverb) {
    const conv = audioCtx.createConvolver();
    conv.buffer = getReverbImpulse(voice.reverb.seconds);
    const wet = audioCtx.createGain();
    wet.gain.value = voice.reverb.mix;
    const dry = audioCtx.createGain();
    dry.gain.value = 1 - voice.reverb.mix * 0.4;
    const out = audioCtx.createGain();
    chainEnd.connect(conv);
    conv.connect(wet).connect(out);
    chainEnd.connect(dry).connect(out);
    chainEnd = out;
  }

  // Ghost / echo: a real delay-with-feedback tap mixed back in.
  let delayNodes = null;
  let finalOutput = chainEnd;
  if (voice.delay) {
    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 1 - voice.delay.mix;
    const wetGain = audioCtx.createGain();
    wetGain.gain.value = voice.delay.mix;
    const delayNode = audioCtx.createDelay(1.5);
    delayNode.delayTime.value = voice.delay.time;
    const feedbackGain = audioCtx.createGain();
    feedbackGain.gain.value = voice.delay.feedback;
    const mixOut = audioCtx.createGain();

    chainEnd.connect(dryGain).connect(mixOut);
    chainEnd.connect(delayNode);
    delayNode.connect(feedbackGain).connect(delayNode); // feedback loop
    delayNode.connect(wetGain).connect(mixOut);

    finalOutput = mixOut;
    delayNodes = { delayNode, feedbackGain };
  }

  return {
    input: lowShelf,
    output: finalOutput,
    start: (when) => { lfos.forEach((o) => o.start(when)); },
    stop: () => {
      lfos.forEach((o) => { try { o.stop(); } catch {} });
      if (delayNodes) {
        // Let the echo tail ring out, then break the feedback loop so this
        // node graph can be garbage collected instead of looping forever.
        setTimeout(() => {
          try { delayNodes.feedbackGain.disconnect(); } catch {}
          try { delayNodes.delayNode.disconnect(); } catch {}
        }, Math.max(1000, voice.delay.time * 1000 * 8));
      }
    },
  };
}

/* =========================================================================
   PLAYBACK
   ========================================================================= */
// Requests for the same buffer that arrive while it is still loading (a click
// during the background AI-voice pass, a waveform draw plus a play, ...) share
// one decode/conversion instead of each starting their own.
const bufferLoads = new Map();
function getBuffer(sound) {
  const useRvc = !!sound.rvcVoice;
  const cacheKey = useRvc
    ? `${sound.file}::rvc::${sound.rvcVoice}::${sound.rvcPitch || 0}${sound.rvcSeparateVocals ? "::sep" : ""}`
    : sound.file;
  const cached = cacheBufferGet(cacheKey);
  if (cached) return Promise.resolve(cached);
  let load = bufferLoads.get(cacheKey);
  if (!load) {
    load = loadBuffer(sound, useRvc, cacheKey).finally(() => bufferLoads.delete(cacheKey));
    bufferLoads.set(cacheKey, load);
  }
  return load;
}

async function loadBuffer(sound, useRvc, cacheKey) {
  let filePath = sound.file;
  if (useRvc) {
    const result = await window.electronAPI.convertRvcFile(
      sound.file, sound.id, sound.rvcVoice, sound.rvcPitch || 0, !!sound.rvcSeparateVocals
    );
    if (!result.success) {
      showToast(result.cancelled ? "Conversion cancelled" : "⚠️ RVC conversion failed: " + (result.error || "unknown error"));
      throw new Error(result.error || "RVC conversion failed");
    }
    filePath = result.outputPath;
  }

  const response = await fetch(toFileUrl(filePath));
  if (!response.ok) throw new Error("File not found");
  const arrayBuffer = await response.arrayBuffer();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (decodeErr) {
    // Chromium can't decode every format the picker accepts (WMA, AIFF, ...).
    // Let ffmpeg convert it to WAV once (cached in the main process) and retry.
    const t = await window.electronAPI.transcodeToWav(filePath);
    if (!t?.success) throw decodeErr;
    const retry = await fetch(toFileUrl(t.outputPath));
    audioBuffer = await audioCtx.decodeAudioData(await retry.arrayBuffer());
  }
  cacheBufferSet(cacheKey, audioBuffer);
  queueWaveform(sound, audioBuffer);
  return audioBuffer;
}

// One-off sounds (TTS / music previews) that play through the normal engine
// but must never live in the saved library — pushing them into `sounds` for
// the duration of playback let an unrelated save write them to disk.
const tempSounds = new Map();
function findSound(id) {
  return sounds.find((s) => s.id === id) || tempSounds.get(id);
}

async function playSound(id, opts = {}) {
  if (opts.sound) tempSounds.set(id, opts.sound);
  const sound = findSound(id);
  if (!sound) {
    if (opts.fromQueue) advanceQueue(); // sound was deleted while queued — don't stall the queue
    return;
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();

  // Clicking a sound that is already playing stops it. This must come before
  // the queue and stop-on-overlap handling: queue mode used to queue it again,
  // and stop-on-overlap stopped it and then immediately restarted it.
  if (playingNodes[id]) {
    if (opts.fromQueue) { advanceQueue(); return; }
    stopSound(id);
    return;
  }

  if (queueMode && !opts.fromQueue) {
    queue.push(id);
    showToast("➕ Queued: " + sound.name);
    if (!queuePlaying) advanceQueue();
    return;
  }

  // keepQueue: in queue mode this runs for each queued item — a plain
  // stopAll() would wipe the rest of the queue after the first sound.
  if (stopOnOverlap) stopAll({ keepQueue: true });

  try {
    const audioBuffer = await getBuffer(sound);
    // A second trigger can arrive while the first is still loading; both would
    // get past the check above and the later one would become untracked
    // (impossible to stop). Only the first play goes ahead.
    if (playingNodes[id]) {
      if (opts.fromQueue) advanceQueue();
      return;
    }
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = loopEnabled && !queueMode;

    const voice = computeVoiceParams(sound.rvcVoice ? { ...sound, voicePreset: "normal", pitchOffset: 0, formantTilt: 0 } : sound);
    source.playbackRate.value = voice.rate;
    const voiceChain = buildVoiceChain(voice);

    const gainNode = audioCtx.createGain();
    const targetVol = ((sound.volume ?? 100) / 100) * voice.volumeMult;
    const fadeIn = (sound.fadeIn ?? 0) / 1000;
    const fadeOut = (sound.fadeOut ?? 0) / 1000;
    const offset = sound.startOffset ?? 0;
    const trimEnd = sound.endOffset ?? audioBuffer.duration;
    const duration = Math.max(0.01, trimEnd - offset) / voice.rate;

    gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : targetVol, audioCtx.currentTime);
    if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(targetVol, audioCtx.currentTime + fadeIn);
    if (fadeOut > 0 && !source.loop) {
      const fadeStart = audioCtx.currentTime + Math.max(0, duration - fadeOut);
      gainNode.gain.setValueAtTime(targetVol, fadeStart);
      gainNode.gain.linearRampToValueAtTime(0.0001, fadeStart + fadeOut);
    }

    source.connect(voiceChain.input);
    voiceChain.output.connect(gainNode);
    gainNode.connect(monitorGain);
    if (sound.sendToMic !== false) gainNode.connect(micSendGain);

    const startTime = audioCtx.currentTime;
    voiceChain.start(startTime);
    if (source.loop) {
      // Loop only the trimmed region (it used to loop the whole file after the first pass).
      if (trimEnd > offset) { source.loopStart = offset; source.loopEnd = trimEnd; }
      source.start(0, offset);
    } else source.start(0, offset, duration * voice.rate);

    playingNodes[id] = { source, gainNode, voiceChain, endsAt: startTime + duration, startedAt: startTime, duration, loop: source.loop, baseVol: targetVol, ducker: duckEnabled, ducked: false };

    if (duckEnabled) applyDuck(id);

    const playingCard = document.querySelector(`.sound-card[data-id="${id}"]`);
    if (playingCard) {
      setCardPlayProgress(playingCard, duration, 0, source.loop);
      playingCard.classList.add("playing");
    }
    updateNowPlayingBar();

    source.onended = () => {
      voiceChain.stop();
      // A stopped source fires onended *later*. If the same sound was
      // re-triggered in the meantime, playingNodes[id] is now the NEW play —
      // only clean up if this is still the tracked one, or the new play
      // becomes untracked (can't be stopped, shows no state).
      const tracked = playingNodes[id];
      if (tracked && tracked.source === source) {
        delete playingNodes[id];
        releaseDuck();
        document.querySelector(`.sound-card[data-id="${id}"]`)?.classList.remove("playing");
        updateNowPlayingBar();
      }
      tempSounds.delete(id); // no-op for real library sounds (they live in `sounds`)
      if (queueMode && opts.fromQueue) advanceQueue();
    };
  } catch (e) {
    tempSounds.delete(id);
    showToast("⚠️ Could not play: " + (sound.name || id));
    console.error(e);
    if (opts.fromQueue) advanceQueue(); // a failed item must not freeze the queue
  }
}

function advanceQueue() {
  if (queue.length === 0) { queuePlaying = false; return; }
  queuePlaying = true;
  const nextId = queue.shift();
  playSound(nextId, { fromQueue: true });
}

// Lowers every other playing sound to a fraction of ITS OWN volume. (It used to
// multiply the current gain each time, so volume kept shrinking with every new
// sound and never came back.)
function applyDuck(excludeId) {
  Object.entries(playingNodes).forEach(([id, node]) => {
    if (id === excludeId) return;
    node.ducked = true;
    node.gainNode.gain.setTargetAtTime((node.baseVol ?? 1) * duckAmount, audioCtx.currentTime, 0.03);
  });
}

// When the last sound that was ducking others has finished, bring them back.
function releaseDuck() {
  const nodes = Object.values(playingNodes);
  nodes.forEach((node) => {
    if (!node.ducked) return;
    // Still held down by some other sound that is ducking?
    if (nodes.some((n) => n !== node && n.ducker)) return;
    node.ducked = false;
    node.gainNode.gain.setTargetAtTime(node.baseVol ?? 1, audioCtx.currentTime, 0.08);
  });
}

function stopSound(id) {
  if (playingNodes[id]) {
    try { playingNodes[id].source.stop(); } catch {}
    try { playingNodes[id].voiceChain?.stop(); } catch {}
    delete playingNodes[id];
    releaseDuck();
  }
  document.querySelector(`.sound-card[data-id="${id}"]`)?.classList.remove("playing");
  updateNowPlayingBar();
}
function panic() {
  stopAll();
  setMicMuted(true);
  showToast("🛑 Panic button: everything stopped, mic muted");
}

function stopAll({ keepQueue = false } = {}) {
  Object.keys(playingNodes).forEach((id) => stopSound(id));
  if (!keepQueue) {
    queue = [];
    queuePlaying = false;
  }
}

// Renders a horizontal strip of chips, one per currently playing sound,
// each with a tiny animated waveform and a stop button — a live readout
// of the board's state, not decoration, since it's the only place you can
// see and stop one specific sound without hunting for its card.
/* Static 4-bar idle glyph, drawn once at boot. The .idle CSS animation
   (gentle scale/opacity breathe) handles the "alive but not playing" feel
   without needing a running rAF loop when nothing is actually playing. */
function drawTitlebarIdleBars() {
  const canvas = document.getElementById("titlebar-viz");
  if (!canvas) return;
  canvas.classList.add("idle");
  const ctx = canvas.getContext("2d");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent-text").trim() || "#fff";
  ctx.fillStyle = accent;
  const heights = [7, 13, 10, 15];
  heights.forEach((h, i) => {
    const x = 2 + i * 4.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, 18 - h, 2.5, h, 1.2);
    else ctx.rect(x, 18 - h, 2.5, h);
    ctx.fill();
  });
}

/* Titlebar live equalizer — reads real playback levels off titlebarAnalyser
   (tapped from monitorGain in initAudio). Only runs while something is
   actually playing; idles as plain CSS otherwise so it costs nothing at rest. */
function updateTitlebarViz() {
  const ids = Object.keys(playingNodes);
  const canvas = document.getElementById("titlebar-viz");
  if (!canvas) return;
  canvas.classList.toggle("idle", ids.length === 0);
  if (ids.length === 0 || !titlebarAnalyser) { titlebarVizRunning = false; return; }
  if (titlebarVizRunning) return;
  titlebarVizRunning = true;

  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(titlebarAnalyser.frequencyBinCount);
  const BARS = 4;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent-text").trim() || "#fff";

  let lastFrame = 0;
  function draw(ts) {
    if (Object.keys(playingNodes).length === 0) { titlebarVizRunning = false; drawTitlebarIdleBars(); return; }
    if (ts - lastFrame < 33) { requestAnimationFrame(draw); return; }
    lastFrame = ts;
    titlebarAnalyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, 20, 20);
    ctx.fillStyle = accent;
    const step = Math.floor(data.length / BARS);
    for (let i = 0; i < BARS; i++) {
      const level = data[i * step] / 255;
      const h = Math.max(2, level * 16);
      const x = 2 + i * 4.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, 18 - h, 2.5, h, 1.2);
      else ctx.rect(x, 18 - h, 2.5, h);
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

function updateNowPlayingBar() {
  updateTitlebarViz();
  const bar = document.getElementById("now-playing-bar");
  if (!bar) return;
  const ids = Object.keys(playingNodes);
  if (ids.length === 0) {
    bar.classList.remove("visible");
    bar.innerHTML = "";
    return;
  }
  bar.classList.add("visible");
  bar.innerHTML = `<span class="now-playing-label">Playing</span>`;
  ids.forEach((id) => {
    const sound = findSound(id);
    if (!sound) return;
    const color = sound.color || COLORS[0];
    const chip = document.createElement("div");
    chip.className = "now-playing-chip";
    chip.style.setProperty("--chip-color-rgb", hexToRgbString(color));
    chip.innerHTML = `
      <span class="now-playing-chip-waves">
        <span class="wave-bar"></span><span class="wave-bar"></span><span class="wave-bar"></span>
      </span>
      <span>${escHtml(sound.name)}</span>
      <span class="now-playing-chip-stop">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </span>
    `;
    chip.addEventListener("click", () => stopSound(id));
    bar.appendChild(chip);
  });
}

function hexToRgbString(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

async function previewVoice(sound, overrideVoiceFields) {
  stopPreview();
  const token = ++previewToken;
  if (audioCtx.state === "suspended") await audioCtx.resume();
  try {
    const audioBuffer = await getBuffer(sound);
    if (token !== previewToken) return; // a newer preview (or a stop) took over while decoding
    const merged = { ...sound, ...overrideVoiceFields };
    const voice = computeVoiceParams(merged);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = voice.rate;

    const voiceChain = buildVoiceChain(voice);
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = ((sound.volume ?? 100) / 100) * voice.volumeMult;

    source.connect(voiceChain.input);
    voiceChain.output.connect(gainNode);
    gainNode.connect(monitorGain);

    // A preview must always be heard, even when "Monitor mic feed" has taken
    // the speakers away from the sound bus. Connecting twice is harmless.
    monitorGain.connect(audioCtx.destination);

    const pOffset = sound.startOffset ?? 0;
    const pEnd = sound.endOffset ?? audioBuffer.duration;
    voiceChain.start(audioCtx.currentTime);
    if (pEnd > pOffset) source.start(0, pOffset, pEnd - pOffset);
    else source.start(0);
    previewNode = { source, voiceChain };

    source.onended = () => {
      voiceChain.stop();
      // Superseded by a newer preview? It owns the monitor routing now.
      if (previewNode && previewNode.source !== source) return;
      previewNode = null;
      refreshMonitorRouting(); // put the speakers back the way the settings say
    };
  } catch (e) {
    console.error(e);
  }
}
function stopPreview() {
  previewToken++;
  if (previewNode) {
    try { previewNode.source.stop(); } catch {}
    try { previewNode.voiceChain.stop(); } catch {}
    previewNode = null;
  }
}

/* =========================================================================
   LIBRARY
   ========================================================================= */
async function loadSounds() {
  const loaded = await window.electronAPI.loadSounds();
  sounds = Array.isArray(loaded) ? loaded.filter((x) => x && typeof x === "object") : [];
  // Repair rather than drop: an entry missing an id/name would otherwise
  // break rendering, and dropping it here would erase it on the next save.
  for (const entry of sounds) {
    if (!entry.id) entry.id = "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    if (typeof entry.name !== "string") entry.name = String(entry.name ?? "Untitled");
  }
  renderGrid();
  renderCategoryFilter();
  // One IPC round trip per hotkey used to run back to back before the grid
  // appeared. Now the grid paints first and they register in parallel.
  await Promise.all(
    sounds.filter((s) => s.hotkey).map((s) =>
      window.electronAPI.registerHotkey({ id: s.id, accelerator: s.hotkey }).catch((e) => console.warn("hotkey register failed:", s.id, e))
    )
  );
  // Background AI-voice conversion decodes audio and starts Python work;
  // keep it out of the launch window.
  setTimeout(preconvertRvcSounds, 4000);
}

// Converts any sound that already has an AI Voice picked, one at a time,
// quietly in the background after launch — so clicking it later is
// instant instead of waiting on a fresh conversion. Uses the same
// getBuffer()/bufferCache path as normal playback, and main.js's job
// queue means this never runs concurrently with a user-triggered
// Preview/Save conversion.
async function preconvertRvcSounds() {
  const candidates = sounds.filter((s) => s.rvcVoice);
  for (const sound of candidates) {
    // The sound list (or the sound itself) may have changed while this
    // loop was waiting its turn in the queue — skip anything stale.
    const current = sounds.find((s) => s.id === sound.id);
    if (!current || !current.rvcVoice) continue;
    try {
      await getBuffer(current);
    } catch {
      // Failures here are surfaced by getBuffer's own toast when the
      // person actually tries to play it — nothing more to do quietly.
    }
  }
}

function saveSoundsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; window.electronAPI.saveSounds(sounds); }, 400);
}
async function saveSoundsNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return window.electronAPI.saveSounds(sounds);
}

function softDeleteSound(id) {
  const idx = sounds.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = sounds.splice(idx, 1);
  const removedAt = idx;
  stopSound(id);
  saveSoundsNow();
  renderGrid(currentSearchValue());
  renderCategoryFilter();

  if (trashBin) clearTimeout(trashBin.timeout);
  trashBin = { sound: removed, timeout: setTimeout(() => { trashBin = null; }, 6000) };
  showToast("🗑 Deleted \"" + removed.name + "\"", {
    actionLabel: "Undo",
    // Restores *this* toast's sound (captured above) — not whatever happens
    // to be in trashBin now, which may be a different, later deletion — and
    // puts it back where it was rather than at the end of the library.
    onAction: () => {
      if (sounds.some((s) => s.id === removed.id)) return;
      sounds.splice(Math.min(removedAt, sounds.length), 0, removed);
      if (removed.hotkey) {
        window.electronAPI.registerHotkey({ id: removed.id, accelerator: removed.hotkey });
      }
      saveSoundsNow();
      renderGrid(currentSearchValue());
      renderCategoryFilter();
      if (trashBin && trashBin.sound === removed) { clearTimeout(trashBin.timeout); trashBin = null; }
    },
  });
}

function makeSoundEntry(filePath) {
  const name = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  const id = "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const color = COLORS[sounds.length % COLORS.length];
  return {
    id, name, file: filePath, emoji: "🔊", color, hotkey: "",
    volume: 100, category: "", fadeIn: 0, fadeOut: 0, startOffset: 0,
    voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    favorite: false, sendToMic: true, rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
}

function makeImportedSoundEntry(filePath, name) {
  const color = COLORS[sounds.length % COLORS.length];
  const id = "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  return {
    id, name: name || "Imported clip", file: filePath, emoji: "🎬", color, hotkey: "",
    volume: 100, category: "", fadeIn: 0, fadeOut: 0, startOffset: 0,
    voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    favorite: false, sendToMic: true, rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
}

async function addFiles(filePaths) {
  if (!filePaths.length) return;
  for (const file of filePaths) sounds.push(makeSoundEntry(file));
  await saveSoundsNow();
  renderGrid(currentSearchValue());
  renderCategoryFilter();
  showToast("✅ Added " + filePaths.length + " sound" + (filePaths.length > 1 ? "s" : ""));
}

/* =========================================================================
   DRAG-TO-REORDER
   ========================================================================= */
function persistCardOrder(containerSelector = ".sound-card:not(.add-sound-tile)") {
  const ids = [...document.querySelectorAll(containerSelector)].map((el) => el.dataset.id);
  const idSet = new Set(ids);
  const byId = new Map(sounds.map((x) => [x.id, x]));
  // The visible cards take the slots the visible sounds had, in the new order.
  const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
  let r = 0;
  sounds = sounds.map((s) => (idSet.has(s.id) && r < reordered.length ? reordered[r++] : s));
  saveSoundsDebounced();
}

// Pointer-based reordering. HTML5 drag-and-drop can't be used here: Tauri's
// file-drop handler (needed to receive real file paths) disables it on Windows.
function makeCardDraggable(div) {
  div.draggable = false;
  div.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, select, textarea, a")) return;
    const pointerId = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    let active = false;

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        active = true;
        div.classList.add("dragging");
        document.body.classList.add("card-dragging");
      }
      // .dragging has pointer-events:none, so this finds what is *under* the card.
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".sound-card:not(.add-sound-tile)");
      if (over && over !== div && over.parentNode === div.parentNode) {
        const rect = over.getBoundingClientRect();
        const before = (ev.clientX - rect.left) < rect.width / 2;
        over.parentNode.insertBefore(div, before ? over : over.nextSibling);
      }
    };
    const finish = (ev) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!active) return;
      div.classList.remove("dragging");
      document.body.classList.remove("card-dragging");
      // Releasing a drag must not also "click" (play) a card.
      const swallow = (clickEvent) => { clickEvent.stopPropagation(); clickEvent.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (ev.type === "pointerup") persistCardOrder();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

/* =========================================================================
   GRID / CARDS
   ========================================================================= */
function currentSearchValue() {
  return document.getElementById("search-input")?.value || "";
}

function renderGrid(filter = "") {
  const grid = document.getElementById("sounds-grid");
  if (!grid) return;
  const countEl = document.getElementById("sound-count-pill");
  if (countEl) countEl.textContent = `${sounds.length} sound${sounds.length === 1 ? "" : "s"}`;
  const lower = filter.toLowerCase();
  const visible = sounds.filter((s) => {
    const matchesText = !filter || String(s.name ?? "").toLowerCase().includes(lower);
    const matchesCat = currentCategory === "" ? !s.category : s.category === currentCategory;
    return matchesText && matchesCat;
  });

  waveformObserver?.disconnect();
  waveformQueue.length = 0;
  document.documentElement.dataset.crowd = sounds.length > 80 ? "1" : "0";
  grid.innerHTML = "";

  const groups = new Map();
  visible.forEach((s) => {
    const key = s.category || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  groups.forEach((list) => list.sort((a, b) => (b.favorite === true) - (a.favorite === true)));

  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  let addTileInserted = false;

  orderedKeys.forEach((key) => {
    const list = groups.get(key);
    const block = document.createElement("div");
    block.className = "sound-category-block";
    if (key !== "") {
      block.appendChild(createCategoryHeader(key, list.length));
      if (collapsedCategories.has(key)) { grid.appendChild(block); return; }
    }
    const section = document.createElement("div");
    section.className = "sound-category-section";
    section.dataset.category = key;
    if (!addTileInserted) { section.appendChild(createAddSoundTile()); addTileInserted = true; }
    list.forEach((s) => section.appendChild(createCard(s)));
    block.appendChild(section);
    grid.appendChild(block);
  });

  // The Add Sound tile normally rides along in the first open category
  // section. With nothing to show (empty search/category, or every section
  // collapsed) there's no section to carry it, so give it its own — otherwise
  // an empty page would have no way to add sounds.
  if (!addTileInserted) {
    const block = document.createElement("div");
    block.className = "sound-category-block";
    const section = document.createElement("div");
    section.className = "sound-category-section";
    section.dataset.category = currentCategory;
    section.appendChild(createAddSoundTile());
    block.appendChild(section);
    grid.appendChild(block);
  }

  gridEmptyState = visible.length === 0 && sounds.length > 0 ? "no-match" : null;
  updateEmptyState(gridEmptyState);
}

function createCategoryHeader(name, count) {
  const header = document.createElement("div");
  header.className = "category-header";
  const collapsed = collapsedCategories.has(name);
  header.innerHTML = `
    <span class="category-header-chevron ${collapsed ? "collapsed" : ""}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
    </span>
    <span class="category-header-name">${escHtml(name)}</span>
    <span class="category-header-count">${count}</span>
  `;
  header.addEventListener("click", () => {
    if (collapsedCategories.has(name)) collapsedCategories.delete(name);
    else collapsedCategories.add(name);
    try { localStorage.setItem("soundboard:collapsedCategories", JSON.stringify([...collapsedCategories])); } catch {}
    renderGrid(currentSearchValue());
  });
  return header;
}

function createAddSoundTile() {
  const div = document.createElement("div");
  div.className = "sound-card add-sound-tile";
  div.title = "Add sounds";
  div.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
    <div class="sound-name">Add Sound</div>
  `;
  div.addEventListener("click", openAddSoundsDialog);
  return div;
}

function createCard(sound) {
  const div = document.createElement("div");
  div.className = "sound-card";
  div.dataset.id = sound.id;
  const color = sound.color || COLORS[0];
  div.style.setProperty("--card-color", color);
  const badges = [];
  if (sound.rvcVoice) badges.push(`<span class="sound-badge sound-badge-voice" title="AI voice: ${escHtml(sound.rvcVoice)}">🤖 ${escHtml(sound.rvcVoice)}</span>`);
  else if (sound.voicePreset && sound.voicePreset !== "normal") badges.push(`<span class="sound-badge sound-badge-voice" title="Voice effect">${escHtml(sound.voicePreset)}</span>`);
  if (sound.sendToMic === false) badges.push(`<span class="sound-badge sound-badge-local" title="Local only — not sent to the virtual mic">🔇</span>`);
  div.innerHTML = `
    <div class="sound-emoji">${escHtml(sound.emoji || "🔊")}</div>
    <div class="sound-name">${escHtml(sound.name)}</div>
    <button type="button" class="sound-shortcut-btn ${sound.hotkey ? "has-key" : ""}" title="${sound.hotkey ? "Change hotkey" : "Set a global hotkey"}">${sound.hotkey ? escHtml(sound.hotkey) : "Add Shortcut"}</button>
    ${badges.length ? `<div class="sound-badges">${badges.join("")}</div>` : ""}
    <div class="sound-waveform">
      <canvas class="sound-waveform-canvas wf-base" width="360" height="44"></canvas>
      <canvas class="sound-waveform-canvas wf-played" width="360" height="44"></canvas>
    </div>
    <div class="sound-card-actions">
      <button class="sound-favorite-btn ${sound.favorite ? "active" : ""}" title="Favorite">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="${sound.favorite ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </button>
      <button class="sound-edit-btn" title="Edit">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button class="sound-delete-btn" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    </div>
  `;

  div.addEventListener("click", (e) => {
    if (e.target.closest(".sound-edit-btn")) { openEditModal(sound.id); return; }
    if (e.target.closest(".sound-shortcut-btn")) { e.stopPropagation(); openEditModal(sound.id, "hotkey"); return; }
    if (e.target.closest(".sound-delete-btn")) {
      e.stopPropagation();
      try { window.electronAPI?.unregisterHotkey?.(sound.id); } catch (err) { console.error("unregisterHotkey failed:", err); }
      softDeleteSound(sound.id);
      return;
    }
    if (e.target.closest(".sound-favorite-btn")) {
      e.stopPropagation();
      sound.favorite = !sound.favorite;
      saveSoundsDebounced();
      renderGrid(currentSearchValue());
      return;
    }
    playSound(sound.id);
  });

  drawWaveform(div, null); // placeholder bars until the audio is decoded
  if (playingNodes[sound.id]) {
    const node = playingNodes[sound.id];
    let elapsed = Math.max(0, audioCtx.currentTime - (node.startedAt ?? audioCtx.currentTime));
    if (node.loop && node.duration) elapsed %= node.duration;
    setCardPlayProgress(div, node.duration, elapsed, node.loop);
    div.classList.add("playing");
  }

  // The strip is drawn from the original file. Going through getBuffer(sound)
  // for an AI-voice sound would run the (slow, python-backed) conversion — and
  // pop an error toast if it fails — on every single grid re-render.
  if (bufferCache.has(sound.file)) drawWaveform(div, bufferCache.get(sound.file), sound);
  else observeCardForWaveform(div, sound);

  makeCardDraggable(div);

  return div;
}

const WAVEFORM_CONCURRENCY = 2;
const waveformQueue = [];
const waveformPending = new WeakMap();
let waveformActive = 0;
let waveformObserver = null;

function pumpWaveformQueue() {
  while (waveformActive < WAVEFORM_CONCURRENCY && waveformQueue.length) {
    const { card, sound } = waveformQueue.shift();
    if (!card.isConnected) continue;
    if (bufferCache.has(sound.file)) { drawWaveform(card, bufferCache.get(sound.file), sound); continue; }
    waveformActive++;
    getBuffer({ ...sound, rvcVoice: null })
      .catch(() => {})
      .finally(() => { waveformActive--; pumpWaveformQueue(); });
  }
}

function observeCardForWaveform(card, sound) {
  if (typeof IntersectionObserver === "undefined") {
    waveformQueue.push({ card, sound });
    pumpWaveformQueue();
    return;
  }
  if (!waveformObserver) {
    waveformObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        waveformObserver.unobserve(entry.target);
        const s = waveformPending.get(entry.target);
        if (s) {
          waveformPending.delete(entry.target);
          waveformQueue.push({ card: entry.target, sound: s });
        }
      }
      pumpWaveformQueue();
    }, { root: document.getElementById("sounds-grid"), rootMargin: "400px 0px" });
  }
  waveformPending.set(card, sound);
  waveformObserver.observe(card);
}

function queueWaveform(sound, buffer) {
  const card = document.querySelector(`.sound-card[data-id="${sound.id}"]`);
  if (card) drawWaveform(card, buffer, sound);
}
function waveformColor(cardEl) {
  const raw = (cardEl.style.getPropertyValue("--card-color") || "").trim();
  if (!/^#[0-9a-f]{6}$/i.test(raw)) return raw || "#ffffff";
  // On light themes pastel card colours vanish against white, so deepen them.
  if (document.documentElement.dataset.mode !== "light") return raw;
  const k = 0.68;
  const c = [1, 3, 5].map((i) => Math.round(parseInt(raw.slice(i, i + 2), 16) * k));
  return "rgb(" + c.join(",") + ")";
}

const peaksCache = new WeakMap();

function computePeaks(buffer, sound, BARS) {
  const startOffset = sound?.startOffset ?? 0;
  const endOffset = sound?.endOffset ?? buffer.duration;
  const key = startOffset + ":" + endOffset;
  let perBuffer = peaksCache.get(buffer);
  if (!perBuffer) { perBuffer = new Map(); peaksCache.set(buffer, perBuffer); }
  const hit = perBuffer.get(key);
  if (hit) return hit;
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.floor(startOffset * sr));
  const s1 = Math.min(buffer.length, Math.floor(endOffset * sr));
  const span = Math.max(1, s1 - s0);
  const data = buffer.getChannelData(0);
  const per = span / BARS;
  const stride = Math.max(1, Math.floor(per / 160));
  const peaks = new Array(BARS).fill(0);
  let maxPeak = 0.02;
  for (let i = 0; i < BARS; i++) {
    const from = s0 + Math.floor(i * per);
    const to = Math.min(s1, s0 + Math.floor((i + 1) * per));
    let p = 0;
    for (let j = from; j < to; j += stride) { const v = Math.abs(data[j] || 0); if (v > p) p = v; }
    peaks[i] = p;
    if (p > maxPeak) maxPeak = p;
  }
  const out = peaks.map((p) => Math.pow(p / maxPeak, 0.7));
  if (perBuffer.size > 6) perBuffer.clear();
  perBuffer.set(key, out);
  return out;
}

function drawWaveform(cardEl, buffer, soundHint) {
  const canvases = cardEl.querySelectorAll(".sound-waveform-canvas");
  if (!canvases.length) return;
  const W = canvases[0].width, H = canvases[0].height;
  const BARS = 48;
  const slot = W / BARS;
  const barW = Math.max(2, slot * 0.62);
  const color = waveformColor(cardEl);

  // Peak per bar across the *trimmed* region so the strip matches what plays.
  let peaks = new Array(BARS).fill(0.06);
  if (buffer) {
    const sound = soundHint || sounds.find((x) => x.id === cardEl.dataset.id);
    peaks = computePeaks(buffer, sound, BARS);
  }

  canvases.forEach((canvas) => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < BARS; i++) {
      const h = Math.max(4, peaks[i] * H);
      const x = i * slot + (slot - barW) / 2;
      const y = (H - h) / 2;
      if (ctx.roundRect) ctx.roundRect(x, y, barW, h, barW / 2);
      else ctx.rect(x, y, barW, h);
    }
    ctx.fill();
  });
}

function redrawAllWaveforms() {
  const byId = new Map(sounds.map((x) => [x.id, x]));
  document.querySelectorAll(".sound-card").forEach((card) => {
    const sound = byId.get(card.dataset.id);
    drawWaveform(card, sound && bufferCache.has(sound.file) ? bufferCache.get(sound.file) : null, sound);
  });
}

// Drives the CSS playhead that sweeps across the waveform while a card plays.
function setCardPlayProgress(cardEl, duration, elapsed, loop) {
  cardEl.style.setProperty("--play-dur", Math.max(0.05, duration || 0.05) + "s");
  cardEl.style.setProperty("--play-delay", -(elapsed || 0) + "s");
  cardEl.style.setProperty("--play-iter", loop ? "infinite" : "1");
}

// What renderGrid last decided, so a bare updateEmptyState() call (startup)
// re-applies it instead of overriding it.
let gridEmptyState = null;

function updateEmptyState(state) {
  const empty = document.getElementById("empty-state");
  const grid = document.getElementById("sounds-grid");
  if (!empty || !grid) return;
  if (state === undefined) state = gridEmptyState;
  // The grid stays visible even when empty because it holds the Add Sound
  // tile; "compact" shrinks it to just that tile so the message sits below.
  grid.style.display = "grid";
  if (sounds.length === 0) {
    empty.classList.add("visible");
    grid.classList.add("compact");
    empty.querySelector("p").innerHTML = "No sounds yet.<br/>Click the <strong>Add Sound</strong> tile or drag files here to get started.";
  } else if (state === "no-match") {
    empty.classList.add("visible");
    grid.classList.add("compact");
    // The default view only lists sounds with no category, so when every
    // sound is categorized it's empty without any search being involved.
    const filtering = currentSearchValue().trim() !== "" || currentCategory !== "";
    empty.querySelector("p").innerHTML = filtering
      ? "No sounds match your search."
      : "No uncategorized sounds.<br/>Pick a category from the dropdown above to see the rest.";
  } else {
    empty.classList.remove("visible");
    grid.classList.remove("compact");
  }
}

function renderCategoryFilter() {
  const sel = document.getElementById("category-filter");
  if (!sel) return;
  const cats = [...new Set(sounds.map((s) => s.category).filter(Boolean))];
  if (currentCategory && !cats.includes(currentCategory)) {
    // The last sound in this category was deleted/moved — fall back to the
    // default view instead of showing an empty grid with a blank dropdown.
    currentCategory = "";
    renderGrid(currentSearchValue());
  }
  sel.innerHTML = `<option value="">Uncategorized</option>` +
    cats.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("");
  sel.value = currentCategory;
}

/* =========================================================================
   DRAG AND DROP (file import)
   ========================================================================= */
// Electron 32+ removed File.path; webUtils (exposed via preload) is the
// supported replacement. Falls back to .path for older runtimes.
function filePathOf(file) {
  try {
    const p = window.electronAPI?.getPathForFile?.(file);
    if (p) return p;
  } catch {}
  return file.path || "";
}

function bindDragAndDrop() {
  const grid = document.getElementById("sounds-grid");
  const dropTargets = [grid, document.getElementById("empty-state")].filter(Boolean);

  dropTargets.forEach((el) => {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;
      const paths = files
        .map(filePathOf)
        .filter((p) => p && AUDIO_EXTENSIONS.includes(p.split(".").pop().toLowerCase()));
      if (paths.length === 0) {
        showToast("⚠️ No supported audio files in that drop");
        return;
      }
      await addFiles(paths);
    });
  });
}

/* =========================================================================
   YOUTUBE IMPORT
   Paste a URL, optionally set a start/end clip range, and auto-trim
   silence off the edges. Downloading + trimming happens in the main
   process; this just drives the modal and files the result away as a
   normal sound once it comes back.
   ========================================================================= */
function bindYoutubeImportModal() {
  document.getElementById("yt-import-open-btn")?.addEventListener("click", openYoutubeImportModal);
  document.getElementById("yt-cancel-btn")?.addEventListener("click", closeYoutubeImportModal);
  document.getElementById("yt-import-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("yt-import-modal-overlay")) closeYoutubeImportModal();
  });
  document.getElementById("yt-fetch-btn")?.addEventListener("click", fetchYoutubeInfo);
  document.getElementById("yt-url-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); fetchYoutubeInfo(); }
  });
  document.getElementById("yt-autotrim-toggle")?.addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
  });
  document.getElementById("yt-import-btn-confirm")?.addEventListener("click", runYoutubeImport);
  bindYoutubeCookieControls();
}

/* ---- YouTube cookie management ---- */
const YT_BROWSER_LABELS = {
  chrome: "Chrome", firefox: "Firefox", edge: "Edge", brave: "Brave",
  opera: "Opera", vivaldi: "Vivaldi", chromium: "Chromium", safari: "Safari",
};

function bindYoutubeCookieControls() {
  document.getElementById("yt-cookie-import-btn")?.addEventListener("click", async () => {
    const res = await window.electronAPI.importYoutubeCookiesFile();
    if (res.canceled) return;
    if (!res.success) { showToast("⚠️ " + (res.error || "Couldn't import cookies")); return; }
    renderYtCookieStatus(res.status);
    showToast("✅ Saved " + res.status.fileCookieCount + " YouTube cookies");
  });

  document.getElementById("yt-cookie-browser-btn")?.addEventListener("click", async () => {
    const browser = getVal("yt-cookie-browser-select");
    if (!browser) return;
    const res = await window.electronAPI.useYoutubeCookiesFromBrowser(browser);
    if (!res.success) { showToast("⚠️ " + (res.error || "Couldn't switch cookie source")); return; }
    renderYtCookieStatus(res.status);
    showToast("✅ Using " + (YT_BROWSER_LABELS[browser] || browser) + " cookies");
  });

  document.getElementById("yt-cookie-clear-btn")?.addEventListener("click", async () => {
    const res = await window.electronAPI.clearYoutubeCookies();
    renderYtCookieStatus(res.status);
    showToast("🧹 YouTube cookies cleared");
  });
}

async function refreshYtCookieStatus() {
  try { renderYtCookieStatus(await window.electronAPI.getYoutubeCookieStatus()); } catch (e) { console.error(e); }
}

function renderYtCookieStatus(status) {
  if (!status) return;
  const select = document.getElementById("yt-cookie-browser-select");
  if (select && !select.options.length) {
    for (const b of status.browsers || []) {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = YT_BROWSER_LABELS[b] || b;
      select.appendChild(opt);
    }
  }
  if (select && status.mode === "browser") select.value = status.browser;

  const badge = document.getElementById("yt-cookie-badge");
  if (badge) {
    badge.classList.toggle("active", status.mode !== "none");
    if (status.mode === "file") {
      badge.textContent = "Saved · " + status.fileCookieCount + " cookies";
    } else if (status.mode === "browser") {
      badge.textContent = "From " + (YT_BROWSER_LABELS[status.browser] || status.browser);
    } else {
      badge.textContent = "Not set";
    }
  }
  const clearBtn = document.getElementById("yt-cookie-clear-btn");
  if (clearBtn) clearBtn.disabled = status.mode === "none" && !status.fileCookieCount;
}

// If YouTube is asking for a sign-in, pop the cookie section open so the fix is right there.
function handleYoutubeAuthError(message) {
  if (!/sign in|not a bot|confirm you.re not|login required|age.restricted|cookies/i.test(message || "")) return false;
  const details = document.getElementById("yt-cookies-details");
  if (details) details.open = true;
  return true;
}

function openYoutubeImportModal() {
  setVal("yt-url-input", "");
  setVal("yt-name-input", "");
  setVal("yt-start-input", "");
  setVal("yt-end-input", "");
  document.getElementById("yt-autotrim-toggle")?.classList.add("active");
  const preview = document.getElementById("yt-preview");
  if (preview) preview.style.display = "none";
  setYtStatus("");
  refreshYtCookieStatus();
  document.getElementById("yt-import-modal-overlay")?.classList.add("visible");
}
function closeYoutubeImportModal() {
  document.getElementById("yt-import-modal-overlay")?.classList.remove("visible");
}

function setYtStatus(text) {
  const el = document.getElementById("yt-import-status");
  if (!el) return;
  if (!text) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "block";
  el.textContent = text;
}

function formatSecondsMMSS(total) {
  total = Math.max(0, Math.round(total || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function parseMMSS(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(":").map((p) => parseFloat(p));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

async function fetchYoutubeInfo() {
  const url = getVal("yt-url-input").trim();
  if (!url) { showToast("⚠️ Paste a YouTube URL first"); return; }
  setYtStatus("Loading video info…");
  try {
    const info = await window.electronAPI.getYoutubeInfo(url);
    setYtStatus("");
    if (!info.success) {
      handleYoutubeAuthError(info.error);
      showToast("⚠️ " + (info.error || "Couldn't load that video"));
      return;
    }
    const preview = document.getElementById("yt-preview");
    if (preview) preview.style.display = "block";
    setLabel("yt-preview-title", info.title);
    setLabel("yt-preview-meta", (info.author ? info.author + " · " : "") + formatSecondsMMSS(info.durationSeconds));
    if (!getVal("yt-name-input").trim()) setVal("yt-name-input", info.title);
    if (!getVal("yt-end-input").trim() && info.durationSeconds) {
      setVal("yt-end-input", formatSecondsMMSS(info.durationSeconds));
    }
  } catch (e) {
    console.error(e);
    setYtStatus("");
    showToast("⚠️ Couldn't load that video");
  }
}

async function runYoutubeImport() {
  const url = getVal("yt-url-input").trim();
  if (!url) { showToast("⚠️ Paste a YouTube URL first"); return; }

  const startStr = getVal("yt-start-input").trim();
  const endStr = getVal("yt-end-input").trim();
  if (startStr && parseMMSS(startStr) == null) { showToast("⚠️ Start time should look like mm:ss"); return; }
  if (endStr && parseMMSS(endStr) == null) { showToast("⚠️ End time should look like mm:ss"); return; }
  if (startStr && endStr && parseMMSS(endStr) <= parseMMSS(startStr)) {
    showToast("⚠️ End time must be after start time");
    return;
  }

  const name = getVal("yt-name-input").trim() || "Imported clip";
  const autoTrim = document.getElementById("yt-autotrim-toggle")?.classList.contains("active") ?? true;

  const btn = document.getElementById("yt-import-btn-confirm");
  if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }
  setYtStatus("Downloading and trimming audio — this can take a moment…");

  try {
    const result = await window.electronAPI.importYoutubeClip({
      url, name, start: startStr, end: endStr, autoTrim,
    });
    if (!result.success) {
      handleYoutubeAuthError(result.error);
      showToast("⚠️ " + (result.error || "Import failed"));
      return;
    }
    const entry = makeImportedSoundEntry(result.filePath, result.name || name);
    sounds.push(entry);
    await saveSoundsNow();
    renderGrid(currentSearchValue());
    renderCategoryFilter();
    closeYoutubeImportModal();
    showToast("✅ Imported \"" + entry.name + "\"");
  } catch (e) {
    console.error(e);
    showToast("⚠️ Import failed");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬇ Import"; }
    setYtStatus("");
  }
}

/* =========================================================================
   SETTINGS MODAL (device routing, mic mixer, playback prefs)
   ========================================================================= */
function bindSettingsModal() {
  document.getElementById("settings-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("settings-modal-overlay")) closeSettingsModal();
  });
  document.getElementById("settings-close-btn")?.addEventListener("click", closeSettingsModal);
  document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSettingsTab(btn.dataset.tab));
  });
  bindUiStyleCards();
  renderThemeSwatches();
  bindRvcVoicesPanel();
  renderRvcVoices();
  bindUpdatesPanel();
  bindSetupPanel();
  bindSupportPanel();
  bindPanicHotkeyField();
}

// Populates the Panic Hotkey field with its saved value and wires the
// clear button. Recording (click-to-set) is handled in bindHotkeyListener
// alongside the per-sound hotkey recorder, since both share one
// keydown-capture flow.
function bindPanicHotkeyField() {
  const input = document.getElementById("panic-hotkey");
  if (input) input.value = appSettings.panicHotkey || "";
  const clearBtn = document.getElementById("panic-hotkey-clear-btn");
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = "1";
    clearBtn.addEventListener("click", async () => {
      if (appSettings.panicHotkey) {
        try { await window.electronAPI.unregisterHotkey("__panic__"); } catch {}
      }
      updateSetting("panicHotkey", "");
      if (input) input.value = "";
      showToast("Panic hotkey cleared");
    });
  }
}

// Renders the Appearance tab's theme picker as two collapsible groups —
// "Dark themes" and "Light themes" — each with its own header (name,
// count, chevron) and 3-column swatch grid, instead of one flat list.
function renderThemeSwatches() {
  const container = document.getElementById("theme-swatch-grid");
  if (!container) return;
  const current = document.documentElement.dataset.theme || "crimson";

  container.classList.add("theme-groups");
  container.innerHTML = "";

  const groupDefs = [
    { key: "dark", label: "Dark themes" },
    { key: "light", label: "Light themes" },
  ];

  groupDefs.forEach(({ key, label }) => {
    const themesInGroup = THEMES.filter((t) => t.mode === key);
    if (themesInGroup.length === 0) return;

    const group = document.createElement("div");
    group.className = "theme-group";

    const collapsed = collapsedThemeGroups.has(key);

    const header = document.createElement("div");
    header.className = "theme-group-header";
    header.innerHTML = `
      <span class="theme-group-chevron">${collapsed ? "▸" : "▾"}</span>
      <span class="theme-group-name">${label}</span>
      <span class="theme-group-count">${themesInGroup.length}</span>
    `;

    const swatchGrid = document.createElement("div");
    swatchGrid.className = "theme-group-swatches" + (collapsed ? " collapsed" : "");

    themesInGroup.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-swatch" + (t.id === current ? " selected" : "");
      btn.dataset.theme = t.id;
      btn.innerHTML = `
        <span class="theme-swatch-preview" style="background:${t.swatch}"></span>
        <span class="theme-swatch-name">${t.name}</span>
      `;
      btn.addEventListener("click", () => {
        applyTheme(t.id);
        updateSetting("theme", t.id);
        document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
      swatchGrid.appendChild(btn);
    });

    header.addEventListener("click", () => {
      if (collapsedThemeGroups.has(key)) collapsedThemeGroups.delete(key);
      else collapsedThemeGroups.add(key);
      try {
        localStorage.setItem("soundboard:collapsedThemeGroups", JSON.stringify([...collapsedThemeGroups]));
      } catch {}
      renderThemeSwatches();
    });

    group.appendChild(header);
    group.appendChild(swatchGrid);
    container.appendChild(group);
  });
}

// AI Voices tab — lists the .pth/.index model files stored in the app's
// rvc_voices folder as clickable cards (plus an "Off" card), so the
// person can mark which voice they're currently running in their
// separate real-time RVC app. Nothing here does any audio conversion.
let rvcVoicesCache = [];

async function renderRvcVoices() {
  const grid = document.getElementById("rvc-voice-grid");
  if (!grid) return;
  rvcVoicesCache = await window.electronAPI.listRvcVoices();
  // The TTS / Music / Live Voice pickers were only filled once at launch, so
  // a voice added later never showed up there until restart.
  populateTtsRvcVoiceOptions(rvcVoicesCache);
  populateMusicRvcVoiceOptions(rvcVoicesCache);
  populateLiveVoiceOptions(rvcVoicesCache);
  const active = appSettings.activeRvcVoice || null;

  grid.innerHTML = "";

  const offCard = document.createElement("div");
  offCard.className = "rvc-voice-card" + (active === null ? " active" : "");
  offCard.innerHTML = `
    <div class="rvc-voice-card-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        <line x1="2" y1="2" x2="22" y2="22"/>
      </svg>
    </div>
    <div class="rvc-voice-card-info">
      <div class="rvc-voice-card-name">Off</div>
      <div class="rvc-voice-card-meta">Not using an AI voice right now</div>
    </div>
  `;
  offCard.addEventListener("click", () => {
    updateSetting("activeRvcVoice", null);
    renderRvcVoices();
  });
  grid.appendChild(offCard);

  if (rvcVoicesCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rvc-empty-note";
    empty.textContent = "No voice models yet — add .pth (and optional .index) files.";
    grid.appendChild(empty);
    return;
  }

  rvcVoicesCache.forEach((v) => {
    const card = document.createElement("div");
    card.className = "rvc-voice-card" + (active === v.id ? " active" : "");
    card.innerHTML = `
      <div class="rvc-voice-card-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        </svg>
      </div>
      <div class="rvc-voice-card-info">
        <div class="rvc-voice-card-name">${escHtml(v.name)}</div>
        <div class="rvc-voice-card-meta">${v.sizeMB} MB${v.hasIndex ? " · has index" : ""}</div>
      </div>
      <button type="button" class="rvc-voice-delete-btn" title="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".rvc-voice-delete-btn")) {
        e.stopPropagation();
        window.electronAPI.deleteRvcVoice(v.id).then(() => {
          if (appSettings.activeRvcVoice === v.id) updateSetting("activeRvcVoice", null);
          renderRvcVoices();
        });
        return;
      }
      updateSetting("activeRvcVoice", v.id);
      renderRvcVoices();
    });
    grid.appendChild(card);
  });
}

function bindRvcVoicesPanel() {
  const grid = document.getElementById("rvc-voice-grid");
  const addBtn = document.getElementById("rvc-add-btn");
  const folderBtn = document.getElementById("rvc-open-folder-btn");
  const installBtn = document.getElementById("rvc-backend-install-btn");
  const alreadyBound = grid?.dataset.bound;
  if (grid) grid.dataset.bound = "1";

  if (!alreadyBound) {
    addBtn?.addEventListener("click", async () => {
      await window.electronAPI.importRvcVoiceFiles();
      renderRvcVoices();
    });
    folderBtn?.addEventListener("click", () => {
      window.electronAPI.openRvcVoicesFolder();
    });
    installBtn?.addEventListener("click", installRvcBackend);
    window.electronAPI.onRvcBackendLog((line) => {
      const logEl = document.getElementById("rvc-backend-log");
      if (!logEl) return;
      logEl.style.display = "block";
      appendLog(logEl, line);
    });
    window.electronAPI.onRvcConversionLog((line) => {
      const logEl = document.getElementById("edit-rvc-log");
      if (!logEl) return;
      logEl.style.display = "block";
      appendLog(logEl, line);
    });

    const pythonInput = document.getElementById("rvc-python-command");
    if (pythonInput) {
      pythonInput.value = appSettings.rvcPythonCommand || "";
      pythonInput.addEventListener("change", () => {
        updateSetting("rvcPythonCommand", pythonInput.value.trim());
        checkRvcBackendStatus();
      });
    }

    const qualitySelect = document.getElementById("rvc-quality");
    if (qualitySelect) {
      qualitySelect.value = ["fast", "balanced", "high"].includes(appSettings.rvcQuality) ? appSettings.rvcQuality : "balanced";
      qualitySelect.addEventListener("change", () => { updateSetting("rvcQuality", qualitySelect.value); refreshRvcTuning(); });
    }

    // Voice Match Strength and Clarity sliders. Until one is moved it follows the
    // chosen quality preset; moving it stores an override (null = use the preset).
    // The preset numbers mirror QUALITY_PRESETS in sidecar/rvc-audio.js.
    const RVC_PRESET_DEFAULTS = { fast: { index: 40, clarity: 0 }, balanced: { index: 50, clarity: 35 }, high: { index: 50, clarity: 60 } };
    const rvcIndexSlider = document.getElementById("rvc-index-rate");
    const rvcClaritySlider = document.getElementById("rvc-clarity");
    const rvcTuningReset = document.getElementById("rvc-tuning-reset");
    function refreshRvcTuning() {
      if (!rvcIndexSlider || !rvcClaritySlider) return;
      const preset = RVC_PRESET_DEFAULTS[appSettings.rvcQuality] || RVC_PRESET_DEFAULTS.balanced;
      const idxSet = typeof appSettings.rvcIndexRate === "number";
      const clSet = typeof appSettings.rvcClarity === "number";
      const idx = idxSet ? Math.round(appSettings.rvcIndexRate * 100) : preset.index;
      const cl = clSet ? Math.round(appSettings.rvcClarity * 100) : preset.clarity;
      rvcIndexSlider.value = idx;
      rvcClaritySlider.value = cl;
      setLabel("rvc-index-rate-label", idx + "%" + (idxSet ? "" : " · preset"));
      setLabel("rvc-clarity-label", cl + "%" + (clSet ? "" : " · preset"));
      if (rvcTuningReset) rvcTuningReset.style.display = idxSet || clSet ? "" : "none";
    }
    rvcIndexSlider?.addEventListener("input", () => { updateSetting("rvcIndexRate", parseInt(rvcIndexSlider.value, 10) / 100); refreshRvcTuning(); });
    rvcClaritySlider?.addEventListener("input", () => { updateSetting("rvcClarity", parseInt(rvcClaritySlider.value, 10) / 100); refreshRvcTuning(); });
    rvcTuningReset?.addEventListener("click", () => { updateSetting("rvcIndexRate", null); updateSetting("rvcClarity", null); refreshRvcTuning(); });
    refreshRvcTuning();

    const commandInput = document.getElementById("rvc-command-template");
    if (commandInput) {
      commandInput.value = appSettings.rvcCommandTemplate || RVC_DEFAULT_COMMAND_TEMPLATE;
      commandInput.addEventListener("change", () => {
        updateSetting("rvcCommandTemplate", commandInput.value.trim());
      });
    }
    document.getElementById("rvc-command-reset-btn")?.addEventListener("click", () => {
      if (commandInput) commandInput.value = RVC_DEFAULT_COMMAND_TEMPLATE;
      updateSetting("rvcCommandTemplate", RVC_DEFAULT_COMMAND_TEMPLATE);
      showToast("✅ Command template reset to default");
    });

    if (grid) {
      grid.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        grid.classList.add("drag-over");
      });
      grid.addEventListener("dragleave", () => grid.classList.remove("drag-over"));
      grid.addEventListener("drop", async (e) => {
        e.preventDefault();
        grid.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer.files || []);
        const paths = files
          .map(filePathOf)
          .filter((p) => p && [".pth", ".index"].includes("." + p.split(".").pop().toLowerCase()));
        if (paths.length === 0) {
          showToast("⚠️ Drop .pth or .index RVC model files");
          return;
        }
        await window.electronAPI.importRvcVoiceFilePaths(paths);
        renderRvcVoices();
      });
    }
  }

  checkRvcBackendStatus();
}

async function checkRvcBackendStatus() {
  const statusEl = document.getElementById("rvc-backend-status");
  if (!statusEl) return;
  statusEl.textContent = "Checking…";
  statusEl.className = "rvc-backend-status";
  const status = await window.electronAPI.checkRvcBackend();
  const { text, ready } = describeRvcStatus(status, "✓ Backend ready");
  statusEl.textContent = text;
  statusEl.className = "rvc-backend-status " + (ready ? "ready" : "missing");
  refreshGpuUi();
}

// Turns the main-process backend check into one status line, so both the
// AI Voices tab and the Setup tab explain the same problems the same way.
function describeRvcStatus(status, readyText) {
  // When the configured Python didn't work but another one on the machine
  // did, say which one is in use so the setup isn't a mystery.
  const via = status.pythonAutoDetected
    ? ` (using ${String(status.pythonCommand).includes("python_embedded") ? "bundled Python" : status.pythonCommand})`
    : "";
  if (status.ready) return { text: readyText + via, ready: true };
  if (!status.pythonFound) return { text: "Python not found", ready: false };
  if (!status.pythonCompatible) {
    return {
      text: `Python ${status.pythonVersion} found, but AI Voices needs Python 3.9–3.10` +
        (window.navigator.userAgent.includes("Windows") ? " — use One-Click Setup in the Setup tab" : ""),
      ready: false,
    };
  }
  if (!status.rvcInstalled && !status.demucsInstalled) return { text: "Python found — backend not installed" + via, ready: false };
  const missing = [!status.rvcInstalled && "rvc-python", !status.demucsInstalled && "demucs"].filter(Boolean).join(" and ");
  return { text: `Backend incomplete — ${missing} missing (click Install)` + via, ready: false };
}

/* ---- Conversion progress bar (sound edit screen, Music Converter, TTS) ---- */

// Which bar belongs to which conversion. main.js tags every progress event
// with the sound id being converted, so each screen only shows its own.
const CONV_BOX_MATCHERS = {
  edit: (id) => !!editingId && id === editingId,
  music: (id) => id.startsWith("music_"),
  tts: (id) => id.startsWith("tts_preview_"),
};

function convBox(kind) {
  return document.querySelector(`.conv-progress[data-kind="${kind}"]`);
}

function renderConvLabel(box) {
  const secs = Math.floor((Date.now() - box._startedAt) / 1000);
  // Some steps have no percentage (voice conversion itself), so show elapsed
  // time as proof it's still working.
  const elapsed = secs >= 5 ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "";
  box.querySelector(".conv-progress-label").textContent = (box._label || "") + elapsed;
}

function showConvProgress(box, p) {
  if (!box) return;
  box.style.display = "block";
  box.dataset.soundId = p.soundId || "";
  const stepText = p.totalSteps > 1 ? `Step ${p.step}/${p.totalSteps}: ` : "";
  box._label = stepText + p.label + (p.percent != null ? ` — ${p.percent}%` : "");
  const fill = box.querySelector(".conv-progress-fill");
  if (p.percent == null) {
    fill.classList.add("indeterminate");
    fill.style.width = "";
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = p.percent + "%";
  }
  const cancelBtn = box.querySelector(".conv-progress-cancel");
  if (cancelBtn) cancelBtn.style.display = p.cancellable ? "" : "none";
  if (!box._timer) {
    box._startedAt = Date.now();
    box._timer = setInterval(() => renderConvLabel(box), 1000);
  }
  renderConvLabel(box);
}

function hideConvProgress(box) {
  if (!box) return;
  box.style.display = "none";
  clearInterval(box._timer);
  box._timer = null;
  const cancelBtn = box.querySelector(".conv-progress-cancel");
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = "Cancel"; }
}

function initConversionProgress() {
  document.querySelectorAll(".conv-progress").forEach((box) => {
    box.querySelector(".conv-progress-cancel")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Cancelling…";
      await window.electronAPI.cancelRvcConversion(box.dataset.soundId);
    });
  });

  window.electronAPI.onRvcConversionProgress((p) => {
    if (!p?.soundId) return;
    for (const [kind, matches] of Object.entries(CONV_BOX_MATCHERS)) {
      if (!matches(p.soundId)) continue;
      const box = convBox(kind);
      if (p.done) hideConvProgress(box);
      else showConvProgress(box, p);
    }
  });
}

/* ---- Setup progress bar, cancel button, and the optional GPU install ---- */

const SETUP_BUTTON_IDS = ["rvc-backend-install-btn", "setup-rvc-btn", "setup-python-btn", "rvc-gpu-btn", "setup-gpu-btn"];

// Only one setup can run at a time (main.js enforces it too), so grey out
// every install button while one is in progress.
function setSetupButtonsDisabled(disabled) {
  SETUP_BUTTON_IDS.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
}

function initSetupProgress() {
  const cancelButtons = document.querySelectorAll(".setup-progress-cancel");
  cancelButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Cancelling…";
      await window.electronAPI.cancelRvcSetup();
    });
  });

  // Progress arrives from main.js for every setup step; a null update means
  // the setup finished (or was cancelled), so hide the bar again.
  window.electronAPI.onRvcSetupProgress((p) => {
    document.querySelectorAll(".setup-progress").forEach((box) => {
      if (!p) {
        box.style.display = "none";
        const cancelBtn = box.querySelector(".setup-progress-cancel");
        if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = "Cancel"; }
        return;
      }
      box.style.display = "block";
      const label = p.totalSteps > 1 ? `Step ${p.step}/${p.totalSteps}: ${p.label}` : p.label;
      box.querySelector(".setup-progress-label").textContent = label;
      const fill = box.querySelector(".setup-progress-fill");
      if (p.percent === null || p.percent === undefined) {
        fill.classList.add("indeterminate");
        fill.style.width = "";
      } else {
        fill.classList.remove("indeterminate");
        fill.style.width = p.percent + "%";
      }
    });
  });

  ["rvc-gpu-btn", "setup-gpu-btn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", installRvcGpu);
  });
}

// Shows the GPU row (in both tabs) only when an NVIDIA GPU is present.
let gpuRefreshPromise = null;
function refreshGpuUi() {
  if (gpuRefreshPromise) return gpuRefreshPromise;
  gpuRefreshPromise = (async () => {
    const rows = [["rvc-gpu-row", "rvc-gpu-status", "rvc-gpu-btn"], ["setup-gpu-row", "setup-gpu-status", "setup-gpu-btn"]]
      .map(([row, status, btn]) => ({
        row: document.getElementById(row),
        status: document.getElementById(status),
        btn: document.getElementById(btn),
      }))
      .filter((r) => r.row && r.status && r.btn);
    if (!rows.length) return;

    let gpu;
    try { gpu = await window.electronAPI.checkRvcGpu(); } catch { gpu = { supported: false }; }
    for (const r of rows) {
      if (!gpu.supported || !gpu.nvidia) { r.row.style.display = "none"; continue; }
      r.row.style.display = "flex";
      if (gpu.torchCuda === true) {
        r.status.textContent = `✓ GPU acceleration on — ${gpu.gpuName}`;
        r.status.className = "rvc-backend-status ready";
        r.btn.style.display = "none";
      } else if (gpu.torchCuda === false) {
        r.status.textContent = `${gpu.gpuName} found — not being used yet (CPU mode)`;
        r.status.className = "rvc-backend-status";
        r.btn.style.display = "inline-block";
      } else {
        r.status.textContent = `${gpu.gpuName} found — set up the backend first, then enable GPU`;
        r.status.className = "rvc-backend-status";
        r.btn.style.display = "none";
      }
    }
  })().finally(() => { gpuRefreshPromise = null; });
  return gpuRefreshPromise;
}

async function installRvcGpu() {
  const ok = window.confirm(
    "Enable GPU acceleration?\n\n" +
    "This downloads the CUDA version of PyTorch (about 2.5 GB) and can take several minutes. " +
    "It needs an NVIDIA GPU with up-to-date drivers."
  );
  if (!ok) return;
  ["rvc-backend-log", "setup-rvc-log"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ""; el.style.display = "block"; }
  });
  setSetupButtonsDisabled(true);
  const result = await window.electronAPI.installRvcGpu();
  setSetupButtonsDisabled(false);
  if (result.cancelled) {
    showToast("Setup cancelled");
  } else if (result.success) {
    showToast("✅ GPU acceleration installed");
  } else {
    console.error("GPU install failed:", result.error);
    showToast("⚠️ GPU install failed: " + (result.error || "unknown error"));
  }
  refreshGpuUi();
}

async function installRvcBackend() {
  const installBtn = document.getElementById("rvc-backend-install-btn");
  const statusEl = document.getElementById("rvc-backend-status");
  const logEl = document.getElementById("rvc-backend-log");
  if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
  if (installBtn) { installBtn.disabled = true; installBtn.textContent = "Installing…"; }
  if (statusEl) { statusEl.textContent = "Installing…"; statusEl.className = "rvc-backend-status"; }

  setSetupButtonsDisabled(true);
  const result = await window.electronAPI.installRvcBackend();
  setSetupButtonsDisabled(false);
  if (installBtn) { installBtn.disabled = false; installBtn.textContent = "Install / Update Backend"; }

  if (result.cancelled) {
    showToast("Setup cancelled");
  } else if (result.success) {
    showToast("✅ AI Voice backend installed");
  } else {
    console.error("AI Voice backend install failed:", result.error);
    if (statusEl) { statusEl.className = "rvc-backend-status missing"; statusEl.textContent = "⚠️ " + (result.error || "Install failed"); }
    showToast("⚠️ Backend install failed: " + (result.error || "unknown error"));
  }
  checkRvcBackendStatus();
}

function switchSettingsTab(tab) {
  document.querySelectorAll(".settings-tab-btn").forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  document.querySelectorAll(".settings-tab-panel").forEach((p) => {
    p.style.display = p.dataset.tab === tab ? "flex" : "none";
  });
}
function closeSettingsModal() {
  document.getElementById("settings-modal-overlay")?.classList.remove("visible");
}

/* =========================================================================
   UPDATES TAB (Settings > Updates) — manual "Check for Updates" / "Update
   Now" controls, plus live status pushed from the main process any time
   an automatic background check happens too.
   ========================================================================= */
function bindUpdatesPanel() {
  const checkBtn = document.getElementById("updates-check-btn");
  const installBtn = document.getElementById("updates-install-btn");
  const versionEl = document.getElementById("updates-current-version");
  const alreadyBound = checkBtn?.dataset.bound;
  if (checkBtn) checkBtn.dataset.bound = "1";

  if (versionEl) {
    window.electronAPI.getAppVersion().then((v) => {
      versionEl.textContent = "v" + v;
    });
  }

  if (!alreadyBound) {
    checkBtn?.addEventListener("click", async () => {
      checkBtn.disabled = true;
      setUpdatesStatus("Checking…", "");
      const result = await window.electronAPI.checkForUpdates();
      checkBtn.disabled = false;
      if (!result.success) {
        setUpdatesStatus("⚠️ Couldn't check for updates", "missing");
        showToast("⚠️ Update check failed: " + (result.error || "unknown error"));
      }
      // Success case doesn't set status here — the "checking"/"available"/
      // "not-available" events from onUpdateStatus below handle that, since
      // checkForUpdates() and the app's own launch-time check both flow
      // through the same events.
    });

    installBtn?.addEventListener("click", () => {
      window.electronAPI.installUpdateNow();
    });

    window.electronAPI.onUpdateStatus((data) => {
      const installRow = document.getElementById("updates-install-row");
      switch (data.status) {
        case "checking":
          setUpdatesStatus("Checking…", "");
          break;
        case "available":
          setUpdatesStatus(`⬇ Downloading v${data.version}…`, "");
          break;
        case "not-available":
          setUpdatesStatus("✓ You're up to date", "ready");
          break;
        case "downloading":
          setUpdatesStatus(`⬇ Downloading… ${data.percent ?? 0}%`, "");
          break;
        case "downloaded":
          setUpdatesStatus(`✓ v${data.version} ready to install`, "ready");
          if (installRow) installRow.style.display = "flex";
          showToast(`✅ Update v${data.version} downloaded — click "Update Now" to install`);
          break;
        case "error":
          setUpdatesStatus("⚠️ Update check failed", "missing");
          break;
      }
    });
  }
}

function setUpdatesStatus(text, cls) {
  const statusEl = document.getElementById("updates-status");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = "rvc-backend-status" + (cls ? " " + cls : "");
}

/* =========================================================================
   NAV SIDEBAR — switches between the Soundboard view and the
   Text-To-Speech view. Both views stay mounted in the DOM; switching
   just toggles which one is visible, so nothing needs re-rendering.
   ========================================================================= */
function bindNavSidebar() {
  document.querySelectorAll(".nav-item:not(#nav-settings-btn)").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item:not(#nav-settings-btn)").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      document.querySelectorAll(".view-panel").forEach((panel) => {
        panel.style.display = panel.id === `view-${view}` ? "flex" : "none";
      });
      if (view === "tts") ensureTtsVoicesLoaded();
    });
  });
  document.getElementById("nav-settings-btn")?.addEventListener("click", () => {
    document.getElementById("settings-modal-overlay")?.classList.add("visible");
  });

  const sidebar = document.getElementById("nav-sidebar");
  const collapseBtn = document.getElementById("nav-collapse-btn");
  if (appSettings.sidebarCollapsed) sidebar?.classList.add("collapsed");
  collapseBtn?.addEventListener("click", () => {
    const collapsed = sidebar.classList.toggle("collapsed");
    updateSetting("sidebarCollapsed", collapsed);
    collapseBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  });
  if (collapseBtn) collapseBtn.title = appSettings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
}

/* =========================================================================
   TEXT-TO-SPEECH PAGE — Flowery TTS for the base voice, with an optional
   pass through an installed RVC voice. Reuses the exact same playback
   and RVC-conversion pipeline as the sound grid: a generated (or saved)
   clip is just a sound-shaped object with .file/.rvcVoice/.rvcPitch,
   so getBuffer()/playSound() already know how to handle it.
   ========================================================================= */
let ttsVoicesLoaded = false;
let ttsAllVoices = [];

function bindTtsPage() {
  const textEl = document.getElementById("tts-text");
  const charCountEl = document.getElementById("tts-char-count");
  const voiceSearchEl = document.getElementById("tts-voice-search");
  const speedEl = document.getElementById("tts-speed");
  const speedLabelEl = document.getElementById("tts-speed-label");
  const volumeEl = document.getElementById("tts-volume");
  const volumeLabelEl = document.getElementById("tts-volume-label");
  const rvcPitchEl = document.getElementById("tts-rvc-pitch");
  const rvcPitchLabelEl = document.getElementById("tts-rvc-pitch-label");

  textEl?.addEventListener("input", () => {
    if (charCountEl) charCountEl.textContent = `${textEl.value.length} / 2000`;
  });

  voiceSearchEl?.addEventListener("input", () => filterTtsVoiceOptions(voiceSearchEl.value));

  speedEl?.addEventListener("input", () => {
    if (speedLabelEl) speedLabelEl.textContent = parseFloat(speedEl.value).toFixed(1) + "x";
  });

  volumeEl?.addEventListener("input", () => {
    if (volumeLabelEl) volumeLabelEl.textContent = volumeEl.value + "%";
  });

  rvcPitchEl?.addEventListener("input", () => {
    if (rvcPitchLabelEl) rvcPitchLabelEl.textContent = rvcPitchEl.value;
  });

  document.getElementById("tts-generate-play-btn")?.addEventListener("click", () => runTts("play"));
  document.getElementById("tts-generate-save-btn")?.addEventListener("click", () => runTts("save"));

  populateTtsRvcVoiceOptions();
}

// AI Voices tab already loads the RVC voice list into memory elsewhere
// (renderRvcVoices) — reuse that same in-memory list rather than a
// second IPC round trip.
async function populateTtsRvcVoiceOptions(known) {
  const select = document.getElementById("tts-rvc-voice-select");
  if (!select) return;
  try {
    const voices = known || await window.electronAPI.listRvcVoices();
    const previous = select.value;
    select.innerHTML = `<option value="">None (use Flowery voice as-is)</option>` +
      voices.map((v) => `<option value="${escHtml(v.id)}">${escHtml(v.name)}</option>`).join("");
    if (voices.some((v) => v.id === previous)) select.value = previous;
  } catch {}
}

let ttsVoicesLoading = null;
function ensureTtsVoicesLoaded() {
  if (ttsVoicesLoaded) return Promise.resolve();
  // Flipping between tabs while loading used to fire a request per click.
  if (!ttsVoicesLoading) ttsVoicesLoading = loadTtsVoices().finally(() => { ttsVoicesLoading = null; });
  return ttsVoicesLoading;
}

async function loadTtsVoices() {
  const select = document.getElementById("tts-voice-select");
  if (select) select.innerHTML = `<option value="">Loading voices…</option>`;
  const result = await window.electronAPI.listTtsVoices().catch((e) => ({ success: false, error: e?.message }));
  if (!result.success) {
    if (select) select.innerHTML = `<option value="">Couldn't load voices</option>`;
    showToast("⚠️ Couldn't reach Flowery TTS: " + (result.error || "unknown error"));
    return;
  }
  ttsAllVoices = result.voices || [];
  ttsVoicesLoaded = true;
  renderTtsVoiceOptions(ttsAllVoices);
}

function renderTtsVoiceOptions(voices) {
  const select = document.getElementById("tts-voice-select");
  if (!select) return;
  select.innerHTML = voices
    .map((v) => {
      const meta = [v.language, v.gender].filter(Boolean).join(" · ");
      return `<option value="${escHtml(v.id)}">${escHtml(v.name)}${meta ? ` (${escHtml(meta)})` : ""}</option>`;
    })
    .join("");
}

function filterTtsVoiceOptions(query) {
  const q = query.trim().toLowerCase();
  if (!q) { renderTtsVoiceOptions(ttsAllVoices); return; }
  renderTtsVoiceOptions(
    ttsAllVoices.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      v.language.toLowerCase().includes(q) ||
      v.gender.toLowerCase().includes(q)
    )
  );
}

async function runTts(mode) {
  const text = document.getElementById("tts-text")?.value.trim();
  const voice = document.getElementById("tts-voice-select")?.value;
  const translate = document.getElementById("tts-translate-toggle")?.classList.contains("active");
  const speed = parseFloat(document.getElementById("tts-speed")?.value || "1");
  const ttsVolume = parseInt(document.getElementById("tts-volume")?.value || "100", 10);
  const rvcVoice = document.getElementById("tts-rvc-voice-select")?.value || null;
  const rvcPitch = parseInt(document.getElementById("tts-rvc-pitch")?.value || "0", 10);

  if (!text) { showToast("⚠️ Type something to speak first"); return; }
  if (!voice) { showToast("⚠️ Pick a voice first"); return; }

  const statusEl = document.getElementById("tts-status");
  const playBtn = document.getElementById("tts-generate-play-btn");
  const saveBtn = document.getElementById("tts-generate-save-btn");
  const ttsBox = convBox("tts");
  if (statusEl) statusEl.style.display = "none"; // the progress bar replaces the "Generating…" pill
  showConvProgress(ttsBox, { label: "Generating speech…", percent: null, cancellable: false });
  if (playBtn) playBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;

  try {
    const result = await window.electronAPI.generateTts({ text, voice, translate, speed });
    if (!result.success) throw new Error(result.error || "TTS generation failed");
    // With an AI voice picked, the RVC conversion runs next and takes over
    // the bar; without one there's nothing left to wait for.
    if (mode === "play" && rvcVoice) {
      showConvProgress(ttsBox, { label: "Preparing voice conversion…", percent: null, cancellable: false });
    } else {
      hideConvProgress(ttsBox);
    }

    if (mode === "play") {
      if (statusEl) statusEl.style.display = "none";
      await playTtsClip(result.filePath, rvcVoice, rvcPitch, ttsVolume);
    } else {
      if (statusEl) statusEl.style.display = "none";
      await saveTtsClipAsSound(result.filePath, text, voice, rvcVoice, rvcPitch, ttsVolume);
    }
  } catch (e) {
    if (statusEl) { statusEl.style.display = "block"; statusEl.className = "rvc-backend-status missing"; statusEl.textContent = "⚠️ " + (e.message || "Something went wrong"); }
    showToast("⚠️ TTS failed: " + (e.message || "unknown error"));
  } finally {
    hideConvProgress(ttsBox);
    if (playBtn) playBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Plays a generated clip through the exact same engine as a sound-grid
// card (master volume, virtual mic routing, RVC conversion if an AI
// voice was picked) without adding it to the visible library.
async function playTtsClip(filePath, rvcVoice, rvcPitch, volume = 100) {
  const tempId = "tts_preview_" + Date.now();
  const tempSound = {
    id: tempId, name: "TTS Preview", file: filePath, volume, sendToMic: true,
    fadeIn: 0, fadeOut: 0, startOffset: 0, voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    rvcVoice: rvcVoice || null, rvcPitch: rvcPitch || 0, rvcSeparateVocals: false,
  };
  // Played as a temp sound: it never enters the saved `sounds` list, so no
  // save/re-render during a long RVC conversion can leak it into the library.
  await playSound(tempId, { sound: tempSound });
}

async function saveTtsClipAsSound(filePath, text, flowVoice, rvcVoice, rvcPitch, volume = 100) {
  const name = text.length > 40 ? text.slice(0, 40).trim() + "…" : text;
  const color = COLORS[sounds.length % COLORS.length];
  const sound = {
    id: "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    name, file: filePath, emoji: "🗣️", color, hotkey: "",
    volume, category: "TTS", fadeIn: 0, fadeOut: 0, startOffset: 0,
    voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    favorite: false, sendToMic: true,
    rvcVoice: rvcVoice || null, rvcPitch: rvcPitch || 0, rvcSeparateVocals: false,
  };
  sounds.push(sound);
  await saveSoundsNow();
  renderGrid(currentSearchValue());
  renderCategoryFilter();
  showToast("✅ Saved to Soundboard: " + name);
}

/* =========================================================================
   MUSIC CONVERTER PAGE — full-song RVC conversion with vocal separation
   on by default. Source is either a downloaded YouTube song or a local
   file; conversion reuses the exact same convert-rvc-file pipeline (and
   its live log stream) as the AI Voices tab.
   ========================================================================= */
let musicInputFile = null; // { path, name }
let musicResultFile = null; // path to the final converted file

function bindMusicPage() {
  document.querySelectorAll(".music-source-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".music-source-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const src = btn.dataset.source;
      document.getElementById("music-source-youtube").style.display = src === "youtube" ? "block" : "none";
      document.getElementById("music-source-file").style.display = src === "file" ? "block" : "none";
    });
  });

  document.getElementById("music-yt-fetch-btn")?.addEventListener("click", fetchMusicYoutubeInfo);
  document.getElementById("music-yt-use-btn")?.addEventListener("click", downloadMusicYoutube);
  document.getElementById("music-file-choose-btn")?.addEventListener("click", chooseMusicFile);

  document.getElementById("music-rvc-pitch")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById("music-rvc-pitch-label").textContent =
      v === 0 ? "0 (Male ↔ Female)" : v > 0 ? `+${v} (toward Male)` : `${v} (toward Female)`;
  });

  document.getElementById("music-convert-btn")?.addEventListener("click", runMusicConversion);
  document.getElementById("music-play-btn")?.addEventListener("click", playMusicResult);
  document.getElementById("music-play-mic-btn")?.addEventListener("click", playMusicResultThroughMic);
  document.getElementById("music-save-btn")?.addEventListener("click", saveMusicResultAsSound);
  document.getElementById("music-export-btn")?.addEventListener("click", exportMusicResult);

  window.electronAPI.onRvcConversionLog((line) => {
    const logEl = document.getElementById("music-convert-log");
    if (!logEl || logEl.style.display === "none") return;
    appendLog(logEl, line);
  });

  populateMusicRvcVoiceOptions();
}

async function populateMusicRvcVoiceOptions(known) {
  const select = document.getElementById("music-rvc-voice-select");
  if (!select) return;
  try {
    const voices = known || await window.electronAPI.listRvcVoices();
    const previous = select.value;
    select.innerHTML = voices.length
      ? voices.map((v) => `<option value="${escHtml(v.id)}">${escHtml(v.name)}</option>`).join("")
      : `<option value="">No AI voices installed — add one in AI Voices</option>`;
    if (voices.some((v) => v.id === previous)) select.value = previous;
  } catch {
    select.innerHTML = `<option value="">Couldn't load voices</option>`;
  }
}

async function fetchMusicYoutubeInfo() {
  const url = document.getElementById("music-yt-url")?.value.trim();
  if (!url) return;
  const previewEl = document.getElementById("music-yt-preview");
  const infoEl = document.getElementById("music-yt-info");
  const fetchBtn = document.getElementById("music-yt-fetch-btn");
  fetchBtn.disabled = true;
  fetchBtn.textContent = "Fetching…";
  const result = await window.electronAPI.getYoutubeInfo(url);
  fetchBtn.disabled = false;
  fetchBtn.textContent = "Fetch";
  if (!result.success) { showToast("⚠️ " + result.error); return; }
  const mins = Math.floor(result.durationSeconds / 60);
  const secs = String(result.durationSeconds % 60).padStart(2, "0");
  // Title/author come from YouTube — untrusted text, never raw HTML.
  infoEl.innerHTML = `<strong>${escHtml(result.title)}</strong><br>${escHtml(result.author)} · ${mins}:${secs}`;
  previewEl.style.display = "block";
  previewEl.dataset.url = url;
  previewEl.dataset.title = result.title;
}

async function downloadMusicYoutube() {
  const previewEl = document.getElementById("music-yt-preview");
  const url = previewEl?.dataset.url;
  const title = previewEl?.dataset.title || "Imported song";
  if (!url) return;
  const useBtn = document.getElementById("music-yt-use-btn");
  useBtn.disabled = true;
  useBtn.textContent = "Downloading…";
  const result = await window.electronAPI.musicImportYoutube({ url, name: title });
  useBtn.disabled = false;
  useBtn.textContent = "Download & Use This Song";
  if (!result.success) { showToast("⚠️ " + result.error); return; }
  musicInputFile = { path: result.filePath, name: result.name };
  setMusicSourceStatus(`✓ Ready: ${result.name}`);
}

async function chooseMusicFile() {
  const files = await window.electronAPI.openFileDialog();
  if (!files || !files.length) return;
  const filePath = files[0];
  musicInputFile = { path: filePath, name: filePath.split(/[\\/]/).pop() };
  setMusicSourceStatus(`✓ Ready: ${musicInputFile.name}`);
}

function setMusicSourceStatus(text) {
  const el = document.getElementById("music-source-status");
  el.style.display = "block";
  el.textContent = text;
}

async function runMusicConversion() {
  if (!musicInputFile) { showToast("⚠️ Choose a source first"); return; }
  const voiceId = document.getElementById("music-rvc-voice-select")?.value;
  if (!voiceId) { showToast("⚠️ Pick an AI voice first"); return; }
  const pitch = parseInt(document.getElementById("music-rvc-pitch")?.value || "0", 10);
  const separateVocals = true; // always on for music — see note in the UI

  const statusEl = document.getElementById("music-convert-status");
  const logEl = document.getElementById("music-convert-log");
  const convertBtn = document.getElementById("music-convert-btn");
  const resultRow = document.getElementById("music-result-row");
  resultRow.style.display = "none";
  document.getElementById("music-save-btn").style.display = "inline-block";
  musicResultFile = null;
  logEl.textContent = "";
  logEl.style.display = "block";
  statusEl.style.display = "block";
  statusEl.className = "rvc-backend-status";
  statusEl.textContent = "Converting… this can take a few minutes for a full song.";
  convertBtn.disabled = true;

  try {
    // Stable per source file, so re-converting the same song reuses the cached
    // vocal separation instead of redoing the slow demucs pass every time.
    let hash = 5381;
    for (let i = 0; i < musicInputFile.path.length; i++) hash = ((hash << 5) + hash + musicInputFile.path.charCodeAt(i)) >>> 0;
    const soundId = "music_" + hash.toString(36);
    const result = await window.electronAPI.convertRvcFile(musicInputFile.path, soundId, voiceId, pitch, separateVocals);
    if (result.cancelled) {
      statusEl.className = "rvc-backend-status";
      statusEl.textContent = "Conversion cancelled";
      return;
    }
    if (!result.success) throw new Error(result.error || "Conversion failed");
    musicResultFile = result.outputPath;
    // Conversion just produces the file — it does NOT get added to the
    // Soundboard or exported automatically. That's an explicit choice via
    // the Save/Export buttons below, so a quick preview-and-discard doesn't
    // clutter the grid.
    statusEl.className = "rvc-backend-status ready";
    statusEl.textContent = "✓ Done — play it back, then Save or Export if you want to keep it.";
    resultRow.style.display = "flex";
  } catch (e) {
    console.error("Music conversion failed:", e);
    statusEl.className = "rvc-backend-status missing";
    statusEl.textContent = "⚠️ " + (e.message || "Conversion failed");
    showToast("⚠️ Conversion failed: " + (e.message || "unknown error"));
  } finally {
    convertBtn.disabled = false;
    hideConvProgress(convBox("music"));
  }
}

// Local-only preview — does NOT get routed to the virtual mic, so previewing
// a conversion never lets Discord (or anything listening to the mic) hear it.
async function playMusicResult() {
  if (!musicResultFile) return;
  const tempId = "music_preview_" + Date.now();
  const tempSound = {
    id: tempId, name: "Music Preview", file: musicResultFile, volume: 100, sendToMic: false,
    fadeIn: 0, fadeOut: 0, startOffset: 0, voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
  await playSound(tempId, { sound: tempSound });
}

// Explicit opt-in: routes the converted song to the virtual mic, same as a
// normal soundboard sound with "Send to mic" on.
async function playMusicResultThroughMic() {
  if (!musicResultFile) return;
  const tempId = "music_preview_mic_" + Date.now();
  const tempSound = {
    id: tempId, name: "Music Preview", file: musicResultFile, volume: 100, sendToMic: true,
    fadeIn: 0, fadeOut: 0, startOffset: 0, voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
  await playSound(tempId, { sound: tempSound });
}

async function saveMusicResultAsSound() {
  if (!musicResultFile) return;
  const name = musicInputFile?.name?.replace(/\.[^.]+$/, "") || "Converted song";
  const color = COLORS[sounds.length % COLORS.length];
  const sound = {
    id: "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    name, file: musicResultFile, emoji: "🎵", color, hotkey: "",
    volume: 100, category: "Music", fadeIn: 0, fadeOut: 0, startOffset: 0,
    voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    favorite: false, sendToMic: true,
    rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
  sounds.push(sound);
  await saveSoundsNow();
  renderGrid(currentSearchValue());
  renderCategoryFilter();
  showToast("✅ Saved to Soundboard: " + name);
}

async function exportMusicResult() {
  if (!musicResultFile) return;
  const suggestedName = (musicInputFile?.name?.replace(/\.[^.]+$/, "") || "converted") + ".wav";
  const result = await window.electronAPI.exportFile(musicResultFile, suggestedName);
  if (result.success) showToast("✅ Saved to " + result.savedTo);
  else if (!result.canceled) showToast("⚠️ Export failed: " + (result.error || "unknown error"));
}

/* =========================================================================
   LIVE VOICE CHANGER PAGE — mic audio is captured in ~1.2s chunks and
   converted through a persistent rvc-python API server process (model
   loaded once, not per-chunk). While active, the raw mic is disconnected
   from the shared virtual-mic bus so Discord only hears the converted
   voice, not both layered together.
   ========================================================================= */
let livePitchApplyTimer = null;
function bindLiveVoicePage() {
  document.getElementById("live-start-btn")?.addEventListener("click", () => {
    return getVal("live-mode", "fx") === "fx" ? startLiveFx() : startLiveVoiceChanger();
  });
  document.getElementById("live-stop-btn")?.addEventListener("click", () => {
    return liveFxActive ? stopLiveFx() : stopLiveVoiceChanger();
  });
  bindLiveFxControls();

  document.getElementById("live-rvc-pitch")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById("live-rvc-pitch-label").textContent =
      v === 0 ? "0 (Male ↔ Female)" : v > 0 ? `+${v} (toward Male)` : `${v} (toward Female)`;
    if (!liveVoiceActive) return;
    clearTimeout(livePitchApplyTimer);
    livePitchApplyTimer = setTimeout(() => window.electronAPI.setLiveVoiceParams({ pitch: v }), 150);
  });

  document.getElementById("live-self-monitor-toggle")?.addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
    if (liveVoiceOutGain) {
      try { liveVoiceOutGain.disconnect(audioCtx.destination); } catch {}
      if (e.currentTarget.classList.contains("active")) liveVoiceOutGain.connect(audioCtx.destination);
    }
  });

  window.electronAPI.onRvcConversionLog((line) => {
    const logEl = document.getElementById("live-log");
    if (!logEl || logEl.style.display === "none") return;
    appendLog(logEl, line);
  });

  populateLiveVoiceOptions();
}

async function populateLiveVoiceOptions(known) {
  const select = document.getElementById("live-rvc-voice-select");
  if (!select) return;
  try {
    const voices = known || await window.electronAPI.listRvcVoices();
    const previous = select.value;
    select.innerHTML = voices.length
      ? voices.map((v) => `<option value="${escHtml(v.id)}">${escHtml(v.name)}</option>`).join("")
      : `<option value="">No AI voices installed — add one in AI Voices</option>`;
    if (voices.some((v) => v.id === previous)) select.value = previous;
  } catch {
    select.innerHTML = `<option value="">Couldn't load voices</option>`;
  }
}

async function startLiveVoiceChanger() {
  if (liveVoiceActive) return;
  const voiceId = document.getElementById("live-rvc-voice-select")?.value;
  if (!voiceId) { showToast("⚠️ Pick an AI voice first"); return; }
  if (!liveMicSource || !micMuteGain) {
    showToast("⚠️ No live microphone connected — pick one in Audio settings first");
    return;
  }
  const pitch = parseInt(document.getElementById("live-rvc-pitch")?.value || "0", 10);

  const startBtn = document.getElementById("live-start-btn");
  const stopBtn = document.getElementById("live-stop-btn");
  const statusEl = document.getElementById("live-status");
  const logEl = document.getElementById("live-log");
  startBtn.disabled = true;
  statusEl.textContent = "Loading model… (can take up to a minute)";
  statusEl.className = "rvc-backend-status";
  logEl.textContent = "";
  logEl.style.display = "block";

  const result = await window.electronAPI.startLiveVoice({ voiceId, pitch });
  startBtn.disabled = false;
  if (!result.success) {
    statusEl.textContent = "⚠️ " + (result.error || "Failed to start");
    statusEl.className = "rvc-backend-status missing";
    showToast("⚠️ Live voice failed to start: " + (result.error || "unknown error"));
    return;
  }

  try {
    if (audioCtx.state === "suspended") await audioCtx.resume();
    await ensureLiveVoiceWorklet();
  } catch (e) {
    await window.electronAPI.stopLiveVoice();
    statusEl.textContent = "⚠️ Couldn't start the capture engine";
    statusEl.className = "rvc-backend-status missing";
    showToast("⚠️ Couldn't start live voice: " + (e?.message || "audio engine error"));
    return;
  }

  liveVoiceOutGain = audioCtx.createGain();
  liveVoiceOutGain.gain.value = 1;
  liveVoiceOutGain.connect(virtualMicDest);
  if (document.getElementById("live-self-monitor-toggle")?.classList.contains("active")) {
    liveVoiceOutGain.connect(audioCtx.destination);
  }
  liveVoiceNextPlayTime = 0;
  liveVoiceChunkQueue = [];

  liveVoiceBaseChunkMs = Math.min(LIVE_VOICE_MAX_CHUNK_MS, Math.max(400, parseInt(document.getElementById("live-chunk-size")?.value || "900", 10) || 900));
  liveVoiceChunkMs = liveVoiceBaseChunkMs;
  liveVoiceFastStreak = 0;
  liveVoiceSeq = 0;
  liveVoiceLastPlayedSeq = -1;
  liveVoiceDelayAvg = 0;
  liveVoiceActive = true;
  await startLiveVoiceCapture();

  startBtn.style.display = "none";
  stopBtn.style.display = "inline-block";
  statusEl.textContent = "🟢 Live";
  statusEl.className = "rvc-backend-status ready";
}

// Mic audio is captured as raw PCM and cut into fixed-size chunks. Unlike the
// old per-chunk MediaRecorder restart, capture is continuous, so no audio is
// lost between chunks, and each chunk is encoded straight to WAV in the
// renderer, so the main process needs no webm decode step.
let liveVoiceChunkMs = 900;

const LIVE_VOICE_OVERLAP_MS = 160;
const LIVE_VOICE_SEND_RATE = 16000;
const LIVE_VOICE_SILENCE_RMS = 0.004;
const LIVE_VOICE_MAX_CHUNK_MS = 2000;
let liveVoiceBaseChunkMs = 900;
let liveVoiceFastStreak = 0;
let liveVoiceSeq = 0;
let liveVoiceLastPlayedSeq = -1;
let liveVoiceWorkletReady = false;

async function ensureLiveVoiceWorklet() {
  if (liveVoiceWorkletReady) return;
  await audioCtx.audioWorklet.addModule("live-capture-worklet.js");
  liveVoiceWorkletReady = true;
}

function resampleMono(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = i * ratio;
    const b = a + ratio;
    const ia = Math.floor(a);
    const ib = Math.min(samples.length, Math.ceil(b));
    let sum = 0;
    let weight = 0;
    for (let k = ia; k < ib; k++) {
      const w = Math.min(k + 1, b) - Math.max(k, a);
      sum += samples[k] * w;
      weight += w;
    }
    out[i] = weight ? sum / weight : 0;
  }
  return out;
}

function windowRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

async function startLiveVoiceCapture() {
  const sampleRate = audioCtx.sampleRate;
  const acc = new Float32Array(Math.ceil(sampleRate * (LIVE_VOICE_MAX_CHUNK_MS / 1000) * 2));
  let filled = 0;

  liveVoiceProcessor = new AudioWorkletNode(audioCtx, "live-capture", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
  });
  liveVoiceSilentGain = audioCtx.createGain();
  liveVoiceSilentGain.gain.value = 0;

  liveVoiceProcessor.port.onmessage = (e) => {
    if (!liveVoiceActive) return;
    const block = e.data;
    if (filled + block.length > acc.length) filled = 0;
    acc.set(block, filled);
    filled += block.length;

    const windowSamples = Math.round((sampleRate * liveVoiceChunkMs) / 1000);
    if (filled < windowSamples) return;
    const hopSamples = Math.max(1, windowSamples - Math.round((sampleRate * LIVE_VOICE_OVERLAP_MS) / 1000));

    const windowData = acc.slice(0, windowSamples);
    acc.copyWithin(0, hopSamples, filled);
    filled -= hopSamples;

    const seq = liveVoiceSeq++;
    if (windowRms(windowData) < LIVE_VOICE_SILENCE_RMS) return;

    const down = resampleMono(windowData, sampleRate, LIVE_VOICE_SEND_RATE);
    enqueueLiveVoiceChunk({
      seq,
      wavBase64: encodeWavBase64(down, LIVE_VOICE_SEND_RATE),
      capturedAt: performance.now(),
      durationMs: (windowData.length / sampleRate) * 1000,
      hopMs: (hopSamples / sampleRate) * 1000,
    });
  };

  routeMicInput();
  liveVoiceProcessor.connect(liveVoiceSilentGain);
  liveVoiceSilentGain.connect(audioCtx.destination);
}

// Float32 samples → base64 of a 16-bit mono PCM WAV file.
function encodeWavBase64(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function stopLiveVoiceChanger() {
  if (!liveVoiceActive) return;
  liveVoiceActive = false;

  if (liveVoiceProcessor) {
    liveVoiceProcessor.port.onmessage = null;
    try { micMuteGain?.disconnect(liveVoiceProcessor); } catch {}
    try { liveVoiceProcessor.disconnect(); } catch {}
  }
  liveVoiceProcessor = null;
  try { liveVoiceSilentGain?.disconnect(); } catch {}
  liveVoiceSilentGain = null;
  liveVoiceChunkQueue = [];

  try { liveVoiceOutGain?.disconnect(); } catch {}
  liveVoiceOutGain = null;

  routeMicInput();

  await window.electronAPI.stopLiveVoice();

  document.getElementById("live-start-btn").style.display = "inline-block";
  document.getElementById("live-stop-btn").style.display = "none";
  const statusEl = document.getElementById("live-status");
  statusEl.textContent = "Idle";
  statusEl.className = "rvc-backend-status";
}

// One conversion in flight at a time — the local inference server
// processes requests one at a time anyway, and this keeps a slow
// hardware run from piling up an ever-growing backlog of queued audio
// (falling further and further behind live). If more than 2 chunks
// back up, older ones are dropped rather than played late.
async function enqueueLiveVoiceChunk(chunk) {
  liveVoiceChunkQueue.push(chunk);
  if (liveVoiceProcessing) return;
  liveVoiceProcessing = true;
  try {
    while (liveVoiceChunkQueue.length) {
      while (liveVoiceChunkQueue.length > 1) liveVoiceChunkQueue.shift();
      const next = liveVoiceChunkQueue.shift();
      await processLiveVoiceChunk(next);
    }
  } finally {
    liveVoiceProcessing = false;
  }
}

function applyChunkFades(audioBuffer, fadeInSec, fadeOutSec) {
  const sr = audioBuffer.sampleRate;
  const total = audioBuffer.length;
  const inN = Math.min(total, Math.round(fadeInSec * sr));
  const outN = Math.min(total, Math.round(fadeOutSec * sr));
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < inN; i++) d[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / inN);
    for (let i = 0; i < outN; i++) d[total - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / outN);
  }
}

function adaptLiveVoiceChunkSize(convertMs, hopMs) {
  if (convertMs > hopMs * 0.85) {
    liveVoiceChunkMs = Math.min(LIVE_VOICE_MAX_CHUNK_MS, liveVoiceChunkMs + 150);
    liveVoiceFastStreak = 0;
  } else if (convertMs < hopMs * 0.45 && liveVoiceChunkMs > liveVoiceBaseChunkMs) {
    liveVoiceFastStreak++;
    if (liveVoiceFastStreak >= 12) {
      liveVoiceChunkMs = Math.max(liveVoiceBaseChunkMs, liveVoiceChunkMs - 100);
      liveVoiceFastStreak = 0;
    }
  } else {
    liveVoiceFastStreak = 0;
  }
}

async function processLiveVoiceChunk(chunk) {
  if (!liveVoiceActive || !liveVoiceOutGain) return;
  try {
    const startedAt = performance.now();
    const result = await window.electronAPI.convertLiveVoiceChunk({ audioBase64: chunk.wavBase64, format: "wav" });
    const convertMs = performance.now() - startedAt;
    if (!liveVoiceActive || !liveVoiceOutGain) return;
    if (!result.success) { console.warn("[LiveVoice] chunk failed:", result.error); return; }

    const arrBuf = base64ToArrayBuffer(result.audioBase64);
    const audioBuffer = await audioCtx.decodeAudioData(arrBuf);
    if (!liveVoiceActive || !liveVoiceOutGain) return;

    const overlapSec = LIVE_VOICE_OVERLAP_MS / 1000;
    const now = audioCtx.currentTime;
    const contiguous = chunk.seq === liveVoiceLastPlayedSeq + 1;
    let startAt = liveVoiceNextPlayTime;
    const late = startAt < now + 0.03;
    if (late) startAt = now + 0.05;
    const fadeIn = contiguous && !late ? overlapSec : 0.006;
    applyChunkFades(audioBuffer, fadeIn, overlapSec);

    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(liveVoiceOutGain);
    src.start(startAt);
    liveVoiceNextPlayTime = startAt + Math.max(0.05, audioBuffer.duration - overlapSec);
    liveVoiceLastPlayedSeq = chunk.seq;

    const delayMs = chunk.durationMs + (performance.now() - chunk.capturedAt) + Math.max(0, (startAt - now) * 1000);
    adaptLiveVoiceChunkSize(convertMs, chunk.hopMs);
    updateLiveVoiceStatus(delayMs, convertMs, chunk.hopMs);
  } catch (e) {
    console.warn("[LiveVoice] chunk processing error:", e);
  }
}

// Shows the measured delay next to the "Live" badge and warns when the
// machine can't convert a chunk faster than the chunk's own length (in which
// case the delay keeps growing and chunks start getting dropped).
function updateLiveVoiceStatus(delayMs, convertMs, hopMs) {
  const statusEl = document.getElementById("live-status");
  if (!statusEl || !liveVoiceActive) return;
  liveVoiceDelayAvg = liveVoiceDelayAvg ? liveVoiceDelayAvg * 0.7 + delayMs * 0.3 : delayMs;
  const secs = (liveVoiceDelayAvg / 1000).toFixed(1);
  if (convertMs > hopMs) {
    statusEl.textContent = `⚠️ Live · ~${secs}s delay. Too slow for this chunk size, try Smooth or use a GPU`;
    statusEl.className = "rvc-backend-status missing";
  } else {
    statusEl.textContent = `🟢 Live · ~${secs}s delay`;
    statusEl.className = "rvc-backend-status ready";
  }
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* =========================================================================
   SETUP TAB (Settings > Setup) — one place that checks whether everything
   the app can use is actually ready, and offers a one-click fix for
   anything that isn't (short of things Windows won't allow to be silent,
   like installing a driver).
   ========================================================================= */
function bindSetupPanel() {
  const recheckBtn = document.getElementById("setup-recheck-btn");
  const vbBtn = document.getElementById("setup-vbcable-btn");
  const ytBtn = document.getElementById("setup-ytdlp-btn");
  const rvcBtn = document.getElementById("setup-rvc-btn");
  const alreadyBound = recheckBtn?.dataset.bound;
  if (recheckBtn) recheckBtn.dataset.bound = "1";

  if (!alreadyBound) {
    recheckBtn?.addEventListener("click", runSetupChecks);

    vbBtn?.addEventListener("click", () => {
      window.electronAPI.openExternalLink("https://vb-audio.com/Cable/");
    });

    ytBtn?.addEventListener("click", async () => {
      ytBtn.disabled = true;
      ytBtn.textContent = "Downloading…";
      const result = await window.electronAPI.prepareYtDlp();
      ytBtn.disabled = false;
      ytBtn.textContent = "Download Now";
      if (result.success) {
        showToast("✅ YouTube import tool ready");
      } else {
        showToast("⚠️ Download failed: " + (result.error || "unknown error"));
      }
      checkYtDlpSetupStatus();
    });

    rvcBtn?.addEventListener("click", async () => {
      const logEl = document.getElementById("setup-rvc-log");
      if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
      rvcBtn.disabled = true;
      rvcBtn.textContent = "Installing…";
      const statusEl = document.getElementById("setup-rvc-status");
      if (statusEl) { statusEl.textContent = "Installing…"; statusEl.className = "rvc-backend-status"; }

      setSetupButtonsDisabled(true);
      const result = await window.electronAPI.installRvcBackend();
      setSetupButtonsDisabled(false);
      rvcBtn.disabled = false;
      rvcBtn.textContent = "Install Backend";
      if (result.cancelled) {
        showToast("Setup cancelled");
      } else if (result.success) {
        showToast("✅ AI Voice backend installed");
      } else {
        console.error("AI Voice backend install failed:", result.error);
        if (statusEl) { statusEl.className = "rvc-backend-status missing"; statusEl.textContent = "⚠️ " + (result.error || "Install failed"); }
        showToast("⚠️ Backend install failed: " + (result.error || "unknown error"));
      }
      checkRvcSetupStatus();
    });

    document.getElementById("setup-python-btn")?.addEventListener("click", async () => {
      const pythonBtn = document.getElementById("setup-python-btn");
      const logEl = document.getElementById("setup-rvc-log");
      const statusEl = document.getElementById("setup-rvc-status");
      if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
      pythonBtn.disabled = true;
      pythonBtn.textContent = "Setting up… (a couple minutes)";
      if (statusEl) { statusEl.textContent = "Setting up Python…"; statusEl.className = "rvc-backend-status"; }

      setSetupButtonsDisabled(true);
      const result = await window.electronAPI.installBundledPython();
      setSetupButtonsDisabled(false);
      pythonBtn.disabled = false;
      pythonBtn.textContent = "✨ One-Click Setup (no Python needed)";
      if (result.cancelled) {
        showToast("Setup cancelled — run it again to pick up where it left off");
      } else if (result.success) {
        // main.js wrote the new python path straight to settings.json. Our
        // in-memory appSettings still holds the old value and gets written
        // back in full on the next updateSetting() — silently undoing the
        // setup — so pull the fresh value in now.
        try {
          const fresh = await window.electronAPI.loadSettings();
          if (fresh?.rvcPythonCommand) {
            appSettings.rvcPythonCommand = fresh.rvcPythonCommand;
            const pyInput = document.getElementById("rvc-python-command");
            if (pyInput) pyInput.value = fresh.rvcPythonCommand;
          }
        } catch {}
        showToast("✅ AI Voices is ready — no manual Python install needed");
      } else {
        console.error("Bundled Python setup failed:", result.error);
        if (statusEl) { statusEl.className = "rvc-backend-status missing"; statusEl.textContent = "⚠️ " + (result.error || "Setup failed"); }
        showToast("⚠️ Setup failed: " + (result.error || "unknown error"));
      }
      checkRvcSetupStatus();
    });

    // Backend install logs stream from the same "rvc-backend-log" channel
    // used by the AI Voices tab — mirror them here too if this tab's log
    // box happens to be the one visible.
    window.electronAPI.onRvcBackendLog((line) => {
      const logEl = document.getElementById("setup-rvc-log");
      if (!logEl || logEl.style.display === "none") return;
      appendLog(logEl, line);
    });
  }

  runSetupChecks();
}

async function runSetupChecks() {
  checkVbCableSetupStatus();
  checkYtDlpSetupStatus();
  checkRvcSetupStatus();
}

// VB-Cable can't be checked from the main process (it's a media device, not
// a filesystem thing), so this reuses the same device-label heuristic
// loadDevices() already uses for the Virtual Mic Output dropdown.
async function checkVbCableSetupStatus() {
  const statusEl = document.getElementById("setup-vbcable-status");
  const btn = document.getElementById("setup-vbcable-btn");
  if (!statusEl) return;
  statusEl.textContent = "Checking…";
  statusEl.className = "rvc-backend-status";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.some(isCableInput);
    if (found) {
      statusEl.textContent = "✓ Installed and detected";
      statusEl.className = "rvc-backend-status ready";
      if (btn) btn.style.display = "none";
    } else {
      statusEl.textContent = "Not detected";
      statusEl.className = "rvc-backend-status missing";
      if (btn) btn.style.display = "inline-block";
    }
  } catch {
    statusEl.textContent = "Couldn't check (mic permission needed)";
    statusEl.className = "rvc-backend-status missing";
    if (btn) btn.style.display = "inline-block";
  }
}

async function checkYtDlpSetupStatus() {
  const statusEl = document.getElementById("setup-ytdlp-status");
  const btn = document.getElementById("setup-ytdlp-btn");
  if (!statusEl) return;
  statusEl.textContent = "Checking…";
  statusEl.className = "rvc-backend-status";
  const status = await window.electronAPI.checkYtDlpStatus();
  if (status.exists) {
    statusEl.textContent = "✓ Ready";
    statusEl.className = "rvc-backend-status ready";
    if (btn) btn.style.display = "none";
  } else {
    statusEl.textContent = "Not downloaded yet — grabs itself automatically on first import";
    statusEl.className = "rvc-backend-status missing";
    if (btn) btn.style.display = "inline-block";
  }
}

async function checkRvcSetupStatus() {
  const statusEl = document.getElementById("setup-rvc-status");
  const btn = document.getElementById("setup-rvc-btn");
  const pythonBtn = document.getElementById("setup-python-btn");
  if (!statusEl) return;
  statusEl.textContent = "Checking…";
  statusEl.className = "rvc-backend-status";
  const status = await window.electronAPI.checkRvcBackend();
  const { text, ready } = describeRvcStatus(status, "✓ Ready");
  statusEl.textContent = text;
  statusEl.className = "rvc-backend-status " + (ready ? "ready" : "missing");
  const isWindows = window.navigator.userAgent.includes("Windows");
  if (ready) {
    if (btn) btn.style.display = "none";
    if (pythonBtn) pythonBtn.style.display = "none";
  } else if (status.pythonFound) {
    // Python is there: offer the normal install, plus the one-click private
    // Python (Windows only) when the version we found won't work.
    if (btn) btn.style.display = "inline-block";
    if (pythonBtn) pythonBtn.style.display = isWindows && !status.pythonCompatible ? "inline-block" : "none";
  } else {
    // Windows can get a private Python with one click; other platforms
    // almost always have python3 already, so point them at a normal
    // install instead of promising a button that won't work there.
    if (btn) btn.style.display = "none";
    if (pythonBtn) pythonBtn.style.display = isWindows ? "inline-block" : "none";
  }
  refreshGpuUi();
}

/* =========================================================================
   EDIT MODAL
   ========================================================================= */
async function openEditModal(id, focusField) {
  const sound = sounds.find((s) => s.id === id);
  if (!sound) return;
  editingId = id;

  setVal("edit-name", sound.name);
  setVal("edit-emoji", sound.emoji || "🔊");
  setVal("edit-hotkey", sound.hotkey || "");
  setVal("edit-volume", sound.volume ?? 100);
  setLabel("edit-vol-label", (sound.volume ?? 100) + "%");
  setVal("edit-category", sound.category || "");
  setVal("edit-fadein", sound.fadeIn ?? 0);
  setVal("edit-fadeout", sound.fadeOut ?? 0);

  setVal("edit-pitch", sound.pitchOffset ?? 0);
  setVal("edit-formant", sound.formantTilt ?? 0);
  setLabel("edit-pitch-label", (sound.pitchOffset ?? 0) + " st");
  setLabel("edit-formant-label", (sound.formantTilt ?? 0).toFixed(2));

  const sendToMicEl = document.getElementById("edit-send-to-mic");
  if (sendToMicEl) sendToMicEl.checked = sound.sendToMic !== false;

  document.querySelectorAll(".voice-preset-btn:not(.rvc-pitch-preset-btn)").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.preset === (sound.voicePreset || "normal"));
  });

  const row = document.getElementById("color-picker-row");
  if (row) {
    row.innerHTML = "";
    COLORS.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "color-swatch" + (c === (sound.color || COLORS[0]) ? " selected" : "");
      sw.style.background = c;
      sw.dataset.color = c;
      sw.addEventListener("click", () => {
        document.querySelectorAll(".color-swatch").forEach((x) => x.classList.remove("selected"));
        sw.classList.add("selected");
      });
      row.appendChild(sw);
    });
  }

  editingRvcVoice = sound.rvcVoice || null;
  editingRvcPitch = sound.rvcPitch || 0;
  editingRvcSeparate = !!sound.rvcSeparateVocals;
  setVal("edit-rvc-pitch", editingRvcPitch);
  setLabel("edit-rvc-pitch-label", String(editingRvcPitch));
  const separateEl = document.getElementById("edit-rvc-separate");
  if (separateEl) separateEl.checked = editingRvcSeparate;
  rvcVoicesCache = await window.electronAPI.listRvcVoices();
  renderEditRvcVoiceGrid();
  setLabel("edit-rvc-status", "");

  switchModalTab("sound");
  document.getElementById("modal-overlay")?.classList.add("visible");
  if (focusField === "hotkey") {
    setTimeout(() => document.getElementById("edit-hotkey")?.focus(), 50);
  }
}

function currentVoiceFormValues() {
  const selectedBtn = document.querySelector(".voice-preset-btn.selected");
  return {
    voicePreset: selectedBtn?.dataset.preset || "normal",
    pitchOffset: parseFloat(getVal("edit-pitch", 0)) || 0,
    formantTilt: parseFloat(getVal("edit-formant", 0)) || 0,
  };
}

function bindModalTabs() {
  document.querySelectorAll(".modal-tab-btn:not(.settings-tab-btn)").forEach((btn) => {
    btn.addEventListener("click", () => switchModalTab(btn.dataset.tab));
  });
}
function switchModalTab(tab) {
  document.querySelectorAll(".modal-tab-btn:not(.settings-tab-btn)").forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  document.querySelectorAll(".modal-tab-panel:not(.settings-tab-panel)").forEach((p) => {
    p.style.display = p.dataset.tab === tab ? "flex" : "none";
  });
  if (tab !== "voice") stopPreview();
  if (tab !== "aivoice") stopRvcPreview();
}

// AI Voice tab — builds the "Off" + per-model card grid inside the Edit
// Sound modal, mirroring the AI Voices Settings tab but scoped to
// whichever sound is currently being edited.
function renderEditRvcVoiceGrid() {
  const grid = document.getElementById("edit-rvc-voice-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const offCard = document.createElement("div");
  offCard.className = "rvc-voice-card" + (!editingRvcVoice ? " active" : "");
  offCard.innerHTML = `
    <div class="rvc-voice-card-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="2" y1="2" x2="22" y2="22"/>
      </svg>
    </div>
    <div class="rvc-voice-card-info">
      <div class="rvc-voice-card-name">Off</div>
      <div class="rvc-voice-card-meta">Use Voice FX preset above instead</div>
    </div>
  `;
  offCard.addEventListener("click", () => {
    editingRvcVoice = null;
    setLabel("edit-rvc-status", "");
    renderEditRvcVoiceGrid();
  });
  grid.appendChild(offCard);

  rvcVoicesCache.forEach((v) => {
    const card = document.createElement("div");
    card.className = "rvc-voice-card" + (editingRvcVoice === v.id ? " active" : "");
    card.innerHTML = `
      <div class="rvc-voice-card-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        </svg>
      </div>
      <div class="rvc-voice-card-info">
        <div class="rvc-voice-card-name">${escHtml(v.name)}</div>
        <div class="rvc-voice-card-meta">${v.sizeMB} MB${v.hasIndex ? " · has index" : ""}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      editingRvcVoice = v.id;
      setLabel("edit-rvc-status", "");
      renderEditRvcVoiceGrid();
    });
    grid.appendChild(card);
  });

  if (rvcVoicesCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rvc-empty-note";
    empty.textContent = "No voice models yet — add them in Settings > AI Voices.";
    grid.appendChild(empty);
  }
}

function stopRvcPreview() {
  if (rvcPreviewAudio) {
    try { rvcPreviewAudio.pause(); } catch {}
    rvcPreviewAudio = null;
  }
}

// Clears the Edit modal's live conversion log box right before a new
// convertRvcFile() call, so each run starts with a blank slate instead of
// appending onto the previous attempt's output.
function resetEditRvcLog() {
  const logEl = document.getElementById("edit-rvc-log");
  if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
}

// The edit modal's preset grid starts as static HTML for the original
// voices. It is rebuilt here from VOICE_PRESETS, grouped under headings the
// same way as the Live Voice picker, so every voice shows up (new ones need
// no HTML) and the list stays easy to scan. Runs before the click handlers
// below are attached.
function renderExtraVoicePresetButtons() {
  const grid = document.getElementById("voice-preset-grid");
  if (!grid) return;
  const grouped = new Set(VOICE_GROUPS.flatMap(([, ids]) => ids));
  const groups = [...VOICE_GROUPS];
  const other = Object.keys(VOICE_PRESETS).filter((id) => !grouped.has(id));
  if (other.length) groups.push(["Other", other]);
  grid.innerHTML = "";
  for (const [label, ids] of groups) {
    const present = ids.filter((id) => VOICE_PRESETS[id]);
    if (!present.length) continue;
    const head = document.createElement("div");
    head.className = "voice-preset-group";
    head.textContent = label;
    grid.appendChild(head);
    for (const id of present) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-preset-btn" + (id === "normal" ? " selected" : "");
      btn.dataset.preset = id;
      btn.textContent = voiceLabel(id);
      grid.appendChild(btn);
    }
  }
}

function bindVoicePresets() {
  renderExtraVoicePresetButtons();
  document.querySelectorAll(".voice-preset-btn:not(.rvc-pitch-preset-btn)").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".voice-preset-btn:not(.rvc-pitch-preset-btn)").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
  document.getElementById("edit-pitch")?.addEventListener("input", (e) => {
    setLabel("edit-pitch-label", e.target.value + " st");
  });
  document.getElementById("edit-formant")?.addEventListener("input", (e) => {
    setLabel("edit-formant-label", parseFloat(e.target.value).toFixed(2));
  });
  document.getElementById("voice-preview-btn")?.addEventListener("click", () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    previewVoice({ ...sound, rvcVoice: null }, currentVoiceFormValues());
  });

  document.getElementById("edit-rvc-pitch")?.addEventListener("input", (e) => {
    editingRvcPitch = parseInt(e.target.value, 10) || 0;
    setLabel("edit-rvc-pitch-label", String(editingRvcPitch));
  });
  document.querySelectorAll(".rvc-pitch-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingRvcPitch = parseInt(btn.dataset.rvcPitch, 10) || 0;
      setVal("edit-rvc-pitch", editingRvcPitch);
      setLabel("edit-rvc-pitch-label", String(editingRvcPitch));
    });
  });
  document.getElementById("edit-rvc-separate")?.addEventListener("change", (e) => {
    editingRvcSeparate = e.target.checked;
  });
}

function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function getVal(id, fallback = "") { const el = document.getElementById(id); return el ? el.value : fallback; }
function setLabel(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function closeModal() {
  document.getElementById("modal-overlay")?.classList.remove("visible");
  stopPreview();
  stopRvcPreview();
  editingId = null;
  stopHotkeyRecording();
}

/* =========================================================================
   HOTKEYS
   ========================================================================= */
function startHotkeyRecording(targetId = "edit-hotkey") {
  const input = document.getElementById(targetId);
  if (!input) return;
  recordingHotkey = true;
  recordingHotkeyTarget = targetId;
  recordingHotkeyPrev = input.value;
  input.value = "Press keys...";
  input.classList.add("recording");
}
// Cancelling (Esc / clicking away / closing the modal) puts the previous
// value back — otherwise the literal text "Press keys..." got left in the
// field and could even be saved as the hotkey.
function stopHotkeyRecording(restore = true) {
  const input = document.getElementById(recordingHotkeyTarget);
  if (recordingHotkey && restore && input && input.value === "Press keys...") input.value = recordingHotkeyPrev;
  recordingHotkey = false;
  input?.classList.remove("recording");
  recordingHotkeyTarget = "edit-hotkey";
}
function bindHotkeyListener() {
  window.electronAPI.onHotkeyTriggered((id) => {
    if (id === "__panic__") { panic(); return; }
    playSound(id);
  });
  document.getElementById("edit-hotkey")?.addEventListener("click", () => {
    if (!recordingHotkey) startHotkeyRecording("edit-hotkey");
  });
  document.getElementById("panic-hotkey")?.addEventListener("click", () => {
    if (!recordingHotkey) startHotkeyRecording("panic-hotkey");
  });
  // Clicking away without pressing anything cancels the recording. Before
  // this it stayed armed and swallowed every keystroke in the app.
  ["edit-hotkey", "panic-hotkey"].forEach((fieldId) => {
    document.getElementById(fieldId)?.addEventListener("blur", () => {
      if (recordingHotkey && recordingHotkeyTarget === fieldId) stopHotkeyRecording();
    });
  });
  document.addEventListener("keydown", (e) => {
    if (!recordingHotkey) return;
    e.preventDefault();
    // Esc cancels. It must never be recorded: a global "Escape" hotkey would
    // steal the Escape key from every other app on the machine.
    if (e.key === "Escape") { stopHotkeyRecording(); e.stopImmediatePropagation(); return; }
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey) mods.push("Alt");
    if (e.metaKey) mods.push(/Mac/i.test(navigator.platform) ? "Command" : "Super");
    let key = e.key;
    if (["Control", "Shift", "Alt", "Meta", "AltGraph", "Dead", "Unidentified"].includes(key)) return;
    const keyMap = {
      " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Enter: "Return", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
    };
    // Use the physical key for letters/digits: with Shift held e.key is "!"
    // instead of "1", and with Alt on some layouts it's a symbol — neither is
    // a valid accelerator.
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
    else if (/^Numpad[0-9]$/.test(e.code)) key = "num" + e.code.slice(6);
    else key = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key);
    const accelerator = [...mods, key].join("+");
    setVal(recordingHotkeyTarget, accelerator);
    const wasPanic = recordingHotkeyTarget === "panic-hotkey";
    stopHotkeyRecording(false);
    if (wasPanic) setPanicHotkey(accelerator);
  });
}

async function setPanicHotkey(accelerator) {
  const prev = appSettings.panicHotkey || "";
  if (!accelerator) return;
  // The main process swaps the old hotkey for the new one and puts the old one
  // back if the new one can't be registered.
  let result = null;
  try { result = await window.electronAPI.registerHotkey({ id: "__panic__", accelerator }); } catch {}
  if (result?.success) {
    updateSetting("panicHotkey", accelerator);
  } else {
    showToast("⚠️ Couldn't register that hotkey — it may be in use");
    // Keep showing (and saving) whatever hotkey is actually still active.
    setVal("panic-hotkey", prev);
  }
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (recordingHotkey) return;
    const modalOpen = document.getElementById("modal-overlay")?.classList.contains("visible")
      || document.getElementById("settings-modal-overlay")?.classList.contains("visible")
      || document.getElementById("yt-import-modal-overlay")?.classList.contains("visible");
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

    if (pushToTalkMode && e.code === "Backquote" && !e.repeat) { setMicMuted(false); }

    if (modalOpen || typing) return;

    if (e.code === "Space") { e.preventDefault(); stopAll(); return; }
    if (/^Digit[1-9]$/.test(e.code)) {
      const idx = parseInt(e.code.replace("Digit", ""), 10) - 1;
      const card = document.querySelectorAll(".sound-card:not(.add-sound-tile)")[idx];
      if (card) playSound(card.dataset.id);
    }
  });
  document.addEventListener("keyup", (e) => {
    if (pushToTalkMode && e.code === "Backquote") setMicMuted(true);
  });
  // If focus leaves the window while the push-to-talk key is held, the keyup
  // never arrives and the mic would stay open indefinitely.
  window.addEventListener("blur", () => {
    if (pushToTalkMode) setMicMuted(true);
  });
}

/* =========================================================================
   WINDOW STATE SYNC
   ========================================================================= */
function bindWindowStateSync() {
  const icon = document.getElementById("maximize-icon");
  const applyIcon = (isMaximized) => {
    if (!icon) return;
    icon.innerHTML = isMaximized
      ? `<rect x="1.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none"/><rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" fill="none"/>`
      : `<rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none"/>`;
  };
  window.electronAPI.isWindowMaximized().then(applyIcon).catch(() => {});
  window.electronAPI.onWindowStateChanged(applyIcon);
}

async function loadAppVersion() {
  try {
    const v = await window.electronAPI.getAppVersion();
    setLabel("app-version-label", "v" + v);
  } catch {}
}

/* =========================================================================
   GENERAL UI BINDINGS
   ========================================================================= */
function wireToggle(id, onChange, startActive = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (startActive) el.classList.add("active");
  el.addEventListener("click", () => {
    const active = el.classList.toggle("active");
    onChange(active);
  });
}

// Same as wireToggle, but its on/off state is restored from — and written
// back to — settings.json, so it stays exactly as the person left it
// until they flip it again in Settings.
function wirePersistedToggle(id, settingKey, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  const initial = !!appSettings[settingKey];
  if (initial) el.classList.add("active");
  onChange(initial);
  el.addEventListener("click", () => {
    const active = el.classList.toggle("active");
    onChange(active);
    updateSetting(settingKey, active);
  });
}

async function openAddSoundsDialog() {
  const files = await window.electronAPI.openFileDialog();
  await addFiles(files);
}

function bindUI() {

  let searchDebounce;
  document.getElementById("search-input")?.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const value = e.target.value;
    searchDebounce = setTimeout(() => renderGrid(value), 150);
  });
  document.getElementById("category-filter")?.addEventListener("change", (e) => {
    currentCategory = e.target.value;
    renderGrid(currentSearchValue());
  });
  document.getElementById("stop-all-btn")?.addEventListener("click", stopAll);
  document.getElementById("panic-btn-manual")?.addEventListener("click", panic);
  bindNavSidebar();
  bindTtsPage();
  bindMusicPage();
  bindLiveVoicePage();
  document.getElementById("btn-minimize")?.addEventListener("click", () => window.electronAPI.windowMinimize());
  document.getElementById("btn-maximize")?.addEventListener("click", () => window.electronAPI.windowMaximize());
  document.getElementById("btn-close")?.addEventListener("click", () => window.electronAPI.windowClose());

  wirePersistedToggle("local-monitor-toggle", "localMonitorEnabled", (active) => setLocalMonitorEnabled(active));
  wirePersistedToggle("monitor-mic-feed-toggle", "monitorMicFeedEnabled", (active) => setMonitorMicFeed(active));
  let echoToggleReady = false;
  wirePersistedToggle("echo-cancel-toggle", "echoCancellation", (active) => {
    appSettings.echoCancellation = active; // connectLiveMic reads this
    // The browser applies it when the mic is opened, so reopen it (not on first wiring).
    if (echoToggleReady && micInputDeviceId && audioCtx) connectLiveMic(micInputDeviceId);
  });
  echoToggleReady = true;
  wirePersistedToggle("mic-fx-toggle", "micFxEnabled", (active) => { micFxEnabled = active; rebuildMicChain(); });
  wirePersistedToggle("duck-toggle", "duckEnabled", (active) => { duckEnabled = active; });
  wirePersistedToggle("queue-toggle", "queueMode", (active) => { queueMode = active; queue = []; });
  const lowPowerToggle = document.getElementById("low-power-toggle");
  if (lowPowerToggle) {
    lowPowerToggle.classList.toggle("active", document.documentElement.dataset.perf === "low");
    lowPowerToggle.addEventListener("click", () => {
      const active = lowPowerToggle.classList.toggle("active");
      updateSetting("lowPowerMode", active);
      applyPerformanceMode();
    });
  }
  wirePersistedToggle("stop-overlap-toggle", "stopOnOverlap", (active) => { stopOnOverlap = active; });
  wirePersistedToggle("loop-toggle", "loopEnabled", (active) => { loopEnabled = active; });
  wirePersistedToggle("noise-gate-toggle", "noiseGateEnabled", (active) => {
    noiseGateEnabled = active;
    if (!active && micGateGain) micGateGain.gain.value = 1;
  });
  // Mic mute is a live, momentary control (not a saved preference) —
  // it always starts unmuted on launch.
  wireToggle("mic-mute-toggle", (active) => setMicMuted(active));
  wirePersistedToggle("push-to-talk-toggle", "pushToTalkMode", (active) => {
    pushToTalkMode = active;
    setMicMuted(active);
  });

  const masterSlider = document.getElementById("master-volume");
  if (masterSlider) {
    const savedMaster = appSettings.masterVolume ?? parseInt(masterSlider.value, 10);
    masterSlider.value = savedMaster;
    setLabel("master-vol-label", savedMaster + "%");
    monitorGain.gain.value = savedMaster / 100;
    masterSlider.addEventListener("input", () => {
      setLabel("master-vol-label", masterSlider.value + "%");
      monitorGain.gain.value = masterSlider.value / 100;
      updateSetting("masterVolume", parseInt(masterSlider.value, 10));
    });
  }

  const micSlider = document.getElementById("mic-volume");
  if (micSlider) {
    const savedMic = appSettings.micVolume ?? parseInt(micSlider.value, 10);
    micSlider.value = savedMic;
    setLabel("mic-vol-label", savedMic + "%");
    micSendGain.gain.value = savedMic / 100;
    micSlider.addEventListener("input", () => {
      setLabel("mic-vol-label", micSlider.value + "%");
      micSendGain.gain.value = micSlider.value / 100;
      updateSetting("micVolume", parseInt(micSlider.value, 10));
    });
  }

  const gateThresholdSlider = document.getElementById("noise-gate-threshold");
  if (gateThresholdSlider) {
    const savedThreshold = appSettings.noiseGateThreshold ?? parseFloat(gateThresholdSlider.value);
    gateThresholdSlider.value = savedThreshold;
    noiseGateThreshold = savedThreshold / 100;
    setLabel("noise-gate-threshold-label", savedThreshold + "%");
    gateThresholdSlider.addEventListener("input", () => {
      noiseGateThreshold = parseFloat(gateThresholdSlider.value) / 100;
      setLabel("noise-gate-threshold-label", gateThresholdSlider.value + "%");
      updateSetting("noiseGateThreshold", parseFloat(gateThresholdSlider.value));
    });
  }

  document.getElementById("modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal-overlay")) closeModal();
  });
  document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);
  document.getElementById("edit-volume")?.addEventListener("input", (e) => {
    setLabel("edit-vol-label", e.target.value + "%");
  });
  document.getElementById("hotkey-clear-btn")?.addEventListener("click", () => {
    setVal("edit-hotkey", "");
    stopHotkeyRecording();
  });
  document.getElementById("reveal-file-btn")?.addEventListener("click", () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (sound) window.electronAPI.showInFolder(sound.file);
  });

  document.getElementById("edit-rvc-preview-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    stopRvcPreview();
    if (!editingRvcVoice) {
      showToast("⚠️ Pick a voice first — Off has nothing to preview here");
      return;
    }
    setLabel("edit-rvc-status", "Converting…");
    resetEditRvcLog();
    const result = await window.electronAPI.convertRvcFile(sound.file, sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
    if (!result.success) {
      setLabel("edit-rvc-status", "");
      showToast(result.cancelled ? "Conversion cancelled" : "⚠️ RVC conversion failed: " + (result.error || "unknown error"));
      return;
    }
    setLabel("edit-rvc-status", result.cached ? "Cached ✓" : "Converted ✓");
    rvcPreviewAudio = new Audio(toFileUrl(result.outputPath));
    rvcPreviewAudio.volume = Math.min(1, (sound.volume ?? 100) / 100); // media elements cap at 100%
    rvcPreviewAudio.play().catch(() => {});
  });

  document.getElementById("edit-rvc-reconvert-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    if (!editingRvcVoice) {
      showToast("⚠️ Pick a voice first — Off has nothing to reconvert here");
      return;
    }
    stopRvcPreview();
    setLabel("edit-rvc-status", "Clearing old conversion…");
    resetEditRvcLog();
    await window.electronAPI.clearRvcConversion(sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
    // Drop the in-memory decoded copy too, in case a corrupt/stale file
    // was already loaded once this session — otherwise playback would
    // keep using the old broken buffer even after the file is redone.
    bufferCache.delete(`${sound.file}::rvc::${editingRvcVoice}::${editingRvcPitch}${editingRvcSeparate ? "::sep" : ""}`);

    setLabel("edit-rvc-status", "Converting…");
    const result = await window.electronAPI.convertRvcFile(sound.file, sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
    if (!result.success) {
      setLabel("edit-rvc-status", "");
      showToast(result.cancelled ? "Conversion cancelled" : "⚠️ RVC conversion failed: " + (result.error || "unknown error"));
      return;
    }
    setLabel("edit-rvc-status", "Converted ✓");
    rvcPreviewAudio = new Audio(toFileUrl(result.outputPath));
    rvcPreviewAudio.volume = Math.min(1, (sound.volume ?? 100) / 100); // media elements cap at 100%
    rvcPreviewAudio.play().catch(() => {});
  });

  document.getElementById("modal-save-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    const oldHotkey = sound.hotkey;
    const snapshot = { ...sound }; // restored if the save can't be completed

    sound.name = getVal("edit-name").trim() || sound.name;
    sound.emoji = getVal("edit-emoji").trim() || "🔊";
    const typedHotkey = getVal("edit-hotkey").trim();
    sound.hotkey = typedHotkey === "Press keys..." ? oldHotkey : typedHotkey;
    const typedVolume = parseInt(getVal("edit-volume", 100), 10);
    sound.volume = Number.isFinite(typedVolume) ? typedVolume : 100;
    sound.category = getVal("edit-category").trim();
    sound.fadeIn = parseInt(getVal("edit-fadein", 0)) || 0;
    sound.fadeOut = parseInt(getVal("edit-fadeout", 0)) || 0;

    const sendToMicEl = document.getElementById("edit-send-to-mic");
    if (sendToMicEl) sound.sendToMic = sendToMicEl.checked;

    const voiceVals = currentVoiceFormValues();
    sound.voicePreset = voiceVals.voicePreset;
    sound.pitchOffset = voiceVals.pitchOffset;
    sound.formantTilt = voiceVals.formantTilt;

    const sel = document.querySelector(".color-swatch.selected");
    if (sel) sound.color = sel.dataset.color;

    const rvcChanged =
      editingRvcVoice !== (sound.rvcVoice || null) ||
      editingRvcPitch !== (sound.rvcPitch || 0) ||
      editingRvcSeparate !== !!sound.rvcSeparateVocals;

    if (rvcChanged) {
      if (editingRvcVoice) {
        setLabel("edit-rvc-status", "Converting…");
        resetEditRvcLog();
        const saveBtn = document.getElementById("modal-save-btn");
        if (saveBtn) saveBtn.disabled = true;
        const result = await window.electronAPI.convertRvcFile(sound.file, sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
        if (saveBtn) saveBtn.disabled = false;
        if (!result.success) {
          setLabel("edit-rvc-status", "");
          showToast(result.cancelled ? "Conversion cancelled" : "⚠️ RVC conversion failed: " + (result.error || "unknown error"));
          Object.assign(sound, snapshot); // leave the sound as it was so the person can retry
          return;
        }
        sound.rvcVoice = editingRvcVoice;
        sound.rvcPitch = editingRvcPitch;
        sound.rvcSeparateVocals = editingRvcSeparate;
      } else {
        sound.rvcVoice = null;
        sound.rvcPitch = 0;
        sound.rvcSeparateVocals = false;
      }
    }

    if (sound.hotkey !== oldHotkey) {
      try {
        const result = await window.electronAPI.registerHotkey({ id: sound.id, accelerator: sound.hotkey });
        if (!result?.success) {
          showToast("⚠️ Hotkey conflict: " + (result?.error || "couldn't register it"));
          sound.hotkey = oldHotkey;
        }
      } catch (e) {
        console.error("registerHotkey failed:", e);
        showToast("⚠️ Couldn't register that hotkey");
        sound.hotkey = oldHotkey;
      }
    }
    await saveSoundsNow();
    renderGrid(currentSearchValue());
    renderCategoryFilter();
    closeModal();
    showToast("✅ Saved");
  });

  document.getElementById("modal-delete-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const idToDelete = editingId;
    try { await window.electronAPI?.unregisterHotkey?.(idToDelete); } catch (err) { console.error("unregisterHotkey failed:", err); }
    closeModal();
    softDeleteSound(idToDelete);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (recordingHotkey) { stopHotkeyRecording(); return; }
    if (document.getElementById("modal-overlay")?.classList.contains("visible")) {
      closeModal();
      return;
    }
    if (document.getElementById("settings-modal-overlay")?.classList.contains("visible")) {
      closeSettingsModal();
      return;
    }
    if (document.getElementById("yt-import-modal-overlay")?.classList.contains("visible")) {
      closeYoutubeImportModal();
    }
  });
}

/* =========================================================================
   UTIL
   ========================================================================= */
// Turns a raw filesystem path into a URL the webview may load. Under Tauri that
// is the asset protocol (convertFileSrc handles encoding for every platform);
// local files can't be loaded through file:// from the app's own origin.
function toFileUrl(filePath) {
  if (window.electronAPI?.toFileUrl) return window.electronAPI.toFileUrl(filePath);
  const normalized = filePath.replace(/\\/g, "/");
  const isDrivePath = /^[A-Za-z]:\//.test(normalized);
  const encoded = normalized
    .split("/")
    .map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join("/");
  return isDrivePath ? `file:///${encoded}` : `file://${encoded}`;
}

// Safe for any value (a missing name/label used to throw and abort the whole
// grid render) and for attribute contexts, including single-quoted ones.
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Appends to a log box but keeps only the tail, so a long conversion or pip
// install can't grow the DOM (and memory) without bound.
function appendLog(el, text, max = 40000) {
  el.textContent += text;
  if (el.textContent.length > max) el.textContent = el.textContent.slice(-max);
  el.scrollTop = el.scrollHeight;
}

let toastTimer;
function showToast(msg, { actionLabel, onAction } = {}) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.style.cssText = "margin-left:12px;background:none;border:none;color:var(--accent);font-weight:700;cursor:pointer;";
    btn.addEventListener("click", () => { onAction(); t.classList.remove("show"); });
    t.appendChild(btn);
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), actionLabel ? 6000 : 2500);
}


/* =========================================================================
   DEVICE HOT-PLUG
   Installing VB-Cable (or plugging in a headset) while the app is open
   used to need a restart. Now the device lists refresh on their own, and a
   newly appeared cable is connected automatically if none was chosen.
   ========================================================================= */
function isCableInput(d) {
  const lbl = (d.label || "").toLowerCase();
  return d.kind === "audiooutput" && (lbl.includes("cable input") || (lbl.includes("cable") && !lbl.includes("output")));
}

function fillDeviceSelect(sel, devices, fallbackPrefix, placeholder) {
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML =
    (placeholder ? `<option value="">${placeholder}</option>` : "") +
    devices.map((d) => `<option value="${escHtml(d.deviceId)}">${escHtml(d.label || fallbackPrefix + " " + d.deviceId.slice(0, 6))}</option>`).join("");
  if (current && devices.some((d) => d.deviceId === current)) sel.value = current;
}

let deviceRefreshTimer = null;
function bindDeviceChangeWatcher() {
  navigator.mediaDevices?.addEventListener("devicechange", () => {
    clearTimeout(deviceRefreshTimer);
    deviceRefreshTimer = setTimeout(refreshDevicesAfterChange, 600);
  });
}

async function refreshDevicesAfterChange() {
  let devices;
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const audioOut = devices.filter((d) => d.kind === "audiooutput");
  const audioIn = realMicInputs(devices);
  const inSel = document.getElementById("virtual-mic-device");

  fillDeviceSelect(document.getElementById("output-device"), audioOut, "Speaker");
  fillDeviceSelect(inSel, audioOut, "Output", "-- Select CABLE Input --");
  const micSel = document.getElementById("mic-input-device");
  fillDeviceSelect(micSel, audioIn, "Mic");
  if (micInputDeviceId && audioIn.length && !audioIn.some((d) => d.deviceId === micInputDeviceId)) {
    // The chosen mic was unplugged: its stream has ended, so reconnect to another one.
    const fallback = pickDefaultRealMic(audioIn);
    micInputDeviceId = fallback.deviceId;
    if (micSel) micSel.value = fallback.deviceId;
    showToast("⚠️ Microphone disconnected. Switched to " + (fallback.label || "the default mic"));
    await connectLiveMic(fallback.deviceId);
  }

  const cable = audioOut.find(isCableInput);
  const stillThere = virtualMicDeviceId && audioOut.some((d) => d.deviceId === virtualMicDeviceId);
  if (virtualMicDeviceId && !stillThere) {
    virtualMicDeviceId = "";
    updateSetting("virtualMicDeviceId", "");
    if (inSel) inSel.value = "";
    await connectVirtualMic(); // stop playing the mic bus on the default speakers
    showToast("⚠️ Virtual mic device disconnected");
  }
  if (cable && !virtualMicDeviceId) {
    virtualMicDeviceId = cable.deviceId;
    updateSetting("virtualMicDeviceId", virtualMicDeviceId);
    if (inSel) inSel.value = cable.deviceId;
    await connectVirtualMic();
    showToast("✅ VB-Cable detected and connected");
  }

  checkVbCableSetupStatus();
  if (document.getElementById("wizard-overlay")?.classList.contains("visible") && wizardStep === 1) refreshWizardCable();
}

/* =========================================================================
   FIRST-RUN SETUP GUIDE
   Three short steps: virtual-mic routing, a test tone, optional extras.
   Shown once (setupWizardDone), re-openable from Settings > System.
   ========================================================================= */
let wizardStep = 1;
const WIZARD_LAST_STEP = 3;

function maybeShowSetupWizard() {
  if (appSettings.setupWizardDone) return;
  // Someone upgrading from an older version already has a library or device
  // choices saved. They don't need a "first run" guide, so skip it silently.
  if (sounds.length > 0 || appSettings.virtualMicDeviceId || appSettings.outputDevice) {
    updateSetting("setupWizardDone", true);
    return;
  }
  openSetupWizard();
}

function openSetupWizard() {
  wizardStep = 1;
  renderWizardStep();
  document.getElementById("wizard-overlay")?.classList.add("visible");
}

function finishSetupWizard() {
  document.getElementById("wizard-overlay")?.classList.remove("visible");
  updateSetting("setupWizardDone", true);
}

function renderWizardStep() {
  document.querySelectorAll(".wizard-step").forEach((el) => {
    el.style.display = Number(el.dataset.step) === wizardStep ? "flex" : "none";
  });
  const back = document.getElementById("wizard-back-btn");
  const next = document.getElementById("wizard-next-btn");
  if (back) back.style.display = wizardStep > 1 ? "inline-block" : "none";
  if (next) next.textContent = wizardStep === WIZARD_LAST_STEP ? "Finish" : "Next";
  if (wizardStep === 1) refreshWizardCable();
  if (wizardStep === 3) refreshWizardExtras();
}

async function refreshWizardCable() {
  const statusEl = document.getElementById("wizard-cable-status");
  const dl = document.getElementById("wizard-cable-download");
  const recheck = document.getElementById("wizard-cable-recheck");
  const help = document.getElementById("wizard-cable-help");
  if (!statusEl) return;
  let found = false;
  try { found = (await navigator.mediaDevices.enumerateDevices()).some(isCableInput); } catch {}
  statusEl.textContent = found ? "✓ Virtual cable detected" : "Virtual cable not found";
  statusEl.className = "rvc-backend-status " + (found ? "ready" : "missing");
  for (const el of [dl, recheck, help]) if (el) el.style.display = found ? "none" : "inline-block";
  if (help && !found) help.style.display = "block";
}

async function refreshWizardExtras() {
  const ytStatus = document.getElementById("wizard-ytdlp-status");
  const ytBtn = document.getElementById("wizard-ytdlp-btn");
  const rvcStatus = document.getElementById("wizard-rvc-status");
  const rvcBtn = document.getElementById("wizard-rvc-btn");
  try {
    const yt = await window.electronAPI.checkYtDlpStatus();
    if (ytStatus) {
      ytStatus.textContent = yt.exists ? "✓ YouTube import ready" : "YouTube import tool not downloaded yet";
      ytStatus.className = "rvc-backend-status " + (yt.exists ? "ready" : "missing");
    }
    if (ytBtn) ytBtn.style.display = yt.exists ? "none" : "inline-block";
  } catch {}
  try {
    const rvc = await window.electronAPI.checkRvcBackend();
    const { text, ready } = describeRvcStatus(rvc, "✓ AI Voices ready");
    if (rvcStatus) {
      rvcStatus.textContent = "AI Voices: " + text;
      rvcStatus.className = "rvc-backend-status " + (ready ? "ready" : "missing");
    }
    if (rvcBtn) rvcBtn.style.display = ready ? "none" : "inline-block";
  } catch {}
}

// A short sine tone through the same paths a sound takes: speakers via the
// monitor bus, and the virtual mic via the mic-send bus.
async function playTestTone() {
  const statusEl = document.getElementById("wizard-test-status");
  try {
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.05);
    gain.gain.setValueAtTime(0.35, t + 0.55);
    gain.gain.linearRampToValueAtTime(0, t + 0.7);
    osc.connect(gain);
    gain.connect(monitorGain);
    gain.connect(micSendGain);
    osc.onended = () => gain.disconnect();
    osc.start(t);
    osc.stop(t + 0.75);
    if (statusEl) { statusEl.textContent = "Played"; statusEl.className = "rvc-backend-status ready"; }
  } catch (e) {
    console.error("Test tone failed:", e);
    if (statusEl) { statusEl.textContent = "Couldn't play: " + (e?.message || "audio engine not ready"); statusEl.className = "rvc-backend-status missing"; }
  }
}

function bindSetupWizard() {
  const byId = (id) => document.getElementById(id);
  byId("wizard-next-btn")?.addEventListener("click", () => {
    if (wizardStep >= WIZARD_LAST_STEP) { finishSetupWizard(); return; }
    wizardStep++;
    renderWizardStep();
  });
  byId("wizard-back-btn")?.addEventListener("click", () => {
    if (wizardStep > 1) { wizardStep--; renderWizardStep(); }
  });
  byId("wizard-skip-btn")?.addEventListener("click", finishSetupWizard);
  byId("wizard-cable-download")?.addEventListener("click", () => window.electronAPI.openExternalLink("https://vb-audio.com/Cable/"));
  byId("wizard-cable-recheck")?.addEventListener("click", refreshWizardCable);
  byId("wizard-test-tone")?.addEventListener("click", playTestTone);

  byId("wizard-ytdlp-btn")?.addEventListener("click", async () => {
    const btn = byId("wizard-ytdlp-btn");
    btn.disabled = true;
    btn.textContent = "Downloading…";
    const result = await window.electronAPI.prepareYtDlp();
    btn.disabled = false;
    btn.textContent = "Get YouTube import tool";
    showToast(result.success ? "✅ YouTube import tool ready" : "⚠️ Download failed: " + (result.error || "unknown error"));
    refreshWizardExtras();
  });

  // AI Voices setup has its own progress bar, cancel button and log in
  // Settings > System, so hand over to it instead of duplicating that here.
  byId("wizard-rvc-btn")?.addEventListener("click", () => {
    finishSetupWizard();
    switchSettingsTab("system");
    byId("settings-modal-overlay")?.classList.add("visible");
  });
}

/* =========================================================================
   HELP & SUPPORT (Settings > System)
   ========================================================================= */
function bindSupportPanel() {
  document.getElementById("diagnostics-copy-btn")?.addEventListener("click", copyDiagnostics);
  document.getElementById("wizard-reopen-btn")?.addEventListener("click", () => {
    closeSettingsModal();
    openSetupWizard();
  });
}

async function copyDiagnostics() {
  try {
    const fromMain = await window.electronAPI.getDiagnostics();
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const report = {
      ...fromMain,
      renderer: {
        userAgent: navigator.userAgent,
        audioContext: audioCtx ? { state: audioCtx.state, sampleRate: audioCtx.sampleRate, baseLatency: audioCtx.baseLatency } : null,
        cableDetected: devices.some(isCableInput),
        virtualMicSelected: !!virtualMicDeviceId,
        liveMicConnected: !!liveMicSource,
        soundsLoaded: sounds.length,
      },
      devices: devices.map((d) => `${d.kind}: ${d.label || "(no label)"}`),
    };
    const text = "Soundboard diagnostics\n" + JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) throw new Error("clipboard unavailable");
    }
    showToast("✅ Diagnostics copied. Paste it into your bug report");
  } catch (e) {
    console.error("copyDiagnostics failed:", e);
    showToast("⚠️ Couldn't copy diagnostics: " + (e?.message || "unknown error"));
  }
}


/* =========================================================================
   LIVE VOICE: INSTANT EFFECTS
   Mic > pitch-shifter worklet > the same effect chain the sound presets use
   > the shared virtual-mic bus. Everything runs on the audio thread, so
   the delay is tens of milliseconds instead of the seconds RVC needs.
   ========================================================================= */
function liveFxParams() {
  const v = computeVoiceParams({
    voicePreset: getVal("live-fx-preset", "normal"),
    pitchOffset: parseInt(getVal("live-fx-pitch", "0"), 10) || 0,
    formantTilt: 0,
  });
  v.rate = Math.min(2.5, Math.max(0.4, v.rate));
  return v;
}

function bindLiveFxControls() {
  const presetSel = document.getElementById("live-fx-preset");
  const pitch = document.getElementById("live-fx-pitch");
  const modeSel = document.getElementById("live-mode");
  if (presetSel) {
    const grouped = new Set(VOICE_GROUPS.flatMap(([, ids]) => ids));
    const groups = [...VOICE_GROUPS];
    const other = Object.keys(VOICE_PRESETS).filter((id) => !grouped.has(id));
    if (other.length) groups.push(["Other", other]);
    presetSel.innerHTML = groups
      .map(([label, ids]) =>
        `<optgroup label="${label}">` +
        ids.filter((id) => VOICE_PRESETS[id])
          .map((id) => `<option value="${id}">${id === "normal" ? "Normal (no change)" : voiceLabel(id)}</option>`)
          .join("") +
        `</optgroup>`)
      .join("");
    if (VOICE_PRESETS[appSettings.liveFxPreset]) presetSel.value = appSettings.liveFxPreset;
    presetSel.addEventListener("change", () => {
      updateSetting("liveFxPreset", presetSel.value);
      if (liveFxActive) swapLiveFxChain();
    });
  }
  if (pitch) {
    const label = document.getElementById("live-fx-pitch-label");
    const showLabel = () => {
      const v = parseInt(pitch.value, 10) || 0;
      if (label) label.textContent = "Extra pitch: " + (v > 0 ? "+" + v : v);
    };
    pitch.value = Number.isFinite(appSettings.liveFxPitch) ? appSettings.liveFxPitch : 0;
    showLabel();
    pitch.addEventListener("input", () => {
      showLabel();
      updateSetting("liveFxPitch", parseInt(pitch.value, 10) || 0);
      // Only the ratio changes, so update it in place instead of rebuilding nodes mid-drag.
      if (liveFxActive && livePitchNode) livePitchNode.parameters.get("ratio").setTargetAtTime(liveFxParams().rate, audioCtx.currentTime, 0.03);
    });
  }
  const levelToggle = document.getElementById("live-fx-level-toggle");
  if (levelToggle) {
    liveFxAutoLevel = appSettings.liveFxAutoLevel !== false;
    levelToggle.classList.toggle("active", liveFxAutoLevel);
    levelToggle.addEventListener("click", () => {
      liveFxAutoLevel = levelToggle.classList.toggle("active");
      updateSetting("liveFxAutoLevel", liveFxAutoLevel);
      liveFxLevelSmooth = 1;
      if (!liveFxAutoLevel && liveFxLevel) liveFxLevel.gain.setTargetAtTime(1, audioCtx.currentTime, 0.1);
    });
  }
  document.getElementById("live-fx-monitor-toggle")?.addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
    if (liveFxOut) {
      try { liveFxOut.disconnect(audioCtx.destination); } catch {}
      if (e.currentTarget.classList.contains("active") && !micFeedMonitorActive()) liveFxOut.connect(audioCtx.destination);
    }
  });
  if (modeSel) {
    if (appSettings.liveMode === "rvc") modeSel.value = "rvc";
    const applyMode = () => {
      const fx = modeSel.value === "fx";
      const fxPanel = document.getElementById("live-fx-panel");
      const rvcPanel = document.getElementById("live-rvc-panel");
      if (fxPanel) fxPanel.style.display = fx ? "flex" : "none";
      if (rvcPanel) rvcPanel.style.display = fx ? "none" : "flex";
    };
    applyMode();
    modeSel.addEventListener("change", () => { updateSetting("liveMode", modeSel.value); applyMode(); });
  }
}

function liveFxRms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function startLiveFxLevelMatcher() {
  stopLiveFxLevelMatcher();
  liveFxInAnalyser = audioCtx.createAnalyser();
  liveFxInAnalyser.fftSize = 1024;
  liveFxOutAnalyser = audioCtx.createAnalyser();
  liveFxOutAnalyser.fftSize = 1024;
  micMuteGain.connect(liveFxInAnalyser);
  liveFxMix.connect(liveFxOutAnalyser);
  const a = new Float32Array(1024);
  const b = new Float32Array(1024);
  liveFxLevelSmooth = 1;
  liveFxLevelTimer = setInterval(() => {
    if (!liveFxActive || !liveFxAutoLevel || !liveFxLevel) return;
    const ri = liveFxRms(liveFxInAnalyser, a);
    const ro = liveFxRms(liveFxOutAnalyser, b);
    if (ri < 0.008 || ro < 0.002) return;
    const target = Math.min(2.8, Math.max(0.35, ri / ro));
    liveFxLevelSmooth = liveFxLevelSmooth * 0.85 + target * 0.15;
    liveFxLevel.gain.setTargetAtTime(liveFxLevelSmooth, audioCtx.currentTime, 0.15);
  }, 100);
}

function stopLiveFxLevelMatcher() {
  if (liveFxLevelTimer) clearInterval(liveFxLevelTimer);
  liveFxLevelTimer = null;
  try { micMuteGain?.disconnect(liveFxInAnalyser); } catch {}
  try { liveFxMix?.disconnect(liveFxOutAnalyser); } catch {}
  liveFxInAnalyser = null;
  liveFxOutAnalyser = null;
}

function buildLiveFxOutputStage() {
  liveFxMix = audioCtx.createGain();
  liveFxLevel = audioCtx.createGain();
  liveFxLevel.gain.value = 1;
  liveFxLimiter = audioCtx.createDynamicsCompressor();
  liveFxLimiter.threshold.value = -4;
  liveFxLimiter.knee.value = 0;
  liveFxLimiter.ratio.value = 20;
  liveFxLimiter.attack.value = 0.002;
  liveFxLimiter.release.value = 0.12;
  liveFxMix.connect(liveFxLevel).connect(liveFxLimiter).connect(liveFxOut);
}

function attachLiveFxChain(fadeInSec) {
  const v = liveFxParams();
  const chain = buildVoiceChain(v);
  const fade = audioCtx.createGain();
  const now = audioCtx.currentTime;
  fade.gain.setValueAtTime(fadeInSec > 0 ? 0 : 1, now);
  if (fadeInSec > 0) fade.gain.linearRampToValueAtTime(1, now + fadeInSec);
  livePitchNode.connect(chain.input);
  chain.output.connect(fade);
  fade.connect(liveFxMix);
  chain.start(now);
  livePitchNode.parameters.get("ratio").setTargetAtTime(v.rate, now, fadeInSec > 0 ? 0.03 : 0.001);
  liveFxOut.gain.setTargetAtTime(v.volumeMult, now, 0.03);
  return { chain, fade };
}

function detachLiveFxChain(entry, fadeOutSec) {
  if (!entry) return;
  const { chain, fade } = entry;
  const now = audioCtx.currentTime;
  try { fade.gain.cancelScheduledValues(now); fade.gain.setValueAtTime(fade.gain.value, now); fade.gain.linearRampToValueAtTime(0, now + fadeOutSec); } catch {}
  try { livePitchNode?.disconnect(chain.input); } catch {}
  setTimeout(() => {
    try { chain.output.disconnect(); } catch {}
    try { fade.disconnect(); } catch {}
    try { chain.stop(); } catch {}
  }, Math.max(60, fadeOutSec * 1000 + 40));
}

function connectLiveFxChain() {
  buildLiveFxOutputStage();
  const entry = attachLiveFxChain(0);
  liveFxChain = entry.chain;
  liveFxChainFade = entry.fade;
  startLiveFxLevelMatcher();
}

function swapLiveFxChain() {
  if (!liveFxActive || !livePitchNode || !liveFxMix) return;
  const old = liveFxChain ? { chain: liveFxChain, fade: liveFxChainFade } : null;
  const entry = attachLiveFxChain(0.05);
  liveFxChain = entry.chain;
  liveFxChainFade = entry.fade;
  detachLiveFxChain(old, 0.05);
  liveFxLevelSmooth = 1;
  if (liveFxLevel) liveFxLevel.gain.setTargetAtTime(1, audioCtx.currentTime, 0.1);
}

function teardownLiveFxChain() {
  stopLiveFxLevelMatcher();
  try { livePitchNode?.disconnect(); } catch {}
  if (liveFxChain) detachLiveFxChain({ chain: liveFxChain, fade: liveFxChainFade }, 0.01);
  liveFxChain = null;
  liveFxChainFade = null;
  try { liveFxMix?.disconnect(); } catch {}
  try { liveFxLevel?.disconnect(); } catch {}
  try { liveFxLimiter?.disconnect(); } catch {}
  liveFxMix = null;
  liveFxLevel = null;
  liveFxLimiter = null;
}

async function startLiveFx() {
  if (liveFxActive || liveVoiceActive) return;
  if (!liveMicSource || !micMuteGain) {
    showToast("⚠️ No live microphone connected — pick one in Audio settings first");
    return;
  }
  const startBtn = document.getElementById("live-start-btn");
  const stopBtn = document.getElementById("live-stop-btn");
  const statusEl = document.getElementById("live-status");
  startBtn.disabled = true;
  try {
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (!liveFxWorkletReady) {
      await audioCtx.audioWorklet.addModule("pitch-shifter-worklet.js");
      liveFxWorkletReady = true;
    }
    livePitchNode = new AudioWorkletNode(audioCtx, "pitch-shifter", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      // The shifter reads one channel, so make the browser down-mix a stereo mic.
      channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
    });
  } catch (e) {
    console.error("Instant effects failed to start:", e);
    startBtn.disabled = false;
    statusEl.textContent = "⚠️ Couldn't start the effects engine";
    statusEl.className = "rvc-backend-status missing";
    showToast("⚠️ Couldn't start Instant effects: " + (e?.message || "audio engine error"));
    return;
  }

  try { livePitchNode.onprocessorerror = () => { console.error("Pitch shifter processor error"); if (liveFxActive) stopLiveFx(); }; } catch {}
  liveFxOut = audioCtx.createGain();
  liveFxOut.connect(micSendGain);
  if (document.getElementById("live-fx-monitor-toggle")?.classList.contains("active") && !micFeedMonitorActive()) liveFxOut.connect(audioCtx.destination);

  // Raw mic goes to the effects node instead of straight to the virtual mic,
  // so Discord hears only the changed voice.
  try { micMuteGain.disconnect(micSendGain); } catch {}
  micMuteGain.connect(livePitchNode);
  liveFxActive = true;
  connectLiveFxChain();

  startBtn.disabled = false;
  startBtn.style.display = "none";
  stopBtn.style.display = "inline-block";
  document.getElementById("live-mode").disabled = true;
  statusEl.textContent = "🟢 Live · instant effects";
  statusEl.className = "rvc-backend-status ready";
}

async function stopLiveFx() {
  if (!liveFxActive) return;
  liveFxActive = false;
  try { micMuteGain?.disconnect(livePitchNode); } catch {}
  teardownLiveFxChain();
  try { liveFxOut?.disconnect(); } catch {}
  liveFxOut = null;
  livePitchNode = null;
  // Restore normal mic routing into the shared virtual-mic bus.
  try { micMuteGain?.connect(micSendGain); } catch {}

  document.getElementById("live-start-btn").style.display = "inline-block";
  document.getElementById("live-stop-btn").style.display = "none";
  document.getElementById("live-mode").disabled = false;
  const statusEl = document.getElementById("live-status");
  statusEl.textContent = "Idle";
  statusEl.className = "rvc-backend-status";
}
