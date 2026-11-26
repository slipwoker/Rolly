/**
 * Session summary and memory extraction. Port of memory/summarizer.py (SUMMARY_PROMPT, fallback), extended for Phase 1:
 * the transcript may contain other people, every extracted item carries confidence, a verbatim quote and the turn it
 * came from, plus confirmations / corrections of existing memories and a "what we moved forward" list.
 * Divergence from the research prompt is deliberate and recorded in docs/PHASE1_DECISIONS.md (P1-D5).
 */
import type { SessionTurn } from "../voice/session.ts";
import type { UtilityLlm } from "./llm.ts";

export const SUMMARY_PROMPT = `You maintain the long-term memory of a voice companion called Rolly.
Below is the transcript of one spoken conversation between Rolly (AGENT) and the person who owns the phone (USER).
Important: speech was recognised automatically and nobody can tell who was speaking. Lines marked USER may come from
the owner or from someone else in the car (a passenger, someone on a call, the radio). Lines marked "USER?" were flagged
by weak acoustic hints as possibly someone else. Attribute cautiously: only treat something as being about the owner
when the words clearly say so in the first person ("I work at...", "my goal is...") and nothing suggests another speaker.

Return ONLY a JSON object with these keys:
  "summary": two to four sentences, third person, stating what was discussed and decided. Write it in the language the USER mostly spoke (Hebrew or English). Mention other people only as far as needed to understand the conversation; no personal details about them. If the user asked Rolly to forget or correct something, do not say what it was about: at most "asked to forget something".
  "topics": list of short topic labels,
  "decisions": list of decisions the user made,
  "unresolved_topics": list of topics opened but not concluded, worth continuing next time,
  "resolved_topics": list of previously open topics (from the list below) that were concluded in this conversation, copied exactly,
  "progress": list of at most three short statements of what this conversation actually moved forward for the user (a decision, a plan, an idea clarified, something done). Noting a task or saving an idea is not progress. Empty if nothing moved.
  "suggested_next_opener": one sentence Rolly could use to open the next journey,
  "preferred_name": ITEM or null — what the user wants to be called, only if they said it about themselves,
  "travel_goals": list of ITEM — what the user said would make their travel time valuable,
  "interests": list of ITEM,
  "goals": list of ITEM — wider goals the user stated,
  "action_items": list of ITEM — concrete things the user said THEY will do, or asked Rolly to note as a task,
  "ideas": list of ITEM — ideas the user came up with or asked Rolly to note or keep (not tasks),
  "facts": list of ITEM — other durable facts about the user (work, family situation, routines), only if stated by the user about themselves,
  "preferences": list of ITEM — how the user likes to talk or be talked to. Feedback about Rolly itself (how it talks, that it sounds robotic, how to pronounce a name) belongs HERE, phrased as what the user wants; it is never an unresolved topic, never progress, and gets at most a few words in the summary,
  "candidate_confirmations": list of {"id": "<id from the 'Not confirmed' list>", "answer": "yes"|"no", "turn": <turn number>} for items the user was asked about and answered,
  "corrections": list of {"memory_id": "<id from 'Known memories'>"|null, "action": "replace"|"delete", "new_content": "<corrected text>"|null, "turn": <turn number>, "quote": "<the user's words>"} when the user said something remembered is wrong or asked to forget it,
  "other_speakers_suspected": true if anything in the transcript suggests more than one person was talking (someone addressed by name, replies that do not fit, "USER?" lines), else false,
  "language": "he" or "en" — the language the user mostly spoke,
  "user_gender": {"form": "masculine"|"feminine"|null, "quotes": [up to three short phrases copied exactly from USER lines (never "USER?" lines) in which the user speaks about THEMSELVES in a gendered Hebrew form, e.g. "אני אורזת", "אני עייף"]}. form is null and quotes are empty when the user never did (English, or only forms that are the same for both). How the user addresses Rolly ("אתה", "את") says nothing about the user.
ITEM is {"content": "<short statement in the user's language>", "confidence": 0.0-1.0, "first_person": true|false,
         "turn": <turn number it comes from>, "quote": "<the user's exact words, verbatim from that turn>", "importance": 1|2|3}.
confidence is how sure you are that this is true AND was said by the owner about themselves.
importance: 3 = central to who this person is or what they are working towards, 2 = useful to know, 1 = a passing detail.
An ITEM that says the same as something already in "Known memories" must not be returned again.
Do not invent anything that is not supported by the transcript. If the transcript is empty or trivial, use empty lists.

Previously open topics:
{open_topics}

Known memories (id: content):
{known}

Not confirmed (id: content) — Rolly may have asked about these:
{candidates}

Transcript (turn number, speaker, words):
{transcript}
`;

export interface Item { content: string; confidence: number; first_person: boolean; turn: number | null; quote: string; importance?: number | null }

export interface SummaryResult {
  method: "llm" | "fallback_no_llm";
  summary: string;
  topics: string[];
  decisions: string[];
  unresolved_topics: string[];
  resolved_topics: string[];
  progress: string[];
  suggested_next_opener: string;
  preferred_name: Item | null;
  travel_goals: Item[];
  interests: Item[];
  goals: Item[];
  action_items: Item[];
  ideas: Item[];
  facts: Item[];
  preferences: Item[];
  candidate_confirmations: { id: string; answer: "yes" | "no"; turn: number | null }[];
  corrections: { memory_id: string | null; action: "replace" | "delete"; new_content: string | null; turn: number | null; quote: string }[];
  other_speakers_suspected: boolean;
  language: "he" | "en" | null;
  /** how the user speaks about themselves in Hebrew, with the phrases that show it (checked against the transcript before use) */
  user_gender: { form: "masculine" | "feminine"; quotes: string[] } | null;
  llm?: string;
  ms?: number;
  error?: string;
}

export function formatTranscript(turns: SessionTurn[], maxChars = 24_000): string {
  // a line in which the user named something to forget was already acted on during the ride: its words are not shown again
  const lines = turns.filter((t) => t.text).map((t) =>
    `${t.idx} ${t.role === "agent" ? "AGENT" : t.attribution === "uncertain" ? "USER?" : "USER"}: ${
      t.meta?.forget_request ? "[asked Rolly to forget something; already done]" : t.text}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars / 3) + "\n[...]\n" + text.slice(-(2 * maxChars) / 3);
  return text;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null);

function item(v: unknown): Item | null {
  if (!v || typeof v !== "object") return typeof v === "string" && v ? { content: v, confidence: 0.5, first_person: false, turn: null, quote: "" } : null;
  const o = v as Record<string, unknown>;
  const content = String(o.content ?? "").trim();
  if (!content) return null;
  const c = num(o.confidence);
  const imp = num(o.importance);
  return { content, confidence: c === null ? 0.5 : Math.max(0, Math.min(1, c)), first_person: o.first_person === true, turn: num(o.turn), quote: String(o.quote ?? ""),
    importance: imp === null ? null : Math.min(3, Math.max(1, Math.round(imp))) };
}
const items = (v: unknown): Item[] => (Array.isArray(v) ? v.map(item).filter((x): x is Item => !!x) : []);

export function normalize(obj: Record<string, unknown>): SummaryResult {
  return {
    method: "llm",
    summary: String(obj.summary ?? ""),
    topics: strs(obj.topics), decisions: strs(obj.decisions), unresolved_topics: strs(obj.unresolved_topics),
    resolved_topics: strs(obj.resolved_topics), progress: strs(obj.progress).slice(0, 3),
    suggested_next_opener: String(obj.suggested_next_opener ?? ""),
    preferred_name: item(obj.preferred_name),
    travel_goals: items(obj.travel_goals), interests: items(obj.interests), goals: items(obj.goals),
    action_items: items(obj.action_items), ideas: items(obj.ideas), facts: items(obj.facts ?? obj.new_user_facts), preferences: items(obj.preferences),
    candidate_confirmations: (Array.isArray(obj.candidate_confirmations) ? obj.candidate_confirmations : [])
      .map((c: Record<string, unknown>) => ({ id: String(c?.id ?? ""), answer: c?.answer === "yes" ? "yes" as const : "no" as const, turn: num(c?.turn) }))
      .filter((c) => c.id),
    corrections: (Array.isArray(obj.corrections) ? obj.corrections : [])
      .map((c: Record<string, unknown>) => ({
        memory_id: c?.memory_id ? String(c.memory_id) : null, action: c?.action === "delete" ? "delete" as const : "replace" as const,
        new_content: c?.new_content ? String(c.new_content) : null, turn: num(c?.turn), quote: String(c?.quote ?? ""),
      })),
    other_speakers_suspected: obj.other_speakers_suspected === true,
    language: obj.language === "he" || obj.language === "en" ? obj.language : null,
    user_gender: genderEvidence(obj.user_gender),
  };
}

function genderEvidence(v: unknown): SummaryResult["user_gender"] {
  const g = (v ?? {}) as { form?: unknown; quotes?: unknown };
  if (g.form !== "masculine" && g.form !== "feminine") return null;
  const quotes = strs(g.quotes).map((q) => q.trim()).filter((q) => q.length >= 3 && q.length <= 80).slice(0, 3);
  return quotes.length ? { form: g.form, quotes } : null;
}

export function fallbackSummary(turns: SessionTurn[]): SummaryResult {
  const user = turns.filter((t) => t.role === "user" && t.text).map((t) => t.text);
  return {
    method: "fallback_no_llm",
    summary: user.length ? `Conversation with ${user.length} user turns. First user remark: ${user[0]!.slice(0, 200)}` : "Conversation ended before the user said anything.",
    topics: [], decisions: [], unresolved_topics: [], resolved_topics: [], progress: [], suggested_next_opener: "",
    preferred_name: null, travel_goals: [], interests: [], goals: [], action_items: [], ideas: [], facts: [], preferences: [],
    candidate_confirmations: [], corrections: [], other_speakers_suspected: false, language: null, user_gender: null,
  };
}

export async function summarizeSession(llm: UtilityLlm | null, turns: SessionTurn[], ctx: {
  openTopics: string[]; known: { id: string; content: string }[]; candidates: { id: string; content: string }[];
}): Promise<SummaryResult> {
  if (!turns.some((t) => t.role === "user") || !llm) return fallbackSummary(turns);
  const prompt = SUMMARY_PROMPT
    .replace("{open_topics}", ctx.openTopics.map((t) => `- ${t}`).join("\n") || "- (none)")
    .replace("{known}", ctx.known.map((m) => `- ${m.id}: ${m.content}`).join("\n") || "- (none)")
    .replace("{candidates}", ctx.candidates.map((m) => `- ${m.id}: ${m.content}`).join("\n") || "- (none)")
    .replace("{transcript}", formatTranscript(turns));
  try {
    const r = await llm.json(prompt, { maxTokens: 2200, purpose: "summary" });
    if (!("summary" in r.obj)) throw new Error("summariser returned no summary");
    return { ...normalize(r.obj), llm: llm.name, ms: r.ms };
  } catch (e) {
    return { ...fallbackSummary(turns), error: String(e).slice(0, 300) };
  }
}
