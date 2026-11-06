import { DateTime } from "luxon";

export interface CallingHours {
  start: string; // HH:MM
  end: string; // HH:MM
  days: number[]; // ISO weekday 1=Mon..7=Sun
}

/** Returns `now` if calling is allowed now, otherwise the next allowed moment (in UTC). */
export function nextAllowedCallTime(now: DateTime, hours: CallingHours, timezone: string): DateTime {
  const local = now.setZone(timezone);
  const [sh, sm] = hours.start.split(":").map(Number);
  const [eh, em] = hours.end.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const day = local.plus({ days: i }).startOf("day");
    if (!hours.days.includes(day.weekday)) continue;
    const open = day.set({ hour: sh, minute: sm });
    const close = day.set({ hour: eh, minute: em });
    if (i === 0 && local >= open && local < close) return now.toUTC();
    if (local < open) return open.toUTC();
  }
  throw new Error("Calling hours have no open days");
}
