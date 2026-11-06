import { DateTime, Interval } from "luxon";
import type { BusinessHours, DayKey } from "../../agents/config.js";

const DAY_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface SlotOptions {
  from: DateTime;
  to: DateTime;
  timezone: string;
  businessHours: BusinessHours;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  busy: Interval[];
  now?: DateTime;
  stepMinutes?: number;
}

/** Free appointment start times inside business hours that don't overlap busy time. */
export function computeOpenSlots(o: SlotOptions): DateTime[] {
  const now = (o.now ?? DateTime.now()).setZone(o.timezone);
  const earliest = now.plus({ minutes: o.minNoticeMinutes });
  const step = o.stepMinutes ?? Math.min(30, o.durationMinutes);
  const out: DateTime[] = [];
  let day = o.from.setZone(o.timezone).startOf("day");
  const lastDay = o.to.setZone(o.timezone).startOf("day");

  while (day <= lastDay) {
    const windows = o.businessHours[DAY_KEYS[day.weekday - 1]] ?? [];
    for (const [startS, endS] of windows) {
      const [sh, sm] = startS.split(":").map(Number);
      const [eh, em] = endS.split(":").map(Number);
      const windowEnd = day.set({ hour: eh, minute: em });
      let t = day.set({ hour: sh, minute: sm });
      while (t.plus({ minutes: o.durationMinutes }) <= windowEnd) {
        const slot = Interval.fromDateTimes(
          t.minus({ minutes: o.bufferMinutes }),
          t.plus({ minutes: o.durationMinutes + o.bufferMinutes }),
        );
        if (t >= earliest && t >= o.from && t < o.to && !o.busy.some((b) => b.overlaps(slot))) out.push(t);
        t = t.plus({ minutes: step });
      }
    }
    day = day.plus({ days: 1 });
  }
  return out;
}

/** Pick a short, spread-out list (what a person would offer on the phone). */
export function pickSpread(slots: DateTime[], max = 6): DateTime[] {
  if (slots.length <= max) return slots;
  const byDay = new Map<string, DateTime[]>();
  for (const s of slots) {
    const k = s.toISODate()!;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const picked: DateTime[] = [];
  let round = 0;
  while (picked.length < max) {
    let added = false;
    for (const daySlots of byDay.values()) {
      // morning, afternoon, then fill
      const order = [0, Math.floor(daySlots.length / 2), daySlots.length - 1, ...daySlots.keys()];
      const uniq = [...new Set(order)];
      const s = daySlots[uniq[round]];
      if (s && !picked.includes(s)) {
        picked.push(s);
        added = true;
        if (picked.length >= max) break;
      }
    }
    if (!added) break;
    round++;
  }
  return picked.sort((a, b) => a.toMillis() - b.toMillis());
}

export function spokenTime(dt: DateTime): string {
  return dt.toFormat("cccc, LLLL d 'at' h:mm a").replace(":00 ", " ");
}
