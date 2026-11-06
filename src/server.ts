import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";
import { twilioRouter, voicemailRoute } from "./api/twilio-routes.js";
import { hooksRouter } from "./api/hooks-routes.js";
import { tenantRouter } from "./api/tenant-routes.js";
import { platformRouter } from "./api/platform-routes.js";
import { oauthRouter } from "./api/oauth-routes.js";
import { authRouter } from "./api/auth-routes.js";
import fs from "node:fs";
import path from "node:path";
import { handleMediaStream } from "./telephony/call-session.js";
import { log, errMsg } from "./lib/log.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/twilio/voicemail.mp3", voicemailRoute());
  app.use("/twilio", twilioRouter());
  app.use("/hooks", hooksRouter());
  app.use("/oauth", oauthRouter());
  app.use("/platform", platformRouter());
  app.use("/auth", authRouter());
  app.use("/api", tenantRouter());

  // Dashboard (built with `npm run build`): static files + SPA fallback.
  const webDist = path.resolve(process.env.WEB_DIST ?? "web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/|auth\/|platform\/|twilio\/|hooks\/|oauth\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: "invalid request", issues: err.issues });
    const status = (err as { status?: number }).status;
    if (status && ((status >= 400 && status < 500) || status === 503)) return res.status(status).json({ error: errMsg(err) });
    log.error("request failed", { error: errMsg(err) });
    res.status(500).json({ error: errMsg(err) });
  });
  return app;
}

export function createHttpServer() {
  const app = createApp();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/twilio/media")) wss.handleUpgrade(req, socket, head, (ws) => handleMediaStream(ws));
    else socket.destroy();
  });
  return server;
}
