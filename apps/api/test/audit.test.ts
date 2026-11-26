/**
 * Agent audit (src/audit/): pure metrics and costs, then one real conversation end to end against PostgreSQL
 * (createApp + fake pod + scripted phone + a fake utility model), the backoffice API, and the privacy rules:
 * "forget" and retention remove the personal text, deleting the conversation removes the audit row.
 * Own database (TEST_AUDIT_DATABASE_URL, default postgres://rolly:rolly@127.0.0.1/rolly_audit_test), created if missing,
 * so it can run next to memory.test.ts, which resets its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import type { UtilityLlm } from "../src/memory/llm.ts";
import { Phone } from "../src/selftest/phone.ts";
import { assess, type AuditTurn } from "../src/audit/quality.ts";
import { loadPricing, parseUsage, priceOf, tokenCost, gpuPerDay, DEFAULT_PRICING } from "../src/audit/pricing.ts";
import { costs, dayKey, overview, byPrompt, type SessionRow } from "../src/audit/insights.ts";
import { normalizeJudge } from "../src/audit/judge.ts";
import { startFakePod, tone, type FakePod } from "./fakePod.ts";

// ------------------------------------------------------------------ pure
const t = (idx: number, role: "user" | "agent", text: string, extra: Partial<AuditTurn> = {}): AuditTurn =>
  ({ idx, role, text, attribution: "primary", language: role === "user" ? "he" : null, meta: {}, ...extra });
const base = { session: { language: "he", end_reason: "client_end", onboarding: false, summary: { method: "llm", counts: { active: 1, candidate: 0 } } },
  memoryEvents: [], llmCalls: [], notes: [] };

describe("audit metrics (pure)", () => {
  it("a clean conversation has no flags and a full score", () => {
    const r = assess({ ...base, turns: [t(0, "agent", "בוקר טוב דני, איך הלילה?"), t(1, "user", "בסדר, קצת עייף"), t(2, "agent", "אז קפה כפול היום. מה על הפרק?"),
      t(3, "user", "פגישה עם לקוח"), t(4, "agent", "איזה לקוח? החדש מהשבוע שעבר?")],
      stats: { duration_s: 300, server_reply_ms: [700, 800, 900], interruptions: 0, errors: 0 } });
    expect(r.flags).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.quality.reply_ms).toMatchObject({ p50: 800, p95: 900, slow: 0 });
    expect(r.quality.style.replies).toBe(3);
  });

  it("flags language mismatch, bot-speak, slow replies and user memory fixes", () => {
    const r = assess({ ...base,
      turns: [t(0, "user", "the rest of the army", { language: "en" }), t(1, "agent", "הבנתי אותך."), t(2, "user", "oh lay", { language: "en" }),
        t(3, "agent", "צודק, לפעמים פשוט צריך לנשום."), t(4, "user", "you", { language: "en" }), t(5, "agent", "נכון, בסוף היום הכי חשוב זה לנוח.")],
      stats: { duration_s: 200, server_reply_ms: [1800, 2600, 3500], interruptions: 0, errors: 0 },
      memoryEvents: [{ action: "correct", via: "voice" }] });
    const ids = r.flags.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["language_mismatch", "bot_speak", "slow", "memory_corrected"]));
    expect(r.score).toBeLessThan(50);
    expect(r.flags.find((f) => f.id === "language_mismatch")!.why).toContain("en:3");
  });

  it("a pipeline failure and an abandoned ride", () => {
    const r = assess({ ...base, session: { ...base.session, end_reason: "provider_error" }, turns: [t(0, "agent", "היי")], stats: { duration_s: 12, errors: 1 } });
    expect(r.flags.map((f) => f.id)).toEqual(["pipeline_failed", "abandoned"]);
  });

  it("prices tokens with cached input and leaves unknown models unpriced", () => {
    const p = DEFAULT_PRICING;
    expect(priceOf(p, "gpt-6-luna-2026-10-01")).toEqual(p.models["gpt-6-luna"]);
    // 1000 in (800 cached), 200 out at 0.10 / 0.01 / 0.50 per 1M
    expect(tokenCost(p, "gpt-6-luna", { prompt_tokens: 1000, cached_tokens: 800, completion_tokens: 200 })).toBeCloseTo((200 * 0.1 + 800 * 0.01 + 200 * 0.5) / 1e6, 12);
    expect(tokenCost(p, "mystery-model", { prompt_tokens: 10 })).toBeNull();
    // the pod is a fixed cost per day, never per conversation
    expect(gpuPerDay(p)).toBeCloseTo(1.09 * 24);
    expect(gpuPerDay(loadPricing('{"gpu_hours_per_day": 10}'))).toBeCloseTo(10.9);
    expect(parseUsage({ prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } }))
      .toEqual({ prompt_tokens: 5, cached_tokens: 3, completion_tokens: 2, reasoning_tokens: 1 });
    const o = loadPricing('{"gpu_usd_per_hour": 0.79, "models": {"x": {"input": 1, "cached": 0.1, "output": 2}}}');
    expect(o.gpu_usd_per_hour).toBe(0.79);
    expect(o.models["gpt-6-luna"]).toBeTruthy();
    expect(loadPricing("not json").gpu_usd_per_hour).toBe(1.09);
  });

  it("aggregates conversations, costs and prompt versions", () => {
    const now = new Date();
    const row = (id: string, extra: Partial<SessionRow>): SessionRow => ({ id, user_id: "u1", user_label: "A", started_at: now, language: "he", end_reason: "client_end",
      user_turns: 3, onboarding: false, stats: { duration_s: 600, server_reply_ms: [600, 800] }, quality: { score: 90, style: { replies: 4, clean: 3, ack: 1 }, turns_agent: 4, interruptions: 1 },
      flags: [], cost: { gpu_usd: 0.18 }, judge: { overall: 4, scores: { naturalness: 4 } }, review_rating: 5, prompt_hash: "aaa", api_usd: 0.001, ...extra });
    const rows = [row("s1", {}), row("s2", { flags: ["slow"], prompt_hash: "bbb", quality: { score: 70, style: { replies: 2, clean: 0, ack: 2 }, turns_agent: 2 } }),
      row("s3", { user_turns: 0, cost: { gpu_usd: 0.01 } })];
    const calls = [{ at: now, purpose: "summary", model: "gpt-6-luna", ok: true, ms: 900, cost_usd: 0.0008, prompt_tokens: 3000, completion_tokens: 400, cached_tokens: 0, session_id: "s1", user_id: "u1" },
      { at: now, purpose: "plan", model: "gpt-6-luna", ok: false, ms: 100, cost_usd: 0, prompt_tokens: null, completion_tokens: null, cached_tokens: null, session_id: "s1", user_id: "u1" }];
    // the service exists since today: one day of the fixed pod in the 7-day range, whatever the number of conversations
    const fixed = { gpuPerDay: 26.16, gpuHoursPerDay: 24, firstDay: dayKey(now, "Asia/Jerusalem") };
    const o = overview(rows, calls, { timeZone: "Asia/Jerusalem", days: 7, ...fixed });
    expect(o.kpis.conversations).toBe(2);
    expect(o.kpis.minutes).toBe(20);
    expect(o.kpis.gpu_usd).toBeCloseTo(26.16, 6);
    expect(o.kpis.total_usd).toBeCloseTo(0.0008 + 26.16, 6);
    expect(o.kpis.api_usd_per_minute).toBeCloseTo(0.0008 / 20, 8);
    expect(o.kpis.gpu_busy_share).toBeCloseTo(20 / (24 * 60), 4);
    expect(o.daily.filter((d) => d.gpu_usd > 0)).toHaveLength(1);
    expect(o.daily).toHaveLength(7);
    expect(o.flags).toEqual([{ key: "slow", n: 1 }]);
    expect(o.insights.style.ack_rate).toBe(0.5);
    expect(o.insights.judge.naturalness).toBe(4);
    const c = costs(rows, calls, { timeZone: "Asia/Jerusalem", days: 7, fixedMonthly: { a: 30 }, ...fixed });
    expect(c.by_purpose.find((p) => p.purpose === "plan")!.failures).toBe(1);
    expect(c.totals).toMatchObject({ pod_days: 1, gpu_usd: 26.16, fixed_other_usd: 1 });
    expect(c.totals.total_usd).toBeCloseTo(27.16, 2);
    expect(c.by_user[0]).toMatchObject({ minutes: 20, minutes_share: 1, api_usd: 0.0008 });
    expect(c.by_user[0]).not.toHaveProperty("gpu_usd");
    const bp = byPrompt(rows);
    expect(bp.find((p) => p.hash === "bbb")!.bot_speak_rate).toBe(1);
    expect(bp.find((p) => p.hash === "aaa")!.conversations).toBe(1);
  });

  it("normalises the judge's answer", () => {
    const j = normalizeJudge({ scores: { naturalness: 7, relevance: 2.4, bogus: 3 }, issues: [{ turn: 3, criterion: "relevance", note: "answered a misheard line" }, { note: "" }] }, "m", 10);
    expect(j.scores).toEqual({ naturalness: 5, relevance: 2 });
    expect(j.overall).toBe(4);
    expect(j.issues).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ end to end with PostgreSQL
const URL = process.env.TEST_AUDIT_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_audit_test";
const ADMIN = "admin-test-token-123";
let available = true, pod: FakePod, app: FastifyInstance, port: number, db: pg.Pool;
let full: Awaited<ReturnType<typeof import("../src/app.ts")["createApp"]>>;

/** answers like the real utility model would, per purpose, with an OpenAI-style usage block */
const fakeLlm: UtilityLlm = {
  name: "gpt-6-luna",
  async json(prompt, opts = {}) {
    const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 0 } };
    const item = (content: string, quote: string) => ({ content, quote, confidence: 0.95, first_person: true, turn: null });
    if (opts.purpose === "summary") return { ms: 5, usage, obj: {
      summary: "דני רוצה ללמוד איטלקית בנסיעות.", unresolved_topics: [], progress: [], language: "he", other_speakers_suspected: false,
      preferred_name: item("דני", "קוראים לי דני"), travel_goals: [item("ללמוד איטלקית בנסיעות", "אני רוצה ללמוד איטלקית בנסיעות")] } };
    if (opts.purpose === "plan") return { ms: 5, usage, obj: { next_agenda: [{ topic: "איטלקית: מאיפה להתחיל", why: "goal", kind: "goal_step" }], agenda_outcome: [] } };
    if (opts.purpose === "judge") {
      expect(prompt).toContain("ROLLY:");
      return { ms: 5, usage, obj: { scores: { naturalness: 4, relevance: 3, initiative: 4, memory_use: 4, brevity: 5, language: 4 }, overall: 4,
        issues: [{ turn: 2, criterion: "relevance", note: "a generic reply to a specific statement" }], strengths: ["short"], summary: "Mostly natural." } };
    }
    return { ms: 5, usage, obj: {} };
  },
};

async function ensureDb(url: string) {
  try { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await c.end(); return true; }
  catch (e) {
    if (!/does not exist/.test(String(e))) return false;
    const u = new globalThis.URL(url), name = u.pathname.slice(1);
    u.pathname = "/postgres";
    try { const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); await c.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`); await c.end(); return true; }
    catch { return false; }
  }
}

beforeAll(async () => {
  if (!(await ensureDb(URL))) { available = false; return; }
  pod = await startFakePod({ script: ["קוראים לי דני", "אני רוצה ללמוד איטלקית בנסיעות", "טוב, הגעתי, ביי"], token: "pod-key", replyMs: 400 });
  const config = { ...loadConfig({ DATABASE_URL: URL, ROLLY_GPU_API_KEY: "pod-key", ROLLY_GPU_WORKER_URL: pod.url, ROLLY_DEV_AUTH: "1",
    ROLLY_ADMIN_TOKEN: ADMIN, ROLLY_BUILD: "testbuild" } as NodeJS.ProcessEnv), port: 0 };
  const { createApp } = await import("../src/app.ts");
  full = await createApp(config, { llm: fakeLlm });
  app = await buildServer(full);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
  db = new pg.Pool({ connectionString: URL });
}, 30_000);
afterAll(async () => { await app?.close(); await pod?.close(); await db?.end(); });

const speech = (ms: number) => new Uint8Array(tone(ms, 16000, 0.3, 300));
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 150)); }
};
const adminGet = (path: string, token = ADMIN) => app.inject({ method: "GET", url: path, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("audit end to end", () => {
  let uid: string, sid: string;

  it("records prompt, notes, per-turn timings, model usage, utility calls, assessment and judge for a conversation", async () => {
    if (!available) return;
    uid = await full.store.createUser("tester A");
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=${uid}`);
    phone.send({ type: "session.start", language: "he", language_explicit: true, journey: { duration_min: 20 } });
    await phone.waitReply(0, 5000);
    for (let i = 0; i < 3; i++) { const end = await phone.say(speech(500)); await phone.waitReply(end - 1, 5000); }
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.closed, 8000, "closed");
    phone.stop();

    const a = await until(async () => (await db.query("SELECT * FROM session_audit WHERE user_id=$1 AND judge IS NOT NULL", [uid])).rows[0], 20_000);
    sid = a.session_id;
    await full.audit.flush();
    // prompt: persona stored once, personal part kept apart
    const v = (await db.query("SELECT * FROM prompt_versions WHERE hash=$1", [a.prompt_hash])).rows[0];
    expect(v.text.startsWith("You are Rolly.")).toBe(true);
    expect(v.build).toBe("testbuild");
    expect(a.memory_block).toContain("Local time");
    expect(a.opener).toContain("journey_start");
    expect(a.prompt_chars).toBe(v.text.length + 2 + a.memory_chars);
    // assessment
    expect(a.quality.turns_user).toBe(3);
    expect(a.quality.conv_llm).toMatchObject({ calls: 4, model: "fake-gemma" });
    expect(a.quality.reply_ms.n).toBe(3);
    expect(a.cost).toEqual({ conversation_s: expect.any(Number) }); // no GPU share per conversation
    expect(a.judge).toMatchObject({ overall: 4, model: "gpt-6-luna" });
    // per-turn timings on agent turns
    const turns = (await db.query("SELECT role, meta FROM turns WHERE session_id=$1 AND role='agent' ORDER BY idx", [sid])).rows;
    expect(turns.at(-1)!.meta).toMatchObject({ llm_ttft_ms: 180, tts_ttfa_ms: 95, completion_tokens: 30 });
    expect(typeof turns.at(-1)!.meta.reply_ms).toBe("number");
    // the session's own stats carry the pod's raw usage
    const st = (await db.query("SELECT stats FROM sessions WHERE id=$1", [sid])).rows[0].stats;
    expect(st.usage.tts.engine).toBe("fake-voice");
    // every utility call, attributed to the session, priced
    const calls = (await db.query("SELECT purpose, cost_usd, session_id, user_id FROM llm_calls WHERE user_id=$1", [uid])).rows;
    const purposes = calls.map((c) => c.purpose);
    expect(purposes).toEqual(expect.arrayContaining(["summary", "plan", "judge"]));
    expect(calls.filter((c) => c.purpose === "summary").every((c) => c.session_id === sid)).toBe(true);
    expect(Number(calls.find((c) => c.purpose === "summary")!.cost_usd)).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6, 9);
  }, 40_000);

  it("serves the backoffice page and refuses the API without the admin token", async () => {
    if (!available) return;
    const page = await app.inject({ method: "GET", url: "/admin" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.body).toContain("/admin/app.js");
    expect((await app.inject({ method: "GET", url: "/admin/app.js" })).statusCode).toBe(200);
    for (const mode of ["light", "dark"]) {
      const logo = await app.inject({ method: "GET", url: `/admin/logo-${mode}.svg` });
      expect(logo.statusCode).toBe(200);
      expect(logo.headers["content-type"]).toBe("image/svg+xml");
      expect(logo.body).toContain('viewBox="112 150 800 800"');
    }
    expect((await adminGet("/v1/admin/audit/overview", "")).statusCode).toBe(401);
    expect((await adminGet("/v1/admin/audit/overview", "wrong")).statusCode).toBe(401);
  });

  it("answers overview, sessions, detail, prompts, costs, users and model calls", async () => {
    if (!available) return;
    const o = (await adminGet("/v1/admin/audit/overview?days=7")).json();
    expect(o.kpis.conversations).toBe(1);
    expect(o.kpis.api_usd).toBeGreaterThan(0);
    const list = (await adminGet("/v1/admin/audit/sessions?days=7")).json();
    expect(list.sessions.map((x: { id: string }) => x.id)).toContain(sid);
    const det = (await adminGet(`/v1/admin/audit/sessions/${sid}`)).json();
    expect(det.turns.length).toBeGreaterThanOrEqual(6);
    expect(det.audit.persona_text.startsWith("You are Rolly.")).toBe(true);
    expect(det.llm_calls.length).toBeGreaterThanOrEqual(3);
    expect(det.memories_learned.map((m: { content: string }) => m.content)).toContain("ללמוד איטלקית בנסיעות");
    const pr = (await adminGet("/v1/admin/audit/prompts?days=7")).json();
    expect(pr.versions[0].metrics.conversations).toBe(1);
    const c = (await adminGet("/v1/admin/audit/costs?days=7")).json();
    expect(c.by_purpose.map((p: { purpose: string }) => p.purpose)).toContain("summary");
    const u = (await adminGet("/v1/admin/audit/users?days=7")).json();
    expect(u.users.find((x: { id: string }) => x.id === uid)).toMatchObject({ conversations: 1, display_label: "tester A" });
    const calls = (await adminGet("/v1/admin/audit/llm-calls?days=7&purpose=judge")).json();
    expect(calls.calls.every((x: { purpose: string }) => x.purpose === "judge")).toBe(true);
    // self-test users are hidden unless asked for
    await full.store.createUser("selftest 2026");
    expect((await adminGet("/v1/admin/audit/users?days=7")).json().users.some((x: { display_label: string }) => x.display_label.startsWith("selftest"))).toBe(false);
    expect((await adminGet("/v1/admin/audit/users?days=7&selftest=1")).json().users.some((x: { display_label: string }) => x.display_label.startsWith("selftest"))).toBe(true);
  });

  it("stores the owner's review and names a prompt version", async () => {
    if (!available) return;
    const r = await app.inject({ method: "POST", url: `/v1/admin/audit/sessions/${sid}/review`, headers: { authorization: `Bearer ${ADMIN}` },
      payload: { rating: 4, tags: ["great", "too_long"], note: "good opener" } });
    expect(r.statusCode).toBe(200);
    const a = (await db.query("SELECT review_rating, review_tags, review_note FROM session_audit WHERE session_id=$1", [sid])).rows[0];
    expect(a).toEqual({ review_rating: 4, review_tags: ["great", "too_long"], review_note: "good opener" });
    const bad = await app.inject({ method: "POST", url: `/v1/admin/audit/sessions/${sid}/review`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { rating: 9 } });
    expect(bad.statusCode).toBe(400);
    const hash = (await db.query("SELECT prompt_hash FROM session_audit WHERE session_id=$1", [sid])).rows[0].prompt_hash;
    const p = await app.inject({ method: "PATCH", url: `/v1/admin/audit/prompts/${hash}`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { label: "lean v2" } });
    expect(p.statusCode).toBe(200);
    expect((await adminGet(`/v1/admin/audit/prompts/${hash}`)).json().label).toBe("lean v2");
  });

  it("'forget' removes the personal text from the audit, keeps the persona and the measurements", async () => {
    if (!available) return;
    await db.query("UPDATE session_audit SET notes = $2 WHERE session_id=$1", [sid, JSON.stringify([
      { kind: "plan", text: "bring up Italian", turns: 1, at_s: 5 }, { kind: "style", text: "Your last two replies opened by agreeing.", turns: 1, at_s: 9 }])]);
    const m = (await db.query("SELECT id FROM memories WHERE user_id=$1 AND content='ללמוד איטלקית בנסיעות'", [uid])).rows[0];
    expect(await full.store.deleteMemory(uid, m.id, "app")).toBe(true);
    const a = (await db.query("SELECT * FROM session_audit WHERE session_id=$1", [sid])).rows[0];
    expect(a).toMatchObject({ memory_block: null, opener: null, plan: null, redacted: "forget" });
    expect(a.notes).toEqual([{ kind: "plan", turns: 1, at_s: 5 }, { kind: "style", text: "Your last two replies opened by agreeing.", turns: 1, at_s: 9 }]);
    expect(a.judge.overall).toBe(4);
    expect(a.judge.issues).toBeUndefined();
    expect(a.quality.turns_user).toBe(3);
    expect((await db.query("SELECT 1 FROM prompt_versions WHERE hash=$1", [a.prompt_hash])).rowCount).toBe(1);
  });

  it("retention removes personal text of old rows only; deleting the conversation removes its audit row", async () => {
    if (!available) return;
    const old = crypto.randomUUID(), fresh = crypto.randomUUID();
    for (const [id, age] of [[old, 40], [fresh, 1]] as const) {
      await db.query("INSERT INTO sessions(id, user_id, started_at) VALUES ($1,$2, now() - make_interval(days => $3))", [id, uid, age]);
      await db.query("INSERT INTO session_audit(session_id, user_id, created_at, memory_block, opener) VALUES ($1,$2, now() - make_interval(days => $3), 'personal', 'hello')", [id, uid, age]);
    }
    expect(await full.audit.purge(30)).toBe(1);
    const rows = Object.fromEntries((await db.query("SELECT session_id, memory_block, redacted FROM session_audit WHERE session_id = ANY($1::uuid[])", [[old, fresh]])).rows.map((r) => [r.session_id, r]));
    expect(rows[old]).toMatchObject({ memory_block: null, redacted: "retention" });
    expect(rows[fresh]).toMatchObject({ memory_block: "personal", redacted: null });
    expect(await full.store.deleteSession(uid, sid)).toBeTruthy();
    expect((await db.query("SELECT 1 FROM session_audit WHERE session_id=$1", [sid])).rowCount).toBe(0);
    // account deletion removes the user's model-call records too
    await full.store.deleteAccount(uid);
    expect((await db.query("SELECT 1 FROM llm_calls WHERE user_id=$1", [uid])).rowCount).toBe(0);
  });
});
