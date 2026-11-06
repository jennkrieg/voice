import twilio from "twilio";
import { requireEnv } from "../env.js";

let client: ReturnType<typeof twilio> | null = null;
export function twilioClient() {
  if (!client) client = twilio(requireEnv("TWILIO_ACCOUNT_SID"), requireEnv("TWILIO_AUTH_TOKEN"));
  return client;
}
