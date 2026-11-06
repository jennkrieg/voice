import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCallerId, classifyHealth, type PoolNumber } from "../src/dialer/caller-id.ts";
import { areaCodeOf, stateOfNumber } from "../src/lib/area-codes.ts";

const n = (e164: string, over: Partial<PoolNumber> = {}): PoolNumber => ({ e164, outboundEnabled: true, restedUntil: null, dailyCap: 75, usedToday: 0, ...over });
const POOL = [n("+12125550100"), n("+14155550100"), n("+13105550100"), n("+15125550100")]; // NYC, SF, LA, Austin

test("area code helpers", () => {
  assert.equal(areaCodeOf("+14155550199"), "415");
  assert.equal(areaCodeOf("+442079460958"), null);
  assert.equal(stateOfNumber("+16285550100"), "CA"); // SF overlay
  assert.equal(stateOfNumber("+17375550100"), "TX");
});

test("matches the contact's area code first", () => {
  assert.deepEqual(pickCallerId({ contactPhone: "+14155559999", pool: POOL, localPresence: true }), { e164: "+14155550100", reason: "same_area_code" });
});

test("falls back to a number in the same state, then the business number", () => {
  // 628 is San Francisco (CA) but we have no 628 number -> a CA number.
  const r = pickCallerId({ contactPhone: "+16285559999", pool: POOL, localPresence: true })!;
  assert.equal(r.reason, "same_state");
  assert.ok(["+14155550100", "+13105550100"].includes(r.e164));
  // Ohio contact, no OH numbers -> business number.
  assert.deepEqual(pickCallerId({ contactPhone: "+16145559999", pool: POOL, businessNumber: "+15125550100", localPresence: true }), { e164: "+15125550100", reason: "business_number" });
});

test("local presence off always uses the business number", () => {
  assert.equal(pickCallerId({ contactPhone: "+14155559999", pool: POOL, businessNumber: "+12125550100", localPresence: false })!.e164, "+12125550100");
});

test("re-uses the number the person saw before", () => {
  assert.deepEqual(pickCallerId({ contactPhone: "+14155559999", pool: POOL, previousNumber: "+12125550100", localPresence: true }), { e164: "+12125550100", reason: "previous_number" });
});

test("skips numbers that are disabled, resting, or at their daily cap", () => {
  const tomorrow = new Date(Date.now() + 86400_000);
  const pool = [n("+14155550100", { usedToday: 75 }), n("+14155550101", { restedUntil: tomorrow }), n("+14155550102", { outboundEnabled: false }), n("+14155550103", { usedToday: 10 })];
  assert.equal(pickCallerId({ contactPhone: "+14155559999", pool, localPresence: true })!.e164, "+14155550103");
  // Previous number at its cap -> pick another.
  assert.equal(pickCallerId({ contactPhone: "+14155559999", pool, previousNumber: "+14155550100", localPresence: true })!.e164, "+14155550103");
  assert.equal(pickCallerId({ contactPhone: "+14155559999", pool: pool.slice(0, 3), localPresence: true }), null);
});

test("spreads load across same-area numbers (least used first)", () => {
  const pool = [n("+14155550100", { usedToday: 40 }), n("+14155550101", { usedToday: 5 })];
  assert.equal(pickCallerId({ contactPhone: "+14155559999", pool, localPresence: true })!.e164, "+14155550101");
});

test("number health flags likely spam labels", () => {
  assert.equal(classifyHealth({ attempts: 5, answered: 0, shortCalls: 0 }).status, "new");
  assert.equal(classifyHealth({ attempts: 100, answered: 35, shortCalls: 5 }).status, "good");
  assert.equal(classifyHealth({ attempts: 100, answered: 15, shortCalls: 2 }).status, "watch");
  assert.equal(classifyHealth({ attempts: 100, answered: 6, shortCalls: 1 }).status, "at_risk");
  assert.equal(classifyHealth({ attempts: 100, answered: 30, shortCalls: 25 }).status, "at_risk");
});
