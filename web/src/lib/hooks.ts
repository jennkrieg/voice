import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { useSession } from "./session";
import { useToast } from "../components/ui";

/** GET a client-scoped endpoint. Cache keys include the client id so switching clients never mixes data. */
export function useApi<T = any>(path: string | null, opts: Partial<UseQueryOptions<T>> = {}) {
  const { tenantId } = useSession();
  return useQuery<T>({ queryKey: [tenantId ?? "admin", path], queryFn: () => api<T>(path!), enabled: !!path, ...opts });
}

/** Mutation that refreshes all of the current client's data afterwards and toasts errors. */
export function useAction<V = any, R = any>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); onSuccess?: (r: R) => void } = {}) {
  const qc = useQueryClient();
  const { tenantId } = useSession();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [tenantId ?? "admin"] });
      if (opts.success) toast(typeof opts.success === "function" ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e), "error"),
  });
}

export type Agent = { id: string; name: string; config: any; createdAt: string; updatedAt: string };
export type PhoneNumber = { id: string; agentId: string | null; e164: string; twilioSid: string; friendlyName: string | null; createdAt: string };
export type Integration = { id: string; kind: string; label: string | null; settings: any; hasCredentials: boolean; createdAt: string };
export type CallListItem = {
  id: string;
  agentId: string;
  contactId: string | null;
  contactName: string | null;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  status: string;
  outcome: string | null;
  booked: boolean;
  transferredTo: string | null;
  endedBy: string | null;
  durationSeconds: number | null;
  summary: string | null;
  reviewScore: number | null;
  hasRecording: boolean;
  scheduledFor: string | null;
  createdAt: string;
};
