"use strict";

/*
 * Quality helpers for AI voice (RVC) conversion.
 *
 *  1. Quality presets   -> inference settings passed to rvc-python (pitch
 *                          tracker, index strength, consonant protection...).
 *                          Flags are probed from `rvc_python cli --help`, so a
 *                          version that lacks one is never handed an unknown
 *                          argument (that would make every conversion fail).
 *  2. prepareRvcInput   -> mono 44.1 kHz WAV, rumble removed, very quiet clips
 *                          lifted. Always runs: it also fixes inputs the CLI
 *                          can't decode (mp3, m4a, ...), at negligible cost.
 *  3. polishRvcOutput   -> (skipped by the Fast preset unless Clarity is raised)
 *                          level-matches the result to the source, removes DC /
 *                          rumble, restores the top end the voice model leaves
 *                          dull ("Clarity"), and limits peaks so it can't clip.
 *  4. MIX_FILTER        -> vocals + instrumental without the 6 dB drop amix's
 *                          default normalisation causes.
 */

const { spawn, exec } = require("child_process");

/* ------------------------------ presets ---------------------------------- */

// Values are common RVC inference settings:
//   index rate   how strongly the voice model's training-set timbre is blended
//                in (needs a .index file). Higher = closer to the target voice,
//                but too high is the usual cause of a metallic / "robotic" sound
//                (it copies the artefacts of the training data), so presets stay
//                at or below 0.5. Raise it only if the voice doesn't sound enough
//                like the target.
//   protect      shields consonants/breaths from being "voiced"; lower = clearer
//                speech, slightly weaker voice match. (0.5 disables it.)
//   rms mix      0 follows the source loudness envelope, 1 the output's.
//   clarity      0..1, how much of the top end is restored in post-processing.
//                RVC models reproduce the middle of the sound well but leave the
//                highs (air, "s" sounds, breath) dull, which is the "muffled" sound.
// The Settings sliders (rvcIndexRate / rvcClarity) override indexRate / clarity.
// NOTE: the same defaults are mirrored in renderer.js (RVC_PRESET_DEFAULTS).
const QUALITY_PRESETS = {
  fast:     { method: "rmvpe", indexRate: 0.4, protect: 0.33, rmsMix: 0.25, filterRadius: 3, polish: false, clarity: 0 },
  balanced: { method: "rmvpe", indexRate: 0.5, protect: 0.33, rmsMix: 0.25, filterRadius: 3, polish: true,  clarity: 0.35 },
  high:     { method: "rmvpe", indexRate: 0.5, protect: 0.30, rmsMix: 0.20, filterRadius: 3, polish: true,  clarity: 0.6 },
};
const DEFAULT_QUALITY = "balanced";

function normalizeQuality(value) {
  return Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, value) ? value : DEFAULT_QUALITY;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// The values actually used: the person's slider if they set one, else the preset's.
function resolveTuning(quality, settings) {
  const p = QUALITY_PRESETS[normalizeQuality(quality)];
  const s = settings || {};
  return {
    indexRate: isNum(s.rvcIndexRate) ? Math.min(1, Math.max(0, s.rvcIndexRate)) : p.indexRate,
    clarity: isNum(s.rvcClarity) ? Math.min(1, Math.max(0, s.rvcClarity)) : p.clarity,
  };
}

/* --------------------------- rvc-python flags ----------------------------- */

const FLAG_CANDIDATES = {
  method: ["--method", "-me"],
  indexRate: ["--index_rate", "-ir"],
  protect: ["--protect", "-pr"],
  rmsMix: ["--rms_mix_rate", "-rmr"],
  filterRadius: ["--filter_radius", "-fr"],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flagRe = (flag) => new RegExp(`(?:^|[\\s,\\[])${escapeRe(flag)}(?=[\\s,=\\]]|$)`, "m");

// Which of the tunables this rvc-python build understands, as the flag to use.
function parseSupportedFlags(helpText) {
  const text = String(helpText || "");
  const found = {};
  for (const [key, candidates] of Object.entries(FLAG_CANDIDATES)) {
    const flag = candidates.find((c) => flagRe(c).test(text));
    if (flag) found[key] = flag;
  }
  // Older versions have --method but no rmvpe; passing it would be an error.
  if (found.method && !/rmvpe/i.test(text)) delete found.method;
  return found;
}

// Flags the person already put in their command template win over presets.
function templateHasFlag(template, key) {
  return FLAG_CANDIDATES[key].some((c) => new RegExp(`(^|\\s)${escapeRe(c)}(\\s|=|$)`).test(template || ""));
}

function buildQualityArgs(quality, supported, { hasIndex, template, indexRate }) {
  const p = QUALITY_PRESETS[normalizeQuality(quality)];
  const wanted = { method: p.method, protect: p.protect, rmsMix: p.rmsMix, filterRadius: p.filterRadius };
  if (hasIndex) wanted.indexRate = isNum(indexRate) ? indexRate : p.indexRate; // meaningless without an index file
  let args = "";
  for (const [key, value] of Object.entries(wanted)) {
    if (!supported[key] || templateHasFlag(template, key)) continue;
    args += ` ${supported[key]} ${value}`;
  }
  return args;
}

const helpCache = new Map(); // python command -> help text (importing torch is slow; do it once)
function getRvcHelp(python) {
  if (helpCache.has(python)) return Promise.resolve(helpCache.get(python));
  return new Promise((resolve) => {
    exec(`${python} -m rvc_python cli --help`, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      const text = `${stdout || ""}\n${stderr || ""}`;
      if (!err) helpCache.set(python, text); // don't cache a failure (e.g. first run still installing)
      resolve(err ? "" : text);
    });
  });
}

// Extra CLI arguments (with a leading space) for this python + preset + voice.
async function rvcQualityArgs(python, quality, opts) {
  const supported = parseSupportedFlags(await getRvcHelp(python));
  return buildQualityArgs(quality, supported, opts);
}

/* -------------------------------- ffmpeg ---------------------------------- */

function ffmpegBin() {
  try { return require("ffmpeg-static") || "ffmpeg"; } catch { return "ffmpeg"; }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), ["-hide_banner", "-nostdin", "-y", ...args], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`))
    );
  });
}

// { mean, max } in dBFS, or null when it can't be measured / is digital silence.
async function probeVolume(file) {
  try {
    const log = await runFfmpeg(["-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
    const mean = parseFloat((log.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/) || [])[1]);
    const max = parseFloat((log.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/) || [])[1]);
    return Number.isFinite(mean) && Number.isFinite(max) ? { mean, max } : null;
  } catch {
    return null;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Mono 44.1 kHz WAV for the voice model. Returns true on success; callers fall
// back to the original file if this fails.
async function prepareRvcInput(src, dest) {
  try {
    const stats = await probeVolume(src);
    const filters = ["highpass=f=60"]; // rumble / handling noise confuses the pitch tracker
    // A very quiet clip gives the model's feature extractor little to work with.
    if (stats && stats.max < -9 && stats.max > -50) filters.push(`volume=${Math.min(20, -3 - stats.max).toFixed(1)}dB`);
    await runFfmpeg(["-i", src, "-vn", "-af", filters.join(","), "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", dest]);
    return true;
  } catch {
    return false;
  }
}

async function probeSampleRate(file) {
  try {
    const log = await runFfmpeg(["-i", file, "-vn", "-f", "null", "-"]);
    const hz = parseInt((log.match(/(\d+) Hz/) || [])[1], 10);
    return Number.isFinite(hz) ? hz : null;
  } catch {
    return null;
  }
}

// Level-match the converted audio to the reference (the source it came from),
// strip rumble/DC, restore the top end ("clarity"), and keep peaks under about
// -0.5 dBFS. Returns true on success.
//
// Clarity does two things, both scaled by `clarity` (0..1):
//  * a gentle high shelf from 6 kHz (up to +4.5 dB)
//  * a scaled copy of the SOURCE's content above 8 kHz mixed in (-14 dB at low
//    clarity up to full level at 1; speech has little up there, so it stays subtle). Breath and "s"
//    sounds are mostly noise-like and carry little of the speaker's identity, so
//    this gives the dull converted voice its air back without bringing the old
//    voice with it.
async function polishRvcOutput(converted, reference, dest, { clarity = 0 } = {}) {
  try {
    const [conv, ref] = await Promise.all([probeVolume(converted), probeVolume(reference)]);
    let gain = 0;
    if (conv && ref) {
      gain = clamp(ref.mean - conv.mean, -12, 12);
      if (conv.max + gain > -1.5) gain = -1.5 - conv.max; // never boost into clipping
    }
    const c = clamp(clarity, 0, 1);
    const chain = ["highpass=f=40"];
    if (c > 0) chain.push(`highshelf=f=6000:g=${(4.5 * c).toFixed(2)}`);
    chain.push(`volume=${gain.toFixed(2)}dB`);

    if (c > 0 && ref) {
      const rate = (await probeSampleRate(converted)) || 44100;
      const airDb = (-14 + 14 * c).toFixed(1); // clarity 1 = the source's highs at their natural level
      const graph =
        `[0:a]${chain.join(",")}[v];` +
        `[1:a]aresample=${rate},highpass=f=8000,volume=${airDb}dB[air];` +
        `[v][air]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.944:level=0[out]`;
      await runFfmpeg(["-i", converted, "-i", reference, "-filter_complex", graph, "-map", "[out]", "-ar", String(rate), "-c:a", "pcm_s16le", dest]);
    } else {
      chain.push("alimiter=limit=0.944:level=0");
      await runFfmpeg(["-i", converted, "-af", chain.join(","), "-c:a", "pcm_s16le", dest]);
    }
    return true;
  } catch {
    return false;
  }
}

// normalize=0 keeps each input at full level (the default halves both, a 6 dB
// drop); the limiter catches the rare sum that exceeds full scale.
const MIX_FILTER = "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.944:level=0[aout]";

module.exports = {
  QUALITY_PRESETS, DEFAULT_QUALITY, normalizeQuality, resolveTuning,
  parseSupportedFlags, buildQualityArgs, rvcQualityArgs,
  runFfmpeg, probeVolume, prepareRvcInput, polishRvcOutput, MIX_FILTER,
};
