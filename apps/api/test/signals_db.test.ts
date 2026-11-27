/** Standing consent for a source and what leaves with it (P1-D42), against a real PostgreSQL (TEST_DATABASE_URL). */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Db } from "../src/db/index.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { signalEnabled, signalSettings } from "../src/signals/consent.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  it("is ON unless a row says off: a new account is on, an explicit off row switches one source off", async () => {
    const uid = await store.createUser("default-on");
    expect(await signalSettings(db, uid)).toEqual({ calendar: true, mail: true, whatsapp: true });
    await db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,'mail',false)", [uid]);
    expect(await signalSettings(db, uid)).toEqual({ calendar: true, mail: false, whatsapp: true });
    expect(await signalEnabled(db, uid, "mail")).toBe(false);
    expect(await signalEnabled(db, uid, "whatsapp")).toBe(true);
  });

  it("accounts that existed before the default changed start OFF (migration 009), and keep a choice they already made", async () => {
    const old = await store.createUser("existing"), chosen = await store.createUser("chosen");
    await db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,'calendar',true)", [chosen]); // switched on before
    await db.query(readFileSync(resolve(import.meta.dirname, "../src/db/migrations/009_signal_consent_default_on.sql"), "utf8"));
    expect(await signalSettings(db, old)).toEqual({ calendar: false, mail: false, whatsapp: false });
    expect(await signalSettings(db, chosen)).toEqual({ calendar: true, mail: false, whatsapp: false });
    const fresh = await store.createUser("after");
    expect(await signalSettings(db, fresh)).toEqual({ calendar: true, mail: true, whatsapp: true });
  });

  it("a row is needed to switch off, accepts only known sources, accepts only known sources, and goes with the account", async () => {
    const uid = await store.createUser("consent");
    expect((await db.query("SELECT enabled FROM signal_consent WHERE user_id=$1", [uid])).rows).toEqual([]);
    await db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,'calendar',false)", [uid]);
    expect((await db.query("SELECT enabled FROM signal_consent WHERE user_id=$1 AND source='calendar'", [uid])).rows[0]!.enabled).toBe(false);
    for (const src of ["mail", "whatsapp"]) await db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,$2,false)", [uid, src]); // each source has its own row
    await expect(db.query("INSERT INTO signal_consent(user_id, source, enabled) VALUES ($1,'sms',true)", [uid])).rejects.toThrow(); // an unknown source is refused
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
