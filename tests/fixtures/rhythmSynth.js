/**
 * Deterministic audio with KNOWN rhythm, for testing the rhythm analyser
 * (shared/rhythm/analyzer.js) — used by backend/test_rhythm.js and the
 * browser specs alike. Seeded, so every run produces the same samples.
 *
 *   drums()   a kick / snare / hi-hat groove at a given BPM (optionally
 *             ramping), with the bar's first kick accented — ground truth
 *             for every beat and downbeat
 *   speech()  syllable-like voiced bursts at irregular spacing: onsets, no pulse
 *   tone()    a steady tone: sound, but nothing ever starts
 *   toWav()   any of the above as a 16-bit mono WAV file's bytes
 */

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function drums({ bpm, seconds, sr = 22050, accentDownbeat = true, rampTo = null, seed = 1, offset = 0.1, gain = 1 }) {
  const out = new Float32Array(Math.round(seconds * sr));
  const r = rng(seed);
  const add = (t, f) => {
    const i0 = Math.round(t * sr);
    for (let i = 0; i < sr * 0.25 && i0 + i < out.length; i++) out[i0 + i] += gain * f(i / sr);
  };
  const kick = (amp) => (t) => amp * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9);
  const snare = (amp) => (t) => amp * (r() * 2 - 1) * Math.exp(-t * 22);
  const hat = (amp) => (t) => amp * (r() * 2 - 1) * Math.exp(-t * 80);
  const truth = [];
  let t = offset;
  let i = 0;
  while (t < seconds - 0.3) {
    const bar = i % 4;
    truth.push({ t, down: bar === 0 });
    if (bar === 0) add(t, kick(accentDownbeat ? 0.9 : 0.6));
    if (bar === 2) add(t, kick(0.55));
    if (bar === 1 || bar === 3) add(t, snare(0.35));
    add(t, hat(0.12));
    const cur = rampTo ? bpm + (rampTo - bpm) * (t / seconds) : bpm;
    add(t + 30 / cur, hat(0.08));
    t += 60 / cur;
    i++;
  }
  return { samples: out, sr, truth };
}

export function speech({ seconds, sr = 22050, seed = 7 }) {
  const out = new Float32Array(Math.round(seconds * sr));
  const r = rng(seed);
  let t = 0.2;
  while (t < seconds - 0.5) {
    const len = 0.08 + r() * 0.22;
    const f0 = 110 + r() * 80;
    const i0 = Math.round(t * sr);
    for (let i = 0; i < len * sr && i0 + i < out.length; i++) {
      const x = i / sr;
      const env = Math.sin((Math.PI * x) / len);
      out[i0 + i] += 0.3 * env * (Math.sin(2 * Math.PI * f0 * x) + 0.5 * Math.sin(4 * Math.PI * f0 * x) + 0.2 * (r() * 2 - 1));
    }
    t += len + 0.03 + r() * 0.35 + (r() < 0.12 ? 0.5 + r() * 0.6 : 0);
  }
  return { samples: out, sr };
}

export function tone({ seconds, sr = 22050, freq = 440, amp = 0.25 }) {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return { samples: out, sr };
}

/** 16-bit PCM mono WAV bytes. */
export function toWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}
