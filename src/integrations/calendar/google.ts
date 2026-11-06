import { google, type calendar_v3 } from "googleapis";
import { DateTime, Interval } from "luxon";
import { env, requireEnv } from "../../env.js";
import type { CalendarProvider } from "./types.js";
import { computeOpenSlots } from "./slots.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

export function googleOAuthClient() {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    `${env.PUBLIC_BASE_URL}/oauth/google/callback`,
  );
}

export class GoogleCalendarProvider implements CalendarProvider {
  kind = "google_calendar" as const;
  requiresEmail = false;
  private cal: calendar_v3.Calendar;

  constructor(
    secrets: { refreshToken: string },
    private calendarId = "primary",
  ) {
    const auth = googleOAuthClient();
    auth.setCredentials({ refresh_token: secrets.refreshToken });
    this.cal = google.calendar({ version: "v3", auth });
  }

  async openSlots(from: DateTime, to: DateTime, cfg: Parameters<CalendarProvider["openSlots"]>[2], tz: string) {
    const fb = await this.cal.freebusy.query({
      requestBody: { timeMin: from.toUTC().toISO()!, timeMax: to.toUTC().toISO()!, timeZone: tz, items: [{ id: this.calendarId }] },
    });
    const busy = (fb.data.calendars?.[this.calendarId]?.busy ?? [])
      .filter((b) => b.start && b.end)
      .map((b) => Interval.fromDateTimes(DateTime.fromISO(b.start!), DateTime.fromISO(b.end!)));
    return computeOpenSlots({
      from,
      to,
      timezone: tz,
      businessHours: cfg.businessHours,
      durationMinutes: cfg.durationMinutes,
      bufferMinutes: cfg.bufferMinutes,
      minNoticeMinutes: cfg.minNoticeMinutes,
      busy,
    });
  }

  async book(input: Parameters<CalendarProvider["book"]>[0], cfg: Parameters<CalendarProvider["book"]>[1], tz: string) {
    const end = input.start.plus({ minutes: cfg.durationMinutes });
    // Re-check right before booking: someone may have taken the slot during the call.
    const free = await this.openSlots(input.start, end, { ...cfg, minNoticeMinutes: 0 }, tz);
    if (!free.some((s) => s.toMillis() === input.start.toMillis())) throw new Error("That time is no longer available");
    const ev = await this.cal.events.insert({
      calendarId: this.calendarId,
      sendUpdates: input.attendee.email ? "all" : "none",
      requestBody: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start.toISO()!, timeZone: tz },
        end: { dateTime: end.toISO()!, timeZone: tz },
        attendees: input.attendee.email ? [{ email: input.attendee.email, displayName: input.attendee.name }] : undefined,
      },
    });
    return { id: ev.data.id!, start: input.start.toISO()!, end: end.toISO()!, link: ev.data.htmlLink ?? undefined };
  }
}
