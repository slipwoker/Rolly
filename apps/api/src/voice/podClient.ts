/**
 * Client for the GPU worker's `WS /v1/session` (TypeScript port of providers/remote.py).
 * The worker runs the whole voice pipeline; this side only supplies the context and relays audio and events.
 */
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import type { PodSessionContext } from "@rolly/contracts";

export interface PodAudio {
  event: string;
  data: Record<string, unknown>;
  sampleRate: number;
  pcm: Uint8Array;
}

export interface PodHandlers {
  onEvent(event: string, data: Record<string, unknown>): void;
  onAudio(a: PodAudio): void;
  /** the connection ended without close() having been called */
  onLost(reason: string): void;
}

export function sessionUrls(baseUrl: string): { ws: string; describe: string } {
  const b = baseUrl.replace(/\/+$/, "");
  const ws = b.startsWith("https://") ? "wss://" + b.slice(8) : b.startsWith("http://") ? "ws://" + b.slice(7) : b;
  return { ws: ws + "/session", describe: b + "/session/describe" };
}

export function unpackPodAudio(frame: Uint8Array): PodAudio {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const n = dv.getUint32(0, false);
  const head = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + n))) as {
    event: string; data?: Record<string, unknown>; sample_rate?: number;
  };
  return { event: head.event, data: head.data ?? {}, sampleRate: Number(head.sample_rate) || 24000, pcm: frame.subarray(4 + n) };
}

export function packPodAudio(event: string, data: Record<string, unknown>, sampleRate: number, pcm: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ event, data, sample_rate: sampleRate }));
  const out = new Uint8Array(4 + head.byteLength + pcm.byteLength);
  new DataView(out.buffer).setUint32(0, head.byteLength, false);
  out.set(head, 4);
  out.set(pcm, 4 + head.byteLength);
  return out;
}

/** Use the HTTPS proxy from the environment when one is set (development sandbox); Render has none. */
export function proxyAgentFor(url: string): HttpsProxyAgent<string> | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  const host = new URL(url).hostname;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (noProxy.some((p) => host === p || (p.startsWith(".") && host.endsWith(p)) || (p.startsWith("*.") && host.endsWith(p.slice(1))))) {
    return undefined;
  }
  return new HttpsProxyAgent(proxy);
}

export class PodSession {
  private ws: WebSocket | null = null;
  private closed = false;
  describe: Record<string, unknown> = {};

  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly h: PodHandlers) {}

  async start(ctx: PodSessionContext, timeoutMs = 30_000): Promise<void> {
    const { ws: url } = sessionUrls(this.baseUrl);
    const agent = proxyAgentFor(url);
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      maxPayload: 0,
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      ...(agent ? { agent } : {}),
    });
    this.ws = ws;
    // One permanent message handler from the start: events sent right after "ready" can arrive in the same read and
    // are emitted synchronously, before an await continuation could attach a second handler.
    let ready = false;
    let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
    const started = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    const fail = (e: Error) => { if (!ready && settle) { settle.reject(e); settle = null; } };
    const timer = setTimeout(() => fail(new Error("pipeline host did not answer in time")), timeoutMs);
    ws.on("unexpected-response", (_req, res) => fail(new Error(`pipeline host refused: HTTP ${res.statusCode}`)));
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", ctx })));
    ws.on("message", (raw, isBinary) => {
      if (!ready) {
        if (isBinary) return fail(new Error("pipeline host sent audio before ready"));
        let first: { type?: string; describe?: Record<string, unknown> };
        try { first = JSON.parse(raw.toString()); } catch { return fail(new Error("pipeline host sent invalid JSON")); }
        if (first.type !== "ready") return fail(new Error(`pipeline host refused the session: ${JSON.stringify(first).slice(0, 200)}`));
        ready = true;
        clearTimeout(timer);
        this.describe = first.describe ?? {};
        settle?.resolve();
        settle = null;
        return;
      }
      if (isBinary) {
        const buf = raw as Buffer;
        this.h.onAudio(unpackPodAudio(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
        return;
      }
      let msg: { type?: string; event?: string; data?: Record<string, unknown>; message?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "event" && msg.event) this.h.onEvent(msg.event, msg.data ?? {});
      else if (msg.type === "error") this.h.onEvent("error", { message: msg.message ?? "pipeline error", fatal: true });
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      if (!ready) return fail(new Error(`pipeline host closed the connection (${code})`));
      if (!this.closed) this.h.onLost(`connection to the pipeline host was lost (${code})`);
    });
    ws.on("error", (e) => {
      if (!ready) return fail(e instanceof Error ? e : new Error(String(e)));
      if (!this.closed) this.h.onLost(`pipeline connection error: ${String(e).slice(0, 200)}`);
    });
    await started;
    // keep-alive like the research relay (ping every 20 s)
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20_000);
    ws.once("close", () => clearInterval(ping));
  }

  pushAudio(pcm: Uint8Array): void {
    if (this.ws && !this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm, { binary: true });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && !this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendText(text: string): void { this.send({ type: "text", text: text.slice(0, 2000) }); }
  interrupt(): void { this.send({ type: "interrupt" }); }
  /**
   * A note for the model's next `turns` turns (pacing, memory hints). It is shown to the model next to the user's words,
   * never stored in the conversation history and never interrupts speech. A worker without the note channel ignores it.
   */
  note(text: string, turns = 1): void { this.send({ type: "note", text: text.slice(0, 600), turns: Math.min(6, Math.max(1, Math.round(turns))) }); }

  close(): void {
    if (this.closed) return;
    this.send({ type: "close" });
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
