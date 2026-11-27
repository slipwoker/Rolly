/** Standing consent for a source and what leaves with it (P1-D41), against a real PostgreSQL (TEST_DATABASE_URL). */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Db } from "../src/db/index.ts";
import { MemoryStore } from "../src/memory/store.ts";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_test";
let db: Db, store: MemoryStore;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: URL }); await c.connect(); // no silent skip: a missing database fails this file
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await c.end();
  db = createPool(URL); await migrate(db);
  store = new MemoryStore(db, { candidateTtlDays: 14, transcriptRetentionDays: 30 });
});
afterAll(async () => { await db?.end(); });

describe("signal consent", () => {
  it("is off unless a row says on, accepts only known sources, and goes with the account", async () => {
    const uid = await store.createUser("consent");
    expect((await db.query("SELECT enabled FROM signal_consent WHERE user_id=$1", [uid])).rows).toEqual([]);
    await db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,'calendar',true)", [uid]);
    expect((await db.query("SELECT enabled FROM signal_consent WHERE user_id=$1 AND source='calendar'", [uid])).rows[0]!.enabled).toBe(true);
    await expect(db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,'whatsapp',true)", [uid])).rejects.toThrow(); // not yet: it gets its own consent screen
    await store.deleteAccount(uid);
    expect((await db.query("SELECT 1 FROM signal_consent WHERE user_id=$1", [uid])).rows).toEqual([]);
  });

  it("withdrawing consent removes the plan items that came from the calendar, and only those", async () => {
    const uid = await store.createUser("withdraw");
    await store.saveAgenda(uid, null, [
      { topic: "הפגישה עם המשקיע", why: "", kind: "direction", ref_id: null, source: "calendar", expires_at: "2026-12-04" },
      { topic: "שקט בנסיעה", why: "", kind: "fresh", ref_id: null },
    ], null);
    expect((await store.memoryView(uid)).agenda!.items).toHaveLength(2);
    await store.dropAgendaSource(uid, "calendar");
    expect((await store.memoryView(uid)).agenda!.items.map((i) => i.topic)).toEqual(["שקט בנסיעה"]);
  });
});
