export function duration(seconds?: number | null): string {
  if (!seconds) return "–";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function when(iso?: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function phone(e164?: string | null): string {
  if (!e164) return "–";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const OUTCOME_LABEL: Record<string, string> = {
  appointment_booked: "Booked",
  transferred: "Transferred",
  interested_follow_up: "Interested",
  callback_requested: "Callback requested",
  information_provided: "Info provided",
  not_interested: "Not interested",
  do_not_contact: "Do not contact",
  wrong_number: "Wrong number",
  voicemail: "Voicemail",
  caller_hung_up_early: "Hung up early",
  no_conversation: "No conversation",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Failed",
  other: "Other",
};

export type Tone = "green" | "blue" | "amber" | "red" | "slate" | "violet";
export const OUTCOME_TONE: Record<string, Tone> = {
  appointment_booked: "green",
  transferred: "blue",
  interested_follow_up: "violet",
  callback_requested: "amber",
  information_provided: "blue",
  not_interested: "slate",
  do_not_contact: "red",
  wrong_number: "slate",
  voicemail: "slate",
  caller_hung_up_early: "red",
  no_conversation: "slate",
};

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  dialing: "Dialing",
  in_progress: "Live",
  completed: "Completed",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Failed",
  voicemail: "Voicemail",
  canceled: "Canceled",
  skipped: "Skipped",
};

export function pct(n?: number | null) {
  return n == null ? "–" : `${n}%`;
}

export function titleCase(s: string) {
  return s.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
