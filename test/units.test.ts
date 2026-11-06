import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DateTime, Interval } from "luxon";
import { mulawToPcm, pcmToMulaw } from "../src/audio/mulaw.ts";
import { decodeWav, generatePreset, SAMPLE_RATE } from "../src/audio/ambience.ts";
import { computeOpenSlots, pickSpread, spokenTime } from "../src/integrations/calendar/slots.ts";
import { nextAllowedCallTime } from "../src/dialer/calling-window.ts";
import { SentenceChunker } from "../src/agents/sentences.ts";
import { verifyHubSpotSignatureV3 } from "../src/integrations/crm/hubspot.ts";
import { parseAgentConfig, fillTemplate, templateVars } from "../src/agents/config.ts";
import { toE164 } from "../src/lib/phone.ts";
import { encryptJson, decryptJson, signToken, verifyToken } from "../src/lib/crypto.ts";

test("mu-law round trip stays within quantisation error", () => {
  const pcm = new Int16Array([0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]);
  const back = mulawToPcm(pcmToMulaw(pcm));
  pcm.forEach((v, i) => assert.ok(Math.abs(back[i] - v) <= Math.max(8, Math.abs(v) * 0.04), `${v} -> ${back[i]}`));
});

test("ambience presets generate a loop at 8 kHz with headroom", () => {
  for (const p of ["office", "call_center", "coffee_shop"] as const) {
    const loop = generatePreset(p, 5);
    assert.ok(loop.length >= SAMPLE_RATE * 4.5);
    const peak = loop.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 0.1 && peak <= 0.61, `${p} peak ${peak}`);
  }
});

test("WAV decoder mixes stereo and resamples to 8 kHz", () => {
  const rate = 16000, frames = 1600;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(16000, i * 4);
    data.writeInt16LE(0, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  const out = decodeWav(Buffer.concat([h, data]));
  assert.equal(out.length, 800);
  assert.ok(Math.abs(out[10] - 16000 / 32768 / 2) < 1e-3);
});

test("open slots respect business hours, busy time, buffer and notice", () => {
  const tz = "America/New_York";
  const now = DateTime.fromISO("2026-11-09T08:00", { zone: tz }); // Monday 8am
  const slots = computeOpenSlots({
    from: now,
    to: now.endOf("day"),
    timezone: tz,
    businessHours: { mon: [["09:00", "12:00"]] },
    durationMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 90,
    busy: [Interval.fromDateTimes(DateTime.fromISO("2026-11-09T10:00", { zone: tz }), DateTime.fromISO("2026-11-09T11:00", { zone: tz }))],
    now,
  });
  assert.deepEqual(slots.map((s) => s.toFormat("HH:mm")), ["09:30", "11:00", "11:30"]);
  assert.equal(spokenTime(slots[0]), "Monday, November 9 at 9:30 AM");
  assert.equal(spokenTime(slots[1]), "Monday, November 9 at 11 AM");
});

test("pickSpread spreads choices across days", () => {
  const tz = "UTC";
  const base = DateTime.fromISO("2026-11-09T09:00", { zone: tz });
  const slots = [0, 1, 2].flatMap((d) => [0, 1, 2, 3, 4, 5].map((h) => base.plus({ days: d, hours: h })));
  const picked = pickSpread(slots, 6);
  assert.equal(picked.length, 6);
  assert.equal(new Set(picked.map((p) => p.toISODate())).size, 3);
});

test("calling window: inside hours is now, outside moves to next opening (contact timezone)", () => {
  const hours = { start: "09:00", end: "20:00", days: [1, 2, 3, 4, 5] };
  const inside = DateTime.fromISO("2026-11-09T15:00:00Z"); // 10:00 NY Monday
  assert.equal(nextAllowedCallTime(inside, hours, "America/New_York").toISO(), inside.toUTC().toISO());
  const fridayNight = DateTime.fromISO("2026-11-14T02:00:00Z"); // Fri 21:00 NY
  assert.equal(nextAllowedCallTime(fridayNight, hours, "America/New_York").setZone("America/New_York").toFormat("ccc HH:mm"), "Mon 09:00");
  const early = DateTime.fromISO("2026-11-09T12:00:00Z"); // 4am LA
  assert.equal(nextAllowedCallTime(early, hours, "America/Los_Angeles").setZone("America/Los_Angeles").toFormat("ccc HH:mm"), "Mon 09:00");
});

test("sentence chunker emits whole sentences and keeps abbreviations together", () => {
  const c = new SentenceChunker();
  const out = [...c.push("Sure thing! Dr. Smith has openings "), ...c.push("on Tuesday. Want one? "), ...c.push("Great")];
  // Short fragments ("Sure thing!", "Want one?") are merged with what follows to avoid tiny TTS requests.
  assert.deepEqual(out, ["Sure thing! Dr. Smith has openings on Tuesday."]);
  assert.equal(c.flush(), "Want one? Great");
});

test("HubSpot v3 signature verification", () => {
  const secret = "s3cret", ts = String(Date.now()), body = '[{"objectId":1}]', uri = "https://x.test/hooks/t/hubspot?agentId=a";
  const sig = crypto.createHmac("sha256", secret).update("POST" + uri + body + ts).digest("base64");
  assert.ok(verifyHubSpotSignatureV3({ clientSecret: secret, method: "post", uri, rawBody: body, timestamp: ts, signature: sig }));
  assert.ok(!verifyHubSpotSignatureV3({ clientSecret: secret, method: "POST", uri, rawBody: body + " ", timestamp: ts, signature: sig }));
  assert.ok(!verifyHubSpotSignatureV3({ clientSecret: secret, method: "POST", uri, rawBody: body, timestamp: String(Date.now() - 10 * 60_000), signature: sig }));
});

test("agent config fills nested defaults and greeting templates", () => {
  const cfg = parseAgentConfig({ businessName: "Acme Dental", voice: { voiceId: "abc" } });
  assert.equal(cfg.voice.stability, 0.45);
  assert.equal(cfg.dialer.callingHours.start, "09:00");
  assert.equal(cfg.behaviour.recordCalls, true);
  const g = fillTemplate(cfg.outboundGreeting, templateVars(cfg, { firstName: "Sam" }));
  assert.equal(g, "Hi Sam, this is Alex, a virtual assistant calling from Acme Dental. This call may be recorded. Do you have a minute?");
  assert.throws(() => parseAgentConfig({}));
});

test("phone normalisation", () => {
  assert.equal(toE164("(415) 555-0100"), "+14155550100");
  assert.equal(toE164("1-415-555-0100"), "+14155550100");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("123"), null);
});

test("secrets encryption and signed tokens", () => {
  const blob = encryptJson({ apiKey: "k" });
  assert.deepEqual(decryptJson(blob), { apiKey: "k" });
  const t = signToken({ callId: "c1" }, 60);
  assert.equal(verifyToken<{ callId: string }>(t)?.callId, "c1");
  assert.equal(verifyToken(t.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), null);
});
