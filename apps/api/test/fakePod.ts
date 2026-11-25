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

export async function startFakePod(opts: { script: string[]; token?: string; replyMs?: number; language?: string }): Promise<FakePod> {
  const starts: Record<string, unknown>[] = [];
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  let line = 0;
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
    const reply = (text: string, proactive = false) => {
      const id = `r${++rid}`;
      ev("agent.turn_started", { response_id: id, proactive });
      ev("agent.text", { response_id: id, delta: text });
      const audio = tone(opts.replyMs ?? 1200, 44100, 0.2, 220);
      for (let off = 0; off < audio.length; off += 4410 * 2) ws.send(packPodAudio("agent.audio", { response_id: id }, 44100, audio.subarray(off, off + 4410 * 2)));
      agentUntil = Date.now() + (opts.replyMs ?? 1200);
      ev("agent.turn_done", { response_id: id, text });
      return id;
    };
    ws.once("message", (raw) => {
      const start = JSON.parse(raw.toString());
      starts.push(start.ctx);
      ws.send(JSON.stringify({ type: "ready", describe: { provider_id: "fake-pod" } }));
      if (start.ctx?.proactive && start.ctx?.opener_instruction) reply("Opener from the fake pod.", true);
      let lastRid = `r${rid}`;
      ws.on("message", (m, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(m.toString());
          if (msg.type === "close") ws.close();
          return;
        }
        const pcm = m as Buffer;
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
            lastRid = reply(`Reply to: ${text}`);
          }
        }
      });
    });
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`, starts,
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(() => r()); }),
  };
}
