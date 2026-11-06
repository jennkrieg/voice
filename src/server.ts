import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";
import { twilioRouter, voicemailRoute } from "./api/twilio-routes.js";
import { hooksRouter } from "./api/hooks-routes.js";
import { tenantRouter } from "./api/tenant-routes.js";
import { platformRouter } from "./api/platform-routes.js";
import { oauthRouter } from "./api/oauth-routes.js";
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
  app.use("/api", tenantRouter());

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: "invalid request", issues: err.issues });
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
