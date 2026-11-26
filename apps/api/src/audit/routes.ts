/**
 * Backoffice API (owner only, admin token): /v1/admin/audit/*, and the backoffice page itself at /admin.
 * The page is static (no build step) and holds no secret: it asks for the admin token and sends it as a bearer token.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index.ts";
import type { UtilityLlm } from "../memory/llm.ts";
import type { AuditRecorder } from "./recorder.ts";
import { byPrompt, costs, dayKey, overview, type CallRow, type FixedCost, type SessionRow } from "./insights.ts";
import { gpuPerDay } from "./pricing.ts";
import { JUDGE_CRITERIA } from "./judge.ts";
import { THRESHOLDS } from "./quality.ts";

export interface AuditRouteDeps {
  db: Db;
  audit: AuditRecorder;
  llm: UtilityLlm | null;
  timeZone: string;
  retentionDays: number;
  isAdmin(req: FastifyRequest): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELFTEST = "u.display_label LIKE 'selftest%'";

const UI_DIR = resolve(import.meta.dirname, "ui");
const ui = (f: string) => readFileSync(resolve(UI_DIR, f), "utf8");

export async function auditRoutes(app: FastifyInstance, d: AuditRouteDeps) {
  const { db, audit } = d;
  const files = { html: ui("index.html"), js: ui("app.js"), css: ui("app.css") };
  const headers = (reply: FastifyReply, type: string) => reply
    .header("content-type", type).header("cache-control", "no-store").header("x-frame-options", "DENY")
    .header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  app.get("/admin", async (_req, reply) => headers(reply, "text/html; charset=utf-8").send(files.html));
  app.get("/admin/app.js", async (_req, reply) => headers(reply, "text/javascript; charset=utf-8").send(files.js));
  app.get("/admin/app.css", async (_req, reply) => headers(reply, "text/css; charset=utf-8").send(files.css));

  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    if (d.isAdmin(req)) return true;
    void reply.code(401).send({ error: "unauthorized" });
    return false;
  };
  const range = (req: FastifyRequest) => {
    const qy = req.query as Record<string, string | undefined>;
    const days = Math.min(365, Math.max(1, Number(qy.days) || 30));
    return { days, selftest: qy.selftest === "1", qy };
  };

  async function sessionRows(days: number, selftest: boolean, extra = "", params: unknown[] = []): Promise<SessionRow[]> {
    return (await db.query(
      `SELECT s.id, s.user_id, u.display_label AS user_label, s.started_at, s.language, s.end_reason, s.user_turns, s.onboarding, s.stats,
         a.quality, a.flags, a.cost, a.judge, a.review_rating, a.prompt_hash, c.api_usd
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN session_audit a ON a.session_id = s.id
       LEFT JOIN (SELECT session_id, sum(cost_usd) AS api_usd FROM llm_calls WHERE session_id IS NOT NULL GROUP BY session_id) c ON c.session_id = s.id
       WHERE u.deleted_at IS NULL AND s.started_at > now() - make_interval(days => $1::int) AND ($2::boolean OR NOT coalesce(${SELFTEST}, false)) ${extra}
       ORDER BY s.started_at DESC`, [days, selftest, ...params])).rows.map((r) => ({ ...r, api_usd: r.api_usd === null ? null : Number(r.api_usd) }));
  }
  async function callRows(days: number, selftest: boolean): Promise<CallRow[]> {
    return (await db.query(
      `SELECT c.at, c.purpose, c.model, c.ok, c.ms, c.cost_usd, c.prompt_tokens, c.completion_tokens, c.cached_tokens, c.session_id, c.user_id
       FROM llm_calls c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.at > now() - make_interval(days => $1::int) AND ($2::boolean OR NOT coalesce(${SELFTEST}, false))`, [days, selftest])).rows;
  }

  /** the pod as a fixed cost per day, from the day of the first recorded session (the service did not exist before) */
  async function fixed(): Promise<FixedCost> {
    const first = (await db.query<{ t: Date | null }>("SELECT min(started_at) AS t FROM sessions")).rows[0]?.t ?? null;
    return { gpuPerDay: gpuPerDay(audit.pricing), gpuHoursPerDay: audit.pricing.gpu_hours_per_day, firstDay: first ? dayKey(first, d.timeZone) : null };
  }

  // ------------------------------------------------------------------ overview, insights
  app.get("/v1/admin/audit/overview", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days, selftest } = range(req);
    const [rows, calls] = [await sessionRows(days, selftest), await callRows(days, selftest)];
    return { days, time_zone: d.timeZone, ...overview(rows, calls, { timeZone: d.timeZone, days, ...(await fixed()) }), thresholds: THRESHOLDS,
      utility_llm: d.llm?.name ?? null, build: audit.build };
  });

  // ------------------------------------------------------------------ sessions
  app.get("/v1/admin/audit/sessions", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days, selftest, qy } = range(req);
    const conds: string[] = [], params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length + 2}`; };
    if (qy.user_id && UUID.test(qy.user_id)) conds.push(`s.user_id = ${p(qy.user_id)}::uuid`);
    if (qy.flag) conds.push(`${p(qy.flag)}::text = ANY(a.flags)`);
    if (qy.prompt) conds.push(`a.prompt_hash = ${p(qy.prompt)}::text`);
    if (qy.reviewed === "1") conds.push("a.reviewed_at IS NOT NULL");
    if (qy.reviewed === "0") conds.push("a.reviewed_at IS NULL");
    if (qy.all !== "1") conds.push("s.user_turns > 0");
    const rows = await sessionRows(days, selftest, conds.map((c) => "AND " + c).join(" "), params);
    return { sessions: rows.slice(0, 500).map((s) => {
      const st = s.stats ?? {};
      const qq = (s.quality ?? {}) as Record<string, any>;
      return { id: s.id, user_id: s.user_id, user_label: s.user_label, started_at: s.started_at, language: s.language, end_reason: s.end_reason,
        user_turns: s.user_turns, onboarding: s.onboarding, duration_s: st.duration_s ?? null, reply_p50: qq.reply_ms?.p50 ?? null,
        bot_speak_rate: qq.style?.bot_speak_rate ?? null, interruptions: st.interruptions ?? null, score: qq.score ?? null,
        flags: s.flags ?? [], judge: s.judge?.overall ?? null, review: s.review_rating, prompt_hash: s.prompt_hash,
        api_usd: s.api_usd === null ? 0 : Math.round(s.api_usd * 1e6) / 1e6 };
    }), total: rows.length };
  });

  app.get("/v1/admin/audit/sessions/:id", async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: "not found" });
    const s = (await db.query(
      `SELECT s.*, u.display_label AS user_label FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1`, [id])).rows[0];
    if (!s) return reply.code(404).send({ error: "not found" });
    const a = (await db.query(
      `SELECT a.*, v.text AS persona_text, v.label AS prompt_label, v.first_seen AS prompt_first_seen FROM session_audit a
       LEFT JOIN prompt_versions v ON v.hash = a.prompt_hash WHERE a.session_id=$1`, [id])).rows[0] ?? null;
    const turns = (await db.query("SELECT idx, role, text, language, attribution, meta, created_at FROM turns WHERE session_id=$1 ORDER BY idx", [id])).rows;
    const calls = (await db.query(
      "SELECT id, at, purpose, model, ok, error, ms, prompt_chars, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, cost_usd FROM llm_calls WHERE session_id=$1 ORDER BY at", [id])).rows;
    const events = (await db.query("SELECT memory_id, action, via, at FROM memory_events WHERE session_id=$1 ORDER BY at", [id])).rows;
    const used = a?.memory_ids?.length ? (await db.query(
      "SELECT id, kind, status, content, confidence FROM memories WHERE id = ANY($1::uuid[]) AND user_id=$2", [a.memory_ids, s.user_id])).rows : [];
    const learned = (await db.query(
      `SELECT id, kind, status, content, confidence, provenance->>'reason' AS reason, provenance->>'attribution' AS attribution, created_at
       FROM memories WHERE user_id=$1 AND status<>'deleted' AND (source_session_id=$2::uuid OR provenance->>'session_id'=$3) ORDER BY created_at`,
      [s.user_id, id, id])).rows;
    const prev = (await db.query(
      `SELECT s2.id FROM sessions s2 WHERE s2.user_id=$1 AND s2.started_at < $2 AND s2.user_turns > 0 ORDER BY s2.started_at DESC LIMIT 1`, [s.user_id, s.started_at])).rows[0]?.id ?? null;
    const next = (await db.query(
      `SELECT s2.id FROM sessions s2 WHERE s2.user_id=$1 AND s2.started_at > $2 AND s2.user_turns > 0 ORDER BY s2.started_at ASC LIMIT 1`, [s.user_id, s.started_at])).rows[0]?.id ?? null;
    return { session: s, audit: a, turns, llm_calls: calls, memory_events: events, memories_used: used, memories_learned: learned,
      neighbours: { prev, next }, judge_criteria: JUDGE_CRITERIA, retention_days: d.retentionDays };
  });

  app.post("/v1/admin/audit/sessions/:id/review", async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const b = z.object({ rating: z.number().int().min(1).max(5).nullable(), tags: z.array(z.string().min(1).max(40)).max(12).default([]),
      note: z.string().max(2000).nullable().default(null) }).safeParse(req.body ?? {});
    if (!b.success || !UUID.test(id)) return reply.code(400).send({ error: "bad request" });
    return (await audit.review(id, b.data)) ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  app.post("/v1/admin/audit/sessions/:id/judge", async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: "not found" });
    if (!d.llm) return reply.code(503).send({ error: "no utility model configured" });
    try { return { judge: await audit.judge(id, d.llm) }; }
    catch (e) { return reply.code(502).send({ error: String(e).slice(0, 300) }); }
  });

  app.post("/v1/admin/audit/sessions/:id/reassess", async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const r = UUID.test(id) ? await audit.assess(id) : null;
    return r ?? reply.code(404).send({ error: "not found" });
  });

  /** recompute quality and flags of recent sessions (after a threshold or heuristic changed) */
  app.post("/v1/admin/audit/reassess", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days } = range(req);
    const ids = (await db.query<{ id: string }>("SELECT id FROM sessions WHERE started_at > now() - make_interval(days => $1::int) ORDER BY started_at DESC LIMIT 1000", [days])).rows;
    let n = 0;
    for (const { id } of ids) if (await audit.assess(id).catch(() => null)) n++;
    return { reassessed: n };
  });

  // ------------------------------------------------------------------ prompts
  app.get("/v1/admin/audit/prompts", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days, selftest } = range(req);
    const versions = (await db.query("SELECT hash, language, chars, build, first_seen, last_seen, label FROM prompt_versions ORDER BY first_seen DESC")).rows;
    const stats = new Map(byPrompt(await sessionRows(days, selftest)).map((p) => [p.hash, p]));
    const sizes = (await db.query(
      `SELECT prompt_hash, percentile_disc(0.5) WITHIN GROUP (ORDER BY prompt_chars) AS prompt_chars_p50,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY memory_chars) AS memory_chars_p50, max(prompt_chars) AS prompt_chars_max,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY prompt_tokens_est) AS tokens_est_p50
       FROM session_audit WHERE prompt_hash IS NOT NULL GROUP BY prompt_hash`)).rows;
    const sz = new Map(sizes.map((r) => [r.prompt_hash, r]));
    return { versions: versions.map((v) => ({ ...v, ...(sz.get(v.hash) ?? {}), metrics: stats.get(v.hash) ?? null })) };
  });

  app.get("/v1/admin/audit/prompts/:hash", async (req, reply) => {
    if (!guard(req, reply)) return;
    const v = (await db.query("SELECT * FROM prompt_versions WHERE hash=$1", [(req.params as { hash: string }).hash])).rows[0];
    return v ?? reply.code(404).send({ error: "not found" });
  });

  app.patch("/v1/admin/audit/prompts/:hash", async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = z.object({ label: z.string().max(80).nullable() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "bad request" });
    const r = await db.query("UPDATE prompt_versions SET label=$2 WHERE hash=$1", [(req.params as { hash: string }).hash, b.data.label]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  // ------------------------------------------------------------------ costs, model calls
  app.get("/v1/admin/audit/costs", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days, selftest } = range(req);
    const [rows, calls] = [await sessionRows(days, selftest), await callRows(days, selftest)];
    return { days, pricing: audit.pricing,
      ...costs(rows, calls, { timeZone: d.timeZone, days, fixedMonthly: audit.pricing.fixed_monthly, ...(await fixed()) }) };
  });

  app.get("/v1/admin/audit/llm-calls", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days, qy } = range(req);
    const conds = ["c.at > now() - make_interval(days => $1::int)"], params: unknown[] = [days];
    if (qy.purpose) { params.push(qy.purpose); conds.push(`c.purpose = $${params.length}`); }
    if (qy.ok === "0") conds.push("NOT c.ok");
    return { calls: (await db.query(
      `SELECT c.id, c.at, c.purpose, c.model, c.ok, c.error, c.ms, c.prompt_chars, c.prompt_tokens, c.cached_tokens, c.completion_tokens,
         c.reasoning_tokens, c.cost_usd, c.session_id, c.user_id, u.display_label AS user_label
       FROM llm_calls c LEFT JOIN users u ON u.id=c.user_id WHERE ${conds.join(" AND ")} ORDER BY c.at DESC LIMIT 300`, params)).rows };
  });

  // ------------------------------------------------------------------ users
  app.get("/v1/admin/audit/users", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { days, selftest } = range(req);
    const users = (await db.query(
      `SELECT u.id, u.display_label, u.created_at,
         (SELECT max(last_seen_at) FROM devices d WHERE d.user_id=u.id) AS last_seen_at,
         (SELECT count(*)::int FROM devices d WHERE d.user_id=u.id AND d.revoked_at IS NULL) AS devices,
         p.preferred_language, p.addressing_value, p.addressing_status,
         (SELECT count(*)::int FROM memories m WHERE m.user_id=u.id AND m.status='active') AS memories_active,
         (SELECT count(*)::int FROM memories m WHERE m.user_id=u.id AND m.status='candidate') AS memories_candidate,
         (SELECT count(*)::int FROM memory_events e WHERE e.user_id=u.id AND e.action IN ('correct','delete') AND e.via IN ('voice','app')) AS user_fixes,
         (SELECT count(*)::int FROM goal_tracks g WHERE g.user_id=u.id AND g.status='active') AS goals_active
       FROM users u LEFT JOIN profiles p ON p.user_id=u.id
       WHERE u.deleted_at IS NULL AND ($1::boolean OR NOT coalesce(${SELFTEST}, false)) ORDER BY u.created_at`, [selftest])).rows;
    const rows = await sessionRows(days, selftest);
    const calls = await callRows(days, selftest);
    const c = costs(rows, calls, { timeZone: d.timeZone, days, fixedMonthly: {}, ...(await fixed()) });
    const cu = new Map(c.by_user.map((x) => [x.user_id, x]));
    return { users: users.map((u) => {
      const mine = rows.filter((s) => s.user_id === u.id && s.user_turns > 0);
      const scores = mine.map((s) => Number((s.quality as { score?: number } | null)?.score)).filter(Number.isFinite);
      return { ...u, conversations: mine.length, minutes: cu.get(u.id)?.minutes ?? 0, last_session_at: mine[0]?.started_at ?? null,
        api_usd: cu.get(u.id)?.api_usd ?? 0,
        avg_score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
        flagged: mine.filter((s) => (s.flags ?? []).length).length,
        languages: [...new Set(mine.map((s) => s.language).filter(Boolean))] };
    }) };
  });
}
