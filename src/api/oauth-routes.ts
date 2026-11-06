import express from "express";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import { encryptJson, newId, verifyToken } from "../lib/crypto.js";
import { googleOAuthClient } from "../integrations/calendar/google.js";
import { log, errMsg } from "../lib/log.js";

export function oauthRouter() {
  const r = express.Router();
  r.get("/google/callback", async (req, res) => {
    const state = verifyToken<{ tenantId: string; label?: string; calendarId?: string }>(String(req.query.state ?? ""));
    if (!state || !req.query.code) return res.status(400).send("This link expired. Start the Google connection again.");
    try {
      const { tokens } = await googleOAuthClient().getToken(String(req.query.code));
      if (!tokens.refresh_token) return res.status(400).send("Google didn't return a refresh token. Remove the app's access at myaccount.google.com/permissions and try again.");
      const [row] = await db()
        .insert(schema.integrations)
        .values({
          id: newId("int"),
          tenantId: state.tenantId,
          kind: "google_calendar",
          label: state.label ?? "Google Calendar",
          settings: { calendarId: state.calendarId ?? "primary" },
          secretsEnc: encryptJson({ refreshToken: tokens.refresh_token }),
        })
        .returning();
      res.type("html").send(`<p>Google Calendar connected. Integration id: <code>${row.id}</code>. You can close this tab.</p>`);
    } catch (e) {
      log.error("google oauth failed", { error: errMsg(e) });
      res.status(500).send("Connection failed. Please try again.");
    }
  });
  return r;
}

export const googleConfigured = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
