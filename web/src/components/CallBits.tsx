import { ArrowDownLeft, ArrowUpRight, CalendarCheck, PhoneForwarded, Mic } from "lucide-react";
import { Badge } from "./ui";
import { OUTCOME_LABEL, OUTCOME_TONE, STATUS_LABEL } from "../lib/format";

export function OutcomeBadge({ outcome, status }: { outcome: string | null; status: string }) {
  if (["queued", "dialing", "in_progress"].includes(status)) return <Badge tone={status === "in_progress" ? "green" : "amber"}>{STATUS_LABEL[status]}</Badge>;
  if (!outcome) return <Badge>{STATUS_LABEL[status] ?? status}</Badge>;
  return <Badge tone={OUTCOME_TONE[outcome] ?? "slate"}>{OUTCOME_LABEL[outcome] ?? outcome}</Badge>;
}

export function Direction({ d }: { d: "inbound" | "outbound" }) {
  return d === "inbound" ? (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500" title="Inbound">
      <ArrowDownLeft className="size-3.5 text-sky-500" /> In
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500" title="Outbound">
      <ArrowUpRight className="size-3.5 text-violet-500" /> Out
    </span>
  );
}

export function CallFlags({ booked, transferred, recording }: { booked: boolean; transferred: boolean; recording?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-400">
      {booked && <CalendarCheck className="size-4 text-emerald-600" aria-label="Booked" />}
      {transferred && <PhoneForwarded className="size-4 text-sky-600" aria-label="Transferred" />}
      {recording && <Mic className="size-4" aria-label="Recorded" />}
    </span>
  );
}

export function Score({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-slate-300">–</span>;
  const tone = value >= 8 ? "text-emerald-700 bg-emerald-50" : value >= 6 ? "text-amber-700 bg-amber-50" : "text-red-700 bg-red-50";
  return <span className={`inline-flex min-w-7 justify-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${tone}`}>{value}</span>;
}
