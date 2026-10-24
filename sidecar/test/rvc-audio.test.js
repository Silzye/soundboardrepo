"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const a = require("../rvc-audio");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rvcaudio-"));
const f = (n) => path.join(tmp, n);
// synthetic tone whose PEAK is `peakDb` dBFS (lavfi's sine is -18 dBFS to begin with)
const tone = (out, peakDb, { ch = 2, sr = 48000, dur = 2, freq = 220 } = {}) =>
  a.runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=${sr}:duration=${dur}`, "-af", `volume=${peakDb + 18}dB`, "-ac", String(ch), out]);

const HELP = `usage: rvc_python cli [-h] -i INPUT -o OUTPUT -mp MODEL
  -pi PITCH, --pitch PITCH
  -ip INDEX, --index INDEX
  -me METHOD, --method METHOD   {harvest,crepe,rmvpe,pm}
  -ir INDEX_RATE, --index_rate INDEX_RATE
  -pr PROTECT, --protect PROTECT
  -rmr RMS_MIX_RATE, --rms_mix_rate RMS_MIX_RATE
  -fr FILTER_RADIUS, --filter_radius FILTER_RADIUS`;

test("flag probing finds the supported tunables", () => {
  const s = a.parseSupportedFlags(HELP);
  assert.deepEqual(s, { method: "--method", indexRate: "--index_rate", protect: "--protect", rmsMix: "--rms_mix_rate", filterRadius: "--filter_radius" });
});

test("probing: only short flags, and no rmvpe -> method is dropped", () => {
  const s = a.parseSupportedFlags("  -ir X\n  -pr X\n  -me METHOD {harvest,pm}");
  assert.deepEqual(s, { indexRate: "-ir", protect: "-pr" });
});

test("probing: a help text with nothing known yields no flags (old behaviour preserved)", () => {
  assert.deepEqual(a.parseSupportedFlags("usage: something else"), {});
  assert.equal(a.buildQualityArgs("balanced", {}, { hasIndex: true, template: "" }), "");
});

test("args: index rate only with an index file; template flags win", () => {
  const s = a.parseSupportedFlags(HELP);
  const noIdx = a.buildQualityArgs("balanced", s, { hasIndex: false, template: "x" });
  assert.ok(!noIdx.includes("index_rate"));
  assert.ok(noIdx.includes("--method rmvpe"));
  const withTpl = a.buildQualityArgs("high", s, { hasIndex: true, template: "py cli -i {input} --protect 0.1 -ir 0.3" });
  assert.ok(!withTpl.includes("--protect") && !withTpl.includes("--index_rate"));
  assert.ok(withTpl.includes("--rms_mix_rate 0.2"));
});

test("unknown quality falls back to balanced", () => {
  assert.equal(a.normalizeQuality("nonsense"), "balanced");
  assert.equal(a.normalizeQuality("toString"), "balanced"); // prototype keys must not pass
  assert.equal(a.normalizeQuality("fast"), "fast");
});

test("prepareRvcInput: stereo 48k quiet clip -> mono 44.1k, lifted to about -3 dB peak", async () => {
  await tone(f("quiet.wav"), -20);
  assert.ok((await a.probeVolume(f("quiet.wav"))).max < -19);
  assert.equal(await a.prepareRvcInput(f("quiet.wav"), f("prep.wav")), true);
  const info = await a.runFfmpeg(["-i", f("prep.wav"), "-f", "null", "-"]);
  assert.match(info, /44100 Hz, mono/);
  const v = await a.probeVolume(f("prep.wav"));
  assert.ok(v.max > -4.5 && v.max < -1.5, `peak was ${v.max}`);
});

test("prepareRvcInput: a loud clip is not boosted", async () => {
  await tone(f("loud.wav"), -2, { ch: 1 });
  await a.prepareRvcInput(f("loud.wav"), f("loudprep.wav"));
  const before = await a.probeVolume(f("loud.wav")), after = await a.probeVolume(f("loudprep.wav"));
  assert.ok(Math.abs(after.max - before.max) < 1.5);
});

test("prepareRvcInput: unreadable input reports failure instead of throwing", async () => {
  fs.writeFileSync(f("garbage.wav"), "not audio");
  assert.equal(await a.prepareRvcInput(f("garbage.wav"), f("nope.wav")), false);
});

test("polishRvcOutput: a too-quiet result is brought up to the source level", async () => {
  await tone(f("src.wav"), -8, { ch: 1 });        // source
  await tone(f("conv.wav"), -18, { ch: 1, sr: 40000 }); // RVC output, 10 dB quieter
  assert.equal(await a.polishRvcOutput(f("conv.wav"), f("src.wav"), f("out.wav")), true);
  const s = await a.probeVolume(f("src.wav")), o = await a.probeVolume(f("out.wav"));
  assert.ok(Math.abs(o.mean - s.mean) < 2, `mean ${o.mean} vs source ${s.mean}`);
  const info = await a.runFfmpeg(["-i", f("out.wav"), "-f", "null", "-"]);
  assert.match(info, /40000 Hz/); // model's sample rate is preserved
});

test("polishRvcOutput: gain is capped at 12 dB so a bad measurement can't blow up the level", async () => {
  await tone(f("cap_src.wav"), -6, { ch: 1 });
  await tone(f("cap_conv.wav"), -45, { ch: 1 });
  await a.polishRvcOutput(f("cap_conv.wav"), f("cap_src.wav"), f("cap_out.wav"));
  const c = await a.probeVolume(f("cap_conv.wav")), o = await a.probeVolume(f("cap_out.wav"));
  assert.ok(Math.abs((o.mean - c.mean) - 12) < 0.6, `applied ${o.mean - c.mean} dB`);
});

test("polishRvcOutput: never clips, even when the source is much louder", async () => {
  await tone(f("hot_src.wav"), -1, { ch: 1 });
  await tone(f("hot_conv.wav"), -6, { ch: 1 });
  await a.polishRvcOutput(f("hot_conv.wav"), f("hot_src.wav"), f("hot_out.wav"));
  const o = await a.probeVolume(f("hot_out.wav"));
  assert.ok(o.max <= -0.4, `peak ${o.max}`);
});

test("mix: both stems keep their level (amix default would drop ~6 dB)", async () => {
  await tone(f("v.wav"), -20, { ch: 1, freq: 300 });
  await tone(f("i.wav"), -20, { ch: 1, freq: 500 });
  await a.runFfmpeg(["-i", f("v.wav"), "-i", f("i.wav"), "-filter_complex", a.MIX_FILTER, "-map", "[aout]", f("mix_fixed.wav")]);
  await a.runFfmpeg(["-i", f("v.wav"), "-i", f("i.wav"), "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]", "-map", "[aout]", f("mix_old.wav")]);
  const fixed = await a.probeVolume(f("mix_fixed.wav")), old = await a.probeVolume(f("mix_old.wav"));
  assert.ok(fixed.max - old.max > 5, `fixed ${fixed.max} vs old ${old.max}`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
