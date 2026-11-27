/**
 * A stand-in for the GPU worker's WS /v1/session with the same wire protocol (backend/gpu_worker.py), for tests.
 * "Speech" = PCM frames whose RMS is above a threshold. After 200 ms of silence following speech the fake emits
 * speech_stopped, a final transcript (next line from `script`, with a level_db derived from the frames' loudness), then an
 * agent reply with audio at 44.1 kHz. Speech arriving while the agent reply is still "playing" interrupts it.
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { packPodAudio } from "../src/voice/podClient.ts";

export interface FakePod {
  url: string;
  starts: Record<string, unknown>[]; // ctx of every session start
  notes: { text: string; turns: number; max_user_words?: number; min_streak?: number }[]; // notes received on the note channel
  texts: string[]; // typed / injected text messages received ({"type":"text"})
  /** bytes of microphone audio received so far */
  audioBytes: number;
  close(): Promise<void>;
}

function rmsDb(pcm: Buffer): number {
  let s = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
}

export function tone(ms: number, rate: number, amp = 0.3, freq = 300): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}

export async function startFakePod(opts: { script: string[]; token?: string; replyMs?: number; language?: string;
  /** what the "model" answers to a given user line (default: "Reply to: <line>"); `ctx` is the session's start context */
  replyText?: (userText: string, ctx: Record<string, unknown>) => string | undefined }): Promise<FakePod> {
  const starts: Record<string, unknown>[] = [];
  const notes: FakePod["notes"] = [];
  const texts: string[] = [];
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  let line = 0;
  let audioBytes = 0;
  server.on("upgrade", (req, socket, head) => {
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => session(ws));
  });
  const session = (ws: WebSocket) => {
    let rid = 0;
    let speaking = false, silenceMs = 0, streamMs = 0, utterDb: number[] = [];
    let agentUntil = 0; // wall ms until which the agent reply "plays"
    let ref: number | null = null;
    const ev = (event: string, data: Record<string, unknown>) => ws.send(JSON.stringify({ type: "event", event, data }));
    const reply = (raw: string, proactive = false) => {
      const id = `r${++rid}`;
      // like the real pipeline: the lookup marker is in the streamed text as the model wrote it (split across two
      // deltas here), removed from the final text, and reported as an event after the turn
      const wantsLookup = raw.includes("<lookup/>");
      const text = raw.replace("<lookup/>", "").trim();
      ev("agent.turn_started", { response_id: id, proactive });
      if (wantsLookup) { ev("agent.text", { response_id: id, delta: text + " " }); ev("agent.text", { response_id: id, delta: "<lookup/>" }); }
      else ev("agent.text", { response_id: id, delta: text });
      const audio = tone(opts.replyMs ?? 1200, 44100, 0.2, 220);
      for (let off = 0; off < audio.length; off += 4410 * 2) ws.send(packPodAudio("agent.audio", { response_id: id }, 44100, audio.subarray(off, off + 4410 * 2)));
      agentUntil = Date.now() + (opts.replyMs ?? 1200);
      // like the real pipeline (providers/modular/pipeline.py): stage timings and raw usage per reply
      ev("metric", { name: "llm_ttft_ms", value_ms: 180, response_id: id });
      ev("metric", { name: "tts_ttfa_ms", value_ms: 95, response_id: id });
      ev("usage", { kind: "llm", prompt_tokens: 900 + rid * 40, completion_tokens: 30, cached_tokens: 800, model: "fake-gemma" });
      ev("usage", { kind: "tts", chars: text.length, audio_s: (opts.replyMs ?? 1200) / 1000, engine: "fake-voice" });
      ev("agent.turn_done", { response_id: id, text, usage: { prompt_tokens: 900 + rid * 40, completion_tokens: 30 } });
      if (wantsLookup) ev("session.lookup_requested", { response_id: id });
      return id;
    };
    ws.once("message", (raw) => {
      const start = JSON.parse(raw.toString());
      starts.push(start.ctx);
      const ctx = (start.ctx ?? {}) as Record<string, unknown>;
      ws.send(JSON.stringify({ type: "ready", describe: { provider_id: "fake-pod" } }));
      if (start.ctx?.proactive && start.ctx?.opener_instruction) reply("Opener from the fake pod.", true);
      let lastRid = `r${rid}`;
      ws.on("message", (m, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(m.toString());
          if (msg.type === "close") ws.close();
          if (msg.type === "text") {
            // typed / injected text: it comes back as a "typed" transcript and the model answers it
            texts.push(String(msg.text));
            ev("user.transcript", { text: String(msg.text), final: true, language: opts.language ?? "he", typed: true });
            lastRid = reply(`Said: ${String(msg.text).slice(0, 60)}`);
          }
          if (msg.type === "note") notes.push({ text: String(msg.text), turns: Number(msg.turns), max_user_words: msg.max_user_words, min_streak: msg.min_streak });
          return;
        }
        const pcm = m as Buffer;
        audioBytes += pcm.length;
        const ms = (pcm.length / 2 / 16000) * 1000;
        streamMs += ms;
        const db = rmsDb(pcm);
        if (db > -45) {
          if (!speaking) {
            speaking = true; utterDb = [];
            ev("user.speech_started", { audio_ms: streamMs });
            if (Date.now() < agentUntil) { ev("agent.interrupted", { response_id: lastRid, detect_audio_ms: streamMs }); agentUntil = 0; }
          }
          utterDb.push(db); silenceMs = 0;
        } else if (speaking) {
          silenceMs += ms;
          if (silenceMs >= 200) {
            speaking = false;
            ev("user.speech_stopped", { audio_end_ms: streamMs - silenceMs });
            const level = utterDb.reduce((a, b) => a + b, 0) / utterDb.length;
            if (ref === null) ref = level;
            const text = opts.script[line++] ?? "(no more lines)";
            ev("user.transcript", { text, final: true, language: opts.language ?? "he", level_db: level, ref_level_db: ref, barge_in: false });
            lastRid = reply(opts.replyText?.(text, ctx) ?? `Reply to: ${text}`);
          }
        }
      });
    });
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`, starts, notes, texts, get audioBytes() { return audioBytes; },
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(() => r()); }),
  };
}
