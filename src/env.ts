import "dotenv/config";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  /** Master key for the platform owner (you). Creates tenants (your clients). */
  PLATFORM_ADMIN_KEY: z.string().min(16).optional(),
  /** 32-byte key (hex or base64) used to encrypt each client's integration secrets at rest. */
  ENCRYPTION_KEY: z.string().optional(),
  /** Postgres URL. Leave empty to use an embedded database in ./data (dev only). */
  DATABASE_URL: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-opus-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VALIDATE_SIGNATURE: bool(true),
  TWILIO_MACHINE_DETECTION: bool(true),

  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-3"),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_DEFAULT_VOICE_ID: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL: z.string().default("eleven_flash_v2_5"),

  /** Google OAuth app (yours) so clients can click "connect Google Calendar". */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  DIALER_ENABLED: bool(true),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = env[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required environment variable ${String(key)}`);
  }
  return v as NonNullable<Env[K]>;
}
