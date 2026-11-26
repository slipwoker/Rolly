import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ClientSessionStart } from "@rolly/contracts";
import type { Config } from "./config.ts";
import { VoiceSession, type ClientSocket, type SessionHooks } from "./voice/session.ts";

export interface ServerDeps {
  config: Config;
  hooks: SessionHooks;
  /** resolves a single-use voice ticket to a user id (consuming it), or null */
  consumeTicket(ticket: string): Promise<string | null>;
  /** extra HTTP routes (auth, memory, progress) */
  routes?: (app: FastifyInstance) => void | Promise<void>;
  health?: () => Promise<Record<string, unknown>>;
}

export const active = new Map<string, VoiceSession>();
/**
 * One live conversation per user. A second voice socket for the same user (a double tap on "start", an app that opened a
 * new session while the previous one was still open) closes the older one: on 2026-11-26 a phone had two sessions open
 * for four minutes, both heard the same speech and both answered.
 */
const liveByUser = new Map<string, VoiceSession>();

function wrap(ws: WebSocket): ClientSocket {
  return {
    sendJson: (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    sendBinary: (b) => { if (ws.readyState === ws.OPEN) ws.send(b, { binary: true }); },
    close: (code, reason) => { try { ws.close(code, reason); } catch { /* ignore */ } },
  };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization"] }, trustProxy: true });

  app.get("/healthz", async () => ({ ok: true, active_sessions: active.size, ...(deps.health ? await deps.health() : {}) }));
  if (deps.routes) await deps.routes(app);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
  app.server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/v1/voice") { socket.destroy(); return; }
    let userId: string | null = null;
    const ticket = url.searchParams.get("ticket");
    if (ticket) userId = await deps.consumeTicket(ticket).catch(() => null);
    else if (config.devAuth && url.searchParams.get("dev_user")) userId = url.searchParams.get("dev_user");
    if (!userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleVoice(ws, userId!, deps, app));
  });
  return app;
}

function handleVoice(ws: WebSocket, userId: string, deps: ServerDeps, app: FastifyInstance) {
  const log = (msg: string, extra?: Record<string, unknown>) => app.log.info({ ...extra, user_id: userId }, msg);
  const session = new VoiceSession(wrap(ws), userId, deps.hooks,
    { url: deps.config.gpuWorkerUrl, apiKey: deps.config.gpuApiKey }, { maxMinutes: deps.config.maxSessionMinutes, log });
  let started = false;
  const startTimer = setTimeout(() => { if (!started) ws.close(4408, "no session.start"); }, 15_000);
  // the phone's audio may arrive while the pod connection is being opened: hold it until the session is up
  const early: Uint8Array[] = [];
  let ready = false;

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      const b = raw as Buffer;
      const pcm = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (ready) session.onClientAudio(pcm);
      else if (started && early.length < 250) early.push(pcm.slice());
      return;
    }
    let m: ClientMessage;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "session.start") {
      if (started) return;
      started = true;
      clearTimeout(startTimer);
      active.set(session.sessionId, session);
      const older = liveByUser.get(userId);
      liveByUser.set(userId, session);
      if (older && older !== session) { log("older live session replaced", { older: older.sessionId }); void older.close("superseded"); }
      await session.start(m as ClientSessionStart);
      ready = true;
      for (const p of early.splice(0)) session.onClientAudio(p);
      return;
    }
    if (ready) session.onClientMessage(m);
  });
  ws.on("close", () => {
    clearTimeout(startTimer);
    if (started) void session.close("client_disconnect");
  });
  void session.finished.then(() => {
    active.delete(session.sessionId);
    if (liveByUser.get(userId) === session) liveByUser.delete(userId);
  });
}
