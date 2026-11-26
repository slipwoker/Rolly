/**
 * After a conversation, a second utility-LLM call (separate from the summary, so neither grows unwieldy) that looks ahead:
 *  - how each tracked goal stands now, and its next step;
 *  - which open tasks the user said they have done;
 *  - what the plan for the previous ride came to;
 *  - the plan (agenda) for the next ride.
 * It runs after the summary has been sent to the phone, so it never delays the end of a conversation, and the next ride
 * starts from a stored plan instead of waiting for a model at session start.
 */
import type { SessionTurn } from "../voice/session.ts";
import type { UtilityLlm } from "./llm.ts";
import { formatTranscript } from "./summarizer.ts";

export type GoalStatus = "active" | "paused" | "achieved" | "dropped";
export type AgendaKind = "follow_up" | "goal_step" | "action_check" | "fresh";

/** `take`: Rolly's own opinion or angle on the topic, written by the stronger model so the small one has something real to say */
export interface AgendaItem { topic: string; why: string; kind: AgendaKind; ref_id: string | null; take?: string }
/** `opened_with`: the topic that opened the ride this plan was made after, when the user did not take it up */
export interface StoredAgenda { created_at: string; session_id: string | null; items: AgendaItem[]; opened_with?: string | null }

export interface GoalUpdate {
  goal_id: string; state_note: string | null; next_step: string | null;
  status: GoalStatus | null; status_turn: number | null; status_quote: string;
  /** indexes into this conversation's "moved forward" list (from the summary) that belong to this goal */
  progress: number[];
}

export interface PlanResult {
  method: "llm" | "none";
  goal_updates: GoalUpdate[];
  completed_action_items: { id: string; turn: number | null; quote: string }[];
  agenda_outcome: { index: number; outcome: "done" | "touched" | "skipped" }[];
  next_agenda: AgendaItem[];
  error?: string;
  ms?: number;
}

export const PLAN_PROMPT = `You keep the long-term notes of a voice companion called Rolly, which talks with one person (the user) while they travel.
A conversation has just ended. Using its transcript and summary, update what Rolly tracks and plan the next ride.
Speech was recognised automatically and nobody can tell who was speaking; lines marked "USER?" may be someone else in the car.

Return ONLY a JSON object with these keys:
  "goal_updates": for each goal from the list below that this conversation actually touched:
      {"goal_id": "<id>", "state_note": "<where this stands now, one or two sentences>", "next_step": "<the next concrete step, or null>",
       "status": null | "paused" | "achieved" | "dropped", "status_turn": <turn number> | null, "status_quote": "<the user's exact words>",
       "progress": [<indexes from the "moved forward" list below that belong to this goal>]}
      Set "status" only when the USER clearly said so about themselves (they reached it, gave it up, or put it on hold); otherwise null.
      Leave out goals the conversation did not touch.
  "completed_action_items": [{"id": "<id from the open tasks>", "turn": <turn number>, "quote": "<the user's exact words>"}] for tasks the USER said they have done or no longer need.
  "agenda_outcome": [{"index": <number from the plan for this ride>, "outcome": "done" | "touched" | "skipped"}]
  "next_agenda": two or three things for Rolly to bring up on the NEXT ride, most valuable first:
      {"topic": "<short, concrete>", "take": "<Rolly's own opinion or angle on it, one sentence a friend would say>", "why": "<one short sentence: why it is worth the user's time>", "kind": "follow_up" | "goal_step" | "action_check" | "fresh", "ref_id": "<id of the goal or task it is about, or null>"}
      follow_up = continue something left open in this conversation; goal_step = the next step of a goal; action_check = ask
      whether an open task got done; fresh = something new and interesting connected to what the user cares about.
      Prefer what the user showed energy for. At most one action_check. Not skipped plan items the user clearly was not interested in.
      Always include one "fresh" item that is light: a small debate, an odd observation or a playful question connected to what the user cares about.
      "take" is what gives Rolly something real to say: a clear stance ("better one small investor who believes than months chasing a big fund"), a concrete angle, or a side in a small debate. Opinions and angles, not facts: state a fact only if it is certainly true. No general wisdom about life, nothing that starts with "sometimes". Leave "take" empty for an action_check.
      Write "topic" as a short noun phrase about the thing itself ("רשימת עשרה לקוחות", "השיחה עם רואה החשבון"), never addressed to the user and without verbs in the second person.
Write every text in the language the user mostly spoke ({language}). Do not invent anything that is not supported by the transcript, the summary or the lists.

Goals (id: goal — how it stood before this conversation):
{goals}

Open tasks the user took on (id: task):
{tasks}

The plan Rolly had for this ride (index: topic):
{agenda}

Summary of this conversation:
{summary}

What this conversation moved forward (index: text):
{progress}

Transcript (turn number, speaker, words):
{transcript}
`;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Record<string, unknown>[] : []);
const KINDS: AgendaKind[] = ["follow_up", "goal_step", "action_check", "fresh"];
const STATUSES: GoalStatus[] = ["active", "paused", "achieved", "dropped"];

export function normalizeAgendaItems(v: unknown, validRefs?: Set<string>): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const o of arr(v)) {
    const topic = str(o.topic);
    if (!topic) continue;
    const ref = str(o.ref_id);
    out.push({
      topic: topic.slice(0, 200), why: str(o.why).slice(0, 240), ...(str(o.take) ? { take: str(o.take).slice(0, 220) } : {}),
      kind: KINDS.includes(o.kind as AgendaKind) ? (o.kind as AgendaKind) : "fresh",
      ref_id: ref && (!validRefs || validRefs.has(ref)) ? ref : null,
    });
  }
  // at most one "did you do it?" per ride
  let checks = 0;
  return out.filter((i) => i.kind !== "action_check" || ++checks <= 1).slice(0, 3);
}

export function normalizePlan(obj: Record<string, unknown>, ids: { goals: Set<string>; tasks: Set<string> }): PlanResult {
  return {
    method: "llm",
    goal_updates: arr(obj.goal_updates).filter((g) => ids.goals.has(str(g.goal_id))).map((g) => ({
      goal_id: str(g.goal_id), state_note: str(g.state_note).slice(0, 400) || null, next_step: str(g.next_step).slice(0, 240) || null,
      status: STATUSES.includes(g.status as GoalStatus) ? (g.status as GoalStatus) : null, status_turn: num(g.status_turn), status_quote: str(g.status_quote),
      progress: (Array.isArray(g.progress) ? g.progress : []).map(num).filter((n): n is number => n !== null && n >= 0 && Number.isInteger(n)).slice(0, 5),
    })),
    completed_action_items: arr(obj.completed_action_items).filter((c) => ids.tasks.has(str(c.id)))
      .map((c) => ({ id: str(c.id), turn: num(c.turn), quote: str(c.quote) })),
    agenda_outcome: arr(obj.agenda_outcome).map((a) => ({ index: num(a.index) ?? -1, outcome: a.outcome === "done" ? "done" as const : a.outcome === "touched" ? "touched" as const : "skipped" as const }))
      .filter((a) => a.index >= 0),
    next_agenda: normalizeAgendaItems(obj.next_agenda, new Set([...ids.goals, ...ids.tasks])),
  };
}

export const emptyPlan = (): PlanResult => ({ method: "none", goal_updates: [], completed_action_items: [], agenda_outcome: [], next_agenda: [] });

export async function planNext(llm: UtilityLlm | null, turns: SessionTurn[], ctx: {
  summary: string; language: string | null; progress: string[];
  goals: { id: string; content: string; state: string | null }[];
  tasks: { id: string; content: string }[];
  agenda: AgendaItem[];
}): Promise<PlanResult> {
  if (!llm || !turns.some((t) => t.role === "user")) return emptyPlan();
  const prompt = PLAN_PROMPT
    .replace("{language}", ctx.language === "en" ? "English" : "Hebrew")
    .replace("{goals}", ctx.goals.map((g) => `- ${g.id}: ${g.content} — ${g.state ?? "no notes yet"}`).join("\n") || "- (none)")
    .replace("{tasks}", ctx.tasks.map((t) => `- ${t.id}: ${t.content}`).join("\n") || "- (none)")
    .replace("{agenda}", ctx.agenda.map((a, i) => `- ${i}: ${a.topic}`).join("\n") || "- (no plan)")
    .replace("{summary}", ctx.summary || "(none)")
    .replace("{progress}", ctx.progress.map((p, i) => `- ${i}: ${p}`).join("\n") || "- (nothing)")
    .replace("{transcript}", formatTranscript(turns));
  try {
    const r = await llm.json(prompt, { maxTokens: 1400 });
    return { ...normalizePlan(r.obj, { goals: new Set(ctx.goals.map((g) => g.id)), tasks: new Set(ctx.tasks.map((t) => t.id)) }), ms: r.ms };
  } catch (e) {
    return { ...emptyPlan(), error: String(e).slice(0, 300) };
  }
}

/** A plan without a model (utility LLM unavailable or its answer unusable): the newest open topic, a goal's next step, one open task. */
export function fallbackAgenda(view: {
  openTopics: string[]; goals: { id: string; content: string; nextStep: string | null; status: GoalStatus }[]; tasks: { id: string; content: string }[];
}): AgendaItem[] {
  const items: AgendaItem[] = [];
  if (view.openTopics[0]) items.push({ topic: view.openTopics[0], why: "", kind: "follow_up", ref_id: null });
  const g = view.goals.find((x) => x.status === "active" && x.nextStep) ?? view.goals.find((x) => x.status === "active");
  if (g) items.push({ topic: g.nextStep ? `${g.content}: ${g.nextStep}` : g.content, why: "", kind: "goal_step", ref_id: g.id });
  const t = view.tasks.at(-1);
  if (t) items.push({ topic: t.content, why: "", kind: "action_check", ref_id: t.id });
  return items.slice(0, 3);
}

/**
 * The plan for THIS ride, from the stored plan: fewer items for a short ride, and after a long gap the "we were just
 * talking about..." items lose their place to goals and fresh topics. Pure, so it costs nothing at session start.
 */
export function adaptAgenda(stored: StoredAgenda | null, opts: { minutes?: number | null; now?: Date; validRefs?: Set<string> }): AgendaItem[] {
  if (!stored?.items?.length) return [];
  const now = opts.now ?? new Date();
  const days = (now.getTime() - new Date(stored.created_at).getTime()) / 86_400_000;
  let items = stored.items.filter((i) => !i.ref_id || !opts.validRefs || opts.validRefs.has(i.ref_id));
  // what opened the last ride and was not taken up does not open this one too (four rides in a row began with the same question)
  if (stored.opened_with && items.length > 1 && items[0]!.topic === stored.opened_with) items = [...items.slice(1), items[0]!];
  if (days > 7) items = [...items.filter((i) => i.kind !== "follow_up"), ...items.filter((i) => i.kind === "follow_up")];
  if (days > 30) items = items.filter((i) => i.kind !== "follow_up" && i.kind !== "action_check");
  const m = opts.minutes ?? null;
  const n = m === null ? 3 : m <= 12 ? 1 : m <= 25 ? 2 : 3;
  return items.slice(0, n);
}
