/**
 * Online lookups (src/lookup/web.ts, P1-D34): the search step on its own with a fake search model, then end to end
 * through the real app (createApp + fake pod + scripted phone + PostgreSQL): the daily allowance, the cost in the audit.
 * Own database (TEST_LOOKUP_DATABASE_URL, default postgres://rolly:rolly@127.0.0.1/rolly_lookup_test), created if missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import type { UtilityLlm } from "../src/memory/llm.ts";
import { LOOKUP_FAILED_TAG, LOOKUP_TAG, lookupMessage, lookupPrompt, webLookup } from "../src/lookup/web.ts";
import { Phone } from "../src/selftest/phone.ts";
import { startFakePod, tone, type FakePod } from "./fakePod.ts";

const searching = (text: string, searches = 1): UtilityLlm & { prompts: string[] } => {
  const prompts: string[] = [];
  return { name: "gpt-6-luna", prompts, async json() { return { obj: {}, ms: 1 }; },
    async search(prompt) { prompts.push(prompt); return { text, ms: 40, searches, usage: { prompt_tokens: 5000, completion_tokens: 150 } }; } };
};
const args = { question: "מה יהיה מזג האוויר שם? אתה יכול לבדוק?", language: "he", timeZone: "Asia/Jerusalem", now: new Date("2026-11-26T10:38:00Z"),
  recent: [{ role: "user" as const, text: "אני טסה לבואנוס איירס בחודש הבא" }, { role: "agent" as const, text: "אז מה את חושבת לגבי בגדים חמים?" }] };

describe("the search step", () => {
  it("asks with the question and the last turns, and nothing else about the user", () => {
    const p = lookupPrompt(args);
    expect(p).toContain("What to find out: מה יהיה מזג האוויר שם? אתה יכול לבדוק?");
    expect(p).toContain("USER: אני טסה לבואנוס איירס בחודש הבא");
    expect(p).toContain("COMPANION: אז מה את חושבת לגבי בגדים חמים?");
    expect(p).toContain("In everyday spoken Hebrew");
    expect(p).toContain("Thursday, 26 November 2026 at 12:38, Asia/Jerusalem");
    expect(lookupPrompt({ ...args, language: "en" })).toContain("In English");
  });

  it("returns spoken text: no links, no markdown, no leftover brackets", async () => {
    const llm = searching("בדקתי: **23–30 מעלות** ביום ([weather.com](https://weather.com/x)), עם ממטרים. ראו https://example.com/a");
    const r = await webLookup(llm, args);
    expect(r).toMatchObject({ ok: true, searches: 1 });
    expect(r.ok && r.answer).toBe("בדקתי: 23–30 מעלות ביום , עם ממטרים. ראו");
    expect(lookupMessage(r)).toContain(`${LOOKUP_TAG} You checked online. What you found: בדקתי: 23–30 מעלות`);
    expect(lookupMessage(r)).toContain("in your own words");
  });

  it("never throws: no search tool, an error and an empty answer are results the conversation can say", async () => {
    expect(await webLookup(null, args)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await webLookup({ name: "x", async json() { return { obj: {}, ms: 1 }; } }, args)).toMatchObject({ ok: false, reason: "unavailable" });
    const broken: UtilityLlm = { name: "x", async json() { return { obj: {}, ms: 1 }; }, async search() { throw new Error("web search HTTP 500"); } };
    const r = await webLookup(broken, args);
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect(lookupMessage(r)).toContain(LOOKUP_FAILED_TAG);
    expect(lookupMessage(r)).toContain("do not guess the answer");
    expect(await webLookup(searching("  ([x](https://x.y)) "), args)).toMatchObject({ ok: false, reason: "failed" });
    expect(lookupMessage({ ok: false, reason: "limit", ms: 0 })).toContain("used up today's online checks");
  });
});

// ------------------------------------------------------------------ end to end
const URL = process.env.TEST_LOOKUP_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_lookup_test";
let available = true, pod: FakePod, app: FastifyInstance, port: number, db: pg.Pool;
const llm = searching("בבואנוס איירס צפויות 23 עד 30 מעלות.");

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
  // the "model" says it is checking on every user line
  pod = await startFakePod({ script: ["מה מזג האוויר בבואנוס איירס?", "ומה שער הדולר?", "ביי"], token: "pod-key", replyMs: 300, replyText: () => "בודק, שנייה. <lookup/>" });
  const config = { ...loadConfig({ DATABASE_URL: URL, ROLLY_GPU_API_KEY: "pod-key", ROLLY_GPU_WORKER_URL: pod.url, ROLLY_DEV_AUTH: "1",
    OPENAI_API_KEY: "test", ROLLY_LOOKUPS_PER_DAY: "1" } as NodeJS.ProcessEnv), port: 0 };
  const { createApp } = await import("../src/app.ts");
  const full = await createApp(config, { llm });
  app = await buildServer(full);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
  db = new pg.Pool({ connectionString: URL });
}, 30_000);
afterAll(async () => { await app?.close(); await pod?.close(); await db?.end(); });

const speech = (ms: number) => new Uint8Array(tone(ms, 16000, 0.3, 300));

describe("a lookup through the app", () => {
  it("the prompt tells the model how to ask; the first lookup is searched and costed, the second is over the daily allowance", async () => {
    if (!available) return;
    const uid = (await db.query<{ id: string }>("INSERT INTO users(display_label) VALUES ('lookup') RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO profiles(user_id) VALUES ($1)", [uid]);
    const phone = new Phone();
    await phone.connect(`ws://127.0.0.1:${port}/v1/voice?dev_user=${uid}`);
    phone.send({ type: "session.start", language: "he" });
    await phone.waitReply(0, 8000);
    expect(String(pod.starts.at(-1)!.system_prompt)).toContain("append the exact marker <lookup/>");

    for (let i = 0; i < 2; i++) {
      const before = pod.texts.length;
      const end = await phone.say(speech(600));
      await phone.waitReply(end - 1, 8000);
      await phone.waitFor(() => pod.texts.length > before, 10_000, `lookup message ${i + 1}`);
      // let the turn that says it finish before the next question
      await phone.waitFor(() => [...phone.turns.values()].filter((t) => t.done && t.text.startsWith("Said: [lookup")).length > i, 8000, "said");
    }
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.events.some((e) => e.msg.type === "session.closed"), 15_000, "closed");

    expect(pod.texts.at(-2)).toContain(`${LOOKUP_TAG} You checked online. What you found: בבואנוס איירס צפויות 23 עד 30 מעלות.`);
    expect(pod.texts.at(-1)).toContain("used up today's online checks");
    // one real search: the question as the user said it, in the prompt of the search model
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain("What to find out: מה מזג האוויר בבואנוס איירס?");
    // in the audit: purpose "lookup", tokens plus one search fee (5000 in at 0.10, 150 out at 0.50 per 1M, + $0.01)
    const calls = (await db.query("SELECT purpose, ok, cost_usd FROM llm_calls WHERE user_id=$1 AND purpose='lookup'", [uid])).rows;
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);
    expect(Number(calls[0].cost_usd)).toBeCloseTo(0.01 + (5000 * 0.1 + 150 * 0.5) / 1e6, 6);
    // the conversation as stored: two things the user said, nothing in brackets
    const turns = (await db.query("SELECT t.role, t.text FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.user_id=$1 ORDER BY t.idx", [uid])).rows as { role: string; text: string }[];
    expect(turns.filter((t) => t.role === "user").map((t) => t.text)).toEqual(["מה מזג האוויר בבואנוס איירס?", "ומה שער הדולר?"]);
    const stats = (await db.query("SELECT stats FROM sessions WHERE user_id=$1", [uid])).rows[0].stats as { lookups: { ok: boolean; reason?: string }[] };
    expect(stats.lookups.map((l) => [l.ok, l.reason ?? null])).toEqual([[true, null], [false, "limit"]]);
  }, 60_000);
});
