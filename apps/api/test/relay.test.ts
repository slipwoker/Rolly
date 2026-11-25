import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { buildContext, emptyMemory } from "../src/persona/promptBuilder.ts";
import type { SessionHooks, SessionTurn } from "../src/voice/session.ts";
import { Phone, gainDb } from "../src/selftest/phone.ts";
import { startFakePod, tone, type FakePod } from "./fakePod.ts";

let pod: FakePod, app: FastifyInstance, port: number;
const finalized: { turns: SessionTurn[]; stats: Record<string, unknown>; endReason: string }[] = [];

beforeAll(async () => {
  pod = await startFakePod({ script: ["שלום", "מה נשמע", "רגע", "שקט"], token: "test-key" });
  const config = { ...loadConfig({ ROLLY_GPU_API_KEY: "test-key", ROLLY_GPU_WORKER_URL: pod.url, ROLLY_DEV_AUTH: "1" } as NodeJS.ProcessEnv), port: 0 };
  const hooks: SessionHooks = {
    async prepare(userId, sessionId, start) {
      const b = buildContext(emptyMemory(), { language: start.language ?? "he" });
      return { onboarding: b.onboarding, ctx: { session_id: sessionId, user_id: userId, language: b.language, system_prompt: b.system_prompt,
        opener_instruction: b.opener_instruction, proactive: true, journey: {}, profile: b.profile, options: {} } };
    },
    async finalize(a) { finalized.push(a); return { ok: true }; },
  };
  app = await buildServer({ config, hooks, consumeTicket: async (t) => (t === "good-ticket" ? "u-ticket" : null) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
afterAll(async () => { await app.close(); await pod.close(); });

const speech = (ms: number) => new Uint8Array(tone(ms, 16000, 0.3, 300));

describe("relay phone <-> rolly-api <-> pod", () => {
  it("refuses a voice socket without a valid ticket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?ticket=bad`);
    const status = await new Promise<number>((r) => { ws.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)); ws.on("open", () => r(101)); ws.on("error", () => {}); });
    expect(status).toBe(401);
  });

  it("relays opener, replies, interruption and resamples to 24 kHz with one seq per turn", async () => {
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u1`);
    phone.send({ type: "session.start", language: "he" });

    const opener = await phone.waitReply(0, 5000);
    expect(opener.seq).toBe(1);
    expect(opener.proactive).toBe(true);
    // 1.2 s at 44.1 kHz -> 1.2 s at 24 kHz (16-bit mono)
    expect(Math.abs(opener.bytes / 2 / 24000 - 1.2)).toBeLessThan(0.01);
    expect(pod.starts[0]!.system_prompt).toContain("You are Rolly.");
    expect(pod.starts[0]!.opener_instruction).toContain("journey_start");

    const end1 = await phone.say(speech(600));
    const r1 = await phone.waitReply(end1 - 1, 5000);
    expect(r1.seq).toBe(2);
    expect(r1.text).toBe("Reply to: שלום");

    // second utterance, then barge in while its reply is still playing
    const end2 = await phone.say(speech(600));
    await phone.waitFor(() => [...phone.turns.values()].some((t) => t.firstAt !== null && t.firstAt > end2 - 1), 5000, "reply 2");
    const r2 = [...phone.turns.values()].find((t) => t.firstAt !== null && t.firstAt > end2 - 1)!;
    await phone.say(speech(400));
    await phone.waitFor(() => r2.interrupted, 5000, "agent.interrupted");
    expect(phone.events.find((e) => e.msg.type === "agent.interrupted")?.msg).toMatchObject({ type: "agent.interrupted", seq: r2.seq });

    // a much quieter utterance (another voice?) is marked uncertain
    await phone.waitReply(Date.now() - 1, 5000).catch(() => {});
    await phone.say(gainDb(speech(600), -25));
    await new Promise((r) => setTimeout(r, 600));

    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.closed, 5000, "closed");
    phone.stop();
    const sumMsg = phone.events.find((e) => e.msg.type === "session.summary");
    expect(sumMsg).toBeTruthy();
    const f = finalized.at(-1)!;
    expect(f.endReason).toBe("client_end");
    const users = f.turns.filter((t) => t.role === "user");
    expect(users.map((t) => t.text)).toEqual(["שלום", "מה נשמע", "רגע", "שקט"]);
    expect(users.slice(0, 3).every((t) => t.attribution === "primary")).toBe(true);
    expect(users[3]!.attribution).toBe("uncertain");
    expect(f.stats.interruptions).toBe(1);
    // the interrupted agent turn is stored as interrupted
    expect(f.turns.some((t) => t.role === "agent" && t.meta.interrupted === true)).toBe(true);
  }, 30_000);
});
