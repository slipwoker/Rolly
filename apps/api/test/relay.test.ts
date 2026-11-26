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
  pod = await startFakePod({ script: ["שלום", "מה נשמע", "רגע", "שקט", "עוד חמש דקות אני מגיע", "תרשום לי משהו", "סתם", "כלום", "בסדר"], token: "test-key",
    // a "model" that falls back on bot-speak, for the style guard
    replyText: (t) => ({ "סתם": "הבנתי אותך.", "כלום": "צודק, נכון.", "בסדר": "בלי טעינה בבית זה לא שווה." } as Record<string, string>)[t] });
  const config = { ...loadConfig({ ROLLY_GPU_API_KEY: "test-key", ROLLY_GPU_WORKER_URL: pod.url, ROLLY_DEV_AUTH: "1" } as NodeJS.ProcessEnv), port: 0 };
  const hooks: SessionHooks = {
    async prepare(userId, sessionId, start) {
      const b = buildContext(emptyMemory(), { language: start.language ?? "he" });
      // "u-pace": a 20-minute ride compressed to 1.2 seconds
      const pace = userId === "u-pace";
      const plan = userId === "u-plan" ? [{ topic: "הגיוס", take: "משקיע קטן" }, { topic: "ספורט", take: "הליכה קצרה" }] : undefined;
      return { onboarding: b.onboarding, pacingScale: pace ? 0.001 : undefined, plan, confirm: userId === "u-plan" ? "אולי גר בחיפה" : null, ctx: { session_id: sessionId, user_id: userId, language: b.language, system_prompt: b.system_prompt,
        opener_instruction: b.opener_instruction, proactive: true, journey: pace ? { duration_min: 20 } : {}, profile: b.profile, options: {} } };
    },
    async onUserTurn({ turn }) { return turn.text.includes("תרשום") ? { text: "NOTE-FROM-HOOK", turns: 1 } : undefined; },
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
    // which voice spoke: all audio arrived at the fake pod's 44.1 kHz (the Hebrew voice's rate), none at another rate
    const byRate = f.stats.voice_s_by_rate as Record<string, number>;
    expect(Object.keys(byRate)).toEqual(["44100"]);
    expect(byRate["44100"]).toBeGreaterThan(1);
    // the interrupted agent turn is stored as interrupted
    expect(f.turns.some((t) => t.role === "agent" && t.meta.interrupted === true)).toBe(true);
  }, 30_000);

  it("paces a ride with notes for the model: halfway, wrap-up, the user's own 'five minutes left', and memory notes", async () => {
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-pace`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000); // opener (1.2 s): "half" is due at 0.66 s and goes out on the 1 s tick
    const end1 = await phone.say(speech(600)); // "עוד חמש דקות אני מגיע"
    await phone.waitReply(end1 - 1, 5000);
    const end2 = await phone.say(speech(600)); // "תרשום לי משהו" -> the hook answers with a note
    await phone.waitReply(end2 - 1, 5000);
    await new Promise((r) => setTimeout(r, 1200)); // one more tick
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.closed, 5000, "closed");
    phone.stop();
    const f = finalized.at(-1)!;
    const kinds = (f.stats.notes as { kind: string }[]).map((n) => n.kind);
    expect(kinds).toContain("pacing_half");
    expect(kinds).toContain("pacing_last");
    expect(kinds).toContain("time_left_5");
    expect(kinds).toContain("memory");
    expect(kinds).not.toContain("pacing_wrap"); // overtaken by "last": only the latest overdue nudge is sent
    expect(pod.notes.some((n) => n.text.includes("half of the ride"))).toBe(true);
    expect(pod.notes.some((n) => n.text === "NOTE-FROM-HOOK" && n.turns === 1)).toBe(true);
    // notes are not turns: the transcript holds only what was said
    expect(f.turns.filter((t) => t.role === "user").map((t) => t.text)).toEqual(["עוד חמש דקות אני מגיע", "תרשום לי משהו"]);
    // a session without an expected length gets no pacing notes
    expect((finalized[0]!.stats.notes as unknown[]).length).toBe(0);
  }, 30_000);

  it("after Rolly's replies: the next plan item waits on the pod for a dry turn, the style guard and the confirm note go out once", async () => {
    const before = pod.notes.length;
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-plan`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000); // opener (carries plan item 0)
    for (let i = 0; i < 3; i++) { const end = await phone.say(speech(500)); await phone.waitReply(end - 1, 5000); } // "סתם", "כלום", "בסדר"
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.closed, 5000, "closed");
    phone.stop();
    const notes = pod.notes.slice(before);
    // after the opener: item 1, conditional on two short answers in a row
    expect(notes[0]).toMatchObject({ turns: 1, max_user_words: 2, min_streak: 2 });
    expect(notes[0]!.text).toContain("Bring up this now: ספורט. Your own take on it: הליכה קצרה");
    // "הבנתי אותך." then "צודק, נכון.": two agreeing openers in a row -> one style note, for one turn, unconditional
    const style = notes.filter((n) => n.text.includes("skip the opener"));
    expect(style).toHaveLength(1);
    expect(style[0]).toMatchObject({ turns: 1 });
    expect(style[0]!.max_user_words).toBeUndefined();
    // the unconfirmed item is offered once, on a quiet turn
    const confirm = notes.filter((n) => n.text.includes("אולי גר בחיפה"));
    expect(confirm).toHaveLength(1);
    expect(confirm[0]).toMatchObject({ max_user_words: 2, min_streak: 1 });
    // a clean reply brings no style note; nothing of this is in the transcript
    const f = finalized.at(-1)!;
    expect((f.stats.notes as { kind: string }[]).map((n) => n.kind).filter((k) => k === "style")).toHaveLength(1);
    expect(f.turns.map((t) => t.text).join(" ")).not.toContain("Bring up this now");
  }, 30_000);

  it("one live conversation per user: a second session closes the older one, another user's session is untouched", async () => {
    const first = new Phone(), other = new Phone(), second = new Phone();
    await first.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-twice`);
    first.send({ type: "session.start", language: "he" });
    await first.waitFor(() => first.events.some((e) => e.msg.type === "session.created"), 5000, "first session");
    await other.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-someone-else`);
    other.send({ type: "session.start", language: "he" });
    await other.waitFor(() => other.events.some((e) => e.msg.type === "session.created"), 5000, "other user's session");
    await second.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-twice`);
    second.send({ type: "session.start", language: "he" });
    await first.waitFor(() => first.events.some((e) => e.msg.type === "session.closed"), 5000, "older session closed");
    expect(first.events.find((e) => e.msg.type === "session.closed")!.msg).toMatchObject({ reason: "superseded" });
    await second.waitFor(() => second.events.some((e) => e.msg.type === "session.created"), 5000, "second session");
    // the newer session works, and so does the other user's
    const end = await second.say(speech(600));
    await second.waitReply(end - 1, 5000);
    expect(second.events.some((e) => e.msg.type === "session.closed")).toBe(false);
    expect(other.events.some((e) => e.msg.type === "session.closed")).toBe(false);
    for (const p of [second, other]) { p.send({ type: "session.end" }); await p.waitFor(() => p.events.some((e) => e.msg.type === "session.closed"), 5000, "end"); }
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(((await res.json()) as { active_sessions: number }).active_sessions).toBe(0);
  }, 30_000);
});
