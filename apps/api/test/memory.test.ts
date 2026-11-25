/**
 * Memory policy and continuity against a real PostgreSQL (local; set TEST_DATABASE_URL, default postgres://rolly:rolly@127.0.0.1/rolly_test).
 * The utility LLM is replaced by a deterministic fake that returns what a summariser would; the policy, the store and
 * the prompt builder are the real code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, migrate, type Db } from "../src/db/index.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { normalize } from "../src/memory/summarizer.ts";
import { buildContext } from "../src/persona/promptBuilder.ts";
import { handleLiveTurn } from "../src/memory/live.ts";
import type { UtilityLlm } from "../src/memory/llm.ts";
import type { SessionTurn } from "../src/voice/session.ts";
import { Auth, RateLimiter, secretOk } from "../src/auth.ts";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_test";
let db: Db, store: MemoryStore, available = true;

beforeAll(async () => {
  try {
    const c = new pg.Client({ connectionString: URL }); await c.connect();
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await c.end();
  } catch { available = false; return; }
  db = createPool(URL);
  await migrate(db);
  store = new MemoryStore(db, { candidateTtlDays: 14, transcriptRetentionDays: 30 });
});
afterAll(async () => { await db?.end(); });

let idx = 0;
const u = (text: string, attribution: "primary" | "uncertain" = "primary"): SessionTurn => ({ idx: idx++, role: "user", text, attribution, startedAt: Date.now(), meta: {} });
const a = (text: string): SessionTurn => ({ idx: idx++, role: "agent", text, attribution: "primary", startedAt: Date.now(), meta: {} });
const item = (content: string, quote: string, extra: Record<string, unknown> = {}) => ({ content, quote, confidence: 0.9, first_person: true, turn: null, ...extra });

describe.skipIf(!process.env.CI && false)("memory policy with PostgreSQL", () => {
  it("first-person one-to-one -> active; uncertain speaker -> candidate; continuity in the next prompt", async () => {
    if (!available) return;
    const uid = await store.createUser("test");
    const sid = crypto.randomUUID();
    await store.startSession(sid, uid, "he", true, new Date());
    const turns = [a("היי! מה השם?"), u("קוראים לי נועה"), a("נעים מאוד"), u("בנסיעות אני רוצה ללמוד ספרדית"),
      u("אני חושבת שזה יעזור לי"), u("אני עייפה"), u("אני לא בטוחה מתי"), u("אני מהנדס תוכנה בגוגל", "uncertain")];
    const summary = normalize({
      summary: "נועה רוצה להשתמש בנסיעות כדי ללמוד ספרדית.", unresolved_topics: ["תוכנית ללימוד ספרדית"], progress: ["הוחלט להתחיל ללמוד ספרדית בנסיעות"],
      preferred_name: item("נועה", "קוראים לי נועה"), travel_goals: [item("ללמוד ספרדית בנסיעות", "אני רוצה ללמוד ספרדית")],
      facts: [item("מהנדס תוכנה בגוגל", "אני מהנדס תוכנה בגוגל")], other_speakers_suspected: false, language: "he",
    });
    const res = await store.applySummary(uid, sid, summary, turns);
    await store.learnAddressing(uid, sid, turns);
    await store.finishSession({ sessionId: sid, userId: uid, turns, summary, stats: {}, endReason: "client_end", describe: {} });

    const byContent = Object.fromEntries(res.decisions.map((d) => [d.content, d.decision]));
    // the uncertain line makes the whole session "other speakers suspected", so nothing becomes active automatically
    expect(byContent["מהנדס תוכנה בגוגל"]!.status).toBe("candidate");
    expect(byContent["מהנדס תוכנה בגוגל"]!.reason).toBe("uncertain_speaker");
    expect(byContent["נועה"]!.reason).toBe("other_speakers_suspected");

    const addr = await store.addressing(uid);
    expect(addr).toMatchObject({ value: "feminine", status: "inferred" }); // 3 primary feminine self-references
    expect(addr.evidence.ignored_uncertain).toBe(1); // "אני מהנדס" from the uncertain turn ignored

    const view = await store.memoryView(uid);
    expect(view.facts).not.toContain("מהנדס תוכנה בגוגל"); // candidates are never facts in the prompt
    expect(view.candidates.map((c) => c.content)).toContain("מהנדס תוכנה בגוגל");
    const ctx = buildContext(view, { language: "he" });
    expect(ctx.onboarding).toBe(false);
    expect(ctx.system_prompt).toContain("תוכנית ללימוד ספרדית"); // continuity: open topic
    expect(ctx.system_prompt).toContain("הוחלט להתחיל ללמוד ספרדית בנסיעות"); // progress
    expect(ctx.system_prompt).toMatch(/Not confirmed[\s\S]*מהנדס תוכנה בגוגל/);
    expect(ctx.system_prompt).toContain("feminine (נקבה)");
    expect(ctx.opener_instruction).toContain("unresolved thing from your memory");
  });

  it("clean one-to-one session -> active; confirmation and correction by voice; deletion in the app", async () => {
    if (!available) return;
    const uid = await store.createUser("test2");
    const sid = crypto.randomUUID();
    await store.startSession(sid, uid, "he", true, new Date());
    const turns = [a("מה השם?"), u("קוראים לי דני"), u("אני רוצה להשתמש בנסיעות כדי לחשוב על הסטארטאפ שלי"), u("אני עובד בבנק")];
    const s = normalize({
      summary: "דני רוצה לחשוב על הסטארטאפ שלו בנסיעות.", preferred_name: item("דני", "קוראים לי דני"),
      travel_goals: [item("לחשוב על הסטארטאפ בנסיעות", "להשתמש בנסיעות כדי לחשוב על הסטארטאפ")],
      facts: [item("עובד בבנק", "אני עובד בבנק"), item("אולי גר בחיפה", "", { confidence: 0.4 })], other_speakers_suspected: false,
    });
    const r = await store.applySummary(uid, sid, s, turns);
    expect(r.decisions.find((d) => d.content === "דני")!.decision.status).toBe("active");
    expect(r.decisions.find((d) => d.content === "עובד בבנק")!.decision.status).toBe("active");
    expect(r.decisions.find((d) => d.content === "אולי גר בחיפה")!.decision).toMatchObject({ status: "candidate", reason: "quote_not_found_in_user_turns" });
    expect((await store.profile(uid)).preferred_name).toBe("דני");

    // confirmation of a candidate by voice (from a primary turn) makes it active
    const cand = (await store.memories(uid, { status: ["candidate"] }))[0]!;
    const sid2 = crypto.randomUUID();
    await store.startSession(sid2, uid, "he", false, new Date());
    const turns2 = [a("רק לוודא, לשמור שגרים בחיפה?"), u("כן, נכון")];
    await store.applySummary(uid, sid2, normalize({ summary: "אישור.", candidate_confirmations: [{ id: cand.id, answer: "yes", turn: turns2[1]!.idx }] }), turns2);
    expect((await store.getMemory(uid, cand.id))!.status).toBe("active");

    // a confirmation from an uncertain turn is not accepted
    const other = await store.addMemory(uid, { kind: "fact", content: "אוהב ג'אז", status: "candidate", provenance: { source: "test" } });
    const turns3 = [u("כן", "uncertain")];
    await store.applySummary(uid, sid2, normalize({ summary: "x", candidate_confirmations: [{ id: other, answer: "yes", turn: turns3[0]!.idx }] }), turns3);
    expect((await store.getMemory(uid, other))!.status).toBe("candidate");

    // live correction by voice ("that's wrong, I work at an insurance company")
    const bank = (await store.memories(uid, { kinds: ["fact"] })).find((m) => m.content === "עובד בבנק")!;
    const fakeLlm: UtilityLlm = { name: "fake", json: async () => ({ obj: { actions: [{ memory_id: bank.id, action: "replace", new_content: "עובד בחברת ביטוח" }] }, ms: 1 }) };
    const turn = u("זה לא נכון, אני עובד בחברת ביטוח");
    const done = await handleLiveTurn(store, fakeLlm, { userId: uid, sessionId: sid2, turn, recent: [turn] });
    expect(done).toEqual([`correct:${bank.id}`]);
    expect((await store.getMemory(uid, bank.id))!.status).toBe("deleted");
    expect((await store.getMemory(uid, bank.id))!.content).toBe(""); // content wiped
    expect((await store.memories(uid, { kinds: ["fact"] })).map((m) => m.content)).toContain("עובד בחברת ביטוח");

    // a correction can also replace an unconfirmed candidate
    const cand2 = await store.addMemory(uid, { kind: "travel_goal", content: "אולי ללמוד ספרדית", status: "candidate", provenance: { source: "test" } });
    expect((await store.memoryView(uid)).knownIds.map((k) => k.id)).toContain(cand2);
    const llm2: UtilityLlm = { name: "fake", json: async () => ({ obj: { actions: [{ memory_id: cand2, action: "replace", new_content: "ללמוד איטלקית" }] }, ms: 1 }) };
    const t2 = u("זה לא נכון, אני רוצה ללמוד איטלקית ולא ספרדית");
    expect(await handleLiveTurn(store, llm2, { userId: uid, sessionId: sid2, turn: t2, recent: [t2] })).toEqual([`correct:${cand2}`]);
    expect((await store.getMemory(uid, cand2))!.status).toBe("deleted");

    // the same correction from an uncertain speaker does nothing
    const uncertain = { ...u("זה לא נכון, הוא עובד בבנק", "uncertain") };
    expect(await handleLiveTurn(store, fakeLlm, { userId: uid, sessionId: sid2, turn: uncertain, recent: [uncertain] })).toEqual([]);

    // explicit addressing request by voice: confirmed immediately
    const t = u("תדבר אליי בלשון רבים");
    await handleLiveTurn(store, null, { userId: uid, sessionId: sid2, turn: t, recent: [t] });
    expect(await store.addressing(uid)).toMatchObject({ value: "plural", status: "confirmed" });
    await store.learnAddressing(uid, sid2, [t]); // applied again after the session: not counted twice
    expect((await store.addressing(uid)).evidence.examples.filter((e) => e.quote === t.text)).toHaveLength(1);

    // deletion in the app
    const goal = (await store.memories(uid, { kinds: ["travel_goal"] }))[0]!;
    expect(await store.deleteMemory(uid, goal.id, "app")).toBe(true);
    expect((await store.memoryView(uid)).profile.travelGoals).toEqual([]);

    // export contains no deleted content; account deletion removes everything
    const exp = await store.exportAll(uid);
    expect(JSON.stringify(exp)).not.toContain("עובד בבנק\"");
    await store.deleteAccount(uid);
    expect((await db.query("SELECT count(*)::int n FROM memories WHERE user_id=$1", [uid])).rows[0].n).toBe(0);
  });

  it("candidates expire", async () => {
    if (!available) return;
    const uid = await store.createUser("t3");
    const id = await store.addMemory(uid, { kind: "fact", content: "x", status: "candidate", provenance: {} });
    await db.query("UPDATE memories SET expires_at = now() - interval '1 minute' WHERE id=$1", [id]);
    expect(await store.expireCandidates(uid)).toBe(1);
    expect((await store.getMemory(uid, id))!.status).toBe("deleted");
  });

  it("pairing code -> refresh -> access -> single-use ticket", async () => {
    if (!available) return;
    const auth = new Auth(db, await Auth.loadSecret(db, null));
    const uid = await store.createUser("t4");
    const { code } = await auth.createPairingCode(uid);
    const p = await auth.pair(code.toLowerCase(), "iPhone");
    expect(p?.user_id).toBe(uid);
    expect(await auth.pair(code, "again")).toBeNull(); // single use
    const r = await auth.refresh(p!.refresh_token);
    expect(auth.verifyAccess(r!.access_token)).toBe(uid);
    expect(await auth.refresh(p!.refresh_token)).toBeNull(); // rotated
    expect(auth.verifyAccess(r!.access_token + "x")).toBeNull();
    expect(auth.verifyAccess(r!.access_token, Date.now() + 16 * 60_000)).toBeNull(); // expired
    const { ticket } = await auth.createTicket(uid);
    expect(await auth.consumeTicket(ticket)).toBe(uid);
    expect(await auth.consumeTicket(ticket)).toBeNull();
  });

  it("silent enrollment: new user + device token, refused when full; key check and rate limit", async () => {
    if (!available) return;
    const auth = new Auth(db, await Auth.loadSecret(db, null));
    const n = (await db.query("SELECT count(DISTINCT user_id)::int n FROM devices WHERE revoked_at IS NULL")).rows[0].n as number;
    const r = await auth.enroll("iPhone", n + 1);
    expect(r).not.toBe("full");
    const ok = r as { user_id: string; refresh_token: string };
    const tokens = await auth.refresh(ok.refresh_token);
    expect(auth.verifyAccess(tokens!.access_token)).toBe(ok.user_id);
    expect((await store.profile(ok.user_id)).addressing_status).toBe("unknown");
    expect(await auth.enroll("iPhone 2", n + 1)).toBe("full");
    expect(secretOk("abc12345", "abc12345")).toBe(true);
    expect(secretOk("abc12346", "abc12345")).toBe(false);
    expect(secretOk("abc12345", null)).toBe(false);
    const rl = new RateLimiter(2, 1000);
    expect([rl.allow("ip", 0), rl.allow("ip", 1), rl.allow("ip", 2), rl.allow("ip", 1500)]).toEqual([true, true, false, true]);
  });
});
