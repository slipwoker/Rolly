/**
 * LLM judge: the utility model rates one conversation against what Rolly is meant to be (persona/core.ts) on a fixed
 * rubric. It is a second opinion for triage, not ground truth: the owner's own review (session_audit.review_*) wins.
 *
 * The transcript already goes to the same provider for the summary, so this adds no new recipient of the data. The judge
 * is told not to repeat personal details; its free text is removed with the rest of the personal text (recorder.ts).
 */
import type { UtilityLlm } from "../memory/llm.ts";
import type { AuditTurn } from "./quality.ts";

export const JUDGE_CRITERIA = {
  naturalness: "Sounds like a close friend talking, not an assistant: no stock openers, no help-line phrasing, no general life wisdom.",
  relevance: "Each reply follows from what the user just said; nothing ignored or misheard and answered as if it made sense.",
  initiative: "Brings something concrete of its own (a take, a specific question, a follow-up) instead of only reacting.",
  memory_use: "Uses what it knows about the user correctly and lightly; invents nothing; does not recite.",
  brevity: "Spoken-length replies (one to three short sentences); no lists, no monologues.",
  language: "Natural spoken language of the conversation; in Hebrew, grammatical gender of address consistent and right.",
} as const;
export type JudgeCriterion = keyof typeof JUDGE_CRITERIA;

export interface JudgeResult {
  scores: Partial<Record<JudgeCriterion, number>>;
  overall: number;
  issues: { turn: number | null; criterion: string; note: string }[];
  strengths: string[];
  summary: string;
  model: string;
  ms: number;
  at: string;
}

const PROMPT = `You review one spoken conversation between a user (driving) and Rolly, a voice companion that should talk like a close friend riding along.
Rate Rolly (only Rolly, never the user) from 1 (bad) to 5 (excellent) on each criterion:
{criteria}

Rules:
- Judge only what is in the transcript. USER? marks a turn that may be another person in the car. Lines in [brackets] are system markers.
- The user's speech is machine-transcribed: a strange user line may be a recognition error. Rolly answering such a line as if it made sense is a relevance problem.
- Do NOT repeat personal details about the user in your notes (names, places, health, work, plans). Describe Rolly's behaviour in general terms, e.g. "agreed and repeated the user's words instead of answering".
- issues: at most 5, the most important first; "turn" is the turn number shown in the transcript.
- strengths: at most 3 short phrases.

Answer with JSON only:
{"scores": {"naturalness": n, "relevance": n, "initiative": n, "memory_use": n, "brevity": n, "language": n}, "overall": n,
 "issues": [{"turn": n, "criterion": "...", "note": "..."}], "strengths": ["..."], "summary": "one sentence on how Rolly did"}

Conversation language: {language}
Transcript:
{transcript}`;

export function judgePrompt(turns: AuditTurn[], language: string | null): string {
  const lines = turns.map((t) => `${t.idx}. ${t.role === "agent" ? "ROLLY" : t.attribution === "uncertain" ? "USER?" : "USER"}: ${t.text}`);
  return PROMPT.replace("{criteria}", Object.entries(JUDGE_CRITERIA).map(([k, v]) => `- ${k}: ${v}`).join("\n"))
    .replace("{language}", language ?? "unknown").replace("{transcript}", lines.join("\n").slice(0, 24_000));
}

const clamp = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : null);

export function normalizeJudge(o: Record<string, unknown>, model: string, ms: number): JudgeResult {
  const scores: JudgeResult["scores"] = {};
  const raw = (o.scores ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(JUDGE_CRITERIA) as JudgeCriterion[]) { const v = clamp(raw[k]); if (v !== null) scores[k] = v; }
  const vals = Object.values(scores);
  const overall = clamp(o.overall) ?? (vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 3);
  const issues = (Array.isArray(o.issues) ? o.issues : []).slice(0, 5).map((i) => {
    const x = (i ?? {}) as Record<string, unknown>;
    return { turn: typeof x.turn === "number" ? x.turn : null, criterion: String(x.criterion ?? "").slice(0, 40), note: String(x.note ?? "").slice(0, 300) };
  }).filter((i) => i.note);
  const strengths = (Array.isArray(o.strengths) ? o.strengths : []).slice(0, 3).map((s) => String(s).slice(0, 120));
  return { scores, overall, issues, strengths, summary: String(o.summary ?? "").slice(0, 300), model, ms, at: new Date().toISOString() };
}

export async function judgeConversation(llm: UtilityLlm, turns: AuditTurn[], language: string | null): Promise<JudgeResult> {
  const shown = turns.filter((t) => t.text.trim());
  if (!shown.some((t) => t.role === "agent")) throw new Error("nothing to judge: no reply from Rolly");
  const r = await llm.json(judgePrompt(shown, language), { maxTokens: 900, purpose: "judge" });
  return normalizeJudge(r.obj, llm.name, r.ms);
}
