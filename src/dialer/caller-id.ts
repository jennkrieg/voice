import { areaCodeOf, stateOfNumber } from "../lib/area-codes.js";

export interface PoolNumber {
  e164: string;
  outboundEnabled: boolean;
  restedUntil: Date | null;
  dailyCap: number;
  usedToday: number;
}

export type CallerIdReason = "previous_number" | "same_area_code" | "same_state" | "business_number" | "least_used";

/**
 * Choose the caller ID for an outbound call:
 *  1. the number this person was called from before (consistency builds recognition and trust),
 *  2. a number with their area code,
 *  3. a number in their state,
 *  4. the business's main number,
 *  5. any other healthy number.
 * Only numbers that are enabled, not resting and under their daily cap are used. Ties go to the least-used number.
 */
export function pickCallerId(opts: {
  contactPhone: string;
  pool: PoolNumber[];
  businessNumber?: string | null;
  previousNumber?: string | null;
  localPresence: boolean;
  now?: Date;
}): { e164: string; reason: CallerIdReason } | null {
  const now = opts.now ?? new Date();
  const eligible = opts.pool
    .filter((n) => n.outboundEnabled && (!n.restedUntil || n.restedUntil <= now) && n.usedToday < n.dailyCap)
    .sort((a, b) => a.usedToday / a.dailyCap - b.usedToday / b.dailyCap);
  if (!eligible.length) return null;
  const find = (pred: (n: PoolNumber) => boolean) => eligible.find(pred)?.e164;

  if (opts.previousNumber) {
    const prev = find((n) => n.e164 === opts.previousNumber);
    if (prev) return { e164: prev, reason: "previous_number" };
  }
  if (opts.localPresence) {
    const ac = areaCodeOf(opts.contactPhone);
    const sameAc = ac && find((n) => areaCodeOf(n.e164) === ac);
    if (sameAc) return { e164: sameAc, reason: "same_area_code" };
    const st = stateOfNumber(opts.contactPhone);
    const sameSt = st && find((n) => stateOfNumber(n.e164) === st);
    if (sameSt) return { e164: sameSt, reason: "same_state" };
  }
  const biz = opts.businessNumber && find((n) => n.e164 === opts.businessNumber);
  if (biz) return { e164: biz, reason: "business_number" };
  return { e164: eligible[0].e164, reason: "least_used" };
}

export interface NumberHealth {
  attempts: number;
  answered: number;
  shortCalls: number;
  answerRate: number;
  status: "good" | "watch" | "at_risk" | "new";
}

/**
 * Spam-label early warning from the last 7 days of outbound calls. A sudden drop in answer rate,
 * or many very short calls, usually means carriers have started showing "Spam Likely".
 */
export function classifyHealth(s: { attempts: number; answered: number; shortCalls: number }): NumberHealth {
  const answerRate = s.attempts ? s.answered / s.attempts : 0;
  let status: NumberHealth["status"] = "good";
  if (s.attempts < 20) status = "new";
  else if (answerRate < 0.1 || s.shortCalls / Math.max(1, s.answered) > 0.6) status = "at_risk";
  else if (answerRate < 0.18) status = "watch";
  return { ...s, answerRate: Math.round(answerRate * 1000) / 1000, status };
}
