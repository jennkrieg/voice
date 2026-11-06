import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, ErrorNote, Field, Input } from "../components/ui";

export function Login() {
  const { branding, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: { role: string } }>("/auth/login", { json: { email, password } });
      qc.clear();
      await refresh();
      nav(r.user.role === "platform_admin" ? "/admin" : "/");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          {branding?.logoUrl ? <img src={branding.logoUrl} alt="" className="h-10" /> : <div className="grid size-11 place-items-center rounded-xl bg-brand text-lg font-bold text-white">{(branding?.name ?? "V")[0]}</div>}
          <h1 className="text-xl font-semibold">{branding?.name ?? "Voice Agents"}</h1>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorNote error={error} />
          <Button variant="primary" className="w-full" loading={busy} type="submit">
            Sign in
          </Button>
        </form>
        {branding?.supportEmail && (
          <p className="mt-4 text-center text-xs text-slate-500">
            Need help? <a className="underline" href={`mailto:${branding.supportEmail}`}>{branding.supportEmail}</a>
          </p>
        )}
      </div>
    </div>
  );
}
