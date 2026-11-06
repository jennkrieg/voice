import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { SessionProvider, useSession } from "./lib/session";
import { ToastProvider, Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { AdminClients, AdminTeam } from "./pages/Admin";
import { Overview } from "./pages/Overview";
import { Calls } from "./pages/Calls";
import { CallDetail } from "./pages/CallDetail";
import { Agents } from "./pages/Agents";
import { AgentEdit } from "./pages/AgentEdit";
import { Numbers } from "./pages/Numbers";
import { Integrations } from "./pages/Integrations";
import { Contacts } from "./pages/Contacts";
import { Insights } from "./pages/Insights";
import { SettingsPage } from "./pages/Settings";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Guard({ admin, client, children }: { admin?: boolean; client?: boolean; children: React.ReactNode }) {
  const { me, loading, isAdmin, tenantId } = useSession();
  if (loading) return <Spinner className="h-full" />;
  if (!me) return <Navigate to="/login" replace />;
  if (admin && !isAdmin) return <Navigate to="/" replace />;
  if (client && !tenantId) return <Navigate to={isAdmin ? "/admin" : "/login"} replace />;
  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Guard>
            <Layout />
          </Guard>
        }
      >
        <Route path="/admin" element={<Guard admin><AdminClients /></Guard>} />
        <Route path="/admin/team" element={<Guard admin><AdminTeam /></Guard>} />
        <Route path="/" element={<Guard client><Overview /></Guard>} />
        <Route path="/calls" element={<Guard client><Calls /></Guard>} />
        <Route path="/calls/:id" element={<Guard client><CallDetail /></Guard>} />
        <Route path="/agents" element={<Guard client><Agents /></Guard>} />
        <Route path="/agents/:id" element={<Guard client><AgentEdit /></Guard>} />
        <Route path="/numbers" element={<Guard client><Numbers /></Guard>} />
        <Route path="/contacts" element={<Guard client><Contacts /></Guard>} />
        <Route path="/insights" element={<Guard client><Insights /></Guard>} />
        <Route path="/integrations" element={<Guard client><Integrations /></Guard>} />
        <Route path="/settings" element={<Guard client><SettingsPage /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <SessionProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
