import { env } from "./env.js";
import { initDb } from "./db/index.js";
import { createHttpServer } from "./server.js";
import { startDialer } from "./dialer/dialer.js";
import { log } from "./lib/log.js";
import { ensureBootstrapAdmin } from "./users.js";

await initDb();
await ensureBootstrapAdmin();
const missing: string[] = (["ANTHROPIC_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "ENCRYPTION_KEY"] as const).filter((k) => !env[k]);
if (!env.PLATFORM_ADMIN_EMAIL && !env.PLATFORM_ADMIN_KEY) missing.push("PLATFORM_ADMIN_EMAIL + PLATFORM_ADMIN_PASSWORD (your dashboard login)");
if (missing.length) log.warn("missing configuration (some features will fail until set)", { missing });

const server = createHttpServer();
server.listen(env.PORT, () => log.info("voice agent platform listening", { port: env.PORT, publicUrl: env.PUBLIC_BASE_URL }));
if (env.DIALER_ENABLED && env.TWILIO_ACCOUNT_SID) startDialer();
