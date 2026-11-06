type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => write("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => write("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write("error", m, meta),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
