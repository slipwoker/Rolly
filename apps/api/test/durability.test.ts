/** A conversation that is cut off keeps what was said, and is finished by whoever notices (P1-D45). Real PostgreSQL (TEST_DATABASE_URL). */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Db } from "../src/db/index.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { IDLE_S, recoverOrphans } from "../src/memory/recover.ts";
import type { SessionHooks, SessionTurn } from "../src/voice/session.ts";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_test";
let db: Db, store: MemoryStore;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: URL }); await c.connect(); // no silent skip: a missing database fails this file
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await c.end();
  db = createPool(URL); await migrate(db);
  store = new MemoryStore(db, { candidateTtlDays: 14, transcriptRetentionDays: 30 });
});
afterAll(async () => { await db?.end(); });

const turn = (idx: number, role: "user" | "agent", text: string, meta: Record<string, unknown> = {}): SessionTurn =>
  ({ idx, role, text, attribution: "primary", startedAt: Date.now() + idx, meta });
async function open(label: string) {
  const uid = await store.createUser(label), sid = crypto.randomUUID();
  await store.startSession(sid, uid, "he", false, new Date());
  return { uid, sid };
}
const age = (sid: string, secs: number) => db.query("UPDATE sessions SET started_at = now() - make_interval(secs => $2), heartbeat_at = now() - make_interval(secs => $2) WHERE id=$1", [sid, secs]);

describe("turns are written as they happen", () => {
  it("a resumed conversation reads them even though the first one never ended", async () => {
    const { uid, sid } = await open("resume");
    await store.recordTurn(sid, turn(0, "agent", "ערב טוב"));
    await store.recordTurn(sid, turn(1, "user", "אני מתלבט בין שני לחמים"));
    expect(await store.lastTurns(uid, sid, 8)).toEqual([{ role: "agent", text: "ערב טוב" }, { role: "user", text: "אני מתלבט בין שני לחמים" }]);
  });

  it("our own marked messages are not part of the transcript", async () => {
    const { sid } = await open("marked");
    await store.recordTurn(sid, turn(0, "user", "[lookup_result - not said by the user] x"));
    expect(await store.sessionTurns(sid)).toEqual([]);
  });

  it("a forget request is stored without its words, whether it is flagged at once or a moment later, and the final state wins", async () => {
    const { uid, sid } = await open("forget");
    const t = turn(0, "user", "תשכח שאני גר ברחוב הרצל");
    await store.recordTurn(sid, t);                       // written before the live step has looked at it
    t.meta.forget_request = true;                         // ...which then marks it
    await store.recordTurn(sid, t);
    expect((await store.sessionTurns(sid))[0]!.text).not.toContain("הרצל");
    // and finishing keeps the same: it overwrites what was written while the conversation ran
    await store.finishSession({ sessionId: sid, userId: uid, turns: [t], summary: null, stats: {}, endReason: "client_end", describe: {} });
    expect((await store.sessionTurns(sid))[0]!.text).not.toContain("הרצל");
  });
});

describe("a cut-off conversation is finished by the next instance", () => {
  const finalizeInto = (calls: Parameters<SessionHooks["finalize"]>[0][]): SessionHooks["finalize"] => async (a) => { calls.push(a); await store.finishSession({ sessionId: a.sessionId, userId: a.userId, turns: a.turns, summary: null, stats: a.stats, endReason: a.endReason, describe: {} }); return null; };

  it("finishes a silent conversation from its turns, once", async () => {
    const { sid } = await open("orphan");
    await store.recordTurn(sid, turn(0, "agent", "ערב טוב"));
    await store.recordTurn(sid, turn(1, "user", "אני צריך להתכונן לפגישה"));
    await age(sid, IDLE_S + 60);
    const calls: Parameters<SessionHooks["finalize"]>[0][] = [];
    expect(await recoverOrphans(store, finalizeInto(calls))).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: sid, endReason: "server_restart" });
    expect(calls[0]!.turns.map((t) => t.text)).toEqual(["ערב טוב", "אני צריך להתכונן לפגישה"]);
    const row = (await db.query("SELECT ended_at, end_reason, user_turns FROM sessions WHERE id=$1", [sid])).rows[0]!;
    expect(row.ended_at).not.toBeNull(); expect(row.end_reason).toBe("server_restart"); expect(row.user_turns).toBe(1);
    expect(await recoverOrphans(store, finalizeInto(calls))).toBe(0); // not again
  });

  it("leaves a conversation that is still alive alone, even a quiet one", async () => {
    const { sid } = await open("alive");
    await store.recordTurn(sid, turn(0, "user", "היי"));
    await age(sid, IDLE_S + 600);
    await store.heartbeat(sid);                                        // it reported just now
    const calls: Parameters<SessionHooks["finalize"]>[0][] = [];
    expect(await recoverOrphans(store, finalizeInto(calls))).toBe(0);
    expect((await db.query("SELECT ended_at FROM sessions WHERE id=$1", [sid])).rows[0]!.ended_at).toBeNull();
  });

  it("only one instance gets an orphan", async () => {
    const { sid } = await open("race");
    await store.recordTurn(sid, turn(0, "user", "היי"));
    await age(sid, IDLE_S + 60);
    const [a, b] = await Promise.all([store.claimOrphan(sid, IDLE_S), store.claimOrphan(sid, IDLE_S)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("closes an empty orphan without a summary, and ignores one that is more than a day old", async () => {
    const empty = await open("empty"), old = await open("old");
    await age(empty.sid, IDLE_S + 60);
    await store.recordTurn(old.sid, turn(0, "user", "ישן"));
    await age(old.sid, 3 * 86_400);
    const calls: Parameters<SessionHooks["finalize"]>[0][] = [];
    await recoverOrphans(store, finalizeInto(calls));
    expect(calls.map((c) => c.sessionId)).not.toContain(empty.sid);
    expect((await db.query("SELECT end_reason FROM sessions WHERE id=$1", [empty.sid])).rows[0]!.end_reason).toBe("server_restart");
    expect((await db.query("SELECT ended_at FROM sessions WHERE id=$1", [old.sid])).rows[0]!.ended_at).toBeNull();
  });
});
