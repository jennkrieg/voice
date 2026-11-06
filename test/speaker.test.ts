import { test } from "node:test";
import assert from "node:assert/strict";
import { Speaker } from "../src/telephony/speaker.ts";
import { pcmToMulaw, mulawToPcm } from "../src/audio/mulaw.ts";

/** Fake TTS: 0.3 s of a constant tone per sentence, delivered in two chunks. */
async function* fakeTts(_text: string, signal: AbortSignal) {
  const tone = pcmToMulaw(new Int16Array(1200).fill(8000));
  for (let i = 0; i < 2; i++) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 5));
    yield tone;
  }
}

test("speaker paces 20 ms frames, reports spoken sentences, and drains", async () => {
  const frames: Uint8Array[] = [];
  const spoken: string[] = [];
  const s = new Speaker((f) => frames.push(f), () => {}, fakeTts, null, 0, (t) => spoken.push(t));
  const t0 = Date.now();
  s.say("Hello there.");
  s.say("How can I help?");
  assert.equal(s.speaking, true);
  await s.drain();
  const elapsed = Date.now() - t0;
  assert.deepEqual(spoken, ["Hello there.", "How can I help?"]);
  assert.ok(frames.every((f) => f.length === 160));
  // 2 x 0.3 s of audio must take roughly real time, not be dumped instantly.
  assert.ok(elapsed >= 450, `played too fast: ${elapsed}ms`);
  s.stop();
});

test("interrupt stops speech immediately and clears Twilio's buffer", async () => {
  let cleared = 0;
  const spoken: string[] = [];
  const s = new Speaker(() => {}, () => cleared++, fakeTts, null, 0, (t) => spoken.push(t));
  s.say("This is a long sentence that will be cut off.");
  await new Promise((r) => setTimeout(r, 60));
  s.interrupt();
  assert.equal(cleared, 1);
  assert.equal(s.speaking, false);
  await s.drain();
  assert.deepEqual(spoken, []);
  s.stop();
});

test("ambience keeps playing between sentences and is mixed under speech", async () => {
  const frames: Uint8Array[] = [];
  const loop = new Float32Array(8000).fill(0.5);
  const s = new Speaker((f) => frames.push(f), () => {}, fakeTts, loop, 0.1, () => {});
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(frames.length >= 4, "ambience frames are sent while silent");
  const idle = mulawToPcm(frames[0])[0];
  assert.ok(Math.abs(idle - 0.5 * 0.1 * 32767) < 120, `ambience level ${idle}`);
  s.say("Hi.");
  await s.drain();
  const loudest = Math.max(...frames.map((f) => mulawToPcm(f)[0]));
  assert.ok(loudest > 8000, "speech + ambience mixed");
  s.stop();
});
