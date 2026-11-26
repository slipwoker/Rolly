/**
 * How the user's name is pronounced (P1-D39): the user's correction picks one of the readings the pod's own front end produced
 * (never phonemes written by the model), is stored with the name, reaches the pod's context, and is dropped when the name changes.
 * Own database (TEST_NAMEPRON_DATABASE_URL), created if missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, migrate, type Db } from "../src/db/index.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { buildContext } from "../src/persona/promptBuilder.ts";
import { handleNamePronunciation, type NameReadings } from "../src/memory/live.ts";
import type { UtilityLlm } from "../src/memory/llm.ts";
import type { SessionTurn } from "../src/voice/session.ts";

const URL = process.env.TEST_NAMEPRON_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_namepron_test";
let db: Db, store: MemoryStore, available = true;

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
  db = createPool(URL);
  await migrate(db);
  store = new MemoryStore(db, { candidateTtlDays: 14, transcriptRetentionDays: 30 });
});
afterAll(async () => { await db?.end(); });

let idx = 0;
const say = (text: string, attribution: "primary" | "uncertain" = "primary"): SessionTurn => ({ idx: idx++, role: "user", text, attribution, startedAt: Date.now(), meta: {} });
const choosing = (choice: unknown): UtilityLlm & { prompts: string[] } => {
  const prompts: string[] = [];
  return { name: "fake", prompts, async json(p) { prompts.push(p); return { obj: { choice }, ms: 1 }; } };
};
const readings = (c: string[] | null): NameReadings & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async candidates(w) { asked.push(w); return c; } };
};

describe("the user corrects how their name is pronounced", () => {
  it("picks one of the readings the voice produced, stores it with the name, and the pod's context carries it", async () => {
    if (!available) return;
    const uid = await store.createUser("pron");
    await store.updateProfile(uid, { preferred_name: "מאור" });
    const turn = say("קוראים לי מאור, לא מאיר");
    const llm = choosing(2), rd = readings(["meʔˈoʁ", "maʔˈoʁ"]);
    const r = await handleNamePronunciation(store, llm, rd, { userId: uid, sessionId: "s", turn, recent: [turn] });
    expect(r).toEqual({ word: "מאור", ipa: "maʔˈoʁ" });
    expect(rd.asked).toEqual(["מאור"]);
    expect(llm.prompts[0]).toContain("1. meʔˈoʁ\n2. maʔˈoʁ");
    expect((await store.profile(uid)).name_pron).toEqual({ name: "מאור", ipa: "maʔˈoʁ", source: "user" });
    const ctx = buildContext(await store.memoryView(uid), { timeZone: "Asia/Jerusalem", language: "he" });
    expect(ctx.profile).toMatchObject({ name: "מאור", name_pron: { name: "מאור", ipa: "maʔˈoʁ" } });
  });

  it("does nothing without the cue, with an uncertain speaker, with one reading only, or when no reading matches", async () => {
    if (!available) return;
    const uid = await store.createUser("pron2");
    await store.updateProfile(uid, { preferred_name: "מאור" });
    const llm = choosing(1), rd = readings(["meʔˈoʁ", "maʔˈoʁ"]);
    const run = (t: SessionTurn, l: UtilityLlm | null = llm, r: NameReadings | null = rd) => handleNamePronunciation(store, l, r, { userId: uid, sessionId: "s", turn: t, recent: [t] });
    expect(await run(say("מה מזג האוויר?"))).toBeNull(); // no cue: no call at all
    expect(llm.prompts).toHaveLength(0);
    expect(await run(say("קוראים לי מאור", "uncertain"))).toBeNull(); // not the user, or not clearly
    expect(await run(say("קוראים לי מאור"), llm, readings(["meʔˈoʁ"]))).toBeNull();
    expect(await run(say("קוראים לי מאור"), choosing(null), rd)).toBeNull();
    expect(await run(say("קוראים לי מאור"), choosing(7), rd)).toBeNull(); // out of range: never invented
    expect(await run(say("קוראים לי מאור"), null, rd)).toBeNull();
    expect((await store.profile(uid)).name_pron).toBeNull();
  });

  it("is dropped when the name changes, and kept when the same name is written again", async () => {
    if (!available) return;
    const uid = await store.createUser("pron3");
    await store.updateProfile(uid, { preferred_name: "מאור" });
    await store.setNamePron(uid, { name: "מאור", ipa: "maʔˈoʁ", source: "user" });
    await store.updateProfile(uid, { preferred_name: "מאור" });
    expect((await store.profile(uid)).name_pron).not.toBeNull();
    await store.updateProfile(uid, { preferred_name: "אורי" });
    expect((await store.profile(uid)).name_pron).toBeNull();
  });
});
