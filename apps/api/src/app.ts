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
import { summarizeSession, type SummaryResult } from "./memory/summarizer.ts";
import { handleCapture, handleLiveTurn } from "./memory/live.ts";
import { fallbackAgenda, planNext, type AgendaItem } from "./memory/plan.ts";
import { scrubUser } from "./memory/scrub.ts";
import { consolidate } from "./memory/consolidate.ts";
import type { ServerDeps } from "./server.ts";
import type { SessionHooks, SessionTurn } from "./voice/session.ts";
import { LINES, runConversation, type Step } from "./selftest/scenarios.ts";

export async function createApp(config: Config, overrides: { llm?: UtilityLlm | null } = {}): Promise<ServerDeps & { store: MemoryStore; auth: Auth }> {
  const db = createPool(config.databaseUrl!);
  await migrate(db);
  const store = new MemoryStore(db, { candidateTtlDays: config.candidateTtlDays, transcriptRetentionDays: config.transcriptRetentionDays });
  const auth = new Auth(db, await Auth.loadSecret(db, config.authSecret || null));
  const llm: UtilityLlm | null = overrides.llm !== undefined ? overrides.llm
    : config.openaiApiKey ? openAiLlm({ baseUrl: config.utilityBaseUrl, apiKey: config.openaiApiKey, model: config.utilityModel, reasoning: config.utilityReasoning }) : null;

  // retention: transcripts older than the retention period and expired candidates, hourly
  const scrub = (userId: string) => scrubUser(store, llm, userId).catch(() => ({ scrubbed: 0, pending: -1 }));
  const purge = async () => {
    await store.purgeTranscripts().catch(() => 0);
    await store.expireCandidates().catch(() => 0);
    // forgotten facts whose removal from derived text did not go through yet (utility LLM was unavailable)
    for (const uid of await store.usersWithPendingScrub().catch(() => [] as string[])) await scrub(uid);
  };
  void purge();
  setInterval(purge, 3600_000).unref();

  // sessions being finalized (summary + memory update), so a resumed session can wait for its predecessor
  const finalizing = new Map<string, Promise<unknown>>();
  // the look-ahead step of a user's last conversation (goal notes, next plan), so a ride that starts right away waits for it
  const lookahead = new Map<string, Promise<unknown>>();
  // the plan each running session was given (the look-ahead step reports what became of it)
  const sessionAgenda = new Map<string, AgendaItem[]>();
  // server-side self-tests only: compress pacing time for a user (see runSelftest)
  const pacingScales = new Map<string, number>();
  const hooks: SessionHooks = {
    async prepare(userId, sessionId, start) {
      const planning = lookahead.get(userId);
      if (planning) await Promise.race([planning, new Promise((r) => setTimeout(r, 8_000))]);
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
      await store.markUsed(view.usedIds);
      sessionAgenda.set(sessionId, built.agenda);
      return {
        onboarding: built.onboarding, pacingScale: pacingScales.get(userId),
        plan: built.agenda.map((a) => ({ topic: a.topic, take: a.take ?? null, kind: a.kind })), confirm: built.confirm,
        ctx: { session_id: sessionId, user_id: userId, language: built.language, system_prompt: built.system_prompt,
          opener_instruction: built.opener_instruction, proactive, journey: start.journey ?? {}, profile: built.profile,
          options: { llm: config.llmSampling } },
      };
    },
    async onUserTurn(args) {
      const done = await handleLiveTurn(store, llm, args);
      if (done.some((d) => /^(delete|correct):/.test(d))) void scrub(args.userId);
      return (await handleCapture(store, llm, args)).note;
    },
    async finalize(args) {
      const p = finalizeSession(args);
      finalizing.set(args.sessionId, p);
      try { return await p; } finally { setTimeout(() => finalizing.delete(args.sessionId), 60_000); }
    },
  };
  async function finalizeSession({ userId, sessionId, turns, stats, endReason, describe, language }: Parameters<SessionHooks["finalize"]>[0]) {
      const visible = turns.filter((t) => !t.text.startsWith("["));
      let summary: SummaryResult | null = null;
      let policy: Awaited<ReturnType<MemoryStore["applySummary"]>> | null = null;
      if (visible.some((t) => t.role === "user")) {
        const view = await store.memoryView(userId);
        const t0 = Date.now();
        summary = await summarizeSession(llm, visible, { openTopics: view.openTopics, known: view.knownIds, candidates: view.candidates });
        stats.summary_ms = Date.now() - t0;
        policy = await store.applySummary(userId, sessionId, summary, visible, { languageDetected: language === "auto" });
        await store.learnAddressing(userId, sessionId, visible);
      }
      await store.finishSession({ sessionId, userId, turns: visible, summary, stats, endReason, describe, policy });
      if (summary && policy) {
        // the look-ahead runs after the phone has its summary: it never delays the end of a conversation
        const la = lookAhead(userId, sessionId, visible, summary, policy.progressIds)
          .catch((e) => store.addSessionStats(sessionId, { lookahead_error: String(e).slice(0, 300) }).catch(() => {}))
          .finally(() => { if (lookahead.get(userId) === la) lookahead.delete(userId); });
        lookahead.set(userId, la);
      } else sessionAgenda.delete(sessionId);
      return summary ? { summary: summary.summary, progress: summary.progress, method: summary.method } : null;
  }

  /** Goal notes, ticked-off tasks, the plan for the next ride, then scrub and consolidation (memory/plan.ts). */
  async function lookAhead(userId: string, sessionId: string, turns: SessionTurn[], summary: SummaryResult, progressIds: string[]) {
    const t0 = Date.now();
    const goals = (await store.goals(userId)).filter((g) => g.status === "active" || g.status === "paused");
    const tasks = await store.memories(userId, { kinds: ["action_item"], status: ["active"], limit: 30 });
    const had = sessionAgenda.get(sessionId) ?? [];
    sessionAgenda.delete(sessionId);
    const plan = await planNext(llm, turns, {
      summary: summary.summary, language: summary.language, progress: summary.progress,
      goals: goals.map((g) => ({ id: g.id, content: g.content, state: [g.state_note, g.next_step ? `next: ${g.next_step}` : null].filter(Boolean).join(" ") || null })),
      tasks: tasks.map((t) => ({ id: t.id, content: t.content })), agenda: had,
    });
    // what opened this ride and was not taken up must not open the next one as well
    const openedSkipped = had[0] && plan.agenda_outcome.find((o) => o.index === 0)?.outcome === "skipped" ? had[0].topic : null;
    const res = await store.applyPlan(userId, sessionId, plan, turns, progressIds, openedSkipped);
    if (!plan.next_agenda.length) await store.saveAgenda(userId, sessionId, fallbackAgenda(await store.memoryView(userId)), openedSkipped);
    const scrubbed = await scrub(userId);
    const cons = await consolidate(store, llm, userId).catch((e) => ({ digest: false, history: false, skipped: String(e).slice(0, 120) }));
    await store.addSessionStats(sessionId, {
      lookahead_ms: Date.now() - t0,
      plan: { method: plan.method, error: plan.error, ms: plan.ms, applied: res.applied, refused: res.refused, next_agenda: plan.next_agenda.length,
        agenda_outcome: plan.agenda_outcome.map((o) => ({ kind: had[o.index]?.kind ?? null, outcome: o.outcome })) },
      scrub: scrubbed, consolidate: cons,
    });
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
      const rows = await store.memories(id, { status: ["active", "candidate"], kinds: ["name", "travel_goal", "goal", "interest", "fact", "preference", "action_item", "idea", "open_topic"] });
      return { memories: rows.map((m) => ({ id: m.id, kind: m.kind, content: m.content, status: m.status, confidence: m.confidence,
        source: m.provenance.source, confirmed: m.provenance.confirmed === true, quote: m.provenance.quote ?? null, created_at: m.created_at, expires_at: m.expires_at })) };
    });
    app.patch("/v1/memories/:id", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const b = parse(z.object({ content: z.string().min(1).max(500) }), req.body, reply); if (!b) return;
      const n = await store.correctMemory(id, (req.params as { id: string }).id, b.content, "app");
      if (n) void scrub(id);
      return n ? { id: n } : reply.code(404).send({ error: "not found" });
    });
    // tasks and ideas: tick off / put back
    app.post("/v1/memories/:id/done", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return (await store.setDone(id, (req.params as { id: string }).id, true, "app")) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.post("/v1/memories/:id/reopen", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return (await store.setDone(id, (req.params as { id: string }).id, false, "app")) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.post("/v1/goals/:id/status", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const b = parse(z.object({ status: z.enum(["active", "paused", "achieved", "dropped"]) }), req.body, reply); if (!b) return;
      return (await store.setGoalStatus(id, (req.params as { id: string }).id, b.status)) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.post("/v1/memories/:id/confirm", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return (await store.confirmCandidate(id, (req.params as { id: string }).id, "app")) ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.delete("/v1/memories/:id", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      const ok = await store.deleteMemory(id, (req.params as { id: string }).id, "app");
      if (ok) void scrub(id);
      return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
    });
    app.get("/v1/progress", async (req, reply) => {
      const id = user(req, reply); if (!id) return;
      return progressOf(id);
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
    // keep a memory as confirmed by the user (optionally reworded), e.g. before deleting the conversation it came from
    app.post("/v1/admin/users/:id/memories/:mid/keep", async (req, reply) => {
      if (!admin(req, reply)) return;
      const { id, mid } = req.params as { id: string; mid: string };
      const b = parse(z.object({ content: z.string().min(1).max(500).optional() }), req.body, reply); if (!b) return;
      if (!/^[0-9a-f-]{36}$/i.test(mid) || !(await store.userExists(id))) return reply.code(404).send({ error: "not found" });
      const kept = await store.keepMemory(id, mid, b.content);
      if (kept && b.content !== undefined) void scrub(id);
      return kept ? { id: kept } : reply.code(404).send({ error: "not found" });
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
      const b = parse(z.object({ scenario: z.enum(["relay", "memory", "goals", "tasks", "agenda"]), lang: z.enum(["he", "en"]).default("he"), user_id: z.string().uuid().optional() }), req.body, reply); if (!b) return;
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

  /** Everything the Progress screen and the home card show: goals with where they stand, tasks, ideas, the next plan. */
  async function progressOf(id: string) {
    const [goals, progress, open, done, ideas, view] = [
      await store.goals(id), await store.progress(id), await store.memories(id, { kinds: ["action_item"], status: ["active"] }),
      await store.memories(id, { kinds: ["action_item", "idea"], status: ["active"], done: true, limit: 10 }),
      await store.memories(id, { kinds: ["idea"], status: ["active"] }), await store.memoryView(id),
    ];
    const item = (m: { id: string; kind: string; content: string; created_at: Date; resolved_at: Date | null }) =>
      ({ id: m.id, kind: m.kind, content: m.content, created_at: m.created_at, done_at: m.resolved_at });
    return {
      goals: goals.map((g) => ({ id: g.id, kind: g.kind, content: g.content, status: g.status, state_note: g.state_note, next_step: g.next_step,
        last_discussed_at: g.last_discussed_at, sessions_count: g.sessions_count,
        progress: progress.filter((p) => p.goal_id === g.id).slice(0, 6).map((p) => ({ id: p.id, text: p.text, created_at: p.created_at })) })),
      action_items: open.map(item), done_items: done.map(item), ideas: ideas.map(item),
      next_up: (view.agenda?.items ?? []).map((a) => ({ topic: a.topic, kind: a.kind })),
      progress: progress.map((p) => ({ id: p.id, text: p.text, created_at: p.created_at, goal_id: p.goal_id })),
      sessions: await store.sessions(id),
    };
  }

  // ---------------------------------------------------------- self-test runner (scripted phone next to the server)
  const jobs = new Map<string, { id: string; scenario: string; lang: "he" | "en"; status: string; started: string; results: unknown[]; user_id: string | null; error: string | null }>();
  const stateOf = async (uid: string) => {
    const view = await store.memoryView(uid);
    const all = await store.memories(uid, { status: ["active", "candidate"] });
    const p = await store.profile(uid);
    return { profile: { preferred_name: p.preferred_name, preferred_language: p.preferred_language, addressing: { value: p.addressing_value, status: p.addressing_status, evidence: p.addressing_evidence } },
      memories: all.map((m) => ({ kind: m.kind, status: m.status, content: m.content, confidence: m.confidence, reason: m.provenance.reason, attribution: m.provenance.attribution })),
      progress: (await store.progress(uid)).map((r) => ({ text: r.text, linked_to_goal: !!r.goal_id })),
      goals: (await store.goals(uid)).map((g) => ({ content: g.content, status: g.status, state_note: g.state_note, next_step: g.next_step, sessions_count: g.sessions_count })),
      tasks_open: view.tasks.map((t) => t.content), ideas: view.ideas,
      tasks_done: (await store.memories(uid, { kinds: ["action_item", "idea"], done: true })).map((m) => m.content),
      next_agenda: view.agenda?.items ?? [], digest: view.digest, scrub_pending: (await store.scrubQueue(uid)).length,
      sessions: (await db.query("SELECT started_at, stats->'notes' AS notes, stats->'plan' AS plan, stats->'lookahead_ms' AS lookahead_ms, stats->'server_reply_ms_median' AS reply_ms FROM sessions WHERE user_id=$1 ORDER BY started_at", [uid])).rows,
      next_opener_instruction: buildContext(view, { timeZone: config.timezone }).opener_instruction,
      next_prompt_chars: buildContext(view, { timeZone: config.timezone, language: "he" }).system_prompt.length,
      next_prompt_memory_part: buildContext(view, { timeZone: config.timezone, language: "he" }).system_prompt.split("\n\n").slice(-2).join("\n\n") };
  };
  async function runSelftest(job: { scenario: string; lang: "he" | "en"; status: string; results: unknown[]; user_id: string | null }) {
    const uid = job.user_id ?? await store.createUser(`selftest ${new Date().toISOString()}`);
    job.user_id = uid;
    const base = `ws://127.0.0.1:${config.port}`;
    const pod = { url: config.gpuWorkerUrl, apiKey: config.gpuApiKey };
    const run = async (label: string, steps: Step[], minutes?: number) => {
      const { ticket } = await auth.createTicket(uid);
      const r = await runConversation({ wsUrl: `${base}/v1/voice?ticket=${ticket}`, lang: job.lang, pod, steps, label, minutes });
      job.results.push({ label, ...r });
      // the next conversation of a scenario builds on this one's look-ahead (goal notes, plan): let it finish
      await Promise.race([lookahead.get(uid) ?? Promise.resolve(), new Promise((res) => setTimeout(res, 45_000))]);
      return r;
    };
    if (job.scenario === "relay") await run("relay", LINES[job.lang].relay);
    else if (job.scenario === "goals") {
      // a goal over three rides: stated, moved forward, moved again; its notes and the plan should follow
      await run("g1_goal_stated", [
        { say: "היי, קוראים לי דני." },
        { say: "אני רוצה לנצל את הנסיעות כדי לתכנן את המעבר שלי לעבודה עצמאית." },
        { say: "אני חושב שהצעד הראשון הוא לבנות רשימה של עשרה לקוחות אפשריים." },
        { say: "טוב, הגעתי, ביי." },
      ]);
      await run("g2_progress", [
        { say: "כן, התחלתי את הרשימה, יש לי כבר ארבעה שמות." },
        { say: "אני צריך עוד שישה, אולי אפנה לקולגות מהעבודה הקודמת." },
        { say: "יאללה, נמשיך בפעם הבאה, ביי." },
      ]);
      await run("g3_next_step", [
        { say: "סיימתי את הרשימה, יש לי עשרה לקוחות." },
        { say: "עכשיו אני רוצה לנסח הודעת פנייה ראשונה ללקוחות." },
        { say: "ביי, הגעתי." },
      ]);
    } else if (job.scenario === "tasks") {
      // "note that for me": saved during the ride; "I did it" on the next ride ticks it off
      await run("t1_note_task_and_idea", [
        { say: "היי, תרשום לי בבקשה להתקשר לרואה החשבון מחר בבוקר." },
        { say: "ויש לי רעיון, תשמור אותו: לפתוח ניוזלטר שבועי ללקוחות." },
        { say: "טוב, זה הכל להיום, ביי." },
      ]);
      job.results.push({ label: "state_after_t1", state: await stateOf(uid) });
      await run("t2_done", [
        { say: "כן, התקשרתי לרואה החשבון, זה סגור." },
        { say: "ביי, הגעתי." },
      ]);
    } else if (job.scenario === "agenda") {
      // ride 1 leaves things open; ride 2 is a "20-minute" ride run ten times faster: halfway, wrap-up and last-word notes
      await run("a1_leaves_things_open", [
        { say: "היי, קוראים לי דני, אני מתכנן טיול משפחתי ליוון בקיץ." },
        { say: "עוד לא החלטתי אם לטוס לאתונה או לאחד האיים." },
        { say: "וגם רציתי לחזור לרוץ פעמיים בשבוע, אבל אין לי כוח." },
        { say: "טוב, הגעתי, נדבר, ביי." },
      ]);
      pacingScales.set(uid, 0.1);
      try {
        await run("a2_paced_ride", [
          { say: "האמת שאני נוטה לאי, נשמע לי רגוע יותר.", wait_ms: 8_000 },
          { say: "כן, אולי כרתים, יש שם גם מה לעשות עם הילדים.", wait_ms: 12_000 },
          { say: "נכון. ומה לגבי הריצה, יש לך רעיון איך להתחיל?", wait_ms: 12_000 },
          { say: "אוקיי, אני אנסה ביום ראשון בבוקר.", wait_ms: 14_000 },
          { say: "סבבה.", wait_ms: 14_000 },
          { say: "טוב, הגעתי, ביי.", wait_ms: 10_000 },
        ], 20);
      } finally { pacingScales.delete(uid); }
    } else {
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
