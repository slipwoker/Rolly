import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { buildContext, emptyMemory } from "../src/persona/promptBuilder.ts";
import { seqBase, type SessionHooks, type SessionTurn } from "../src/voice/session.ts";
import { Phone, gainDb } from "../src/selftest/phone.ts";
import { startFakePod, tone, type FakePod } from "./fakePod.ts";

let pod: FakePod, app: FastifyInstance, port: number;
const finalized: { turns: SessionTurn[]; stats: Record<string, unknown>; endReason: string }[] = [];
const lookups: { userId: string; question: string; lastMedia: unknown[] }[] = [];
const music: string[] = [];

beforeAll(async () => {
  pod = await startFakePod({ script: ["שלום", "מה נשמע", "רגע", "שקט", "עוד חמש דקות אני מגיע", "תרשום לי משהו", "סתם", "כלום", "בסדר", "תנגן את זה", "תנגן משהו"], token: "test-key",
    // a "model" that falls back on bot-speak, for the style guard
    replyText: (t, ctx) => String(ctx.user_id).startsWith("u-lookup") ? "בודק, שנייה. <lookup/>"
      : ({ "סתם": "הבנתי אותך.", "כלום": "צודק, נכון.", "בסדר": "בלי טעינה בבית זה לא שווה." } as Record<string, string>)[t] });
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
    async onUserTurn({ userId, turn, recent }) {
      // "u-standing": the first thing they say settles how to address them, for the rest of the conversation
      if (userId === "u-standing") return recent.filter((t) => t.role === "user").length === 1 ? { text: "STANDING-NOTE", turns: 2, standing: true } : undefined;
      return turn.text.includes("תרשום") ? { text: "NOTE-FROM-HOOK", turns: 1 } : undefined;
    },
    // "u-lookup": the search answers in 100 ms; "u-lookup-fail": it does not work; other users have no lookups at all
    async lookup({ userId, question, lastMedia }) {
      lookups.push({ userId, question, lastMedia });
      await new Promise((r) => setTimeout(r, 100));
      // "u-lookup-music": the answer is "putting on a song"; "-end": the song ends by itself, otherwise it plays until the user taps
      if (userId.startsWith("u-lookup-music")) {
        const ends = userId.endsWith("-end");
        return { message: "[lookup_result - not said by the user] Putting on Bohemian Rhapsody.", ok: true,
          media: [{ kind: "track" as const, title: "Bohemian Rhapsody", subtitle: "Queen", image: null, url: "https://open.spotify.com/track/1", provider: "spotify" as const }],
          playback: { title: "Bohemian Rhapsody", async start() { music.push("start"); return true; }, async stillPlaying() { return !ends; }, async stop() { music.push("stop"); } } };
      }
      return userId === "u-lookup-fail" ? { message: "[lookup_failed - not said by the user] did not work", ok: false, reason: "failed" }
        : { message: "[lookup_result - not said by the user] What you found: 23 to 30 degrees.", ok: true };
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
    expect(opener.seq).toBeGreaterThan(1000); // a range of its own, not 1 (see seqBase)
    expect(opener.seq).toBeLessThan(2 ** 31); // the Android audio module reads it as a signed 32-bit integer
    expect(opener.proactive).toBe(true);
    // 1.2 s at 44.1 kHz -> 1.2 s at 24 kHz (16-bit mono)
    expect(Math.abs(opener.bytes / 2 / 24000 - 1.2)).toBeLessThan(0.01);
    expect(pod.starts[0]!.system_prompt).toContain("You are Rolly.");
    expect(pod.starts[0]!.opener_instruction).toContain("journey_start");

    const end1 = await phone.say(speech(600));
    const r1 = await phone.waitReply(end1 - 1, 5000);
    expect(r1.seq).toBe(opener.seq + 1);
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
    await phone.waitReply(0, 5000); // the easy opener: it carries no plan item
    for (let i = 0; i < 3; i++) { const end = await phone.say(speech(500)); await phone.waitReply(end - 1, 5000); } // "סתם", "כלום", "בסדר"
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.closed, 5000, "closed");
    phone.stop();
    const notes = pod.notes.slice(before);
    // right after the opener: item 0, for a short first answer (up to six words, one is enough)
    expect(notes[0]).toMatchObject({ turns: 1, max_user_words: 6, min_streak: 1 });
    expect(notes[0]!.text).toContain("Bring up this now: הגיוס. Your own take on it: משקיע קטן");
    // "סתם" is a short first answer, so the pod showed item 0; item 1 is queued the usual way: two short answers in a row
    expect(notes[1]).toMatchObject({ turns: 1, max_user_words: 2, min_streak: 2 });
    expect(notes[1]!.text).toContain("Bring up this now: ספורט. Your own take on it: הליכה קצרה");
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

  it("a standing note (how to address the user) is sent again when the pod has used it up", async () => {
    const before = pod.notes.length;
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-standing`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000);
    for (let i = 0; i < 5; i++) { const end = await phone.say(speech(600)); await phone.waitReply(end - 1, 5000); }
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 5000, "closed");
    const standing = pod.notes.slice(before).filter((n) => n.text === "STANDING-NOTE");
    // once when it was said, then again after every two replies: five replies -> at least three times
    expect(standing.length).toBeGreaterThanOrEqual(3);
    expect(standing.every((n) => n.turns === 2)).toBe(true);
    expect((finalized.at(-1)!.stats.notes as { kind: string }[]).filter((n) => n.kind === "standing").length).toBe(standing.length);
  }, 30_000);

  it("an online lookup: 'checking' is said, the marker is never shown, the answer reaches the model at a quiet moment and is not stored as the user's", async () => {
    const textsBefore = pod.texts.length;
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-lookup`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000);
    const end = await phone.say(speech(600));
    const checking = await phone.waitReply(end - 1, 5000);
    expect(checking.text).toBe("בודק, שנייה.");
    // the answer: a second agent turn, with no user speech in between
    await phone.waitFor(() => [...phone.turns.values()].some((t) => t.done && t.text.startsWith("Said: [lookup_result")), 8000, "the answer turn");
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 5000, "closed");

    expect(lookups.at(-1)).toMatchObject({ userId: "u-lookup" });
    expect(pod.texts.slice(textsBefore)).toEqual(["[lookup_result - not said by the user] What you found: 23 to 30 degrees."]);
    // nothing of the mechanism reaches the phone: no marker in the streamed text, no "transcript" of the injected message
    const shown = phone.events.map((e) => JSON.stringify(e.msg)).join(" ");
    expect(shown).not.toContain("<lookup");
    expect(phone.events.filter((e) => e.msg.type === "user.transcript").map((e) => (e.msg as { text: string }).text).some((t) => t.startsWith("["))).toBe(false);
    const f = finalized.at(-1)!;
    expect(f.turns.filter((t) => t.role === "user").map((t) => t.text).some((t) => t.startsWith("["))).toBe(false);
    expect(f.turns.filter((t) => t.role === "user")).toHaveLength(1);
    const [l] = f.stats.lookups as { ok: boolean; search_ms: number; delivered_after_ms: number }[];
    expect(l).toMatchObject({ ok: true });
    // the search took 100 ms, but "checking" was still playing (1.2 s): the answer waited for it to finish
    expect(l!.delivered_after_ms).toBeGreaterThan(900);
    // the turn that says the answer is not timed as a reply to the user
    expect((f.stats.server_reply_ms as number[]).length).toBe(1);
  }, 30_000);

  it("a lookup that does not work is said as such; without the hook the marker is simply dropped", async () => {
    const textsBefore = pod.texts.length;
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-lookup-fail`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000);
    const end = await phone.say(speech(600));
    await phone.waitReply(end - 1, 5000);
    await phone.waitFor(() => pod.texts.length > textsBefore, 8000, "the failure message");
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 5000, "closed");
    expect(pod.texts.at(-1)).toContain("[lookup_failed");
    expect((finalized.at(-1)!.stats.lookups as { ok: boolean; reason?: string }[])[0]).toMatchObject({ ok: false, reason: "failed" });
  }, 30_000);

  it("turn numbers are never reused between conversations (the phone mutes a number that was cut off before)", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2; i++) {
      const phone = new Phone();
      await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-seq`);
      phone.send({ type: "session.start", language: "he" });
      const opener = await phone.waitReply(0, 5000);
      const end = await phone.say(speech(600));
      const reply = await phone.waitReply(end - 1, 5000);
      for (const q of [opener.seq, reply.seq]) { expect(seen.has(q)).toBe(false); seen.add(q); }
      phone.send({ type: "session.end" });
      await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 5000, "closed");
    }
    // ranges: 1,000 numbers apart even within one second, by the clock across server restarts, always within 4 bytes
    const a = seqBase(1_800_000_000_000), b = seqBase(1_800_000_000_000), c = seqBase(1_800_000_005_000);
    expect(b - a).toBeGreaterThanOrEqual(1000);
    expect(c).toBeGreaterThan(b);
    for (const t of [Date.UTC(2026, 10, 26, 9, 54), Date.UTC(2030, 0, 1), Date.UTC(2031, 5, 17, 23, 59, 59)]) expect(seqBase(t) + 5000).toBeLessThan(2 ** 31);
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

  it("music: it starts only after Rolly has finished speaking, listening is off while it plays, and a tap pauses it and brings listening back", async () => {
    music.length = 0;
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-lookup-music`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000);
    const end = await phone.say(speech(600));
    await phone.waitReply(end - 1, 5000);
    await phone.waitFor(() => [...phone.turns.values()].some((t) => t.done && t.text.startsWith("Said: [lookup_result")), 8000, "the answer turn");
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "mic.paused"), 8000, "mic.paused");
    // the card came before the reply, the music only after the reply had been played out
    const types = phone.events.map((e) => e.msg.type);
    expect(types.indexOf("agent.media")).toBeLessThan(types.indexOf("mic.paused"));
    expect(music).toEqual(["start"]);
    const heard = pod.audioBytes;
    await new Promise((r) => setTimeout(r, 700)); // the test phone keeps streaming silence; none of it may reach the model
    expect(pod.audioBytes).toBe(heard);
    phone.send({ type: "client.resume" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "mic.resumed"), 5000, "mic.resumed");
    expect(music).toEqual(["start", "stop"]);
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 5000, "closed");
    expect((finalized.at(-1)!.stats.notes as { kind: string }[]).map((n) => n.kind)).toEqual(expect.arrayContaining(["music_started", "music_stopped_by_user"]));
  }, 40_000);

  it("music that ends by itself brings listening back without a tap", async () => {
    music.length = 0;
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=u-lookup-music-end`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 5000);
    const end = await phone.say(speech(600));
    await phone.waitReply(end - 1, 5000);
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "mic.paused"), 8000, "mic.paused");
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "mic.resumed"), 20_000, "mic.resumed after the song");
    expect(music).toEqual(["start"]); // not paused: it had ended
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 5000, "closed");
  }, 50_000);
});
