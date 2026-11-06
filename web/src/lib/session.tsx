import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, actingTenant, setActingTenant } from "./api";

export type Branding = { name: string; logoUrl: string | null; primaryColor: string; supportEmail: string | null };
export type Me = {
  user: { id: string; email: string; name: string | null; role: "platform_admin" | "owner" | "member"; tenantId: string | null };
  tenant: { id: string; name: string; timezone: string } | null;
  branding: Branding;
};

type Ctx = {
  me: Me | null;
  branding: Branding | null;
  loading: boolean;
  isAdmin: boolean;
  /** The client account currently being viewed. */
  tenantId: string | null;
  tenantName: string | null;
  canManage: boolean;
  openTenant: (id: string, name: string) => void;
  leaveTenant: () => void;
  refresh: () => Promise<unknown>;
};
const SessionCtx = createContext<Ctx>(null as never);
export const useSession = () => useContext(SessionCtx);

function applyBrand(b?: Branding | null) {
  if (!b) return;
  document.documentElement.style.setProperty("--color-brand", b.primaryColor);
  document.title = b.name;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), retry: false, staleTime: 60_000 });
  const brandQ = useQuery({ queryKey: ["branding"], queryFn: () => api<Branding>("/auth/branding"), staleTime: Infinity });
  const [acting, setActing] = useState<{ id: string; name: string } | null>(() => {
    const id = actingTenant();
    let name: string | null = null;
    try {
      name = localStorage.getItem("va_acting_tenant_name");
    } catch {
      /* ignore */
    }
    return id ? { id, name: name ?? "Client" } : null;
  });
  const me = meQ.data ?? null;
  const isAdmin = me?.user.role === "platform_admin";
  useEffect(() => applyBrand(brandQ.data ?? me?.branding), [brandQ.data, me]);
  useEffect(() => {
    // Non-admins never act on behalf of another tenant.
    if (me && !isAdmin && acting) {
      setActingTenant(null);
      setActing(null);
    }
  }, [me, isAdmin, acting]);

  const value: Ctx = {
    me,
    branding: brandQ.data ?? me?.branding ?? null,
    loading: meQ.isLoading,
    isAdmin,
    tenantId: isAdmin ? (acting?.id ?? null) : (me?.tenant?.id ?? null),
    tenantName: isAdmin ? (acting?.name ?? null) : (me?.tenant?.name ?? null),
    canManage: isAdmin || me?.user.role === "owner",
    openTenant: (id, name) => {
      setActingTenant(id);
      try {
        localStorage.setItem("va_acting_tenant_name", name);
      } catch {
        /* ignore */
      }
      setActing({ id, name });
      qc.removeQueries({ predicate: (q) => !["me", "branding"].includes(String(q.queryKey[0])) });
    },
    leaveTenant: () => {
      setActingTenant(null);
      setActing(null);
      qc.removeQueries({ predicate: (q) => !["me", "branding"].includes(String(q.queryKey[0])) });
    },
    refresh: () => meQ.refetch(),
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
