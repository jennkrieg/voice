import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { env, requireEnv } from "../env.js";
import { log } from "../lib/log.js";

/**
 * Deepgram streaming speech-to-text for 8 kHz μ-law phone audio.
 * Events: "partial" (text, while the person is speaking), "utterance" (final text when they stop).
 */
export class DeepgramStream extends EventEmitter {
  private ws: WebSocket;
  private finals: string[] = [];
  private keepAlive: NodeJS.Timeout;
  private queue: Buffer[] = [];

  constructor(language = "en-US") {
    super();
    const q = new URLSearchParams({
      model: env.DEEPGRAM_MODEL,
      language,
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true",
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${q}`, {
      headers: { Authorization: `Token ${requireEnv("DEEPGRAM_API_KEY")}` },
    });
    this.ws.on("open", () => {
      for (const b of this.queue) this.ws.send(b);
      this.queue = [];
    });
    this.ws.on("message", (raw) => this.onMessage(raw.toString()));
    this.ws.on("error", (e) => log.warn("deepgram error", { error: e.message }));
    this.ws.on("close", () => this.emit("close"));
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.type === "Results") {
      const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (text) this.emit("partial", [...this.finals, text].join(" "));
      if (msg.is_final && text) this.finals.push(text);
      if (msg.speech_final) this.flush();
    } else if (msg.type === "UtteranceEnd") {
      this.flush();
    } else if (msg.type === "SpeechStarted") {
      this.emit("speechStarted");
    }
  }

  private flush() {
    if (!this.finals.length) return;
    const text = this.finals.join(" ").trim();
    this.finals = [];
    if (text) this.emit("utterance", text);
  }

  send(mulaw: Buffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(mulaw);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(mulaw);
  }

  close() {
    clearInterval(this.keepAlive);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    setTimeout(() => this.ws.terminate(), 500);
  }
}
