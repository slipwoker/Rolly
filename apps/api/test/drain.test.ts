/** A deploy must not cut conversations (P1-D45): drain on shutdown, hand over with a reconnect, and write turns as they happen. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { active, buildServer, drain, isDraining } from "../src/server.ts";
import { buildContext, emptyMemory } from "../src/persona/promptBuilder.ts";
import type { SessionHooks, SessionTurn } from "../src/voice/session.ts";
import { startFakePod, type FakePod } from "./fakePod.ts";

let pod: FakePod, app: FastifyInstance, port: number;
const finalized: { sessionId: string; endReason: string; turns: SessionTurn[] }[] = [];
const recorded: { sessionId: string; turn: SessionTurn }[] = [];
let heartbeats = 0;

beforeAll(async () => {
  pod = await startFakePod({ script: ["שלום"] });
  const config = { ...loadConfig({ ROLLY_GPU_API_KEY: "k", ROLLY_GPU_WORKER_URL: pod.url, ROLLY_DEV_AUTH: "1" } as NodeJS.ProcessEnv), port: 0 };
  const hooks: SessionHooks = {
    async prepare(userId, sessionId, start) {
      const b = buildContext(emptyMemory(), { language: start.language ?? "he" });
      return { onboarding: b.onboarding, ctx: { session_id: sessionId, user_id: userId, language: b.language, system_prompt: b.system_prompt, opener_instruction: b.opener_instruction,
        proactive: true, journey: {}, profile: b.profile, options: {} } };
    },
    async recordTurn(_u, sessionId, turn) { recorded.push({ sessionId, turn }); },
    async heartbeat() { heartbeats++; },
    async finalize(a) { finalized.push({ sessionId: a.sessionId, endReason: a.endReason, turns: a.turns }); return { ok: true }; },
  };
  app = await buildServer({ config, hooks, consumeTicket: async () => null });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
afterAll(async () => { await app.close(); await pod.close(); });

/** a phone that only listens: what it was told and how the socket closed */
async function connect(user: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?dev_user=${user}`, { perMessageDeflate: false });
  const msgs: { type: string; [k: string]: unknown }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.on("close", (code, reason) => res({ code, reason: reason.toString() })));
  ws.on("message", (raw, bin) => { if (!bin) msgs.push(JSON.parse(raw.toString())); });
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  ws.send(JSON.stringify({ type: "session.start", language: "he" }));
  const until = async (type: string, ms = 5000) => { const t0 = Date.now(); while (!msgs.some((m) => m.type === type)) { if (Date.now() - t0 > ms) throw new Error(`no ${type}`); await new Promise((r) => setTimeout(r, 20)); } };
  await until("session.created");
  return { ws, msgs, closed, until };
}

describe("a deploy does not cut a conversation", () => {
  it("writes each turn as it happens and reports that it is alive", async () => {
    const a = await connect("u-turns");
    await a.until("agent.turn_done");
    await new Promise((r) => setTimeout(r, 50));
    expect(recorded.some((r) => r.turn.role === "agent" && r.turn.text.length > 0)).toBe(true);
    expect(heartbeats).toBeGreaterThanOrEqual(1);
    a.ws.send(JSON.stringify({ type: "session.end" }));
    await a.closed;
  });

  it("waits for a running conversation to finish on its own, then returns without handing anything over", async () => {
    const a = await connect("u-wait");
    const t0 = Date.now();
    const done = drain(10_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(active.size).toBeGreaterThan(0); // still running: drain is waiting
    a.ws.send(JSON.stringify({ type: "session.end" })); // the user says goodbye
    const r = await done;
    expect(r.handedOver).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await a.closed).code).toBe(1000);
    expect(finalized.at(-1)!.endReason).toBe("client_end");
  });
});

describe("while draining", () => {
  it("refuses new voice connections with 503, so the phone retries and lands on the new version", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-late`);
    const status = await new Promise<number>((r) => { ws.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)); ws.on("open", () => r(101)); ws.on("error", () => {}); });
    expect(status).toBe(503);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json().draining).toBe(true);
  });
});
