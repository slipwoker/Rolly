/** When the drain time is up, a conversation that is still running is handed over, not ended (P1-D45). Own file: draining is permanent for the process. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer, drain } from "../src/server.ts";
import { buildContext, emptyMemory } from "../src/persona/promptBuilder.ts";
import type { SessionHooks, SessionTurn } from "../src/voice/session.ts";
import { startFakePod, type FakePod } from "./fakePod.ts";

let pod: FakePod, app: FastifyInstance, port: number;
const finalized: { sessionId: string; endReason: string; turns: SessionTurn[] }[] = [];

beforeAll(async () => {
  pod = await startFakePod({ script: ["שלום"] });
  const config = { ...loadConfig({ ROLLY_GPU_API_KEY: "k", ROLLY_GPU_WORKER_URL: pod.url, ROLLY_DEV_AUTH: "1" } as NodeJS.ProcessEnv), port: 0 };
  const hooks: SessionHooks = {
    async prepare(userId, sessionId, start) {
      const b = buildContext(emptyMemory(), { language: start.language ?? "he" });
      return { onboarding: b.onboarding, ctx: { session_id: sessionId, user_id: userId, language: b.language, system_prompt: b.system_prompt, opener_instruction: b.opener_instruction,
        proactive: true, journey: {}, profile: b.profile, options: {} } };
    },
    async finalize(a) { finalized.push({ sessionId: a.sessionId, endReason: a.endReason, turns: a.turns }); return { ok: true }; },
  };
  app = await buildServer({ config, hooks, consumeTicket: async () => null });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
afterAll(async () => { await app.close(); await pod.close(); });

describe("hand-over", () => {
  it("saves the conversation, closes the phone with 1012 and sends no 'closed' message, so the phone reconnects and resumes it", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-handover`, { perMessageDeflate: false });
    const types: string[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on("close", (code, reason) => res({ code, reason: reason.toString() })));
    ws.on("message", (raw, bin) => { if (!bin) types.push(JSON.parse(raw.toString()).type); });
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
    ws.send(JSON.stringify({ type: "session.start", language: "he" }));
    for (let i = 0; i < 250 && !types.includes("agent.turn_done"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(types).toContain("agent.turn_done"); // a turn was said

    const r = await drain(300); // the time is up almost at once
    expect(r.handedOver).toBe(1);

    const c = await closed;
    expect(c.code).toBe(1012);
    expect(types).not.toContain("session.closed");   // the phone must not think the conversation ended
    expect(types).not.toContain("session.summary");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.endReason).toBe("server_restart");
    expect(finalized[0]!.turns.some((t) => t.role === "agent")).toBe(true); // what was said is kept
  });
});
