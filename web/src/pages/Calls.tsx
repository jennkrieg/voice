import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { PhoneCall } from "lucide-react";
import { api } from "../lib/api";
import { useApi, type Agent, type CallListItem } from "../lib/hooks";
import { useSession } from "../lib/session";
import { OUTCOME_LABEL, STATUS_LABEL, duration, phone, when } from "../lib/format";
import { Button, Card, Empty, PageHeader, Select, Spinner, Table } from "../components/ui";
import { CallFlags, Direction, OutcomeBadge, Score } from "../components/CallBits";

export function Calls() {
  const nav = useNavigate();
  const { tenantId } = useSession();
  const [filters, setFilters] = useState({ agentId: "", status: "", outcome: "" });
  const agents = useApi<{ agents: Agent[] }>("/api/agents");
  const agentName = (id: string) => agents.data?.agents.find((a) => a.id === id)?.name ?? "–";
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const q = useInfiniteQuery({
    queryKey: [tenantId, "calls", qs],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<{ calls: CallListItem[]; nextBefore: string | null }>(`/api/calls?limit=50&${qs}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.calls.length === 50 ? last.nextBefore : undefined),
  });
  const calls = q.data?.pages.flatMap((p) => p.calls) ?? [];

  return (
    <>
      <PageHeader title="Calls" description="Every call your agents handled, with recordings, transcripts and AI reviews." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-48" value={filters.agentId} onChange={(e) => setFilters({ ...filters, agentId: e.target.value })}>
          <option value="">All agents</option>
          {agents.data?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select className="w-44" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select className="w-48" value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">Any outcome</option>
          {Object.entries(OUTCOME_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        {qs && (
          <Button variant="ghost" onClick={() => setFilters({ agentId: "", status: "", outcome: "" })}>
            Clear filters
          </Button>
        )}
      </div>
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : calls.length === 0 ? (
          <Empty icon={<PhoneCall className="size-8" />} title="No calls match">
            Try different filters.
          </Empty>
        ) : (
          <Table head={["", "Contact", "Agent", "Outcome", "Summary", "Length", "Score", "When"]}>
            {calls.map((c) => (
              <tr key={c.id} className="cursor-pointer align-top hover:bg-slate-50" onClick={() => nav(`/calls/${c.id}`)}>
                <td className="px-4 py-3"><Direction d={c.direction} /></td>
                <td className="whitespace-nowrap px-4 py-3">
                  <div className="font-medium">{c.contactName ?? "Unknown"}</div>
                  <div className="text-xs text-slate-500">{phone(c.direction === "inbound" ? c.fromNumber : c.toNumber)}</div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{agentName(c.agentId)}</td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
                    <OutcomeBadge outcome={c.outcome} status={c.status} />
                    <CallFlags booked={c.booked} transferred={!!c.transferredTo} recording={c.hasRecording} />
                  </span>
                </td>
                <td className="max-w-md px-4 py-3 text-slate-600">
                  <p className="line-clamp-2">{c.summary ?? (c.status === "queued" && c.scheduledFor ? `Scheduled ${when(c.scheduledFor)}` : "–")}</p>
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">{duration(c.durationSeconds)}</td>
                <td className="px-4 py-3"><Score value={c.reviewScore} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500">{when(c.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
