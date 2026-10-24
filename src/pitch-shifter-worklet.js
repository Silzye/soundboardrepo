"use strict";

/*
 * Real-time pitch shifter for Live Voice > Instant effects.
 *
 * How it works
 * ------------
 * Input goes into a ring buffer. A read head trails the write head by a
 * "delay" and plays the buffer back at `ratio` times normal speed (a delay
 * that shrinks or grows by 1 - ratio samples per sample), which is what
 * changes the pitch. The delay can only drift within a short window, so every
 * so often the head must jump to keep up, and that jump is where cheap
 * shifters sound rough.
 *
 * To make the jump inaudible:
 *  1. A pitch tracker (normalised autocorrelation on a 4x-decimated copy of
 *     the input) estimates the voice's period T.
 *  2. A jump is always a whole number of periods, so the waveform on the far
 *     side of the jump is nearly identical to where we left.
 *  3. The exact landing spot is then fine-tuned by cross-correlating the
 *     upcoming audio at the old and new positions (WSOLA-style).
 *  4. The two heads are crossfaded for a couple of milliseconds.
 * Unvoiced sounds (s, f, breaths) have no period, so they jump a fixed
 * distance and rely on the correlation alignment alone.
 *
 * Latency is the head delay, which sweeps between roughly 5 ms and 20 ms
 * (about 13 ms on average) whenever the pitch is being changed.
 * Mono in, mono out. Output is a delayed copy of the input at ratio 1.
 */
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    const sr = sampleRate;

    // Ring buffer of recent input.
    this.size = 1 << 15;
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;

    // Head geometry, in samples.
    this.xfLen = Math.round(0.0025 * sr);              // crossfade length
    this.searchUnvoiced = Math.round(0.0025 * sr);     // alignment search radius without a pitch
    this.dMin = this.xfLen + this.searchUnvoiced + 16; // closest the head may sit behind the write point
    this.dMax = this.dMin + Math.round(0.030 * sr);    // furthest
    this.jumpTarget = Math.round(0.015 * sr);          // preferred jump size
    this.jt = this.jumpTarget;                         // actual jump size: a whole number of periods when voiced
    this.dA = this.dMin;                               // active head delay
    this.dB = 0;                                       // incoming head delay (during a crossfade)
    this.ks = new Int32Array(this.xfLen + 1);          // scratch for the splice search
    this.av = new Float32Array(this.xfLen + 1);
    this.xfPos = -1;                                   // -1 = not crossfading

    // Pitch tracker works on a ~12 kHz copy of the input.
    this.dec = Math.max(1, Math.round(sr / 12000));
    const dsr = sr / this.dec;
    this.dWin = Math.round(0.03 * dsr);
    this.minLag = Math.max(2, Math.floor(dsr / 400));  // 400 Hz
    this.maxLag = Math.ceil(dsr / 70);                 // 70 Hz
    this.dbuf = new Float32Array(2048);
    this.dMask = 2047;
    this.dw = 0;
    this.dcount = 0;
    this.acc = 0;
    this.accN = 0;
    this.hopCount = 0;
    this.hopSize = 320;
    this.period = 0;      // current period estimate in input samples, 0 = unvoiced
    this.voicedHold = 0;
    const need = this.dWin + this.maxLag + 1;
    this.dTmp = new Float32Array(need);
    this.nac = new Float32Array(this.maxLag + 2);
    this.csum = new Float64Array(need + 1); // running sum of squares, for the lag energies
  }

  // 4-point cubic read `d` samples behind the write head.
  read(d) {
    const pos = this.w - d;
    const i = Math.floor(pos);
    const f = pos - i;
    const m = this.mask, b = this.buf;
    const y0 = b[(i - 1) & m], y1 = b[i & m], y2 = b[(i + 1) & m], y3 = b[(i + 2) & m];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  detectPitch() {
    const W = this.dWin, minLag = this.minLag, maxLag = this.maxLag;
    const need = W + maxLag + 1;
    if (this.dcount < need) return;
    const x = this.dTmp, db = this.dbuf, dm = this.dMask;
    for (let k = 0; k < need; k++) x[k] = db[(this.dw - need + k) & dm];
    const base = need - W;

    // Prefix sums of x^2: the energy of any window is then two lookups, so the
    // lag loop below only has to compute the cross-correlation (about half the work).
    const cs = this.csum;
    cs[0] = 0;
    for (let k = 0; k < need; k++) cs[k + 1] = cs[k] + x[k] * x[k];
    const e0 = cs[base + W] - cs[base];
    if (e0 / W < 1e-6) { this.noPitch(); return; } // too quiet to judge

    const nac = this.nac;
    let max = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      const o = base - lag;
      for (let i = 0; i < W; i++) c += x[base + i] * x[o + i];
      const e1 = cs[o + W] - cs[o];
      const v = c / Math.sqrt(e0 * e1 + 1e-12);
      nac[lag] = v;
      if (v > max) max = v;
    }
    if (max < 0.55) { this.noPitch(); return; }

    // Smallest lag that is a local peak and nearly as strong as the best:
    // this avoids locking onto a multiple of the true period.
    let pick = -1;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (nac[lag] >= 0.85 * max && nac[lag] >= nac[lag - 1] && nac[lag] >= nac[lag + 1]) { pick = lag; break; }
    }
    if (pick < 0) { this.noPitch(); return; }

    const y0 = nac[pick - 1], y1 = nac[pick], y2 = nac[pick + 1];
    const den = y0 - 2 * y1 + y2;
    let shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
    if (shift > 1) shift = 1; else if (shift < -1) shift = -1;
    const T = (pick + shift) * this.dec;

    if (this.period > 0 && Math.abs(T / this.period - 1) < 0.25) this.period = 0.5 * this.period + 0.5 * T;
    else this.period = T;
    this.voicedHold = 3;
    this.updateJump();
  }

  updateJump() {
    const T = this.period;
    this.jt = T > 0 ? Math.max(1, Math.round(this.jumpTarget / T)) * T : this.jumpTarget;
  }

  noPitch() {
    if (--this.voicedHold <= 0) { this.period = 0; this.voicedHold = 0; this.updateJump(); }
  }

  // Start a crossfade to a new head position. dir < 0: the delay grew too
  // large, skip ahead. dir > 0: the delay shrank too far, step back.
  startJump(dir, ratio) {
    const T = this.period;
    const voiced = T > 0;
    const jt = this.jt;

    let target = dir < 0 ? this.dA - jt : this.dA + jt;
    if (target < this.dMin + 8) target = this.dMin + 8;
    if (target > this.dMax) target = this.dMax;

    const S = voiced ? Math.min(Math.round(T * 0.25), 160) : this.searchUnvoiced;
    const L = this.xfLen, m = this.mask, b = this.buf;
    const pa = Math.floor(this.w - this.dA);
    // The reference audio and the sample offsets are the same for every
    // candidate, so work them out once.
    const ks = this.ks, av = this.av;
    let ea = 0;
    for (let j = 0; j < L; j++) {
      ks[j] = Math.round(j * ratio);
      const v = b[(pa + ks[j]) & m];
      av[j] = v;
      ea += v * v;
    }

    let best = -Infinity, bestOff = 0;
    for (let off = -S; off <= S; off++) {
      const dTry = target + off;
      if (dTry < this.dMin || dTry > this.dMax + S) continue;
      const pb = Math.floor(this.w - dTry);
      let c = 0, eb = 0;
      for (let j = 0; j < L; j++) {
        const bv = b[(pb + ks[j]) & m];
        c += av[j] * bv;
        eb += bv * bv;
      }
      const score = c / Math.sqrt(ea * eb + 1e-12) - (0.0005 * Math.abs(off)) / (S + 1);
      if (score > best) { best = score; bestOff = off; }
    }
    this.dB = target + bestOff;
    this.xfPos = 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const out = output[0];
    const inp = inputs[0] && inputs[0][0];
    const ratio = parameters.ratio[0];
    // At ratio 1 nothing needs to move, but let the delay glide down to its
    // minimum (0.2% speed change, inaudible) so plain voice has low latency.
    const near1 = Math.abs(ratio - 1) < 0.001;
    const step = near1 ? (this.dA > this.dMin ? -0.002 : 0) : 1 - ratio;
    const buf = this.buf, mask = this.mask;

    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;
      buf[this.w] = x;

      // Decimated copy for the pitch tracker.
      this.acc += x;
      if (++this.accN === this.dec) {
        this.dbuf[this.dw] = this.acc / this.dec;
        this.dw = (this.dw + 1) & this.dMask;
        this.dcount++;
        this.acc = 0;
        this.accN = 0;
      }
      if (++this.hopCount >= this.hopSize) { this.hopCount = 0; this.detectPitch(); }

      if (this.xfPos < 0) {
        if (step > 0 && this.dA >= this.dMin + this.jt + 8) this.startJump(-1, ratio);
        // The delay keeps shrinking during the crossfade (xfLen * (ratio - 1) samples),
        // so start the jump early enough that it cannot hit the floor first.
        else if (step < 0 && this.dA <= this.dMin + Math.ceil(this.xfLen * -step) && !near1) this.startJump(1, ratio);
      }

      let y = this.read(this.dA);
      if (this.xfPos >= 0) {
        const g = 0.5 - 0.5 * Math.cos((Math.PI * this.xfPos) / this.xfLen);
        y = y * (1 - g) + this.read(this.dB) * g;
        this.dB += step;
        if (++this.xfPos >= this.xfLen) { this.dA = this.dB; this.xfPos = -1; this.dA -= step; }
      }
      this.dA += step;
      if (this.dA < 8) this.dA = 8;
      out[i] = y;

      this.w = (this.w + 1) & mask;
    }

    // If anything ever went non-finite the read head would stay broken and the
    // output silent forever, so reset to a clean state instead.
    if (!(this.dA >= 8 && this.dA <= this.size - 64) || !Number.isFinite(this.dB)) {
      this.dA = this.dMin; this.dB = 0; this.xfPos = -1;
    }
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor("pitch-shifter", PitchShifter);
