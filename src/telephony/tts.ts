import { env, requireEnv } from "../env.js";
import type { AgentConfig } from "../agents/config.js";

const BASE = "https://api.elevenlabs.io/v1";

export function voiceSettings(cfg: AgentConfig["voice"]) {
  return {
    stability: cfg.stability,
    similarity_boost: cfg.similarityBoost,
    style: cfg.style,
    use_speaker_boost: true,
    speed: cfg.speed,
  };
}

/** Streams μ-law 8 kHz audio (Twilio's format) for one sentence. */
export async function* synthesizeUlaw(text: string, voice: AgentConfig["voice"], signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const voiceId = voice.voiceId ?? env.ELEVENLABS_DEFAULT_VOICE_ID;
  const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=ulaw_8000`, {
    method: "POST",
    signal,
    headers: { "xi-api-key": requireEnv("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: voice.model ?? env.ELEVENLABS_MODEL, voice_settings: voiceSettings(voice) }),
  });
  if (!res.ok || !res.body) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
}

/** MP3 preview so you (or a client) can audition a voice from the dashboard. */
export async function previewVoice(text: string, voice: AgentConfig["voice"]): Promise<Buffer> {
  const voiceId = voice.voiceId ?? env.ELEVENLABS_DEFAULT_VOICE_ID;
  const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": requireEnv("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: voice.model ?? env.ELEVENLABS_MODEL, voice_settings: voiceSettings(voice) }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface VoiceInfo {
  voiceId: string;
  name: string;
  category?: string;
  labels: Record<string, string>;
  previewUrl?: string;
}

/** Voices available on your ElevenLabs account (premade, cloned, and library voices you've added). */
export async function listVoices(): Promise<VoiceInfo[]> {
  const res = await fetch(`${BASE}/voices`, { headers: { "xi-api-key": requireEnv("ELEVENLABS_API_KEY") } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string>; preview_url?: string }[] };
  return body.voices.map((v) => ({ voiceId: v.voice_id, name: v.name, category: v.category, labels: v.labels ?? {}, previewUrl: v.preview_url }));
}
