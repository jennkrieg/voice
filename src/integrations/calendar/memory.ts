import { DateTime, Interval } from "luxon";
import type { BookingInput, CalendarProvider } from "./types.js";
import { computeOpenSlots } from "./slots.js";

/** In-memory calendar for demos, the terminal simulator, and tests. */
export class MemoryCalendar implements CalendarProvider {
  kind = "memory" as const;
  requiresEmail = false;
  bookings: { start: DateTime; end: DateTime; title: string }[] = [];

  async openSlots(from: DateTime, to: DateTime, cfg: Parameters<CalendarProvider["openSlots"]>[2], tz: string) {
    return computeOpenSlots({
      from,
      to,
      timezone: tz,
      businessHours: cfg.businessHours,
      durationMinutes: cfg.durationMinutes,
      bufferMinutes: cfg.bufferMinutes,
      minNoticeMinutes: cfg.minNoticeMinutes,
      busy: this.bookings.map((b) => Interval.fromDateTimes(b.start, b.end)),
    });
  }

  async book(input: BookingInput, cfg: Parameters<CalendarProvider["book"]>[1]) {
    const end = input.start.plus({ minutes: cfg.durationMinutes });
    if (this.bookings.some((b) => Interval.fromDateTimes(b.start, b.end).overlaps(Interval.fromDateTimes(input.start, end)))) {
      throw new Error("That time is no longer available");
    }
    this.bookings.push({ start: input.start, end, title: input.title });
    return { id: `mem_${this.bookings.length}`, start: input.start.toISO()!, end: end.toISO()! };
  }
}
