import { DateTime } from "luxon";
import type { CalendarProvider } from "./types.js";

const BASE = "https://api.cal.com/v2";
// Each Cal.com v2 endpoint is versioned separately via this header.
const SLOTS_VERSION = "2024-09-04";
const BOOKINGS_VERSION = "2026-02-25";

/** Cal.com: availability rules live in Cal.com; we only read slots and create bookings. */
export class CalcomProvider implements CalendarProvider {
  kind = "calcom" as const;
  requiresEmail = true;

  constructor(private secrets: { apiKey: string }, private defaultEventTypeId?: number) {}

  private eventTypeId(cfg: { calcomEventTypeId?: number }): number {
    const id = cfg.calcomEventTypeId ?? this.defaultEventTypeId;
    if (!id) throw new Error("No Cal.com event type configured for this agent (calendar.calcomEventTypeId)");
    return id;
  }

  private async call<T>(path: string, version: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secrets.apiKey}`,
        "cal-api-version": version,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; data?: T; error?: { message?: string } };
    if (!res.ok || body.status === "error") {
      throw new Error(`Cal.com ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data as T;
  }

  async openSlots(from: DateTime, to: DateTime, cfg: Parameters<CalendarProvider["openSlots"]>[2], tz: string) {
    const q = new URLSearchParams({
      eventTypeId: String(this.eventTypeId(cfg)),
      start: from.toUTC().toISO()!,
      end: to.toUTC().toISO()!,
      timeZone: tz,
    });
    const data = await this.call<Record<string, { start: string }[]>>(`/slots?${q}`, SLOTS_VERSION);
    const earliest = DateTime.now().plus({ minutes: cfg.minNoticeMinutes });
    return Object.values(data ?? {})
      .flat()
      .map((s) => DateTime.fromISO(s.start, { setZone: true }).setZone(tz))
      .filter((d) => d.isValid && d >= earliest)
      .sort((a, b) => a.toMillis() - b.toMillis());
  }

  async book(input: Parameters<CalendarProvider["book"]>[0], cfg: Parameters<CalendarProvider["book"]>[1], tz: string) {
    if (!input.attendee.email) throw new Error("Cal.com needs the attendee's email address to book");
    const data = await this.call<{ uid: string; id: number; start: string; end: string; meetingUrl?: string; location?: string }>(
      "/bookings",
      BOOKINGS_VERSION,
      {
        method: "POST",
        body: JSON.stringify({
          start: input.start.toUTC().toISO({ suppressMilliseconds: true }),
          eventTypeId: this.eventTypeId(cfg),
          attendee: {
            name: input.attendee.name,
            email: input.attendee.email,
            timeZone: tz,
            ...(input.attendee.phone ? { phoneNumber: input.attendee.phone } : {}),
          },
          metadata: { source: "voice-agent" },
        }),
      },
    );
    return { id: data.uid ?? String(data.id), start: data.start, end: data.end, link: data.meetingUrl ?? data.location };
  }
}
