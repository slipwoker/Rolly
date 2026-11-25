/** PostgreSQL memory store: profile, typed memories with status and provenance, sessions, turns, progress. */
import type { Db } from "../db/index.ts";
import type { MemoryView } from "../persona/promptBuilder.ts";
import type { AddressingValue } from "../persona/phase1Sections.ts";
import type { SessionTurn } from "../voice/session.ts";
import { applyObservations, confirm as confirmAddressing, emptyEvidence, observe, type AddressingRecord } from "./addressing.ts";
import { decide, otherSpeakersSuspected, userActionAccepted, type Decision } from "./policy.ts";
import type { Item, SummaryResult } from "./summarizer.ts";

export type MemoryKind = "fact" | "preference" | "goal" | "travel_goal" | "interest" | "open_topic" | "action_item" | "summary" | "outcome" | "name";

export interface MemoryRow {
  id: string; kind: MemoryKind; content: string; status: "candidate" | "active" | "deleted"; confidence: number | null;
  provenance: Record<string, unknown>; source_session_id: string | null; created_at: Date; updated_at: Date; expires_at: Date | null;
}

const PERSONAL_KINDS: MemoryKind[] = ["fact", "preference", "goal", "travel_goal", "interest", "action_item", "name"];

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
    provenance: Record<string, unknown>; sessionId?: string | null; supersedes?: string | null }): Promise<string> {
    const expires = m.status === "candidate" ? new Date(Date.now() + this.opts.candidateTtlDays * 86_400_000) : null;
    // the same content already active: do not duplicate (refresh it instead)
    const dup = await this.db.query<{ id: string; status: string }>(
      "SELECT id, status FROM memories WHERE user_id=$1 AND kind=$2 AND lower(content)=lower($3) AND status<>'deleted' AND resolved_at IS NULL LIMIT 1",
      [userId, m.kind, m.content]);
    if (dup.rows[0]) {
      const d = dup.rows[0];
      if (d.status === "candidate" && m.status === "active") {
        await this.db.query("UPDATE memories SET status='active', expires_at=NULL, provenance=provenance || $2, updated_at=now() WHERE id=$1", [d.id, JSON.stringify(m.provenance)]);
      } else {
        await this.db.query("UPDATE memories SET updated_at=now() WHERE id=$1", [d.id]);
      }
      return d.id;
    }
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO memories(user_id, kind, content, status, confidence, provenance, source_session_id, supersedes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [userId, m.kind, m.content, m.status, m.confidence ?? null, JSON.stringify(m.provenance), m.sessionId ?? null, m.supersedes ?? null, expires]);
    await this.event(userId, r.rows[0]!.id, "create", String(m.provenance.source ?? "system"), m.sessionId ?? null);
    return r.rows[0]!.id;
  }

  async memories(userId: string, opts: { kinds?: MemoryKind[]; status?: ("candidate" | "active")[]; limit?: number } = {}): Promise<MemoryRow[]> {
    await this.expireCandidates(userId);
    const r = await this.db.query(
      `SELECT id, kind, content, status, confidence, provenance, source_session_id, created_at, updated_at, expires_at
       FROM memories WHERE user_id=$1 AND status = ANY($2) AND resolved_at IS NULL AND ($3::text[] IS NULL OR kind = ANY($3))
       ORDER BY created_at DESC LIMIT $4`,
      [userId, opts.status ?? ["active"], opts.kinds ?? null, opts.limit ?? 200]);
    return r.rows as MemoryRow[];
  }

  async getMemory(userId: string, id: string): Promise<MemoryRow | null> {
    const r = await this.db.query("SELECT * FROM memories WHERE user_id=$1 AND id=$2", [userId, id]);
    return (r.rows[0] as MemoryRow) ?? null;
  }

  /** Correction by the user: the old memory is deleted (content wiped) and the corrected one is active. */
  async correctMemory(userId: string, id: string, content: string, via: "app" | "voice", sessionId: string | null = null, quote?: string): Promise<string | null> {
    const old = await this.getMemory(userId, id);
    if (!old || old.status === "deleted") return null;
    await this.wipe(old.id);
    const newId = await this.addMemory(userId, { kind: old.kind, content, status: "active", confidence: 1,
      provenance: { source: via === "app" ? "user_app" : "correction", session_id: sessionId, quote, confirmed: true }, sessionId, supersedes: old.id });
    if (old.kind === "name") await this.updateProfile(userId, { preferred_name: content });
    await this.event(userId, newId, "correct", via, sessionId);
    return newId;
  }

  /** Deletion by the user: status deleted, content removed (tombstone keeps only the id, kind and dates). */
  async deleteMemory(userId: string, id: string, via: "app" | "voice", sessionId: string | null = null): Promise<boolean> {
    const old = await this.getMemory(userId, id);
    if (!old || old.status === "deleted") return false;
    await this.wipe(old.id);
    if (old.kind === "name") await this.updateProfile(userId, { preferred_name: null });
    await this.event(userId, id, "delete", via, sessionId);
    return true;
  }

  private async wipe(id: string) {
    await this.db.query("UPDATE memories SET status='deleted', content='', provenance=jsonb_build_object('deleted', true), updated_at=now() WHERE id=$1", [id]);
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

  async expireCandidates(userId?: string): Promise<number> {
    const r = await this.db.query(
      `UPDATE memories SET status='deleted', content='', provenance=jsonb_build_object('expired', true), updated_at=now()
       WHERE status='candidate' AND expires_at < now() ${userId ? "AND user_id=$1" : ""} RETURNING id, user_id`, userId ? [userId] : []);
    return r.rowCount ?? 0;
  }

  // ------------------------------------------------------------ prompt view
  async memoryView(userId: string): Promise<MemoryView & { knownIds: { id: string; content: string }[] }> {
    const p = await this.profile(userId);
    const active = await this.memories(userId, { status: ["active"] });
    const candidates = await this.memories(userId, { status: ["candidate"], kinds: PERSONAL_KINDS, limit: 5 });
    const of = (k: MemoryKind, n: number) => active.filter((m) => m.kind === k).slice(0, n);
    const progress = await this.db.query<{ text: string }>("SELECT text FROM progress_items WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 4", [userId]);
    const sc = await this.db.query<{ n: string }>("SELECT count(*) n FROM sessions WHERE user_id=$1 AND user_turns > 0", [userId]);
    const prefs = { ...(p.preferences ?? {}) };
    of("preference", 6).forEach((m, i) => { prefs[`noted ${i + 1}`] = m.content; });
    const known = active.filter((m) => PERSONAL_KINDS.includes(m.kind)).slice(0, 40).map((m) => ({ id: m.id, content: `[${m.kind}] ${m.content}` }));
    return {
      profile: {
        preferredName: p.preferred_name, preferredLanguage: p.preferred_language, professionalBackground: p.professional_background,
        interests: of("interest", 8).map((m) => m.content), travelGoals: of("travel_goal", 5).map((m) => m.content), preferences: prefs,
        addressing: { value: p.addressing_value, status: p.addressing_status, evidenceCount: (p.addressing_evidence?.masculine ?? 0) + (p.addressing_evidence?.feminine ?? 0) },
      },
      facts: [...of("fact", 8), ...of("goal", 5)].map((m) => m.content),
      summaries: of("summary", 3).map((m) => ({ content: m.content, createdAt: m.created_at })),
      openTopics: of("open_topic", 6).map((m) => m.content),
      actionItems: of("action_item", 6).map((m) => m.content),
      progress: progress.rows.map((r) => r.text),
      candidates: candidates.map((m) => ({ id: m.id, content: m.content })),
      sessionCount: Number(sc.rows[0]?.n ?? 0),
      knownIds: known,
    };
  }

  // ------------------------------------------------------------ sessions
  async startSession(id: string, userId: string, language: string, onboarding: boolean, startedAt: Date) {
    await this.db.query("INSERT INTO sessions(id, user_id, started_at, language, onboarding) VALUES ($1,$2,$3,$4,$5)", [id, userId, startedAt, language, onboarding]);
  }

  /** Learn addressing from the session's user turns (primary turns only change the preference). Returns the new record. */
  async learnAddressing(userId: string, sessionId: string, turns: SessionTurn[]): Promise<AddressingRecord> {
    let rec = await this.addressing(userId);
    for (const t of turns) {
      if (t.role !== "user") continue;
      rec = applyObservations(rec, observe(t.text), t.attribution, { session_id: sessionId, at: new Date(t.startedAt) });
    }
    await this.saveAddressing(userId, rec, "summarizer", sessionId);
    return rec;
  }

  async finishSession(args: { sessionId: string; userId: string; turns: SessionTurn[]; summary: SummaryResult | null; stats: Record<string, unknown>;
    endReason: string; describe: Record<string, unknown> }) {
    const { sessionId, turns } = args;
    const userTurns = turns.filter((t) => t.role === "user").length;
    await this.db.query("UPDATE sessions SET ended_at=now(), summary=$2, stats=$3, end_reason=$4, pipeline=$5, user_turns=$6 WHERE id=$1",
      [sessionId, args.summary ? JSON.stringify(args.summary) : null, JSON.stringify(args.stats), args.endReason, JSON.stringify(args.describe), userTurns]);
    for (const t of turns) {
      await this.db.query(
        "INSERT INTO turns(session_id, idx, role, text, language, attribution, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [sessionId, t.idx, t.role, t.text, t.language ?? null, t.attribution, JSON.stringify(t.meta ?? {}), new Date(t.startedAt)]);
    }
  }

  /** Apply the summariser's output under the memory policy. Returns what was decided, for the session record and tests. */
  async applySummary(userId: string, sessionId: string, s: SummaryResult, turns: SessionTurn[]): Promise<{ decisions: { kind: string; content: string; decision: Decision }[]; applied: string[] }> {
    const decisions: { kind: string; content: string; decision: Decision }[] = [];
    const applied: string[] = [];
    if (s.method !== "llm") {
      if (s.summary && turns.some((t) => t.role === "user")) {
        await this.addMemory(userId, { kind: "summary", content: s.summary, status: "active", provenance: { source: "fallback", session_id: sessionId }, sessionId });
      }
      return { decisions, applied };
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
      await this.db.query("INSERT INTO progress_items(user_id, session_id, text) VALUES ($1,$2,$3)", [userId, sessionId, p]);
    }

    // claims about the user: the policy decides active vs candidate
    const groups: [MemoryKind, Item[]][] = [
      ["travel_goal", s.travel_goals], ["interest", s.interests], ["goal", s.goals], ["action_item", s.action_items],
      ["fact", s.facts], ["preference", s.preferences], ["name", s.preferred_name ? [s.preferred_name] : []],
    ];
    for (const [kind, list] of groups) {
      for (const it of list) {
        const d = decide(it, turns, { otherSpeakersSuspected: others });
        decisions.push({ kind, content: it.content, decision: d });
        await this.addMemory(userId, { kind, content: it.content, status: d.status, confidence: it.confidence, provenance: prov(it, d), sessionId });
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
      if (c.action === "delete" && await this.deleteMemory(userId, c.memory_id, "voice", sessionId)) applied.push(`delete:${c.memory_id}`);
      if (c.action === "replace" && c.new_content && await this.correctMemory(userId, c.memory_id, c.new_content, "voice", sessionId, c.quote)) applied.push(`correct:${c.memory_id}`);
    }
    if (s.language && !others) {
      const p = await this.profile(userId);
      if (!p.preferred_language) await this.updateProfile(userId, { preferred_language: s.language });
    }
    return { decisions, applied };
  }

  /** last turns of one of the user's sessions (for resuming after a dropped connection) */
  async lastTurns(userId: string, sessionId: string, n: number): Promise<{ role: "user" | "agent"; text: string }[]> {
    const r = await this.db.query<{ role: "user" | "agent"; text: string }>(
      `SELECT t.role, t.text FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.user_id=$1 AND s.id=$2 ORDER BY t.idx DESC LIMIT $3`,
      [userId, sessionId, n]);
    return r.rows.reverse();
  }

  // ------------------------------------------------------------ progress, export, deletion, retention
  async progress(userId: string, limit = 50) {
    const r = await this.db.query(
      `SELECT p.id, p.text, p.created_at, p.session_id, s.started_at FROM progress_items p LEFT JOIN sessions s ON s.id=p.session_id
       WHERE p.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  }

  async deleteProgress(userId: string, id: string): Promise<boolean> {
    const r = await this.db.query("UPDATE progress_items SET deleted_at=now(), text='' WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL", [userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async sessions(userId: string, limit = 20) {
    const r = await this.db.query(
      `SELECT id, started_at, ended_at, language, onboarding, end_reason, user_turns, summary->>'summary' AS summary,
              summary->'progress' AS progress FROM sessions WHERE user_id=$1 AND user_turns>0 ORDER BY started_at DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  }

  async exportAll(userId: string) {
    const q = async (sql: string) => (await this.db.query(sql, [userId])).rows;
    return {
      exported_at: new Date().toISOString(),
      profile: await this.profile(userId),
      memories: await q("SELECT id, kind, content, status, confidence, provenance, source_session_id, created_at, updated_at, expires_at FROM memories WHERE user_id=$1 AND status<>'deleted' ORDER BY created_at"),
      sessions: await q("SELECT id, started_at, ended_at, language, end_reason, summary FROM sessions WHERE user_id=$1 ORDER BY started_at"),
      turns: await q("SELECT t.session_id, t.idx, t.role, t.text, t.language, t.attribution, t.created_at FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.user_id=$1 ORDER BY t.created_at"),
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
