import fs from "node:fs/promises";

export const SAMPLE_RATE = 8000;
export type AmbiencePreset = "none" | "office" | "call_center" | "coffee_shop" | "custom";

/** Deterministic PRNG so generated loops are identical across restarts. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function normalize(buf: Float32Array, peak = 0.5): Float32Array {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  const k = max ? peak / max : 0;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

/** Crossfade the end into the start so the loop has no click. */
function makeLoopable(buf: Float32Array, fadeSamples = SAMPLE_RATE / 2): Float32Array {
  const n = buf.length - fadeSamples;
  const out = new Float32Array(n);
  out.set(buf.subarray(0, n));
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples;
    out[i] = buf[i] * t + buf[n + i] * (1 - t);
  }
  return out;
}

function brownNoise(len: number, rand: () => number) {
  const out = new Float32Array(len);
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = (last + (rand() * 2 - 1) * 0.02) * 0.998;
    out[i] = last;
  }
  return normalize(out, 1);
}

/** Murmur of distant voices: band-limited noise with slow syllable-rate amplitude modulation. */
function babble(len: number, rand: () => number, voices: number) {
  const out = new Float32Array(len);
  for (let v = 0; v < voices; v++) {
    let lp = 0;
    let hp = 0;
    const rate = 3 + rand() * 3; // syllables per second
    const phase = rand() * Math.PI * 2;
    const pauseEvery = 2 + rand() * 4;
    const gain = 0.4 + rand() * 0.6;
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const white = rand() * 2 - 1;
      lp += 0.25 * (white - lp); // low-pass ~ speech band
      hp = lp - hp * 0.95; // remove rumble
      const syll = Math.max(0, Math.sin(2 * Math.PI * rate * t + phase));
      const phrase = Math.sin((2 * Math.PI * t) / pauseEvery + phase) > -0.3 ? 1 : 0.1;
      out[i] += hp * syll * phrase * gain;
    }
  }
  return normalize(out, 1);
}

function addTransients(out: Float32Array, rand: () => number, perSecond: number, make: (i: number, n: number) => number, len: number, level: number) {
  const count = Math.floor((out.length / SAMPLE_RATE) * perSecond);
  for (let c = 0; c < count; c++) {
    const at = Math.floor(rand() * (out.length - len));
    const amp = level * (0.5 + rand() * 0.5);
    for (let i = 0; i < len; i++) out[at + i] += make(i, len) * amp;
  }
}

/**
 * Synthesised ambience loops (no audio files needed). They're intentionally subtle; for the most
 * realistic result use a real room-tone recording via `ambience.url` (any WAV file).
 */
export function generatePreset(preset: Exclude<AmbiencePreset, "none" | "custom">, seconds = 30): Float32Array {
  const len = (seconds + 0.5) * SAMPLE_RATE;
  const rand = rng(preset.length * 7919);
  const out = new Float32Array(len);
  const room = brownNoise(len, rand);
  const mix = (src: Float32Array, g: number) => src.forEach((v, i) => (out[i] += v * g));

  if (preset === "office") {
    mix(room, 0.5);
    mix(babble(len, rand, 2), 0.12);
    // keyboard clicks
    addTransients(out, rand, 1.5, (i, n) => (rand() * 2 - 1) * Math.exp((-8 * i) / n), 120, 0.25);
  } else if (preset === "call_center") {
    mix(room, 0.35);
    mix(babble(len, rand, 8), 0.45);
    addTransients(out, rand, 2.5, (i, n) => (rand() * 2 - 1) * Math.exp((-8 * i) / n), 100, 0.15);
  } else {
    // coffee_shop
    mix(room, 0.4);
    mix(babble(len, rand, 12), 0.55);
    const f = 2200 + rand() * 1500;
    // cups and spoons
    addTransients(out, rand, 0.6, (i, n) => Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) * Math.exp((-5 * i) / n), 1600, 0.35);
  }
  return makeLoopable(normalize(out, 0.6));
}

/** Parse a PCM WAV (8/16/24/32-bit int or 32-bit float), mix to mono, resample to 8 kHz. */
export function decodeWav(buf: Buffer): Float32Array {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");
  const { channels, rate, bits } = fmt;
  const isFloat = fmt.format === 3 || (fmt.format === 0xfffe && bits === 32);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bytes;
      let v: number;
      if (isFloat) v = data.readFloatLE(p);
      else if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
      else v = (data[p] - 128) / 128;
      sum += v;
    }
    mono[f] = sum / channels;
  }
  if (rate === SAMPLE_RATE) return mono;
  // Average-then-interpolate resample (cheap anti-aliasing for downsampling).
  const ratio = rate / SAMPLE_RATE;
  const out = new Float32Array(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(frames, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let s = 0;
    for (let j = start; j < end; j++) s += mono[j];
    out[i] = s / (end - start);
  }
  return out;
}

const cache = new Map<string, Float32Array>();

/** Returns a loop at 8 kHz, amplitude -1..1, or null for "none". */
export async function loadAmbience(preset: AmbiencePreset, url?: string): Promise<Float32Array | null> {
  if (preset === "none" && !url) return null;
  const key = url ?? preset;
  const hit = cache.get(key);
  if (hit) return hit;
  let loop: Float32Array;
  if (url) {
    const raw = /^https?:\/\//.test(url)
      ? Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).arrayBuffer())
      : await fs.readFile(url);
    loop = normalize(decodeWav(raw), 0.6);
  } else if (preset === "custom" || preset === "none") {
    return null;
  } else {
    loop = generatePreset(preset);
  }
  cache.set(key, loop);
  return loop;
}
