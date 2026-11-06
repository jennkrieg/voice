import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, Bot, Building2, Contact, Lightbulb, LogOut, Phone, PhoneCall, Plug, Settings, ShieldCheck, ShieldAlert, ArrowLeft, Menu } from "lucide-react";
import { useState } from "react";
import { useSession } from "../lib/session";
import { api } from "../lib/api";
import { cx } from "./ui";

const CLIENT_NAV = [
  { to: "/", label: "Overview", icon: BarChart3, end: true },
  { to: "/calls", label: "Calls", icon: PhoneCall },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/numbers", label: "Phone numbers", icon: Phone },
  { to: "/spam-protection", label: "Spam protection", icon: ShieldAlert },
  { to: "/contacts", label: "Contacts", icon: Contact },
  { to: "/insights", label: "AI coaching", icon: Lightbulb },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/settings", label: "Settings", icon: Settings },
];
const ADMIN_NAV = [
  { to: "/admin", label: "Clients", icon: Building2, end: true },
  { to: "/admin/team", label: "Admins", icon: ShieldCheck },
];

export function Layout() {
  const { me, branding, isAdmin, tenantId, tenantName, leaveTenant } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const items = isAdmin && !tenantId ? ADMIN_NAV : CLIENT_NAV;

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    leaveTenant();
    qc.clear();
    nav("/login");
  }

  const sidebar = (
    <aside className="flex h-full w-64 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-16 items-center gap-2.5 border-b border-slate-100 px-5">
        {branding?.logoUrl ? <img src={branding.logoUrl} alt="" className="h-7 w-auto" /> : <div className="grid size-8 place-items-center rounded-lg bg-brand text-sm font-bold text-white">{(branding?.name ?? "V")[0]}</div>}
        <span className="truncate font-semibold">{branding?.name ?? "Voice Agents"}</span>
      </div>
      {isAdmin && tenantId && (
        <div className="border-b border-slate-100 px-3 py-3">
          <button
            onClick={() => {
              leaveTenant();
              nav("/admin");
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
          >
            <ArrowLeft className="size-3.5" /> All clients
          </button>
          <div className="mt-1 truncate px-2 text-sm font-semibold text-slate-900">{tenantName}</div>
        </div>
      )}
      {!isAdmin && me?.tenant && <div className="truncate border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">{me.tenant.name}</div>}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {items.map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            end={i.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) => cx("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition", isActive ? "bg-brand-soft text-brand" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")}
          >
            <i.icon className="size-4" />
            {i.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-slate-100 p-3">
        <div className="px-3 pb-2">
          <div className="truncate text-sm font-medium">{me?.user.name ?? me?.user.email}</div>
          <div className="truncate text-xs text-slate-500">{me?.user.email}</div>
        </div>
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
          <LogOut className="size-4" /> Sign out
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-full">
      <div className="hidden lg:block">{sidebar}</div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/30" />
          <div className="relative h-full w-64" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded p-1.5 hover:bg-slate-100" aria-label="Menu">
            <Menu className="size-5" />
          </button>
          <span className="font-semibold">{tenantName ?? branding?.name}</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
