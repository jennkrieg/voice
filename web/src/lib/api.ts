export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

const TENANT_KEY = "va_acting_tenant";
export function actingTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}
export function setActingTenant(id: string | null) {
  try {
    if (id) localStorage.setItem(TENANT_KEY, id);
    else localStorage.removeItem(TENANT_KEY);
  } catch {
    /* private mode */
  }
}

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = { "X-Requested-With": "dashboard" };
  if (json) h["Content-Type"] = "application/json";
  const t = actingTenant();
  if (t) h["X-Tenant-Id"] = t;
  return h;
}

function errorMessage(body: any, status: number): string {
  if (body?.issues?.length) {
    return body.issues.map((i: any) => `${(i.path ?? []).join(".") || "value"}: ${i.message}`).join("; ");
  }
  return body?.error ?? `Request failed (${status})`;
}

export async function api<T = any>(path: string, opts: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.json === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: headers(opts.json !== undefined),
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.status), body);
  return body as T;
}

export async function apiBlob(path: string, json?: unknown): Promise<Blob> {
  const res = await fetch(path, {
    method: json === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: headers(json !== undefined),
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, errorMessage(body, res.status), body);
  }
  return res.blob();
}

/** URL for <audio src>: adds the acting tenant for platform admins. */
export function mediaUrl(path: string): string {
  const t = actingTenant();
  return t ? `${path}${path.includes("?") ? "&" : "?"}tenantId=${encodeURIComponent(t)}` : path;
}
