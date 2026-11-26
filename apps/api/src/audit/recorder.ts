/**
 * Records what the backoffice audits: the prompt each conversation was given, every utility-model call with its tokens
 * and cost, the notes sent during the conversation, and the per-session assessment (quality.ts) and judge (judge.ts).
 *
 * Privacy (same rules as the memory layer, docs/PHASE1_DECISIONS.md P1-D21, P1-D23):
 *  - the fixed persona part of a prompt has no personal data and is stored once per version (prompt_versions);
 *  - the personal part (memory block, opener, plan, note texts, the judge's notes) lives in session_audit and is removed
 *    after the transcript retention period, and for a user as soon as they delete or correct a memory
 *    (`redactPersonalText`, called from MemoryStore.queueScrub);
 *  - utility-model calls are stored without prompt or answer text;
 *  - deleting a conversation or an account removes its audit rows (foreign keys).
 * Recording never breaks a conversation: every write here swallows its own errors.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import type { LlmPurpose, UtilityLlm } from "../memory/llm.ts";
import { gpuCost, parseUsage, round6, tokenCost, type Pricing } from "./pricing.ts";
import { assess, type AuditTurn, type Quality } from "./quality.ts";
import { judgeConversation, type JudgeResult } from "./judge.ts";

export interface AuditContext { userId?: string | null; sessionId?: string | null }

export const promptHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
/** rough token estimate for a prompt (Hebrew and English mixed); the pod's measured prompt_tokens are shown next to it */
export const estTokens = (chars: number) => Math.round(chars / 3.4);

/** kinds of notes whose text is fixed by the code (no personal content) and kept through redaction */
const GENERIC_NOTE = "(n->>'kind' = 'style' OR n->>'kind' LIKE 'pacing\\_%')";

/** Removes personal text from audit rows. `where` is a SQL condition on session_audit with $1 bound to `param`. */
export async function redactPersonalText(db: Db, where: string, param: unknown, reason: "retention" | "forget"): Promise<number> {
  const r = await db.query(
    `UPDATE session_audit SET memory_block = NULL, opener = NULL, plan = NULL,
       notes = coalesce((SELECT jsonb_agg(CASE WHEN ${GENERIC_NOTE} THEN n ELSE n - 'text' END) FROM jsonb_array_elements(notes) n), '[]'::jsonb),
       judge = CASE WHEN judge IS NULL THEN NULL ELSE judge - 'issues' - 'strengths' - 'summary' END,
       redacted = CASE WHEN redacted = 'forget' THEN redacted ELSE $2 END
     WHERE (${where}) AND (memory_block IS NOT NULL OR opener IS NOT NULL OR plan IS NOT NULL
       OR (judge IS NOT NULL AND (judge ? 'issues' OR judge ? 'summary'))
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(notes) n WHERE n ? 'text' AND NOT ${GENERIC_NOTE}))`,
    [param, reason]);
  return r.rowCount ?? 0;
}

export class AuditRecorder {
  private readonly als = new AsyncLocalStorage<AuditContext>();
  private pending = new Set<Promise<unknown>>();

  constructor(private readonly db: Db, readonly pricing: Pricing, private readonly opts: { build?: string | null; log?: (msg: string, e: unknown) => void } = {}) {}

  get build(): string | null { return this.opts.build ?? null; }

  /** runs `fn` with the user and session that utility-model calls inside it are attributed to */
  run<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
    const outer = this.als.getStore() ?? {};
    return this.als.run({ ...outer, ...ctx }, fn);
  }

  private bg(p: Promise<unknown>) {
    const q = p.catch((e) => this.opts.log?.("audit write failed", e)).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  /** waits for background writes (tests, shutdown) */
  async flush(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }

  /** The same model, with every call recorded in llm_calls. */
  wrapLlm(inner: UtilityLlm): UtilityLlm {
    return {
      name: inner.name,
      json: async (prompt, opts = {}) => {
        const ctx = this.als.getStore() ?? {};
        const purpose: LlmPurpose = opts.purpose ?? "other";
        const t0 = Date.now();
        try {
          const r = await inner.json(prompt, opts);
          this.bg(this.recordCall({ ctx, purpose, model: inner.name, ok: true, ms: r.ms ?? Date.now() - t0, promptChars: prompt.length, usage: r.usage }));
          return r;
        } catch (e) {
          this.bg(this.recordCall({ ctx, purpose, model: inner.name, ok: false, error: String(e).slice(0, 300), ms: Date.now() - t0, promptChars: prompt.length }));
          throw e;
        }
      },
      // a web lookup: tokens plus the provider's fee per search call
      ...(inner.search ? { search: async (prompt: string, opts = {}) => {
        const ctx = this.als.getStore() ?? {};
        const t0 = Date.now();
        try {
          const r = await inner.search!(prompt, opts);
          this.bg(this.recordCall({ ctx, purpose: "lookup", model: inner.name, ok: true, ms: r.ms ?? Date.now() - t0, promptChars: prompt.length, usage: r.usage,
            extraUsd: r.searches * this.pricing.web_search_usd_per_call }));
          return r;
        } catch (e) {
          this.bg(this.recordCall({ ctx, purpose: "lookup", model: inner.name, ok: false, error: String(e).slice(0, 300), ms: Date.now() - t0, promptChars: prompt.length }));
          throw e;
        }
      } } : {}),
    };
  }

  private async recordCall(c: { ctx: AuditContext; purpose: string; model: string; ok: boolean; error?: string; ms: number; promptChars: number; usage?: unknown; extraUsd?: number }) {
    const u = parseUsage(c.usage);
    const tokens = c.ok ? tokenCost(this.pricing, c.model, u) : 0;
    const cost = c.extraUsd ? (tokens ?? 0) + c.extraUsd : tokens;
    await this.db.query(
      `INSERT INTO llm_calls(user_id, session_id, purpose, model, ok, error, ms, prompt_chars, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, cost_usd)
       SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::boolean, $6::text, $7::int, $8::int, $9::int, $10::int, $11::int, $12::int, $13::float8 WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM users WHERE id=$1::uuid)`,
      [c.ctx.userId ?? null, c.ctx.sessionId ?? null, c.purpose, c.model, c.ok, c.error ?? null, Math.round(c.ms), c.promptChars,
        u.prompt_tokens ?? null, u.cached_tokens ?? null, u.completion_tokens ?? null, u.reasoning_tokens ?? null, cost === null ? null : round6(cost)]);
  }

  /** The prompt a conversation starts with. `persona` is the fixed part the system prompt begins with. */
  async recordPrompt(a: { sessionId: string; userId: string; language: string; onboarding: boolean; systemPrompt: string; persona: string;
    opener: string | null; plan: { topic: string; take?: string | null; kind: string }[]; memoryIds: string[]; sampling: Record<string, unknown> }): Promise<void> {
    try {
      const split = a.systemPrompt.startsWith(a.persona);
      const memoryBlock = split ? a.systemPrompt.slice(a.persona.length).replace(/^\n+/, "") : a.systemPrompt;
      let hash: string | null = null;
      if (split && a.persona.trim()) {
        hash = promptHash(a.persona);
        await this.db.query(
          `INSERT INTO prompt_versions(hash, language, text, chars, build) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (hash) DO UPDATE SET last_seen = now()`, [hash, a.language, a.persona, a.persona.length, this.build]);
      }
      await this.db.query(
        `INSERT INTO session_audit(session_id, user_id, build, prompt_hash, prompt_chars, memory_chars, prompt_tokens_est, language, onboarding,
           sampling, memory_ids, plan_kinds, memory_block, opener, plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12,$13,$14,$15)
         ON CONFLICT (session_id) DO NOTHING`,
        [a.sessionId, a.userId, this.build, hash, a.systemPrompt.length, memoryBlock.length, estTokens(a.systemPrompt.length + (a.opener?.length ?? 0)),
          a.language, a.onboarding, JSON.stringify(a.sampling ?? {}), a.memoryIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
          a.plan.map((p) => p.kind), memoryBlock, a.opener, JSON.stringify(a.plan)]);
    } catch (e) { this.opts.log?.("audit recordPrompt failed", e); }
  }

  async saveNotes(sessionId: string, notes: { kind: string; text: string; turns: number; at_s: number }[]): Promise<void> {
    await this.db.query("UPDATE session_audit SET notes=$2 WHERE session_id=$1", [sessionId, JSON.stringify(notes.slice(0, 300))]).catch((e) => this.opts.log?.("audit notes failed", e));
  }

  /** (Re)computes quality, flags and GPU cost of one session from what is stored. Returns null for an unknown session. */
  async assess(sessionId: string): Promise<{ quality: Quality; flags: string[]; score: number } | null> {
    const s = (await this.db.query(
      `SELECT s.id, s.user_id, s.language, s.end_reason, s.onboarding, s.summary, s.stats, a.notes, a.judge
       FROM sessions s LEFT JOIN session_audit a ON a.session_id = s.id WHERE s.id=$1`, [sessionId])).rows[0];
    if (!s) return null;
    const turns = (await this.db.query<AuditTurn>("SELECT idx, role, text, language, attribution, meta FROM turns WHERE session_id=$1 ORDER BY idx", [sessionId])).rows;
    const events = (await this.db.query("SELECT action, via FROM memory_events WHERE session_id=$1", [sessionId])).rows;
    const calls = (await this.db.query("SELECT purpose, ok FROM llm_calls WHERE session_id=$1", [sessionId])).rows;
    const stats = (s.stats ?? {}) as Record<string, unknown>;
    const { quality, flags, score } = assess({
      turns, stats, session: { language: s.language, end_reason: s.end_reason, onboarding: s.onboarding, summary: s.summary },
      memoryEvents: events, llmCalls: calls, notes: Array.isArray(s.notes) ? s.notes : (Array.isArray(stats.notes) ? stats.notes as { kind: string }[] : []),
      judge: s.judge,
    });
    const dur = typeof stats.duration_s === "number" ? stats.duration_s : 0;
    const cost = { gpu_usd: round6(gpuCost(this.pricing, dur)), gpu_usd_per_hour: this.pricing.gpu_usd_per_hour, gpu_sessions_share: this.pricing.gpu_sessions_share };
    const q = { ...quality, score, flag_reasons: Object.fromEntries(flags.map((f) => [f.id, { severity: f.severity, why: f.why }])) };
    await this.db.query(
      `INSERT INTO session_audit(session_id, user_id, language, onboarding, quality, flags, cost) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id) DO UPDATE SET quality=EXCLUDED.quality, flags=EXCLUDED.flags, cost=EXCLUDED.cost`,
      [sessionId, s.user_id, s.language, s.onboarding, JSON.stringify(q), flags.map((f) => f.id), JSON.stringify(cost)]);
    return { quality, flags: flags.map((f) => f.id), score };
  }

  /** Runs the LLM judge on one session and stores the result (and the judge_low flag). */
  async judge(sessionId: string, llm: UtilityLlm): Promise<JudgeResult> {
    const s = (await this.db.query("SELECT user_id, language FROM sessions WHERE id=$1", [sessionId])).rows[0];
    if (!s) throw new Error("no such session");
    const turns = (await this.db.query<AuditTurn>("SELECT idx, role, text, language, attribution, meta FROM turns WHERE session_id=$1 ORDER BY idx", [sessionId])).rows;
    const result = await this.run({ userId: s.user_id, sessionId }, () => judgeConversation(llm, turns, s.language));
    await this.db.query("UPDATE session_audit SET judge=$2 WHERE session_id=$1", [sessionId, JSON.stringify(result)]);
    await this.assess(sessionId);
    return result;
  }

  async review(sessionId: string, r: { rating: number | null; tags: string[]; note: string | null }): Promise<boolean> {
    const u = await this.db.query(
      `UPDATE session_audit SET review_rating=$2, review_tags=$3, review_note=$4, reviewed_at=now() WHERE session_id=$1`,
      [sessionId, r.rating, r.tags, r.note]);
    return (u.rowCount ?? 0) > 0;
  }

  /** hourly: personal text of audit rows older than the transcript retention period */
  async purge(retentionDays: number): Promise<number> {
    return redactPersonalText(this.db, "created_at < now() - make_interval(days => $1::int)", retentionDays, "retention").catch(() => 0);
  }
}

