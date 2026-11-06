import { mulawToPcm, pcmToMulaw } from "../audio/mulaw.js";
import { log, errMsg } from "../lib/log.js";

const FRAME = 160; // 20 ms at 8 kHz
const FRAME_MS = 20;
const LEAD_FRAMES = 5; // keep ~100 ms buffered at Twilio to absorb jitter

type AudioSource = (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;

class Utterance {
  pcm: Int16Array[] = [];
  offset = 0; // samples consumed from pcm[0]
  done = false;
  failed = false;
  controller = new AbortController();
  constructor(public text: string) {}

  available(): number {
    let n = -this.offset;
    for (const c of this.pcm) n += c.length;
    return n;
  }

  take(out: Float32Array, from: number, count: number): number {
    let written = 0;
    while (written < count && this.pcm.length) {
      const head = this.pcm[0];
      const n = Math.min(count - written, head.length - this.offset);
      for (let i = 0; i < n; i++) out[from + written + i] += head[this.offset + i];
      written += n;
      this.offset += n;
      if (this.offset >= head.length) {
        this.pcm.shift();
        this.offset = 0;
      }
    }
    return written;
  }
}

/**
 * Plays queued sentences to the caller as paced 20 ms frames, mixing an optional background loop.
 * Text-to-speech for upcoming sentences is fetched in parallel while the current one plays.
 */
export class Speaker {
  private queue: Utterance[] = [];
  private timer: NodeJS.Timeout | null = null;
  private clockStart = 0;
  private framesSent = 0;
  private ambiencePos = 0;
  private drainWaiters: (() => void)[] = [];
  private lastSpeechAt = 0;

  constructor(
    private sendFrame: (mulaw: Uint8Array) => void,
    private clearRemote: () => void,
    private synth: AudioSource,
    private ambience: Float32Array | null,
    private ambienceVolume: number,
    private onSpoken: (text: string) => void,
  ) {
    if (ambience) this.ensureClock();
  }

  /** True while the agent is talking (including audio still buffered at Twilio). */
  get speaking(): boolean {
    return this.queue.length > 0 || Date.now() - this.lastSpeechAt < LEAD_FRAMES * FRAME_MS + 60;
  }

  say(text: string) {
    const u = new Utterance(text);
    this.queue.push(u);
    void (async () => {
      try {
        for await (const chunk of this.synth(text, u.controller.signal)) u.pcm.push(mulawToPcm(chunk));
      } catch (e) {
        if (!u.controller.signal.aborted) {
          u.failed = true;
          log.warn("tts failed", { error: errMsg(e) });
        }
      } finally {
        u.done = true;
      }
    })();
    this.ensureClock();
  }

  /** Stop talking immediately (caller barged in). */
  interrupt() {
    for (const u of this.queue) u.controller.abort();
    this.queue = [];
    this.clearRemote();
    this.lastSpeechAt = 0;
    this.resolveDrain();
  }

  /** Resolves when everything queued has finished playing. */
  drain(): Promise<void> {
    if (!this.speaking) return Promise.resolve();
    return new Promise((r) => this.drainWaiters.push(r));
  }

  stop() {
    for (const u of this.queue) u.controller.abort();
    this.queue = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.resolveDrain();
  }

  private resolveDrain() {
    const w = this.drainWaiters;
    this.drainWaiters = [];
    w.forEach((r) => r());
  }

  private ensureClock() {
    if (this.timer) return;
    this.clockStart = Date.now();
    this.framesSent = 0;
    this.timer = setInterval(() => this.tick(), 10);
  }

  private tick() {
    const due = Math.floor((Date.now() - this.clockStart) / FRAME_MS) + LEAD_FRAMES;
    // If we fell far behind (event loop stall), don't burst; resync.
    if (due - this.framesSent > 50) this.framesSent = due - LEAD_FRAMES;
    while (this.framesSent < due) {
      const frame = new Float32Array(FRAME);
      let hadSpeech = false;
      let filled = 0;
      while (filled < FRAME && this.queue.length) {
        const u = this.queue[0];
        const got = u.take(frame, filled, FRAME - filled);
        filled += got;
        if (got > 0) hadSpeech = true;
        if (u.available() === 0) {
          if (u.done) {
            this.queue.shift();
            if (!u.failed) this.onSpoken(u.text);
            continue;
          }
          break; // waiting on TTS: pad with silence/ambience
        }
      }
      if (this.ambience) {
        const amp = this.ambienceVolume * 32767;
        for (let i = 0; i < FRAME; i++) {
          frame[i] += this.ambience[this.ambiencePos] * amp;
          this.ambiencePos = (this.ambiencePos + 1) % this.ambience.length;
        }
      }
      if (hadSpeech) this.lastSpeechAt = Date.now();
      if (hadSpeech || this.ambience || this.queue.length) this.sendFrame(pcmToMulaw(frame));
      this.framesSent++;
    }
    if (!this.speaking) {
      this.resolveDrain();
      if (!this.ambience && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }
}
