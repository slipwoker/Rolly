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
import { handleCapture, handleLiveTurn } from "../src/memory/live.ts";
import { emptyPlan, type PlanResult } from "../src/memory/plan.ts";
import { scrubUser } from "../src/memory/scrub.ts";
import { consolidate } from "../src/memory/consolidate.ts";
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
    const goal = (await store.memories(uid, { kinds: ["travel_goal"] })).find((m) => m.content === "לחשוב על הסטארטאפ בנסיעות")!;
    expect(await store.deleteMemory(uid, goal.id, "app")).toBe(true);
    expect((await store.memoryView(uid)).profile.travelGoals).not.toContain("לחשוב על הסטארטאפ בנסיעות");

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

  // ------------------------------------------------------------------ goals, plan, tasks, ideas, forgetting (P1-D17..D20)
  const plan = (patch: Partial<PlanResult>): PlanResult => ({ ...emptyPlan(), method: "llm", ...patch });
  const fakeLlm = (answer: (prompt: string) => Record<string, unknown>) => {
    const prompts: string[] = [];
    const llm: UtilityLlm = { name: "fake", json: async (prompt) => { prompts.push(prompt); return { obj: answer(prompt), ms: 1 }; } };
    return { llm, prompts };
  };
  const session = async (uid: string) => { const sid = crypto.randomUUID(); await store.startSession(sid, uid, "he", false, new Date()); return sid; };

  it("a goal develops over three conversations; its status changes only on the user's own word", async () => {
    if (!available) return;
    const uid = await store.createUser("goals");
    const s1 = await session(uid);
    const t1 = [a("מה נשמע?"), u("אני רוצה לעבור לעבודה עצמאית"), u("אני חושב להתחיל מרשימת לקוחות")];
    const r1 = await store.applySummary(uid, s1, normalize({
      summary: "דובר על מעבר לעבודה עצמאית.", progress: ["הוחלט להתחיל מרשימת לקוחות"],
      goals: [item("לעבור לעבודה עצמאית", "אני רוצה לעבור לעבודה עצמאית", { importance: 3 })],
    }), t1);
    await store.finishSession({ sessionId: s1, userId: uid, turns: t1, summary: null, stats: {}, endReason: "client_end", describe: {} });
    const goal = (await store.goals(uid))[0]!;
    expect(goal).toMatchObject({ content: "לעבור לעבודה עצמאית", status: "active", state_note: null, sessions_count: 0 });

    await store.applyPlan(uid, s1, plan({
      goal_updates: [{ goal_id: goal.id, state_note: "הוחלט להתחיל מרשימת לקוחות אפשריים.", next_step: "לבנות רשימה של עשרה לקוחות", status: null, status_turn: null, status_quote: "", progress: [0] }],
      next_agenda: [{ topic: "רשימת עשרה לקוחות", why: "הצעד הבא", kind: "goal_step", ref_id: goal.id }, { topic: "משהו חדש על תמחור", why: "", kind: "fresh", ref_id: null }],
    }), t1, r1.progressIds);
    let view = await store.memoryView(uid);
    expect(view.goals[0]).toMatchObject({ stateNote: "הוחלט להתחיל מרשימת לקוחות אפשריים.", nextStep: "לבנות רשימה של עשרה לקוחות", status: "active" });
    expect((await store.progress(uid))[0]).toMatchObject({ text: "הוחלט להתחיל מרשימת לקוחות", goal_id: goal.id });
    expect(view.agenda!.items.map((i) => i.kind)).toEqual(["goal_step", "fresh"]);
    const ctx = buildContext(view, { language: "he", journey: { duration_min: 10 } });
    expect(ctx.system_prompt).toContain("Where it stands: הוחלט להתחיל מרשימת לקוחות אפשריים.");
    expect(ctx.agenda.map((i) => i.topic)).toEqual(["רשימת עשרה לקוחות"]); // a 10-minute ride: one item

    // second conversation: someone else in the car says it is done -> the note is updated, the status is not
    const s2 = await session(uid);
    const t2 = [u("יש לי כבר ארבעה שמות ברשימה"), u("הוא כבר סיים עם זה", "uncertain")];
    const p2 = await store.applyPlan(uid, s2, plan({
      goal_updates: [{ goal_id: goal.id, state_note: "יש ארבעה לקוחות ברשימה.", next_step: "עוד שישה", status: "achieved", status_turn: t2[1]!.idx, status_quote: "הוא כבר סיים עם זה", progress: [] }],
    }), t2);
    expect(p2.refused).toEqual([`goal_achieved:${goal.id}:uncertain_speaker`]);
    expect((await store.goals(uid))[0]).toMatchObject({ status: "active", state_note: "יש ארבעה לקוחות ברשימה.", next_step: "עוד שישה", sessions_count: 2 });
    // no new plan came back: the previous one stays
    expect((await store.memoryView(uid)).agenda!.items).toHaveLength(2);

    // third conversation: the user says it themselves
    const s3 = await session(uid);
    const t3 = [u("סיימתי, אני כבר עצמאי")];
    const p3 = await store.applyPlan(uid, s3, plan({
      goal_updates: [{ goal_id: goal.id, state_note: "המעבר הושלם.", next_step: null, status: "achieved", status_turn: t3[0]!.idx, status_quote: "סיימתי, אני כבר עצמאי", progress: [] }],
    }), t3);
    expect(p3.applied).toEqual([`goal_achieved:${goal.id}`]);
    view = await store.memoryView(uid);
    expect(view.goals).toEqual([]); // an achieved goal leaves the prompt...
    expect((await store.goals(uid))[0]!.status).toBe("achieved"); // ...and stays on the Progress screen
    expect(view.agenda!.items.map((i) => i.kind)).toEqual(["fresh"]); // the plan item about it is dropped
    // the app can reopen it
    expect(await store.setGoalStatus(uid, goal.id, "active")).toBe(true);
    expect((await store.memoryView(uid)).goals).toHaveLength(1);
  });

  it("tasks and ideas: saved the moment the user asks, ticked off by voice or in the app", async () => {
    if (!available) return;
    const uid = await store.createUser("tasks");
    const sid = await session(uid);
    const noted = fakeLlm(() => ({ intent: "note", items: [{ kind: "task", content: "להתקשר לרואה החשבון מחר" }, { kind: "idea", content: "ניוזלטר שבועי ללקוחות" }] }));

    // no cue: the model is not even asked
    const plain = u("היה לי יום ארוך");
    expect((await handleCapture(store, noted.llm, { userId: uid, sessionId: sid, turn: plain, recent: [plain] })).saved).toEqual([]);
    expect(noted.prompts).toHaveLength(0);

    const ask = u("תרשום לי להתקשר לרואה החשבון מחר, ותשמור את הרעיון של הניוזלטר");
    const cap = await handleCapture(store, noted.llm, { userId: uid, sessionId: sid, turn: ask, recent: [ask] });
    expect(cap.saved.map((x) => [x.kind, x.status])).toEqual([["action_item", "active"], ["idea", "active"]]);
    expect(cap.note).toBeUndefined(); // saved as the user expects: nothing to tell the model
    let view = await store.memoryView(uid);
    expect(view.tasks.map((t) => t.content)).toEqual(["להתקשר לרואה החשבון מחר"]);
    expect(view.ideas).toEqual(["ניוזלטר שבועי ללקוחות"]);
    expect(noted.prompts[0]).toContain("- (empty)");

    // the same request from a voice that may be someone else: kept as unconfirmed, not on the list
    const other = fakeLlm(() => ({ intent: "note", items: [{ kind: "task", content: "לקנות חלב" }] }));
    const quiet = u("תרשום לקנות חלב", "uncertain");
    expect((await handleCapture(store, other.llm, { userId: uid, sessionId: sid, turn: quiet, recent: [quiet] })).saved[0]!.status).toBe("candidate");
    expect((await store.memoryView(uid)).tasks.map((t) => t.content)).not.toContain("לקנות חלב");
    expect(other.prompts[0]).toContain("- להתקשר לרואה החשבון מחר"); // what is already on the list is shown, to avoid repeats

    // asked to note something, but what? -> the model is told to ask
    const vague = fakeLlm(() => ({ intent: "note", items: [] }));
    const v = u("תרשום את זה");
    expect((await handleCapture(store, vague.llm, { userId: uid, sessionId: sid, turn: v, recent: [v] })).note?.text).toContain("not clear what");
    // "remind me what I said" is not a request to note
    const recall = fakeLlm(() => ({ intent: "other", items: [] }));
    const q = u("תזכיר לי מה אמרתי על הפגישה");
    expect(await handleCapture(store, recall.llm, { userId: uid, sessionId: sid, turn: q, recent: [q] })).toEqual({ saved: [] });

    // "I called him" in the next conversation: ticked off only on the user's own word
    const task = view.tasks[0]!;
    const s2 = await session(uid);
    const t2 = [u("הוא התקשר כבר", "uncertain"), u("כן, התקשרתי לרואה החשבון")];
    expect((await store.applyPlan(uid, s2, plan({ completed_action_items: [{ id: task.id, turn: t2[0]!.idx, quote: "הוא התקשר כבר" }] }), t2)).refused).toEqual([`done:${task.id}:uncertain_speaker`]);
    expect((await store.applyPlan(uid, s2, plan({ completed_action_items: [{ id: task.id, turn: t2[1]!.idx, quote: "התקשרתי לרואה החשבון" }] }), t2)).applied).toEqual([`done:${task.id}`]);
    view = await store.memoryView(uid);
    expect(view.tasks).toEqual([]);
    expect((await store.memories(uid, { kinds: ["action_item"], done: true })).map((m) => m.content)).toEqual(["להתקשר לרואה החשבון מחר"]);
    // the app: put it back, tick the idea off
    expect(await store.setDone(uid, task.id, false, "app")).toBe(true);
    expect(await store.setDone(uid, task.id, false, "app")).toBe(false); // already open
    expect((await store.memoryView(uid)).tasks).toHaveLength(1);
    const idea = (await store.memories(uid, { kinds: ["idea"] }))[0]!;
    expect(await store.setDone(uid, idea.id, true, "app")).toBe(true);
    expect((await store.memoryView(uid)).ideas).toEqual([]);
    // a fact cannot be "done"
    const fact = await store.addMemory(uid, { kind: "fact", content: "גר בחיפה", status: "active", provenance: {} });
    expect(await store.setDone(uid, fact, true, "app")).toBe(false);
  });

  it("'forget that' also removes the fact from summaries, notes, digests and the plan", async () => {
    if (!available) return;
    const uid = await store.createUser("forget");
    const sid = await session(uid);
    const turns = [u("אני עובד בבנק"), u("אני רוצה לחסוך לדירה")];
    const r = await store.applySummary(uid, sid, normalize({
      summary: "דני סיפר שהוא עובד בבנק ורוצה לחסוך לדירה.", unresolved_topics: ["איך לחסוך לדירה עם משכורת מהבנק"], progress: ["הוחלט לבדוק חיסכון דרך הבנק שבו הוא עובד"],
      facts: [item("עובד בבנק", "אני עובד בבנק")], goals: [item("לחסוך לדירה", "אני רוצה לחסוך לדירה")],
    }), turns);
    await store.finishSession({ sessionId: sid, userId: uid, turns, summary: normalize({ summary: "דני סיפר שהוא עובד בבנק ורוצה לחסוך לדירה." }), stats: {}, endReason: "client_end", describe: {}, policy: r });
    const goal = (await store.goals(uid))[0]!;
    await store.applyPlan(uid, sid, plan({
      goal_updates: [{ goal_id: goal.id, state_note: "בודק מסלולי חיסכון דרך הבנק שבו הוא עובד.", next_step: null, status: null, status_turn: null, status_quote: "", progress: [0] }],
      next_agenda: [{ topic: "הטבות חיסכון לעובדי בנק", why: "", kind: "fresh", ref_id: null }, { topic: "כמה לחסוך בחודש", why: "", kind: "goal_step", ref_id: goal.id }],
    }), turns, r.progressIds);
    await store.saveDigests(uid, { digest: "דני עובד בבנק וחוסך לדירה." });
    // the session row keeps the summary text but no copy of the extracted items
    const row = (await db.query("SELECT summary FROM sessions WHERE id=$1", [sid])).rows[0].summary;
    expect(Object.keys(row)).not.toContain("facts");
    expect(row.counts).toMatchObject({ active: 2, candidate: 0 });

    const fact = (await store.memories(uid, { kinds: ["fact"] }))[0]!;
    expect(await store.deleteMemory(uid, fact.id, "voice", sid)).toBe(true);
    expect(await store.scrubQueue(uid)).toHaveLength(1);

    // until the derived text is cleaned, none of it reaches a prompt
    let view = await store.memoryView(uid);
    expect(view).toMatchObject({ summaries: [], openTopics: [], progress: [], digest: null, agenda: null });
    expect(view.goals[0]).toMatchObject({ content: "לחסוך לדירה", stateNote: null });
    expect(buildContext(view, { language: "he" }).system_prompt).not.toContain("בנק");
    // no model available: it stays pending (and hidden); consolidation refuses to write new derived text meanwhile
    expect(await scrubUser(store, null, uid)).toEqual({ scrubbed: 0, pending: 1 });
    expect(await consolidate(store, fakeLlm(() => ({ digest: "x" })).llm, uid)).toMatchObject({ skipped: "scrub_pending" });

    // the scrub pass: every note that mentions the bank is rewritten without it, or dropped
    const scrubber = fakeLlm((prompt) => {
      const keys = [...prompt.matchAll(/^- ([a-z]+:[^:\s]*(?::[^:\s]+)?): (.*)$/gm)].map((m) => ({ key: m[1]!, text: m[2]! }));
      return { rewrites: keys.filter((k) => k.text.includes("בנק")).map((k) => ({ key: k.key, text: k.key.startsWith("a:") || k.key.startsWith("p:") ? "" : k.text.replace(/[^.]*בנק[^.]*\.?/g, "").trim() || "דני רוצה לחסוך לדירה." })) };
    });
    expect(await scrubUser(store, scrubber.llm, uid)).toEqual({ scrubbed: 1, pending: 0 });
    expect(scrubber.prompts[0]).toContain("Forgotten information:\nעובד בבנק");
    expect(await store.scrubQueue(uid)).toEqual([]); // the last copy of the forgotten fact is gone
    view = await store.memoryView(uid);
    const prompt = buildContext(view, { language: "he" }).system_prompt;
    expect(prompt).not.toContain("בנק");
    expect(view.summaries).toHaveLength(1);
    expect(view.agenda!.items.map((i) => i.topic)).toEqual(["כמה לחסוך בחודש"]);
    expect(view.progress).toEqual([]);
    // the export has it nowhere, including the transcript line it was taken from
    const exported = await store.exportAll(uid);
    expect(JSON.stringify(exported)).not.toContain("עובד בבנק");
    expect((exported.turns as { text: string }[]).map((t) => t.text)).toEqual(["[removed at the user's request]", "אני רוצה לחסוך לדירה"]);
    expect((await db.query("SELECT summary->>'summary' s FROM sessions WHERE id=$1", [sid])).rows[0].s).not.toContain("בנק");

    // a correction is queued with what is right, so stale text is replaced, not just removed
    await store.correctMemory(uid, goal.id, "לחסוך לבית עם גינה", "app");
    expect(await store.scrubQueue(uid)).toMatchObject([{ content: "לחסוך לדירה", replacement: "לחסוך לבית עם גינה" }]);
    expect((await store.goals(uid))[0]).toMatchObject({ content: "לחסוך לבית עם גינה", sessions_count: 1 }); // the goal keeps its history
    const fixer = fakeLlm(() => ({ rewrites: [] }));
    await scrubUser(store, fixer.llm, uid);
    expect(fixer.prompts[0]).toContain("The correct information is: לחסוך לבית עם גינה");
  });

  it("memory that outgrows the prompt: the important stays, old conversations are folded into a digest", async () => {
    if (!available) return;
    const uid = await store.createUser("grow");
    const central = await store.addMemory(uid, { kind: "fact", content: "מגדל שלושה ילדים לבד", status: "active", importance: 3, provenance: { confirmed: true } });
    await db.query("UPDATE memories SET created_at = now() - interval '200 days', updated_at = now() - interval '200 days' WHERE id=$1", [central]);
    for (let i = 0; i < 16; i++) await store.addMemory(uid, { kind: "fact", content: `פרט קטן ${i}`, status: "active", importance: 1, provenance: {} });
    let view = await store.memoryView(uid);
    expect(view.facts.length).toBeLessThanOrEqual(10);
    expect(view.facts).toContain("מגדל שלושה ילדים לבד"); // not pushed out by sixteen newer small things
    await store.markUsed(view.usedIds);
    expect((await store.getMemory(uid, central))!.last_used_at).not.toBeNull();

    // five conversations: the three newest summaries stay verbatim, the two older ones are folded
    for (let i = 0; i < 5; i++) {
      const id = await store.addMemory(uid, { kind: "summary", content: `שיחה מספר ${i}`, status: "active", provenance: {} });
      await db.query("UPDATE memories SET created_at = now() - make_interval(days => $2) WHERE id=$1", [id, 10 - i]);
    }
    const c = fakeLlm(() => ({ digest: "הורה יחיד לשלושה.", history_digest: "בשיחות הראשונות דובר על 0 ו-1." }));
    expect(await consolidate(store, c.llm, uid)).toEqual({ digest: true, history: true });
    expect(c.prompts[0]).toContain("- שיחה מספר 0\n- שיחה מספר 1");
    expect(c.prompts[0]).not.toContain("שיחה מספר 2"); // still verbatim in the prompt
    expect(c.prompts[0]).not.toContain("not confirmed");
    view = await store.memoryView(uid);
    expect(view).toMatchObject({ digest: "הורה יחיד לשלושה.", historyDigest: "בשיחות הראשונות דובר על 0 ו-1." });
    expect(view.summaries.map((s) => s.content)).toEqual(["שיחה מספר 4", "שיחה מספר 3", "שיחה מספר 2"]);
    // nothing new to fold: the history digest is left alone
    const again = fakeLlm(() => ({ digest: "הורה יחיד לשלושה ילדים.", history_digest: "should not be used" }));
    expect(await consolidate(store, again.llm, uid)).toEqual({ digest: true, history: false });
    expect((await store.memoryView(uid)).historyDigest).toBe("בשיחות הראשונות דובר על 0 ו-1.");
    // one more conversation: summary 2 becomes "older" and is folded next time
    await store.addMemory(uid, { kind: "summary", content: "שיחה מספר 5", status: "active", provenance: {} });
    const third = fakeLlm(() => ({ digest: "d", history_digest: "h" }));
    await consolidate(store, third.llm, uid);
    expect(third.prompts[0]).toContain("- שיחה מספר 2");
    expect(third.prompts[0]).not.toContain("- שיחה מספר 1\n");
    expect(third.prompts[0]).toContain("what was already folded in");
  });
});
