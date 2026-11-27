/**
 * Conversations that were cut off (a deploy, a crash) and never got their summary and memory update (P1-D45).
 *
 * While a conversation runs it writes its turns and a heartbeat to the database. A conversation that never ended and has
 * been silent for IDLE_S seconds is an orphan: one instance claims it, loads its turns and runs the same finishing step as
 * a normal ending, with end reason "server_restart". The person's words, the memory learned from them and the plan for
 * the next ride are then not lost, and the next ride can pick the conversation up (`resume_of` reads the same turns).
 */
import type { MemoryStore } from "./store.ts";
import type { SessionHooks } from "../voice/session.ts";

export const IDLE_S = 180;

export async function recoverOrphans(store: MemoryStore, finalize: SessionHooks["finalize"], log: (msg: string, extra?: Record<string, unknown>) => void = () => {}): Promise<number> {
  let n = 0;
  for (const id of await store.orphanSessions(IDLE_S)) {
    const claimed = await store.claimOrphan(id, IDLE_S);
    if (!claimed) continue; // another instance has it, or it ended just now
    try {
      const turns = await store.sessionTurns(id);
      if (!turns.length) { await store.closeEmptySession(id, "server_restart"); continue; }
      const last = turns[turns.length - 1]!.startedAt;
      await finalize({ userId: claimed.user_id, sessionId: id, turns, endReason: "server_restart", describe: {}, language: claimed.language ?? "he", startedAt: new Date(claimed.started_at),
        stats: { end_reason: "server_restart", recovered: true, duration_s: Math.max(0, Math.round((last - new Date(claimed.started_at).getTime()) / 1000)), turns_user: turns.filter((t) => t.role === "user").length } });
      n++;
      log("recovered a cut-off conversation", { session: id, turns: turns.length });
    } catch (e) {
      log("recovery failed", { session: id, error: String(e).slice(0, 200) });
    }
  }
  return n;
}
