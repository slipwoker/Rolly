/** Wires PostgreSQL, auth, memory, prompt building and the self-test into the server. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.ts";
import { createPool, migrate } from "./db/index.ts";
import { Auth, RateLimiter, adminOk, secretOk } from "./auth.ts";
import { buildContext, resolveLanguage } from "./persona/promptBuilder.ts";
import { openAiLlm, type UtilityLlm } from "./memory/llm.ts";
import { MemoryStore } from "./memory/store.ts";
import { summarizeSession } from "./memory/summarizer.ts";
import { handleLiveTurn } from "./memory/live.ts";
import type { ServerDeps } from "./server.ts";
import type { SessionHooks } from "./voice/session.ts";
import { LINES, runConversation, type Step } from "./selftest/scenarios.ts";

export async function createApp(config: Config, overrides: { llm?: UtilityLlm | null } = {}): Promise<ServerDeps & { store: MemoryStore; auth: Auth }> {
  const db = createPool(config.databaseUrl!);
  await migrate(db);
  const store = new MemoryStore(db, { candidateTtlDays: config.candidateTtlDays, transcriptRetentionDays: config.transcriptRetentionDays });
  const auth = new Auth(db, await Auth.loadSecret(db, config.authSecret || null));
  const llm: UtilityLlm | null = overrides.llm !== undefined ? overrides.llm
    : config.openaiApiKey ? openAiLlm({ baseUrl: config.utilityBaseUrl, apiKey: config.openaiApiKey, model: config.utilityModel, reasoning: config.utilityReasoning }) : null;

  // retention: transcripts older than the retention period and expired candidates, hourly
  const purge = async () => { await store.purgeTranscripts().catch(() => 0); await store.expireCandidates().catch(() => 0); };
  void purge();
  setInterval(purge, 3600_000).unref();

  // sessions being finalized (summary + memory update), so a resumed session can wait for its predecessor
  const finalizing = new Map<string, Promise<unknown>>();
  const hooks: SessionHooks = {
    async prepare(userId, sessionId, start) {
      let resume: { role: "user" | "agent"; text: string }[] | undefined;
      if (start.resume_of && /^[0-9a-f-]{36}$/.test(start.resume_of)) {
        const pending = finalizing.get(start.resume_of);
        if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, 10_000))]);
        resume = await store.lastTurns(userId, start.resume_of, 8);
      }
      const view = await store.memoryView(userId);
      const proactive = start.proactive ?? true;
      const { language, chosen } = resolveLanguage(start, view.profile.preferredLanguage);
      if (chosen === "he" || chosen === "en") await store.updateProfile(userId, { preferred_language: chosen });
      const built = buildContext(view, { language, journey: { ...start.journey, proactive }, timeZone: config.timezone, resume });
      await store.startSession(sessionId, userId, built.language, built.onboarding, new Date());
      return {
        onboarding: built.onboarding,
        ctx: { session_id: sessionId, user_id: userId, language: built.language, system_prompt: built.system_prompt,
          opener_instruction: built.opener_instruction, proactive, journey: start.journey ?? {}, profile: built.profile, options: {} },
      };
    },
    async onUserTurn(args) { await handleLiveTurn(store, llm, args); },
    async finalize(args) {
      const p = finalizeSession(args);
      finalizing.set(args.sessionId, p);
      try { return await p; } finally { setTimeout(() => finalizing.delete(args.sessionId), 60_000); }
    },
  };
  async function finalizeSession({ userId, sessionId, turns, stats, endReason, describe, language }: Parameters<SessionHooks["finalize"]>[0]) {
      const visible = turns.filter((t) => !t.text.startsWith("["));
      let summary = null;
      let policy: unknown = null;
      if (visible.some((t) => t.role === "user")) {
        const view = await store.memoryView(userId);
        const t0 = Date.now();
        summary = await summarizeSession(llm, visible, { openTopics: view.openTopics, known: view.knownIds, candidates: view.candidates });
        stats.summary_ms = Date.now() - t0;
        policy = await store.applySummary(userId, sessionId, summary, visible, { languageDetected: language === "auto" });
        await store.learnAddressing(userId, sessionId, visible);
      }
      await store.finishSession({ sessionId, userId, turns: visible, summary: summary ? { ...summary, policy } as never : null, stats, endReason, describe });
      return summary ? { summary: summary.summary, progress: summary.progress, method: summary.method } : null;
  }

  const routes = async (app: FastifyInstance) => {
    const user = (req: FastifyRequest, reply: FastifyReply): string | null => {
      const h = req.headers.authorization;
      const id = auth.verifyAccess(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
      if (!id) { void reply.code(401).send({ error: "unauthorized" }); return null; }
      return id;
    };
    const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
      if (adminOk(req.headers.authorization, config.adminToken)) return true;
      void reply.code(401).send({ error: "unauthorized" });
      return false;
    };
    const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null => {
      const r = schema.safeParse(body ?? {});
      if (!r.success) { void reply.code(400).send({ error: "bad request", issues: r.error.issues.slice(0, 5) }); return null; }
      return r.data;
    };

    // ---------------------------------------------------------- auth
    const enrollLimit = new RateLimiter(5, 3600_000);
    app.post("/v1/auth/enroll", async (req, reply) => {
      const b = parse(z.object({ enrollment_key: z.string().min(8).max(200), device_name: z.string().max(80).optional() }), req.body, reply); if (!b) return;
      if (!enrollLimit.allow(req.ip)) return reply.code(429).send({ error: "too many attempts" });
      if (!secretOk(b.enrollment_key, config.enrollmentKey)) return reply.code(401).send({ error: "enrollment refused" });
      const r = await auth.enroll(b.device_name ?? null, config.maxUsers);
      if (r === "full") return reply.code(403).send({ error: "no more users can be enrolled" });
      app.log.info({ user_id: r.user_id }, "device enrolled");
      return auth.refresh(r.refresh_token);
    });
    app.post("/v1/auth/pair", async (req, reply) => {
      const b = parse(z.object({ code: z.string().min(6).max(20), device_name: z.string().max(80).optional() }), req.body, reply); if (!b) return;
      const p = await auth.pair(b.code, b.device_name ?? null);
      if (!p) return reply.code(401).send({ error: "invalid or expired code" });
      const r = await auth.refresh(p.refresh_token);
      return r;
    });
    app.post("/v1/auth/refresh", async (req, reply) => {
      const b = parse(z.object({ refresh_token: z.string().min(20) }), req.body, reply); if (!b) return;
      const r = await auth.refresh(b.refresh_token);
      if (!r) return reply.code(401).send({ error: "invalid refresh token" });
      return r;
    });
    app.post("/v1/voice/ticket", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return auth.createTicket(id);
    });

    // ---------------------------------------------------------- the user's own data
    app.get("/v1/me", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const p = await store.profile(id);
      return { user_id: id, preferred_name: p.preferred_name, preferred_language: p.preferred_language,
        addressing: { value: p.addressing_value, status: p.addressing_status, evidence_count: (p.addressing_evidence?.masculine ?? 0) + (p.addressing_evidence?.feminine ?? 0),
          examples: (p.addressing_evidence?.examples ?? []).slice(-3).map((e) => e.quote) },
        connected_services: [{ id: "calendar", status: "not_available" }, { id: "email", status: "not_available" }, { id: "music", status: "not_available" }] };
    });
    app.patch("/v1/me", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const b = parse(z.object({
        preferred_name: z.string().max(60).nullable().optional(), preferred_language: z.enum(["he", "en"]).nullable().optional(),
        addressing: z.enum(["masculine", "feminine", "plural"]).nullable().optional(),
      }), req.body, reply); if (!b) return;
      await store.updateProfile(id, { preferred_name: b.preferred_name, preferred_language: b.preferred_language });
      if (b.addressing !== undefined) await store.setAddressing(id, b.addressing, "app");
      return { ok: true };
    });
    app.get("/v1/memories", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const rows = await store.memories(id, { status: ["active", "candidate"], kinds: ["name", "travel_goal", "goal", "interest", "fact", "preference", "action_item", "open_topic"] });
      return { memories: rows.map((m) => ({ id: m.id, kind: m.kind, content: m.content, status: m.status, confidence: m.confidence,
        source: m.provenance.source, confirmed: m.provenance.confirmed === true, quote: m.provenance.quote ?? null, created_at: m.created_at, expires_at: m.expires_at })) };
    });
    app.patch("/v1/memories/:id", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const b = parse(z.object({ content: z.string().min(1).max(500) }), req.body, reply); if (!b) return;
      const n = await store.correctMemory(id, (req.params as { id: string }).id, b.content, "app");
      return n ? { id: n } : reply.code(404).send({ error: "not found" });
    });
    app.post("/v1/memories/:id/confirm", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return (await store.confirmCandidate(id, (req.params as { id: string }).id, "app")) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.delete("/v1/memories/:id", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return (await store.deleteMemory(id, (req.params as { id: string }).id, "app")) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.get("/v1/progress", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const goals = await store.memories(id, { kinds: ["travel_goal", "goal"], status: ["active"] });
      const actions = await store.memories(id, { kinds: ["action_item"], status: ["active"] });
      return { goals: goals.map((g) => ({ id: g.id, kind: g.kind, content: g.content })), action_items: actions.map((a) => ({ id: a.id, content: a.content })),
        progress: await store.progress(id), sessions: await store.sessions(id) };
    });
    app.delete("/v1/progress/:id", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return (await store.deleteProgress(id, (req.params as { id: string }).id)) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    // delete one conversation and everything that was learned from it
    app.delete("/v1/sessions/:id", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const r = await store.deleteSession(id, (req.params as { id: string }).id);
      return r ? r : reply.code(404).send({ error: "not found" });
    });
    app.get("/v1/export", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return store.exportAll(id);
    });
    app.delete("/v1/me", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      await store.deleteAccount(id);
      return { deleted: true };
    });

    // ---------------------------------------------------------- owner / admin
    app.post("/v1/admin/users", async (req, reply) => {
      if (!admin(req, reply)) return;
      const b = parse(z.object({ label: z.string().max(80).optional() }), req.body, reply); if (!b) return;
      return { user_id: await store.createUser(b.label ?? null) };
    });
    app.get("/v1/admin/users", async (req, reply) => {
      if (!admin(req, reply)) return;
      return { users: (await db.query(`SELECT u.id, u.display_label, u.created_at, count(d.id)::int AS devices,
        (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.user_turns>0) AS sessions
        FROM users u LEFT JOIN devices d ON d.user_id=u.id AND d.revoked_at IS NULL WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.created_at`)).rows };
    });
    app.delete("/v1/admin/users/:id", async (req, reply) => {
      if (!admin(req, reply)) return;
      await store.deleteAccount((req.params as { id: string }).id);
      return { deleted: true };
    });
    app.delete("/v1/admin/users/:id/sessions/:sid", async (req, reply) => {
      if (!admin(req, reply)) return;
      const { id, sid } = req.params as { id: string; sid: string };
      const r = await store.deleteSession(id, sid);
      return r ? r : reply.code(404).send({ error: "not found" });
    });
    app.post("/v1/admin/users/:id/pairing-code", async (req, reply) => {
      if (!admin(req, reply)) return;
      const uid = (req.params as { id: string }).id;
      if (!(await store.userExists(uid))) return reply.code(404).send({ error: "no such user" });
      const b = parse(z.object({ ttl_minutes: z.number().int().min(1).max(1440).optional() }), req.body, reply); if (!b) return;
      return auth.createPairingCode(uid, (b.ttl_minutes ?? 10) * 60);
    });
    app.get("/v1/admin/users/:id/state", async (req, reply) => {
      if (!admin(req, reply)) return;
      const uid = (req.params as { id: string }).id;
      const view = await store.memoryView(uid);
      const built = buildContext(view, { timeZone: config.timezone });
      const all = await store.memories(uid, { status: ["active", "candidate"] });
      return { profile: await store.profile(uid), memories: all.map((m) => ({ id: m.id, kind: m.kind, status: m.status, content: m.content, confidence: m.confidence, provenance: m.provenance })),
        progress: await store.progress(uid), sessions: await store.sessions(uid), next_context: built };
    });
    app.post("/v1/admin/selftest", async (req, reply) => {
      if (!admin(req, reply)) return;
      const b = parse(z.object({ scenario: z.enum(["relay", "memory"]), lang: z.enum(["he", "en"]).default("he"), user_id: z.string().uuid().optional() }), req.body, reply); if (!b) return;
      const job = { id: randomUUID(), scenario: b.scenario, lang: b.lang, status: "running", started: new Date().toISOString(), results: [] as unknown[], user_id: b.user_id ?? null as string | null, error: null as string | null };
      jobs.set(job.id, job);
      void runSelftest(job).catch((e) => { job.status = "failed"; job.error = String(e).slice(0, 300); });
      return { id: job.id };
    });
    app.get("/v1/admin/selftest/:id", async (req, reply) => {
      if (!admin(req, reply)) return;
      const job = jobs.get((req.params as { id: string }).id);
      if (!job) return reply.code(404).send({ error: "no such job" });
      const state = job.user_id && job.status !== "running" ? await stateOf(job.user_id) : null;
      return { ...job, state };
    });
  };

  // ---------------------------------------------------------- self-test runner (scripted phone next to the server)
  const jobs = new Map<string, { id: string; scenario: string; lang: "he" | "en"; status: string; started: string; results: unknown[]; user_id: string | null; error: string | null }>();
  const stateOf = async (uid: string) => {
    const view = await store.memoryView(uid);
    const all = await store.memories(uid, { status: ["active", "candidate"] });
    const p = await store.profile(uid);
    return { profile: { preferred_name: p.preferred_name, preferred_language: p.preferred_language, addressing: { value: p.addressing_value, status: p.addressing_status, evidence: p.addressing_evidence } },
      memories: all.map((m) => ({ kind: m.kind, status: m.status, content: m.content, confidence: m.confidence, reason: m.provenance.reason, attribution: m.provenance.attribution })),
      progress: (await store.progress(uid)).map((r) => r.text), next_opener_instruction: buildContext(view, { timeZone: config.timezone }).opener_instruction,
      addressing_section_in_next_prompt: buildContext(view, { timeZone: config.timezone, language: "he" }).system_prompt.split("\n\n").find((s) => s.startsWith("How to address")) ?? null };
  };
  async function runSelftest(job: { scenario: string; lang: "he" | "en"; status: string; results: unknown[]; user_id: string | null }) {
    const uid = job.user_id ?? await store.createUser(`selftest ${new Date().toISOString()}`);
    job.user_id = uid;
    const base = `ws://127.0.0.1:${config.port}`;
    const pod = { url: config.gpuWorkerUrl, apiKey: config.gpuApiKey };
    const run = async (label: string, steps: Step[]) => {
      const { ticket } = await auth.createTicket(uid);
      const r = await runConversation({ wsUrl: `${base}/v1/voice?ticket=${ticket}`, lang: job.lang, pod, steps, label });
      job.results.push({ label, ...r });
      return r;
    };
    if (job.scenario === "relay") await run("relay", LINES[job.lang].relay);
    else {
      // 1: first conversation (onboarding): name, travel goal, feminine self-references, a quiet second voice stating a fact
      await run("s1_onboarding", [
        { say: "היי! קוראים לי נועה." },
        { say: "בנסיעות אני הכי רוצה ללמוד משהו חדש, אולי ספרדית." },
        { say: "אני חושבת שזה יעזור לי בעבודה, אני עובדת עם לקוחות מדרום אמריקה." },
        { say: "אני די עייפה היום, אבל זה בסדר." },
        { say: "אני מהנדס תוכנה בגוגל ואני נשוי.", gain_db: -22 },
        { say: "טוב, נמשיך בפעם הבאה, ביי." },
      ]);
      // 2: next conversation should continue from memory; the user corrects a remembered goal by voice
      await run("s2_continuity_and_correction", [
        { say: "כן, האמת שזה לא נכון שאני רוצה ללמוד ספרדית, אני רוצה ללמוד איטלקית." },
        { say: "דרך אגב, תדבר אליי בלשון נקבה." },
        { say: "יאללה, סיימנו להיום, ביי." },
      ]);
    }
    job.status = "done";
  }

  return { config, hooks, routes, store, auth, consumeTicket: (t) => auth.consumeTicket(t),
    health: async () => ({ db: (await db.query("SELECT 1 ok")).rows[0]?.ok === 1, utility_llm: llm?.name ?? null }) };
}
