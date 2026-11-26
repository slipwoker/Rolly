/**
 * Aggregates for the backoffice, computed in memory from session rows (a handful of testers: thousands of rows at most).
 * Pure functions over plain rows, so they are tested without a database (test/audit.test.ts).
 */

export interface SessionRow {
  id: string;
  user_id: string;
  user_label: string | null;
  started_at: Date | string;
  language: string | null;
  end_reason: string | null;
  user_turns: number;
  onboarding: boolean;
  stats: Record<string, unknown> | null;
  quality: Record<string, unknown> | null;
  flags: string[] | null;
  cost: Record<string, unknown> | null;
  judge: { overall?: number; scores?: Record<string, number> } | null;
  review_rating: number | null;
  prompt_hash: string | null;
  api_usd: number | null;
}

export interface CallRow { at: Date | string; purpose: string; model: string; ok: boolean; ms: number | null; cost_usd: number | null;
  prompt_tokens: number | null; completion_tokens: number | null; cached_tokens: number | null; session_id: string | null; user_id: string | null }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const arr = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : []);

export function dayKey(d: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

/** conversations: sessions in which the user said something */
const isConversation = (s: SessionRow) => s.user_turns > 0;
const minutesOf = (s: SessionRow) => (num(s.stats?.duration_s) ?? 0) / 60;
/**
 * The GPU pod is a fixed cost (pricing.ts): `gpuPerDay` for every day of the range on which the service existed
 * (from the day of its first recorded session). Never divided among conversations.
 */
export interface FixedCost { gpuPerDay: number; gpuHoursPerDay: number; firstDay: string | null }
const podDay = (k: string, f: FixedCost) => f.firstDay !== null && k >= f.firstDay;

const q = (s: SessionRow, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), s.quality);

export function overview(rows: SessionRow[], calls: CallRow[], opts: { timeZone: string; days: number } & FixedCost) {
  const conv = rows.filter(isConversation);
  const replies = conv.flatMap((s) => arr(s.stats?.server_reply_ms));
  const minutes = conv.reduce((n, s) => n + minutesOf(s), 0);
  const apiUsd = calls.reduce((n, c) => n + (c.cost_usd ?? 0), 0);
  const scores = conv.map((s) => num(q(s, "score"))).filter((x): x is number => x !== null);
  const judged = conv.map((s) => num(s.judge?.overall)).filter((x): x is number => x !== null);
  const reviewed = conv.map((s) => s.review_rating).filter((x): x is number => typeof x === "number");
  const flagged = conv.filter((s) => (s.flags ?? []).length > 0);

  // per day (local)
  const days = new Map<string, { day: string; sessions: number; minutes: number; api_usd: number; replies: number[]; flagged: number; users: Set<string> }>();
  const dayOf = (k: string) => {
    let d = days.get(k);
    if (!d) { d = { day: k, sessions: 0, minutes: 0, api_usd: 0, replies: [], flagged: 0, users: new Set() }; days.set(k, d); }
    return d;
  };
  const today = new Date();
  for (let i = opts.days - 1; i >= 0; i--) dayOf(dayKey(new Date(today.getTime() - i * 86_400_000), opts.timeZone));
  for (const s of rows) {
    if (!isConversation(s)) continue;
    const d = dayOf(dayKey(s.started_at, opts.timeZone));
    d.sessions++; d.minutes += minutesOf(s); d.replies.push(...arr(s.stats?.server_reply_ms)); d.users.add(s.user_id);
    if ((s.flags ?? []).length) d.flagged++;
  }
  for (const c of calls) dayOf(dayKey(c.at, opts.timeZone)).api_usd += c.cost_usd ?? 0;
  const daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({
    day: d.day, sessions: d.sessions, minutes: Math.round(d.minutes * 10) / 10, users: d.users.size, flagged: d.flagged,
    api_usd: r6(d.api_usd), gpu_usd: podDay(d.day, opts) ? r6(opts.gpuPerDay) : 0, reply_p50: pct(d.replies, 50), reply_p95: pct(d.replies, 95),
  }));
  const podDays = daily.filter((d) => podDay(d.day, opts)).length;
  const gpuUsd = podDays * opts.gpuPerDay;
  const podMinutes = podDays * opts.gpuHoursPerDay * 60;

  return {
    kpis: {
      conversations: conv.length, sessions_total: rows.length, users: new Set(conv.map((s) => s.user_id)).size,
      minutes: Math.round(minutes * 10) / 10, avg_minutes: conv.length ? Math.round((minutes / conv.length) * 10) / 10 : null,
      reply_p50: pct(replies, 50), reply_p95: pct(replies, 95),
      api_usd: r6(apiUsd), gpu_usd: r6(gpuUsd), total_usd: r6(apiUsd + gpuUsd),
      // all-in: everything spent in the range over the minutes talked; marginal: what one more minute adds (the API only)
      usd_per_minute: minutes ? r6((apiUsd + gpuUsd) / minutes) : null,
      api_usd_per_minute: minutes ? r6(apiUsd / minutes) : null,
      gpu_busy_share: podMinutes ? Math.round((minutes / podMinutes) * 10000) / 10000 : null,
      api_usd_per_conversation: conv.length ? r6(apiUsd / conv.length) : null,
      avg_score: scores.length ? Math.round(mean(scores)!) : null, judge_avg: r2(mean(judged)), judged: judged.length, review_avg: r2(mean(reviewed)), reviewed: reviewed.length,
      flagged: flagged.length, flagged_share: conv.length ? r2(flagged.length / conv.length) : null,
    },
    daily,
    flags: countBy(conv.flatMap((s) => s.flags ?? [])),
    end_reasons: countBy(rows.map((s) => s.end_reason ?? "open")),
    insights: insights(conv),
  };
}

export function countBy(xs: string[]): { key: string; n: number }[] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/** Behaviour of the agent across conversations: style, turn-taking, plan uptake, memory, language. */
export function insights(conv: SessionRow[]) {
  const sum = (path: string) => conv.reduce((n, s) => n + (num(q(s, path)) ?? 0), 0);
  const replies = sum("style.replies");
  const rate = (path: string) => (replies ? r2(sum(path) / replies) : null);
  const agentTurns = sum("turns_agent");
  const planBy: Record<string, { taken: number; skipped: number }> = {};
  for (const s of conv) {
    const by = (q(s, "plan.by_kind") ?? {}) as Record<string, { taken: number; skipped: number }>;
    for (const [k, v] of Object.entries(by)) { planBy[k] ??= { taken: 0, skipped: 0 }; planBy[k].taken += v.taken; planBy[k].skipped += v.skipped; }
  }
  const planItems = Object.values(planBy).reduce((n, v) => n + v.taken + v.skipped, 0);
  const judgeCrit: Record<string, number[]> = {};
  for (const s of conv) for (const [k, v] of Object.entries(s.judge?.scores ?? {})) if (typeof v === "number") (judgeCrit[k] ??= []).push(v);
  const langs = countBy(conv.map((s) => s.language ?? "?"));
  return {
    style: {
      replies, bot_speak_rate: replies ? r2(1 - sum("style.clean") / replies) : null,
      ack_rate: rate("style.ack"), platitude_rate: rate("style.platitude"), apology_rate: rate("style.apology"),
      therapist_rate: rate("style.therapist"), promise_rate: rate("style.promise"), question_rate: rate("style.question"),
      questions_in_a_row: sum("style.questions_in_a_row"), guard_notes: sum("style.guard_notes"),
      avg_agent_words: r2(mean(conv.map((s) => num(q(s, "words.agent_avg"))).filter((x): x is number => x !== null && x > 0))),
      long_replies: sum("words.long_replies"),
    },
    turn_taking: {
      agent_turns: agentTurns, interruptions: sum("interruptions"), interruption_rate: agentTurns ? r2(sum("interruptions") / agentTurns) : null,
      slow_replies: sum("reply_ms.slow"), stt_discarded: sum("stt_discarded"), uncertain_turns: sum("uncertain_turns"),
      avg_user_turns: conv.length ? r2(sum("turns_user") / conv.length) : null,
    },
    plan: { items: planItems, taken_rate: planItems ? r2(Object.values(planBy).reduce((n, v) => n + v.taken, 0) / planItems) : null, by_kind: planBy },
    memory: {
      active: sum("memory.active"), candidate: sum("memory.candidate"),
      user_corrections: sum("memory.user_corrections"), user_deletions: sum("memory.user_deletions"), user_confirmations: sum("memory.user_confirmations"),
      summary_failures: conv.filter((s) => q(s, "summary.failed") === true).length,
    },
    language: { sessions: langs, mismatches: conv.filter((s) => q(s, "language.mismatch") === true).length },
    judge: Object.fromEntries(Object.entries(judgeCrit).map(([k, v]) => [k, r2(mean(v))])),
  };
}

/** Per prompt version: how conversations went with it (comparison across prompt changes). */
export function byPrompt(rows: SessionRow[]) {
  const groups = new Map<string, SessionRow[]>();
  for (const s of rows.filter(isConversation)) {
    const k = s.prompt_hash ?? "unknown";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  return [...groups.entries()].map(([hash, ss]) => {
    const replies = ss.flatMap((s) => arr(s.stats?.server_reply_ms));
    const st = insights(ss).style;
    return {
      hash, conversations: ss.length, minutes: Math.round(ss.reduce((n, s) => n + minutesOf(s), 0) * 10) / 10,
      reply_p50: pct(replies, 50), bot_speak_rate: st.bot_speak_rate, ack_rate: st.ack_rate, platitude_rate: st.platitude_rate,
      avg_agent_words: st.avg_agent_words,
      interruption_rate: insights(ss).turn_taking.interruption_rate,
      avg_score: ((a) => (a.length ? Math.round(mean(a)!) : null))(ss.map((s) => num(q(s, "score"))).filter((x): x is number => x !== null)),
      judge_avg: r2(mean(ss.map((s) => num(s.judge?.overall)).filter((x): x is number => x !== null))),
      review_avg: r2(mean(ss.map((s) => s.review_rating).filter((x): x is number => typeof x === "number"))),
      flagged_share: r2(ss.filter((s) => (s.flags ?? []).length).length / ss.length),
      prompt_tokens_p50: pct(ss.map((s) => num((s.stats?.usage as { llm?: { max_prompt_tokens?: number } } | undefined)?.llm?.max_prompt_tokens)).filter((x): x is number => !!x), 50),
    };
  });
}

/**
 * Costs by day and purpose, by model and by user, with a monthly run-rate.
 * Variable: utility-model calls (per conversation, per user). Fixed: the GPU pod per day and the monthly services; they are
 * shown against the minutes talked, never split per conversation or user.
 */
export function costs(rows: SessionRow[], calls: CallRow[], opts: { timeZone: string; days: number; fixedMonthly: Record<string, number> } & FixedCost) {
  const byPurpose = new Map<string, { purpose: string; calls: number; failures: number; usd: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number; ms: number[] }>();
  const byModel = new Map<string, { model: string; calls: number; usd: number; unpriced: number }>();
  const byUser = new Map<string, { user_id: string; label: string | null; api_usd: number; conversations: number; minutes: number }>();
  const labels = new Map(rows.map((s) => [s.user_id, s.user_label]));
  const user = (id: string) => byUser.get(id) ?? byUser.set(id, { user_id: id, label: labels.get(id) ?? null, api_usd: 0, conversations: 0, minutes: 0 }).get(id)!;
  const daily = new Map<string, Record<string, number>>();
  const dayRow = (k: string) => daily.get(k) ?? daily.set(k, {}).get(k)!;
  const today = new Date();
  for (let i = opts.days - 1; i >= 0; i--) dayRow(dayKey(new Date(today.getTime() - i * 86_400_000), opts.timeZone));
  for (const c of calls) {
    const p = byPurpose.get(c.purpose) ?? byPurpose.set(c.purpose, { purpose: c.purpose, calls: 0, failures: 0, usd: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, ms: [] }).get(c.purpose)!;
    p.calls++; if (!c.ok) p.failures++; p.usd += c.cost_usd ?? 0;
    p.prompt_tokens += c.prompt_tokens ?? 0; p.completion_tokens += c.completion_tokens ?? 0; p.cached_tokens += c.cached_tokens ?? 0;
    if (typeof c.ms === "number") p.ms.push(c.ms);
    const m = byModel.get(c.model) ?? byModel.set(c.model, { model: c.model, calls: 0, usd: 0, unpriced: 0 }).get(c.model)!;
    m.calls++; m.usd += c.cost_usd ?? 0; if (c.ok && c.cost_usd === null) m.unpriced++;
    if (c.user_id) user(c.user_id).api_usd += c.cost_usd ?? 0;
    const d = dayRow(dayKey(c.at, opts.timeZone));
    d[c.purpose] = (d[c.purpose] ?? 0) + (c.cost_usd ?? 0);
  }
  const dayMinutes = new Map<string, number>();
  for (const s of rows) {
    if (!isConversation(s)) continue;
    const u = user(s.user_id);
    u.conversations++; u.minutes += minutesOf(s);
    const k = dayKey(s.started_at, opts.timeZone);
    dayMinutes.set(k, (dayMinutes.get(k) ?? 0) + minutesOf(s));
  }
  const keys = [...daily.keys()].sort();
  const podDays = keys.filter((k) => podDay(k, opts)).length;
  const api = calls.reduce((n, c) => n + (c.cost_usd ?? 0), 0);
  const gpu = podDays * opts.gpuPerDay;
  const minutes = rows.filter(isConversation).reduce((n, s) => n + minutesOf(s), 0);
  const fixedMonthly = Object.values(opts.fixedMonthly).reduce((a, b) => a + b, 0);
  const fixedOther = (fixedMonthly / 30) * podDays;
  const podMinutes = podDays * opts.gpuHoursPerDay * 60;
  const total = api + gpu + fixedOther;
  return {
    totals: {
      api_usd: r6(api), gpu_usd: r2(gpu), fixed_other_usd: r2(fixedOther), total_usd: r2(total), pod_days: podDays,
      minutes: Math.round(minutes * 10) / 10,
      usd_per_minute: minutes ? r6(total / minutes) : null,        // all-in
      api_usd_per_minute: minutes ? r6(api / minutes) : null,      // marginal: what one more minute of talk adds
      gpu_busy_share: podMinutes ? Math.round((minutes / podMinutes) * 10000) / 10000 : null,
      gpu_per_day_usd: r2(opts.gpuPerDay),
      fixed_monthly_usd: fixedMonthly,
      monthly_run_rate_usd: r2((api / Math.max(1, podDays || opts.days)) * 30 + opts.gpuPerDay * 30 + fixedMonthly),
    },
    daily: keys.map((day) => ({ day, ...Object.fromEntries(Object.entries(daily.get(day)!).map(([k, x]) => [k, r6(x)])),
      gpu: podDay(day, opts) ? r2(opts.gpuPerDay) : 0, minutes: Math.round((dayMinutes.get(day) ?? 0) * 10) / 10 })),
    by_purpose: [...byPurpose.values()].map((p) => ({ ...p, usd: r6(p.usd), ms_p50: pct(p.ms, 50), ms_p95: pct(p.ms, 95), ms: undefined })).sort((a, b) => b.usd - a.usd),
    by_model: [...byModel.values()].map((m) => ({ ...m, usd: r6(m.usd) })).sort((a, b) => b.usd - a.usd),
    by_user: [...byUser.values()].map((u) => ({ ...u, api_usd: r6(u.api_usd), minutes: Math.round(u.minutes * 10) / 10,
      minutes_share: minutes ? Math.round((u.minutes / minutes) * 1000) / 1000 : null })).sort((a, b) => b.minutes - a.minutes),
  };
}
