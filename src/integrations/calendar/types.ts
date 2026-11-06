import type { DateTime } from "luxon";
import type { AgentConfig } from "../../agents/config.js";

export interface BookingInput {
  start: DateTime;
  title: string;
  description: string;
  attendee: { name: string; email?: string; phone?: string };
}

export interface BookingResult {
  id: string;
  start: string;
  end: string;
  link?: string;
}

export interface CalendarProvider {
  kind: "google_calendar" | "calcom" | "memory";
  /** Whether the attendee's email is required to book. */
  requiresEmail: boolean;
  openSlots(from: DateTime, to: DateTime, cfg: AgentConfig["calendar"], timezone: string): Promise<DateTime[]>;
  book(input: BookingInput, cfg: AgentConfig["calendar"], timezone: string): Promise<BookingResult>;
}
