/** PostgreSQL memory store: profile, typed memories with status and provenance, sessions, turns, progress. */
import { redactPersonalText } from "../audit/recorder.ts";
import type { Db } from "../db/index.ts";
import type { MemoryView } from "../persona/promptBuilder.ts";
import type { AddressingValue } from "../persona/phase1Sections.ts";
import type { SessionTurn } from "../voice/session.ts";
import { applyObservations, confirm as confirmAddressing, emptyEvidence, observe, type AddressingRecord } from "./addressing.ts";
import { decide, otherSpeakersSuspected, userActionAccepted, type Decision } from "./policy.ts";
import type { Item, SummaryResult } from "./summarizer.ts";
import { normalizeAgendaItems, type AgendaItem, type GoalStatus, type PlanResult, type StoredAgenda } from "./plan.ts";
import { BUDGET, sameStatement, selectWithinBudget, type Selectable } from "./select.ts";
import type { DerivedText } from "./scrub.ts";

export type MemoryKind = "fact" | "preference" | "goal" | "travel_goal" | "interest" | "open_topic" | "action_item" | "idea" | "summary" | "outcome" | "name";

export interface MemoryRow {
  id: string; kind: MemoryKind; content: string; status: "candidate" | "active" | "deleted"; confidence: number | null;
  provenance: Record<string, unknown>; source_session_id: string | null; created_at: Date; updated_at: Date; expires_at: Date | null;
  importance: number | null; last_used_at: Date | null; resolved_at: Date | null;
}

export interface GoalRow {
  id: string; kind: "goal" | "travel_goal"; content: string; created_at: Date; status: GoalStatus;
  state_note: string | null; next_step: string | null; last_discussed_at: Date | null; sessions_count: number;
}

const PERSONAL_KINDS: MemoryKind[] = ["fact", "preference", "goal", "travel_goal", "interest", "action_item", "idea", "name"];
const GOAL_KINDS: MemoryKind[] = ["goal", "travel_goal"];
/** tasks and ideas: the kinds a user can tick off */
const LIST_KINDS: MemoryKind[] = ["action_item", "idea"];

/** what a transcript line is replaced by when the user asked to forget what it says */
export const REMOVED = "[removed at the user's request]";

const selectable = (m: MemoryRow): Selectable & { row: MemoryRow } => ({
  id: m.id, content: m.content, createdAt: m.created_at, updatedAt: m.updated_at, importance: m.importance, lastUsedAt: m.last_used_at,
  confirmed: m.provenance?.confirmed === true, row: m,
});

export class MemoryStore {
  constructor(readonly db: Db, readonly opts: { candidateTtlDays: number; transcriptRetentionDays: number }) {}

  // ------------------------------------------------------------ users and profile
  async createUser(label: string | null): Promise<string> {
    const r = await this.db.query<{ id: string }>("INSERT INTO users(display_label) VALUES ($1) RETURNING id", [label]);
    await this.db.query("INSERT INTO profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING", [r.rows[0]!.id]);
    return r.rows[0]!.id;
  }

  async userExists(userId: string): Promise<boolean> {
    const r = await this.db.query("SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL", [userId]);
    return r.rowCount === 1;
  }

  async profile(userId: string) {
    await this.db.query("INSERT INTO profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    const r = await this.db.query("SELECT * FROM profiles WHERE user_id=$1", [userId]);
    return r.rows[0] as {
      preferred_name: string | null; preferred_language: "he" | "en" | null; languages: string[]; addressing_value: AddressingValue | null;
      addressing_status: "unknown" | "inferred" | "confirmed"; addressing_evidence: AddressingRecord["evidence"];
      professional_background: string | null; preferences: Record<string, string>;
      digest: string | null; history_digest: string | null; digest_at: Date | null; next_agenda: StoredAgenda | null;
    };
  }

  async addressing(userId: string): Promise<AddressingRecord> {
    const p = await this.profile(userId);
    return { value: p.addressing_value, status: p.addressing_status, evidence: { ...emptyEvidence(), ...(p.addressing_evidence ?? {}) } };
  }

  async saveAddressing(userId: string, rec: AddressingRecord, via: string, sessionId: string | null = null): Promise<void> {
    const before = await this.addressing(userId);
    await this.db.query("UPDATE profiles SET addressing_value=$2, addressing_status=$3, addressing_evidence=$4, updated_at=now() WHERE user_id=$1",
      [userId, rec.value, rec.status, JSON.stringify(rec.evidence)]);
    if (before.value !== rec.value || before.status !== rec.status) {
      await this.event(userId, null, "addressing", via, sessionId);
    }
  }

  async setAddressing(userId: string, value: AddressingValue | null, via: "app" | "voice", sessionId: string | null = null) {
    await this.saveAddressing(userId, confirmAddressing(await this.addressing(userId), value), via, sessionId);
  }

  async updateProfile(userId: string, patch: { preferred_name?: string | null; preferred_language?: "he" | "en" | null; professional_background?: string | null }) {
    await this.profile(userId);
    const sets: string[] = [], vals: unknown[] = [userId];
    for (const [k, v] of Object.entries(patch)) { if (v !== undefined) { vals.push(v); sets.push(`${k}=$${vals.length}`); } }
    if (sets.length) await this.db.query(`UPDATE profiles SET ${sets.join(", ")}, updated_at=now() WHERE user_id=$1`, vals);
  }

  private async event(userId: string, memoryId: string | null, action: string, via: string, sessionId: string | null) {
    await this.db.query("INSERT INTO memory_events(user_id, memory_id, action, via, session_id) VALUES ($1,$2,$3,$4,$5)", [userId, memoryId, action, via, sessionId]);
  }

  // ------------------------------------------------------------ memories
  async addMemory(userId: string, m: { kind: MemoryKind; content: string; status: "candidate" | "active"; confidence?: number | null;
    provenance: Record<string, unknown>; sessionId?: string | null; supersedes?: string | null; importance?: number | null }): Promise<string> {
    const expires = m.status === "candidate" ? new Date(Date.now() + this.opts.candidateTtlDays * 86_400_000) : null;
    // the same content already active: do not duplicate (refresh it instead)
    // (for tasks and ideas also one ticked off in the last day: "I called him" must not put the call back on the list)
    const same = await this.db.query<{ id: string; status: string; content: string; resolved_at: Date | null }>(
      `SELECT id, status, content, resolved_at FROM memories WHERE user_id=$1 AND kind=$2 AND status<>'deleted'
         AND (resolved_at IS NULL OR (kind = ANY($3) AND resolved_at > now() - interval '1 day')) ORDER BY created_at DESC LIMIT 200`,
      [userId, m.kind, LIST_KINDS]);
    const d = same.rows.find((r) => sameStatement(r.content, m.content));
    if (d) {
      if (d.resolved_at) return d.id;
      if (d.status === "candidate" && m.status === "active") {
        await this.db.query("UPDATE memories SET status='active', expires_at=NULL, provenance=provenance || $2, updated_at=now() WHERE id=$1", [d.id, JSON.stringify(m.provenance)]);
      } else {
        await this.db.query("UPDATE memories SET updated_at=now() WHERE id=$1", [d.id]);
      }
      return d.id;
    }
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO memories(user_id, kind, content, status, confidence, provenance, source_session_id, supersedes, expires_at, importance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [userId, m.kind, m.content, m.status, m.confidence ?? null, JSON.stringify(m.provenance), m.sessionId ?? null, m.supersedes ?? null, expires,
        m.importance ? Math.min(3, Math.max(1, Math.round(m.importance))) : null]);
    await this.event(userId, r.rows[0]!.id, "create", String(m.provenance.source ?? "system"), m.sessionId ?? null);
    return r.rows[0]!.id;
  }

  /** `done: true` lists tasks and ideas the user ticked off (newest first) instead of the open ones. */
  async memories(userId: string, opts: { kinds?: MemoryKind[]; status?: ("candidate" | "active")[]; limit?: number; done?: boolean } = {}): Promise<MemoryRow[]> {
    await this.expireCandidates(userId);
    const r = await this.db.query(
      `SELECT id, kind, content, status, confidence, provenance, source_session_id, created_at, updated_at, expires_at, importance, last_used_at, resolved_at
       FROM memories WHERE user_id=$1 AND status = ANY($2) AND ($3::text[] IS NULL OR kind = ANY($3))
         AND ${opts.done ? "resolved_at IS NOT NULL AND provenance->>'done' = 'true'" : "resolved_at IS NULL"}
       ORDER BY ${opts.done ? "resolved_at" : "created_at"} DESC LIMIT $4`,
      [userId, opts.status ?? ["active"], opts.kinds ?? null, opts.limit ?? 200]);
    return r.rows as MemoryRow[];
  }

  /** Tick a task or idea off, or put it back. */
  async setDone(userId: string, id: string, done: boolean, via: "app" | "voice", sessionId: string | null = null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE memories SET resolved_at = ${done ? "now()" : "NULL"}, updated_at = now(),
              provenance = provenance || jsonb_build_object('done', $4::boolean, 'done_via', $5::text)
       WHERE user_id=$1 AND id=$2 AND kind = ANY($3) AND status='active' AND (resolved_at IS ${done ? "NULL" : "NOT NULL"})`,
      [userId, id, LIST_KINDS, done, via]);
    if (!r.rowCount) return false;
    await this.event(userId, id, done ? "done" : "reopen", via, sessionId);
    return true;
  }

  async markUsed(ids: string[]): Promise<void> {
    if (ids.length) await this.db.query("UPDATE memories SET last_used_at = now() WHERE id = ANY($1::uuid[])", [ids]);
  }

  async getMemory(userId: string, id: string): Promise<MemoryRow | null> {
    const r = await this.db.query("SELECT * FROM memories WHERE user_id=$1 AND id=$2", [userId, id]);
    return (r.rows[0] as MemoryRow) ?? null;
  }

  /** Correction by the user: the old memory is deleted (content wiped) and the corrected one is active. */
  async correctMemory(userId: string, id: string, content: string, via: "app" | "voice", sessionId: string | null = null, quote?: string): Promise<string | null> {
    const old = await this.getMemory(userId, id);
    if (!old || old.status === "deleted") return null;
    await this.queueScrub(userId, old, content);
    const track = (await this.db.query("SELECT status, state_note, next_step, last_discussed_at, sessions_count FROM goal_tracks WHERE memory_id=$1", [old.id])).rows[0];
    await this.wipe(old.id);
    const newId = await this.addMemory(userId, { kind: old.kind, content, status: "active", confidence: 1, importance: old.importance,
      provenance: { source: via === "app" ? "user_app" : "correction", session_id: sessionId, quote, confirmed: true }, sessionId, supersedes: old.id });
    if (track) {
      // a corrected goal keeps its history; its notes are rewritten by the scrub pass
      await this.db.query(
        `INSERT INTO goal_tracks(memory_id, user_id, status, state_note, next_step, last_discussed_at, sessions_count) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (memory_id) DO NOTHING`, [newId, userId, track.status, track.state_note, track.next_step, track.last_discussed_at, track.sessions_count]);
      await this.db.query("DELETE FROM goal_tracks WHERE memory_id=$1", [old.id]);
      await this.db.query("UPDATE progress_items SET goal_id=$2 WHERE goal_id=$1", [old.id, newId]);
    }
    const agenda = (await this.profile(userId)).next_agenda;
    if (agenda?.items?.some((i) => i.ref_id === old.id)) {
      const items = agenda.items.map((i) => (i.ref_id === old.id ? { ...i, ref_id: newId } : i));
      await this.db.query("UPDATE profiles SET next_agenda=$2 WHERE user_id=$1", [userId, JSON.stringify({ ...agenda, items })]);
    }
    if (old.kind === "name") await this.updateProfile(userId, { preferred_name: content });
    await this.event(userId, newId, "correct", via, sessionId);
    return newId;
  }

  /** Deletion by the user: status deleted, content removed (tombstone keeps only the id, kind and dates). */
  async deleteMemory(userId: string, id: string, via: "app" | "voice", sessionId: string | null = null): Promise<boolean> {
    const old = await this.getMemory(userId, id);
    if (!old || old.status === "deleted") return false;
    await this.queueScrub(userId, old, null);
    await this.wipe(old.id);
    if (old.kind === "name") await this.updateProfile(userId, { preferred_name: await this.currentName(userId) });
    await this.event(userId, id, "delete", via, sessionId);
    return true;
  }

  /**
   * The name the profile should show after a name note was removed: the newest name note that is still active, else none.
   * (Removing an unconfirmed duplicate, e.g. with its conversation, used to clear the name although a confirmed one existed.)
   */
  private async currentName(userId: string): Promise<string | null> {
    const r = await this.db.query<{ content: string }>(
      "SELECT content FROM memories WHERE user_id=$1 AND kind='name' AND status='active' AND content<>'' ORDER BY updated_at DESC LIMIT 1", [userId]);
    return r.rows[0]?.content ?? null;
  }

  private async wipe(id: string) {
    await this.db.query("UPDATE memories SET status='deleted', content='', provenance=jsonb_build_object('deleted', true), updated_at=now() WHERE id=$1", [id]);
    await this.db.query("DELETE FROM goal_tracks WHERE memory_id=$1", [id]);
  }

  // ------------------------------------------------------------ forgetting also in derived text (see scrub.ts)
  /** A personal memory the user deleted or corrected may still be stated in summaries, notes and plans. */
  private async queueScrub(userId: string, old: MemoryRow, replacement: string | null) {
    if (!PERSONAL_KINDS.includes(old.kind) || !old.content.trim()) return;
    if (replacement !== null && replacement.trim().toLowerCase() === old.content.trim().toLowerCase()) return;
    await this.db.query("INSERT INTO scrub_queue(user_id, content, replacement) VALUES ($1,$2,$3)", [userId, old.content, replacement]);
    // the audit's copies of prompts, plans and notes may state it too: their personal text goes now (src/audit/recorder.ts)
    await redactPersonalText(this.db, "user_id = $1", userId, "forget");
    // the transcript line it was taken from (known exactly from the provenance) is blanked as well; the rest of the raw
    // transcript is never put into a prompt and is deleted after the retention period
    const prov = old.provenance ?? {};
    if (replacement === null && typeof prov.session_id === "string" && typeof prov.turn === "number") {
      await this.db.query(
        `UPDATE turns t SET text = $4 FROM sessions s
         WHERE s.id = t.session_id AND s.user_id = $1 AND t.session_id = $2 AND t.idx = $3 AND t.role = 'user'`, [userId, prov.session_id, prov.turn, REMOVED]);
    }
  }

  async scrubQueue(userId: string): Promise<{ id: string; content: string; replacement: string | null }[]> {
    return (await this.db.query("SELECT id, content, replacement FROM scrub_queue WHERE user_id=$1 ORDER BY id", [userId])).rows;
  }

  async usersWithPendingScrub(): Promise<string[]> {
    return (await this.db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM scrub_queue")).rows.map((r) => r.user_id);
  }

  /** The forgotten content itself is removed here: this row was its last copy. */
  async scrubDone(id: string): Promise<void> { await this.db.query("DELETE FROM scrub_queue WHERE id=$1", [id]); }
  async scrubFailed(id: string): Promise<void> { await this.db.query("UPDATE scrub_queue SET attempts = attempts + 1 WHERE id=$1", [id]); }

  /** Every piece of text written ABOUT the user's conversations that a forgotten fact could still be in. */
  async derivedTexts(userId: string): Promise<DerivedText[]> {
    const out: DerivedText[] = [];
    const q = async (sql: string) => (await this.db.query(sql, [userId])).rows as Record<string, string>[];
    for (const r of await q("SELECT id, content FROM memories WHERE user_id=$1 AND status='active' AND kind IN ('summary','open_topic') AND content<>'' ORDER BY created_at DESC LIMIT 120")) out.push({ key: `m:${r.id}`, text: r.content! });
    for (const r of await q("SELECT id, text FROM progress_items WHERE user_id=$1 AND deleted_at IS NULL AND text<>'' ORDER BY created_at DESC LIMIT 80")) out.push({ key: `p:${r.id}`, text: r.text! });
    for (const r of await q("SELECT memory_id, state_note, next_step FROM goal_tracks WHERE user_id=$1")) {
      if (r.state_note) out.push({ key: `gs:${r.memory_id}`, text: r.state_note });
      if (r.next_step) out.push({ key: `gn:${r.memory_id}`, text: r.next_step });
    }
    const p = await this.profile(userId);
    if (p.digest) out.push({ key: "d:digest", text: p.digest });
    if (p.history_digest) out.push({ key: "d:history", text: p.history_digest });
    (p.next_agenda?.items ?? []).forEach((it, i) => out.push({ key: `a:${i}`, text: it.why ? `${it.topic} — ${it.why}` : it.topic }));
    return out;
  }

  /** Replace one derived text by its rewritten version; an empty text removes it. */
  async rewriteDerived(userId: string, key: string, text: string): Promise<void> {
    const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (type === "m") {
      if (text) await this.db.query("UPDATE memories SET content=$3, updated_at=now() WHERE user_id=$1 AND id=$2 AND kind IN ('summary','open_topic')", [userId, id, text]);
      else await this.db.query("UPDATE memories SET status='deleted', content='', provenance=jsonb_build_object('deleted', true), updated_at=now() WHERE user_id=$1 AND id=$2 AND kind IN ('summary','open_topic')", [userId, id]);
      // the same summary is also kept on the session row
      await this.db.query(
        `UPDATE sessions s SET summary = jsonb_set(s.summary, '{summary}', to_jsonb($3::text))
         FROM memories m WHERE m.id=$2 AND m.user_id=$1 AND m.kind='summary' AND s.id=m.source_session_id AND s.summary IS NOT NULL`, [userId, id, text]);
    } else if (type === "p") {
      if (text) await this.db.query("UPDATE progress_items SET text=$3 WHERE user_id=$1 AND id=$2", [userId, id, text]);
      else await this.db.query("UPDATE progress_items SET text='', deleted_at=now() WHERE user_id=$1 AND id=$2", [userId, id]);
    } else if (type === "gs" || type === "gn") {
      await this.db.query(`UPDATE goal_tracks SET ${type === "gs" ? "state_note" : "next_step"}=$3, updated_at=now() WHERE user_id=$1 AND memory_id=$2`, [userId, id, text || null]);
    } else if (type === "d") {
      await this.db.query(`UPDATE profiles SET ${id === "digest" ? "digest" : "history_digest"}=$2 WHERE user_id=$1`, [userId, text || null]);
    } else if (type === "a") {
      const p = await this.profile(userId);
      if (!p.next_agenda) return;
      const items = p.next_agenda.items.map((it, i) => (i === Number(id) ? (text ? { ...it, topic: text, why: "" } : null) : it)).filter((x): x is AgendaItem => !!x);
      await this.db.query("UPDATE profiles SET next_agenda=$2 WHERE user_id=$1", [userId, JSON.stringify({ ...p.next_agenda, items })]);
    }
  }

  async confirmCandidate(userId: string, id: string, via: "app" | "voice", sessionId: string | null = null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE memories SET status='active', expires_at=NULL, confidence=1, updated_at=now(),
              provenance = provenance || jsonb_build_object('confirmed', true, 'confirmed_via', $3::text, 'confirmed_session', $4::text)
       WHERE user_id=$1 AND id=$2 AND status='candidate' RETURNING kind, content`, [userId, id, via, sessionId]);
    if (!r.rowCount) return false;
    if (r.rows[0].kind === "name") await this.updateProfile(userId, { preferred_name: r.rows[0].content });
    await this.event(userId, id, "confirm", via, sessionId);
    return true;
  }

  /**
   * The owner (admin) marks a memory as confirmed on the user's behalf: an unconfirmed item becomes active, and a memory
   * that was already active no longer goes with its conversation when that conversation is deleted. With `content`, the
   * wording is replaced as well (a correction).
   */
  async keepMemory(userId: string, id: string, content?: string): Promise<string | null> {
    if (content !== undefined) return this.correctMemory(userId, id, content, "app");
    const r = await this.db.query(
      `UPDATE memories SET status='active', expires_at=NULL, confidence=1, updated_at=now(),
              provenance = provenance || jsonb_build_object('confirmed', true, 'confirmed_via', 'admin')
       WHERE user_id=$1 AND id=$2 AND status IN ('active','candidate') RETURNING kind, content`, [userId, id]);
    if (!r.rowCount) return null;
    if (r.rows[0].kind === "name") await this.updateProfile(userId, { preferred_name: r.rows[0].content });
    await this.event(userId, id, "confirm", "system", null);
    return id;
  }

  async expireCandidates(userId?: string): Promise<number> {
    const r = await this.db.query(
      `UPDATE memories SET status='deleted', content='', provenance=jsonb_build_object('expired', true), updated_at=now()
       WHERE status='candidate' AND expires_at < now() ${userId ? "AND user_id=$1" : ""} RETURNING id, user_id`, userId ? [userId] : []);
    return r.rowCount ?? 0;
  }

  // ------------------------------------------------------------ prompt view
  /**
   * What the conversation model is told about the user. Items are chosen by score within a budget (select.ts), not "the
   * newest N". While a forgotten fact is still waiting to be scrubbed from derived text, none of that text is included.
   * `usedIds` are the memories that made it into the view (for last_used_at, set by the caller when a session starts).
   */
  async memoryView(userId: string, now = new Date()): Promise<MemoryView & { knownIds: { id: string; content: string }[]; usedIds: string[] }> {
    const p = await this.profile(userId);
    const active = await this.memories(userId, { status: ["active"], limit: 500 });
    const candidates = await this.memories(userId, { status: ["candidate"], kinds: PERSONAL_KINDS, limit: 5 });
    const scrubPending = (await this.db.query("SELECT 1 FROM scrub_queue WHERE user_id=$1 LIMIT 1", [userId])).rowCount === 1;
    const pick = (k: MemoryKind, budget: { maxItems: number; maxChars: number }) =>
      selectWithinBudget(active.filter((m) => m.kind === k).map(selectable), budget, now).map((s) => s.row);
    const facts = pick("fact", BUDGET.facts), interests = pick("interest", BUDGET.interests), preferences = pick("preference", BUDGET.preferences);
    const openTopics = scrubPending ? [] : pick("open_topic", BUDGET.openTopics);
    const tasks = pick("action_item", BUDGET.tasks), ideas = pick("idea", BUDGET.ideas);
    const goals = (await this.goals(userId)).filter((g) => g.status === "active" || g.status === "paused").slice(0, BUDGET.goals.maxItems);
    const summaries = scrubPending ? [] : active.filter((m) => m.kind === "summary").slice(0, 3);
    const progress = scrubPending ? [] : (await this.db.query<{ text: string }>(
      "SELECT text FROM progress_items WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 4", [userId])).rows.map((r) => r.text);
    const sc = await this.db.query<{ n: string }>("SELECT count(*) n FROM sessions WHERE user_id=$1 AND user_turns > 0", [userId]);
    const prefs = { ...(p.preferences ?? {}) };
    preferences.forEach((m, i) => { prefs[`noted ${i + 1}`] = m.content; });
    // what a correction or "forget that" can refer to: active personal memories AND unconfirmed candidates
    const allCandidates = await this.memories(userId, { status: ["candidate"], kinds: PERSONAL_KINDS, limit: 20 });
    const known = [
      ...active.filter((m) => PERSONAL_KINDS.includes(m.kind)).slice(0, 60).map((m) => ({ id: m.id, content: `[${m.kind}] ${m.content}` })),
      ...allCandidates.map((m) => ({ id: m.id, content: `[${m.kind}, not confirmed] ${m.content}` })),
    ];
    // the stored plan, without items about a goal or task that is gone, finished or ticked off
    const liveRefs = new Set([...goals.map((g) => g.id), ...active.filter((m) => m.kind === "action_item").map((m) => m.id)]);
    const agenda = !scrubPending && p.next_agenda?.items
      ? { ...p.next_agenda, items: p.next_agenda.items.filter((i) => !i.ref_id || liveRefs.has(i.ref_id)) } : null;
    return {
      profile: {
        preferredName: p.preferred_name, preferredLanguage: p.preferred_language, professionalBackground: p.professional_background,
        interests: interests.map((m) => m.content), travelGoals: goals.filter((g) => g.kind === "travel_goal").map((g) => g.content), preferences: prefs,
        addressing: { value: p.addressing_value, status: p.addressing_status, evidenceCount: (p.addressing_evidence?.masculine ?? 0) + (p.addressing_evidence?.feminine ?? 0) },
      },
      goals: goals.map((g) => ({ id: g.id, kind: g.kind, content: g.content, status: g.status,
        stateNote: scrubPending ? null : g.state_note, nextStep: scrubPending ? null : g.next_step })),
      facts: facts.map((m) => m.content),
      summaries: summaries.map((m) => ({ content: m.content, createdAt: m.created_at })),
      openTopics: openTopics.map((m) => m.content),
      tasks: tasks.map((m) => ({ id: m.id, content: m.content, createdAt: m.created_at })),
      ideas: ideas.map((m) => m.content),
      progress,
      candidates: candidates.map((m) => ({ id: m.id, content: m.content })),
      digest: scrubPending ? null : p.digest, historyDigest: scrubPending ? null : p.history_digest,
      agenda,
      sessionCount: Number(sc.rows[0]?.n ?? 0),
      knownIds: known,
      usedIds: [...facts, ...interests, ...preferences, ...openTopics, ...tasks, ...ideas].map((m) => m.id),
    };
  }

  // ------------------------------------------------------------ goals that develop over time
  /** Every goal with how it stands; a goal without a track row yet is simply "active" with no notes. */
  async goals(userId: string): Promise<GoalRow[]> {
    const r = await this.db.query(
      `SELECT m.id, m.kind, m.content, m.created_at, coalesce(g.status, 'active') AS status, g.state_note, g.next_step, g.last_discussed_at,
              coalesce(g.sessions_count, 0) AS sessions_count
       FROM memories m LEFT JOIN goal_tracks g ON g.memory_id = m.id
       WHERE m.user_id=$1 AND m.status='active' AND m.resolved_at IS NULL AND m.kind = ANY($2)
       ORDER BY coalesce(g.last_discussed_at, m.created_at) DESC`, [userId, GOAL_KINDS]);
    return r.rows as GoalRow[];
  }

  private async upsertGoalTrack(userId: string, goalId: string, patch: { state_note?: string | null; next_step?: string | null; status?: GoalStatus | null; touched?: boolean }) {
    await this.db.query(
      `INSERT INTO goal_tracks(memory_id, user_id, status, state_note, next_step, last_discussed_at, sessions_count)
       VALUES ($1, $2, coalesce($3, 'active'), $4, $5, CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN 1 ELSE 0 END)
       ON CONFLICT (memory_id) DO UPDATE SET
         status = coalesce($3, goal_tracks.status), state_note = coalesce($4, goal_tracks.state_note), next_step = coalesce($5, goal_tracks.next_step),
         last_discussed_at = CASE WHEN $6 THEN now() ELSE goal_tracks.last_discussed_at END,
         sessions_count = goal_tracks.sessions_count + CASE WHEN $6 THEN 1 ELSE 0 END, updated_at = now()`,
      [goalId, userId, patch.status ?? null, patch.state_note ?? null, patch.next_step ?? null, patch.touched ?? false]);
  }

  /** Set by the user in the app. */
  async setGoalStatus(userId: string, goalId: string, status: GoalStatus): Promise<boolean> {
    if (!(await this.goals(userId)).some((g) => g.id === goalId)) return false;
    await this.upsertGoalTrack(userId, goalId, { status });
    await this.event(userId, goalId, `goal_${status}`, "app", null);
    return true;
  }

  /** `openedWith`: the topic that opened the ride just ended, if the user did not take it up (it will not open the next one) */
  async saveAgenda(userId: string, sessionId: string | null, items: AgendaItem[], openedWith: string | null = null): Promise<void> {
    const agenda: StoredAgenda = { created_at: new Date().toISOString(), session_id: sessionId, items: normalizeAgendaItems(items), opened_with: openedWith };
    await this.db.query("UPDATE profiles SET next_agenda=$2 WHERE user_id=$1", [userId, JSON.stringify(agenda)]);
  }

  /** `historyThrough`: creation time of the newest summary folded into history_digest (kept in profiles.digest_at). */
  async saveDigests(userId: string, d: { digest?: string | null; history_digest?: string | null; historyThrough?: Date | null }): Promise<void> {
    await this.db.query("UPDATE profiles SET digest=coalesce($2, digest), history_digest=coalesce($3, history_digest), digest_at=coalesce($4, digest_at) WHERE user_id=$1",
      [userId, d.digest ?? null, d.history_digest ?? null, d.history_digest ? d.historyThrough ?? null : null]);
  }

  /**
   * Apply the look-ahead call (plan.ts). Notes about where a goal stands are records of the conversation, like a
   * summary. Changing a goal's status and ticking a task off are the user's own acts: accepted only from a turn with no
   * hint of another speaker, the same rule as confirmations and corrections.
   */
  async applyPlan(userId: string, sessionId: string, plan: PlanResult, turns: SessionTurn[], progressIds: string[] = [],
    openedWith: string | null = null): Promise<{ applied: string[]; refused: string[] }> {
    const applied: string[] = [], refused: string[] = [];
    if (plan.method !== "llm") return { applied, refused };
    const goalIds = new Set((await this.goals(userId)).map((g) => g.id));
    for (const g of plan.goal_updates) {
      if (!goalIds.has(g.goal_id)) continue;
      let status: GoalStatus | null = null;
      if (g.status && g.status !== "active") {
        const acc = userActionAccepted(g.status_turn, g.status_quote, turns);
        if (acc.ok) { status = g.status; applied.push(`goal_${g.status}:${g.goal_id}`); } else refused.push(`goal_${g.status}:${g.goal_id}:${acc.reason}`);
      }
      await this.upsertGoalTrack(userId, g.goal_id, { state_note: g.state_note, next_step: g.next_step, status, touched: true });
      const linked = g.progress.map((i) => progressIds[i]).filter((x): x is string => !!x);
      if (linked.length) await this.db.query("UPDATE progress_items SET goal_id=$2 WHERE user_id=$1 AND id = ANY($3::uuid[]) AND goal_id IS NULL", [userId, g.goal_id, linked]);
    }
    for (const c of plan.completed_action_items) {
      const acc = userActionAccepted(c.turn, c.quote, turns);
      if (!acc.ok) { refused.push(`done:${c.id}:${acc.reason}`); continue; }
      if (await this.setDone(userId, c.id, true, "voice", sessionId)) applied.push(`done:${c.id}`);
    }
    if (plan.next_agenda.length) await this.saveAgenda(userId, sessionId, plan.next_agenda, openedWith);
    return { applied, refused };
  }

  // ------------------------------------------------------------ sessions
  async startSession(id: string, userId: string, language: string, onboarding: boolean, startedAt: Date) {
    await this.db.query("INSERT INTO sessions(id, user_id, started_at, language, onboarding) VALUES ($1,$2,$3,$4,$5)", [id, userId, startedAt, language, onboarding]);
  }

  /** Learn addressing from the session's user turns (primary turns only change the preference). Returns the new record. */
  async learnAddressing(userId: string, sessionId: string, turns: SessionTurn[],
    /** phrases the summariser picked as the user speaking about themselves in a gendered form */
    fromSummary: { form: "masculine" | "feminine"; quotes: string[] } | null = null): Promise<AddressingRecord> {
    let rec = await this.addressing(userId);
    const counted = new Set<SessionTurn>();
    for (const t of turns) {
      if (t.role !== "user") continue;
      const obs = observe(t.text);
      if (obs.length) counted.add(t);
      rec = applyObservations(rec, obs, t.attribution, { session_id: sessionId, at: new Date(t.startedAt) });
    }
    // The word list above knows a few dozen forms ("אני חושבת"); the summariser reads the whole conversation
    // ("אני אורזת", "אני צמחונית"). Its phrases count only when they stand word for word in a turn the user said,
    // one per turn, and not in a turn the word list already counted.
    const squash = (x: string) => x.replace(/\s+/g, " ").trim();
    for (const q of fromSummary?.quotes ?? []) {
      const turn = turns.find((t) => t.role === "user" && !counted.has(t) && squash(t.text).includes(squash(q)));
      if (!turn) continue;
      counted.add(turn);
      rec = applyObservations(rec, [{ form: fromSummary!.form, kind: "self_reference", quote: squash(q) }], turn.attribution, { session_id: sessionId, at: new Date(turn.startedAt) });
    }
    await this.saveAddressing(userId, rec, "summarizer", sessionId);
    return rec;
  }

  /**
   * The session row keeps the summary text (which the scrub pass can rewrite) and counts. The extracted items and the
   * topic labels are NOT copied here: items live in `memories`, where the user can correct and delete them.
   * A turn marked `forget_request` (the user naming something to forget) is stored without its words.
   */
  async finishSession(args: { sessionId: string; userId: string; turns: SessionTurn[]; summary: SummaryResult | null; stats: Record<string, unknown>;
    endReason: string; describe: Record<string, unknown>; policy?: { decisions: { decision: Decision }[]; applied: string[] } | null }) {
    const { sessionId, turns, summary: s } = args;
    const userTurns = turns.filter((t) => t.role === "user").length;
    const record = s ? {
      summary: s.summary, method: s.method, language: s.language, llm: s.llm, ms: s.ms, error: s.error,
      other_speakers_suspected: s.other_speakers_suspected,
      counts: args.policy ? {
        active: args.policy.decisions.filter((d) => d.decision.status === "active").length,
        candidate: args.policy.decisions.filter((d) => d.decision.status === "candidate").length,
        user_actions: args.policy.applied.length,
      } : undefined,
    } : null;
    await this.db.query("UPDATE sessions SET ended_at=now(), summary=$2, stats=$3, end_reason=$4, pipeline=$5, user_turns=$6 WHERE id=$1",
      [sessionId, record ? JSON.stringify(record) : null, JSON.stringify(args.stats), args.endReason, JSON.stringify(args.describe), userTurns]);
    for (const t of turns) {
      await this.db.query(
        "INSERT INTO turns(session_id, idx, role, text, language, attribution, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [sessionId, t.idx, t.role, t.meta?.forget_request ? REMOVED : t.text, t.language ?? null, t.attribution, JSON.stringify(t.meta ?? {}), new Date(t.startedAt)]);
    }
  }

  /** Apply the summariser's output under the memory policy. Returns what was decided, for the session record and tests. */
  async applySummary(userId: string, sessionId: string, s: SummaryResult, turns: SessionTurn[],
    opts: { languageDetected?: boolean } = {}): Promise<{ decisions: { kind: string; content: string; decision: Decision }[]; applied: string[]; progressIds: string[] }> {
    const decisions: { kind: string; content: string; decision: Decision }[] = [];
    const applied: string[] = [];
    const progressIds: string[] = [];
    if (s.method !== "llm") {
      if (s.summary && turns.some((t) => t.role === "user")) {
        await this.addMemory(userId, { kind: "summary", content: s.summary, status: "active", provenance: { source: "fallback", session_id: sessionId }, sessionId });
      }
      return { decisions, applied, progressIds };
    }
    const others = otherSpeakersSuspected(s.other_speakers_suspected, turns);
    const prov = (it: Item, d: Decision) => ({ source: "summarizer", session_id: sessionId, quote: it.quote.slice(0, 300), turn: d.turn,
      attribution: d.attribution, reason: d.reason, confirmed: false, first_person: it.first_person });

    // conversation-level records: about the conversation, not claims about the user
    if (s.summary) await this.addMemory(userId, { kind: "summary", content: s.summary, status: "active", provenance: { source: "summarizer", session_id: sessionId, other_speakers_suspected: others }, sessionId });
    for (const t of s.unresolved_topics) await this.addMemory(userId, { kind: "open_topic", content: t, status: "active", provenance: { source: "summarizer", session_id: sessionId }, sessionId });
    if (s.resolved_topics.length) {
      await this.db.query("UPDATE memories SET resolved_at=now() WHERE user_id=$1 AND kind='open_topic' AND status='active' AND lower(content) = ANY($2)",
        [userId, s.resolved_topics.map((t) => t.toLowerCase())]);
    }
    for (const p of s.progress) {
      const r = await this.db.query<{ id: string }>("INSERT INTO progress_items(user_id, session_id, text) VALUES ($1,$2,$3) RETURNING id", [userId, sessionId, p]);
      progressIds.push(r.rows[0]!.id);
    }

    // claims about the user: the policy decides active vs candidate
    const groups: [MemoryKind, Item[]][] = [
      ["travel_goal", s.travel_goals], ["interest", s.interests], ["goal", s.goals], ["action_item", s.action_items], ["idea", s.ideas],
      ["fact", s.facts], ["preference", s.preferences], ["name", s.preferred_name ? [s.preferred_name] : []],
    ];
    for (const [kind, list] of groups) {
      for (const it of list) {
        const d = decide(it, turns, { otherSpeakersSuspected: others });
        decisions.push({ kind, content: it.content, decision: d });
        await this.addMemory(userId, { kind, content: it.content, status: d.status, confidence: it.confidence, importance: it.importance, provenance: prov(it, d), sessionId });
        if (kind === "name" && d.status === "active") await this.updateProfile(userId, { preferred_name: it.content });
      }
    }

    // the user's own actions on memory: only from turns without a hint of another speaker
    for (const c of s.candidate_confirmations) {
      const acc = userActionAccepted(c.turn, "", turns);
      if (!acc.ok) continue;
      if (c.answer === "yes" && await this.confirmCandidate(userId, c.id, "voice", sessionId)) applied.push(`confirm:${c.id}`);
      if (c.answer === "no" && await this.deleteMemory(userId, c.id, "voice", sessionId)) applied.push(`reject:${c.id}`);
    }
    for (const c of s.corrections) {
      if (!c.memory_id) continue;
      const acc = userActionAccepted(c.turn, c.quote, turns);
      if (!acc.ok) {
        if (c.action === "replace" && c.new_content) {
          await this.addMemory(userId, { kind: "fact", content: c.new_content, status: "candidate", provenance: { source: "summarizer", session_id: sessionId, reason: `correction_${acc.reason}`, quote: c.quote }, sessionId });
        }
        continue;
      }
      if (c.action === "delete" && await this.deleteMemory(userId, c.memory_id, "voice", sessionId)) {
        applied.push(`delete:${c.memory_id}`);
        const req = turns.find((t) => t.role === "user" && t.idx === c.turn);
        if (req) req.meta.forget_request = true; // the line naming what to forget is not kept in the transcript
      }
      if (c.action === "replace" && c.new_content && await this.correctMemory(userId, c.memory_id, c.new_content, "voice", sessionId, c.quote)) applied.push(`correct:${c.memory_id}`);
    }
    // Only a conversation whose language was DETECTED says something about the user's language: with a fixed language the
    // recogniser writes everything in that language whatever was spoken.
    if (s.language && !others && opts.languageDetected) {
      const p = await this.profile(userId);
      if (!p.preferred_language) await this.updateProfile(userId, { preferred_language: s.language });
    }
    return { decisions, applied, progressIds };
  }

  /**
   * Delete one conversation and what was learned from it: its transcript, its summary, the topics, progress notes and
   * unconfirmed items that came from it. Memories the user has since confirmed or corrected (`provenance.confirmed`) stay.
   */
  async deleteSession(userId: string, sessionId: string): Promise<{ deleted: true; memories: number; progress: number } | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
    const own = await this.db.query("SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2", [sessionId, userId]);
    if (!own.rowCount) return null;
    const mem = await this.db.query<{ id: string }>(
      `SELECT id FROM memories WHERE user_id=$1 AND status<>'deleted' AND coalesce(provenance->>'confirmed', 'false') <> 'true'
         AND (source_session_id=$2::uuid OR provenance->>'session_id'=$3)`, [userId, sessionId, sessionId]);
    for (const m of mem.rows) await this.deleteMemory(userId, m.id, "app", sessionId);
    const prog = await this.db.query("UPDATE progress_items SET deleted_at=now(), text='' WHERE user_id=$1 AND session_id=$2 AND deleted_at IS NULL", [userId, sessionId]);
    await this.db.query("DELETE FROM sessions WHERE id=$1 AND user_id=$2", [sessionId, userId]); // turns go with it (cascade)
    return { deleted: true, memories: mem.rows.length, progress: prog.rowCount ?? 0 };
  }

  /** last turns of one of the user's sessions (for resuming after a dropped connection) */
  async lastTurns(userId: string, sessionId: string, n: number): Promise<{ role: "user" | "agent"; text: string }[]> {
    const r = await this.db.query<{ role: "user" | "agent"; text: string }>(
      `SELECT t.role, t.text FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.user_id=$1 AND s.id=$2 ORDER BY t.idx DESC LIMIT $3`,
      [userId, sessionId, n]);
    return r.rows.reverse();
  }

  // ------------------------------------------------------------ progress, export, deletion, retention
  async progress(userId: string, limit = 50): Promise<{ id: string; text: string; created_at: Date; session_id: string | null; goal_id: string | null; started_at: Date | null }[]> {
    const r = await this.db.query(
      `SELECT p.id, p.text, p.created_at, p.session_id, p.goal_id, s.started_at FROM progress_items p LEFT JOIN sessions s ON s.id=p.session_id
       WHERE p.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  }

  /** Extra stats recorded after the session row was written (the look-ahead step runs later). */
  async addSessionStats(sessionId: string, extra: Record<string, unknown>): Promise<void> {
    await this.db.query("UPDATE sessions SET stats = coalesce(stats, '{}'::jsonb) || $2::jsonb WHERE id=$1", [sessionId, JSON.stringify(extra)]);
  }

  async deleteProgress(userId: string, id: string): Promise<boolean> {
    const r = await this.db.query("UPDATE progress_items SET deleted_at=now(), text='' WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL", [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async sessions(userId: string, limit = 20) {
    const r = await this.db.query(
      `SELECT id, started_at, ended_at, language, onboarding, end_reason, user_turns, nullif(summary->>'summary', '') AS summary
       FROM sessions WHERE user_id=$1 AND user_turns>0 ORDER BY started_at DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  }

  async exportAll(userId: string) {
    const q = async (sql: string) => (await this.db.query(sql, [userId])).rows;
    return {
      exported_at: new Date().toISOString(),
      profile: await this.profile(userId),
      memories: await q("SELECT id, kind, content, status, confidence, provenance, source_session_id, created_at, updated_at, expires_at, resolved_at FROM memories WHERE user_id=$1 AND status<>'deleted' ORDER BY created_at"),
      goals: await q("SELECT memory_id, status, state_note, next_step, last_discussed_at, sessions_count FROM goal_tracks WHERE user_id=$1"),
      sessions: await q("SELECT id, started_at, ended_at, language, end_reason, summary FROM sessions WHERE user_id=$1 ORDER BY started_at"),
      turns: await q("SELECT t.session_id, t.idx, t.role, t.text, t.language, t.attribution, t.created_at FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.user_id=$1 ORDER BY s.started_at, t.idx"),
      progress: await q("SELECT id, text, session_id, created_at FROM progress_items WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at"),
    };
  }

  /** Account deletion: everything belonging to the user is removed (cascades), nothing kept. */
  async deleteAccount(userId: string): Promise<void> {
    await this.db.query("DELETE FROM users WHERE id=$1", [userId]);
  }

  async purgeTranscripts(): Promise<number> {
    const r = await this.db.query(
      `DELETE FROM turns WHERE created_at < now() - make_interval(days => $1)`, [this.opts.transcriptRetentionDays]);
    return r.rowCount ?? 0;
  }
}
