/**
 * A scripted "phone" for end-to-end checks: streams 16 kHz PCM in real time in 20 ms frames (silence in between),
 * receives agent audio and events, and keeps a simulated playback clock (no loudspeaker, so no echo).
 * Used by scripts/e2e-voice.ts and by the server-side self-test (POST /v1/admin/selftest), which runs next to the pod.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import WebSocket from "ws";
import { unpackClientAudio, type ServerMessage } from "@rolly/contracts";
import { StreamResampler } from "../voice/resampler.ts";
import { proxyAgentFor } from "../voice/podClient.ts";

/** scale PCM16 by a gain in dB (used to simulate a quieter second voice) */
export function gainDb(pcm: Uint8Array, db: number): Uint8Array {
  const g = Math.pow(10, db / 20);
  const out = new Uint8Array(pcm.byteLength);
  const i = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength), o = new DataView(out.buffer);
  for (let k = 0; k + 1 < pcm.byteLength; k += 2) o.setInt16(k, Math.max(-32768, Math.min(32767, Math.round(i.getInt16(k, true) * g))), true);
  return out;
}

// ------------------------------------------------------------------ audio helpers
export function wav(pcm: Uint8Array, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export async function userSpeech(text: string, lang: "he" | "en", pod: { url: string; apiKey: string }, cacheDir = "/tmp/rolly-e2e-cache"): Promise<Uint8Array> {
  mkdirSync(cacheDir, { recursive: true });
  const f = resolve(cacheDir, createHash("sha1").update(text).digest("hex").slice(0, 16) + ".pcm16k");
  if (existsSync(f)) return new Uint8Array(readFileSync(f));
  const { fetch, ProxyAgent } = await import("undici");
  const proxy = process.env.HTTPS_PROXY;
  const r = await fetch(pod.url.replace(/\/+$/, "") + "/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${pod.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, language: lang }), ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
  });
  if (!r.ok) throw new Error(`speech endpoint: HTTP ${r.status}`);
  const rate = Number(r.headers.get("x-sample-rate") ?? 22050);
  const raw = new Uint8Array(await r.arrayBuffer());
  const rs = new StreamResampler(rate, 16000);
  const a = rs.push(raw), b = rs.flush();
  const out = new Uint8Array(a.byteLength + b.byteLength); out.set(a); out.set(b, a.byteLength);
  writeFileSync(f, out);
  return out;
}

// ------------------------------------------------------------------ the scripted phone
export interface Turn { seq: number; firstAt: number | null; bytes: number; chunks: Uint8Array[]; text: string; done: boolean; interrupted: boolean; proactive: boolean }

export class Phone {
  ws!: WebSocket;
  events: { t: number; msg: ServerMessage }[] = [];
  turns = new Map<number, Turn>();
  t0 = Date.now();
  queue: Uint8Array[] = [];
  closed = false;
  private mic: NodeJS.Timeout | null = null;

  async connect(url: string) {
    const agent = url.startsWith("wss:") ? proxyAgentFor(url) : undefined;
    this.ws = new WebSocket(url, { perMessageDeflate: false, ...(agent ? { agent } : {}) });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); this.ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
    this.ws.on("message", (raw, bin) => {
      const now = Date.now();
      if (bin) {
        const b = raw as Buffer;
        const { seq, pcm } = unpackClientAudio(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        const t = this.turn(seq);
        if (t.firstAt === null) t.firstAt = now;
        t.bytes += pcm.byteLength; t.chunks.push(pcm.slice());
        return;
      }
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.events.push({ t: now, msg });
      if (msg.type === "agent.turn_started") this.turn(msg.seq).proactive = msg.proactive;
      if (msg.type === "agent.turn_done") { const t = this.turn(msg.seq); t.done = true; t.text = msg.text; }
      if (msg.type === "agent.interrupted") this.turn(msg.seq).interrupted = true;
      if (msg.type === "session.closed") this.closed = true;
    });
    this.ws.on("close", () => { this.closed = true; });
    // microphone: one 20 ms frame every 20 ms, silence unless an utterance is queued
    const frame = 640;
    let next = Date.now();
    const tick = () => {
      if (this.closed) return;
      const now = Date.now();
      while (next <= now) {
        const f = this.queue.shift() ?? new Uint8Array(frame);
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(f, { binary: true });
        next += 20;
      }
      this.mic = setTimeout(tick, Math.max(1, next - Date.now()));
    };
    tick();
  }

  turn(seq: number): Turn {
    let t = this.turns.get(seq);
    if (!t) { t = { seq, firstAt: null, bytes: 0, chunks: [], text: "", done: false, interrupted: false, proactive: false }; this.turns.set(seq, t); }
    return t;
  }

  send(m: Record<string, unknown>) { this.ws.send(JSON.stringify(m)); }

  /** queue an utterance; resolves with the wall time at which its last frame is sent */
  say(pcm: Uint8Array): Promise<number> {
    const frames: Uint8Array[] = [];
    for (let o = 0; o < pcm.byteLength; o += 640) { const f = new Uint8Array(640); f.set(pcm.subarray(o, Math.min(pcm.byteLength, o + 640))); frames.push(f); }
    const startAt = Date.now() + this.queue.length * 20;
    this.queue.push(...frames);
    const endAt = startAt + frames.length * 20;
    return new Promise((r) => setTimeout(() => r(endAt), Math.max(0, endAt - Date.now())));
  }

  playbackEnd(t: Turn): number { return (t.firstAt ?? Date.now()) + (t.bytes / 2 / 24000) * 1000; }

  async waitFor(pred: () => boolean, ms: number, what: string) {
    const until = Date.now() + ms;
    while (!pred()) { if (Date.now() > until) throw new Error(`timeout waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
  }

  /** wait until a new agent turn after `after` is done and its audio would have finished playing */
  async waitReply(after: number, ms = 30_000): Promise<Turn> {
    let found: Turn | undefined;
    await this.waitFor(() => { found = [...this.turns.values()].find((t) => t.firstAt !== null && t.firstAt > after); return !!found; }, ms, "agent audio");
    await this.waitFor(() => found!.done || found!.interrupted, ms, "agent turn done");
    const end = this.playbackEnd(found!);
    if (end > Date.now()) await new Promise((r) => setTimeout(r, end - Date.now()));
    return found!;
  }

  stop() { if (this.mic) clearTimeout(this.mic); }
}

