/**
 * How a conversation went, computed without a model from what is stored anyway: the transcript, the session stats, the
 * memory events and the utility-model calls. Deterministic and cheap, so it runs on every session and can be recomputed
 * for all of them when a threshold changes (POST /v1/admin/audit/reassess).
 *
 * The flags are the backoffice's triage list. Each is something the owner should look at, with a short reason; the score
 * (0-100) is only a sort key: 100 minus a fixed weight per flag.
 */
import { countBotSpeak, type StyleCounts } from "../persona/style.ts";

export interface AuditTurn {
  idx: number;
  role: "user" | "agent";
  text: string;
  language?: string | null;
  attribution: "primary" | "uncertain";
  meta: Record<string, unknown>;
}

export interface AuditInput {
  turns: AuditTurn[];
  stats: Record<string, unknown>;
  session: { language: string | null; end_reason: string | null; onboarding: boolean; summary: Record<string, unknown> | null };
  /** memory changes the user made during or right after this session (voice or app) */
  memoryEvents: { action: string; via: string }[];
  llmCalls: { purpose: string; ok: boolean }[];
  notes: { kind: string }[];
  judge?: { overall?: number } | null;
}

export interface Quality {
  version: number;
  duration_s: number | null;
  turns_user: number;
  turns_agent: number;
  reply_ms: { p50: number | null; p95: number | null; max: number | null; n: number; slow: number };
  client_first_audio_ms_p50: number | null;
  interruptions: number;
  interruption_rate: number | null;
  words: { agent_avg: number; user_avg: number; talk_ratio: number | null; long_replies: number };
  style: StyleCounts & { bot_speak_rate: number | null; guard_notes: number };
  uncertain_turns: number;
  language: { session: string | null; detected: Record<string, number>; mismatch: boolean };
  stt_discarded: number;
  errors: number;
  end_reason: string | null;
  plan: { items: number; taken: number; skipped: number; by_kind: Record<string, { taken: number; skipped: number }> } | null;
  memory: { active: number; candidate: number; user_corrections: number; user_deletions: number; user_confirmations: number };
  summary: { method: string | null; failed: boolean };
  lookahead_failed: boolean;
  utility_failures: number;
  conv_llm: { calls: number; prompt_tokens: number; completion_tokens: number; max_prompt_tokens: number; model: string | null } | null;
  notes_by_kind: Record<string, number>;
}

export interface Flag { id: string; severity: "high" | "medium" | "low"; why: string }

export const QUALITY_VERSION = 1;

/** Thresholds, in one place so a change is visible in review. */
export const THRESHOLDS = {
  slowReplyMs: 2000,       // one reply counted as slow
  slowP50Ms: 1500,         // session flagged slow
  slowP95Ms: 3000,
  botSpeakRate: 0.4,       // share of replies with at least one bot-speak habit
  interruptionRate: 0.3,
  longReplyWords: 40,
  longAvgWords: 32,
  languageMismatchShare: 0.3,
};

const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : []);
const visible = (t: AuditTurn) => !t.text.startsWith("[");

export function assess(inp: AuditInput): { quality: Quality; flags: Flag[]; score: number } {
  const s = inp.stats ?? {};
  const turns = inp.turns.filter(visible);
  const user = turns.filter((t) => t.role === "user");
  const agent = turns.filter((t) => t.role === "agent");
  const reply = numArr(s.server_reply_ms);
  const style = countBotSpeak(agent.map((t) => t.text));
  const botRate = style.replies ? Math.round((1 - style.clean / style.replies) * 100) / 100 : null;
  const agentWords = agent.map((t) => words(t.text));
  const userWords = user.map((t) => words(t.text));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const avg = (a: number[]) => (a.length ? Math.round((sum(a) / a.length) * 10) / 10 : 0);

  const detected: Record<string, number> = {};
  for (const t of user) if (t.language) detected[t.language] = (detected[t.language] ?? 0) + 1;
  const sessLang = inp.session.language;
  const other = sessLang === "he" || sessLang === "en" ? user.filter((t) => t.language && t.language !== sessLang).length : 0;
  const mismatch = other >= 2 && other / Math.max(1, user.length) >= THRESHOLDS.languageMismatchShare;

  const discarded = Object.entries((s.pod_metrics_count ?? {}) as Record<string, number>)
    .filter(([k]) => k.startsWith("stt_discarded_")).reduce((n, [, v]) => n + (Number(v) || 0), 0);

  const planStats = (s.plan ?? null) as { agenda_outcome?: { kind: string | null; outcome: string }[] } | null;
  let plan: Quality["plan"] = null;
  if (planStats?.agenda_outcome?.length) {
    const by: Record<string, { taken: number; skipped: number }> = {};
    let taken = 0, skipped = 0;
    for (const o of planStats.agenda_outcome) {
      const k = o.kind ?? "unknown";
      by[k] ??= { taken: 0, skipped: 0 };
      if (o.outcome === "skipped") { skipped++; by[k].skipped++; } else { taken++; by[k].taken++; }
    }
    plan = { items: planStats.agenda_outcome.length, taken, skipped, by_kind: by };
  }

  const userEv = inp.memoryEvents.filter((e) => e.via === "voice" || e.via === "app");
  const counts = ((inp.session.summary ?? {}).counts ?? {}) as { active?: number; candidate?: number };
  const notesByKind: Record<string, number> = {};
  for (const n of inp.notes) { const k = n.kind.startsWith("time_left_") ? "time_left" : n.kind; notesByKind[k] = (notesByKind[k] ?? 0) + 1; }
  const usage = ((s.usage ?? {}) as { llm?: Quality["conv_llm"] & { cached_tokens?: number } }).llm ?? null;
  const summaryMethod = typeof inp.session.summary?.method === "string" ? inp.session.summary.method : null;

  const quality: Quality = {
    version: QUALITY_VERSION,
    duration_s: num(s.duration_s),
    turns_user: user.length,
    turns_agent: agent.length,
    reply_ms: { p50: pct(reply, 50), p95: pct(reply, 95), max: reply.length ? Math.max(...reply) : null, n: reply.length,
      slow: reply.filter((r) => r > THRESHOLDS.slowReplyMs).length },
    client_first_audio_ms_p50: pct(numArr(s.client_first_audio_ms), 50),
    interruptions: num(s.interruptions) ?? agent.filter((t) => t.meta?.interrupted).length,
    interruption_rate: agent.length ? Math.round(((num(s.interruptions) ?? 0) / agent.length) * 100) / 100 : null,
    words: { agent_avg: avg(agentWords), user_avg: avg(userWords), talk_ratio: sum(userWords) ? Math.round((sum(agentWords) / sum(userWords)) * 10) / 10 : null,
      long_replies: agentWords.filter((w) => w > THRESHOLDS.longReplyWords).length },
    style: { ...style, bot_speak_rate: botRate, guard_notes: notesByKind.style ?? 0 },
    uncertain_turns: user.filter((t) => t.attribution === "uncertain").length,
    language: { session: sessLang, detected, mismatch },
    stt_discarded: discarded,
    errors: num(s.errors) ?? 0,
    end_reason: inp.session.end_reason,
    plan,
    memory: { active: counts.active ?? 0, candidate: counts.candidate ?? 0,
      user_corrections: userEv.filter((e) => e.action === "correct").length,
      user_deletions: userEv.filter((e) => e.action === "delete").length,
      user_confirmations: userEv.filter((e) => e.action === "confirm").length },
    summary: { method: summaryMethod, failed: user.length > 0 && (summaryMethod !== "llm" || !!inp.session.summary?.error) },
    lookahead_failed: typeof s.lookahead_error === "string",
    utility_failures: inp.llmCalls.filter((c) => !c.ok).length,
    conv_llm: usage && usage.calls ? { calls: usage.calls, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
      max_prompt_tokens: usage.max_prompt_tokens, model: usage.model ?? null } : null,
    notes_by_kind: notesByKind,
  };
  const flags = flagsFor(quality, inp.judge ?? null);
  return { quality, flags, score: scoreOf(flags) };
}

const WEIGHT = { high: 25, medium: 12, low: 4 } as const;
export const scoreOf = (flags: Flag[]) => Math.max(0, 100 - flags.reduce((n, f) => n + WEIGHT[f.severity], 0));

export function flagsFor(q: Quality, judge: { overall?: number } | null): Flag[] {
  const f: Flag[] = [];
  const add = (id: string, severity: Flag["severity"], why: string) => f.push({ id, severity, why });
  if (q.end_reason === "provider_error" || q.end_reason === "provider_unavailable") add("pipeline_failed", "high", `ended: ${q.end_reason}`);
  else if (q.errors > 0) add("errors", "medium", `${q.errors} pipeline error(s)`);
  if (q.language.mismatch) add("language_mismatch", "high",
    `session ran as ${q.language.session}, user turns detected as ${Object.entries(q.language.detected).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  if ((q.reply_ms.p50 ?? 0) > THRESHOLDS.slowP50Ms || (q.reply_ms.p95 ?? 0) > THRESHOLDS.slowP95Ms)
    add("slow", "medium", `reply p50 ${q.reply_ms.p50} ms, p95 ${q.reply_ms.p95} ms`);
  if (q.style.replies >= 3 && (q.style.bot_speak_rate ?? 0) >= THRESHOLDS.botSpeakRate)
    add("bot_speak", "medium", `${Math.round((q.style.bot_speak_rate ?? 0) * 100)}% of replies had a bot-speak habit (ack ${q.style.ack}, platitude ${q.style.platitude}, apology ${q.style.apology})`);
  if (q.interruptions >= 2 && (q.interruption_rate ?? 0) >= THRESHOLDS.interruptionRate)
    add("interruptions", "medium", `${q.interruptions} interruptions over ${q.turns_agent} replies`);
  if (q.words.agent_avg > THRESHOLDS.longAvgWords) add("long_replies", "low", `replies average ${q.words.agent_avg} words`);
  if (q.memory.user_corrections + q.memory.user_deletions > 0)
    add("memory_corrected", "medium", `the user corrected ${q.memory.user_corrections} and deleted ${q.memory.user_deletions} memories`);
  if (q.summary.failed) add("summary_failed", "medium", `summary method ${q.summary.method ?? "none"}`);
  if (q.lookahead_failed) add("lookahead_failed", "low", "goal notes / next plan were not written");
  if (q.utility_failures > 0) add("utility_llm_errors", "low", `${q.utility_failures} failed utility-model call(s)`);
  if (q.turns_user <= 1 && (q.duration_s ?? 0) < 90 && q.end_reason !== "superseded") add("abandoned", "low", `${q.turns_user} user turn(s) in ${q.duration_s ?? "?"} s`);
  if (q.end_reason === "superseded") add("superseded", "low", "a second session of the same user replaced this one");
  if (q.uncertain_turns > 0) add("other_voices", "low", `${q.uncertain_turns} user turn(s) may be another speaker`);
  if (q.stt_discarded >= 3) add("stt_discards", "low", `${q.stt_discarded} utterances discarded by the recogniser`);
  if (typeof judge?.overall === "number" && judge.overall <= 2) add("judge_low", "high", `LLM judge overall ${judge.overall}/5`);
  return f;
}
