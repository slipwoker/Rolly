/**
 * The system prompt and the opener for one conversation: the short persona (core.ts) plus a small, capped block of what
 * Rolly knows about the user. Everything else reaches the model as a note on the turn it applies to (P1-D24):
 * the plan for the ride (one item at a time, voice/planFeeder.ts), pacing, the style guard, "ask whether to remember X".
 *
 * The whole prompt has a hard budget (test/persona.test.ts): the conversation model is small, and a long prompt made it
 * follow the rules weakly and sound like a bot.
 */
import { END_MARKER, FIRST_RIDE, addressingLine, core } from "./core.ts";
import type { AddressingState } from "./phase1Sections.ts";
import { adaptAgenda, type AgendaItem, type GoalStatus, type StoredAgenda } from "../memory/plan.ts";
import { PROMPT, clip } from "../memory/select.ts";

export { END_MARKER };
export type Lang = "he" | "en" | "auto";

/** how the user said their name is pronounced: one of the readings the voice's own front end gave (P1-D39) */
export interface NamePron { name: string; ipa: string; source: "user" }

export interface MemoryView {
  profile: {
    preferredName: string | null;
    namePron?: NamePron | null;
    preferredLanguage: "he" | "en" | null;
    professionalBackground?: string | null;
    interests: string[];
    travelGoals: string[];
    preferences: Record<string, string>;
    addressing: AddressingState;
  };
  /** active and paused goals (wider goals and travel-time goals) with how they stand */
  goals: { id: string; kind: "goal" | "travel_goal"; content: string; status: GoalStatus; stateNote: string | null; nextStep: string | null }[];
  facts: string[]; // active facts worth knowing (not candidates)
  summaries: { content: string; createdAt: Date }[]; // most recent first
  openTopics: string[];
  tasks: { id: string; content: string; createdAt: Date }[]; // open tasks the user took on or asked to note
  ideas: string[];
  progress: string[]; // recent "what we moved forward"
  candidates: { id: string; content: string }[]; // unconfirmed, NOT facts
  digest: string | null; // who this person is and what matters to them now
  historyDigest: string | null; // older conversations folded into one paragraph
  agenda: StoredAgenda | null; // the plan made after the previous conversation
  /** how Rolly opened the previous ride (its first words), so the next opening is not the same */
  lastOpener: string | null;
  sessionCount: number; // completed sessions with at least one user turn
}

/**
 * The language of a conversation, which decides which speech recogniser listens: the user's own choice when they made
 * one, else the language of their profile, else Hebrew. A value the app merely defaulted to (no `language_explicit`) is
 * ignored: an English-language iPhone had Hebrew speech "recognised" by the English model (2026-11-26).
 */
export function resolveLanguage(start: { language?: Lang | null; language_explicit?: boolean }, preferred: "he" | "en" | null): { language: Lang; chosen: Lang | null } {
  const chosen = start.language_explicit === true && start.language && ["he", "en", "auto"].includes(start.language) ? start.language : null;
  return { language: chosen ?? preferred ?? "he", chosen };
}

export interface Journey { duration_min?: number; origin?: string; destination?: string; mode?: string; proactive?: boolean }

/** calendar days in the user's time zone: last night's ride is "yesterday", not "earlier today" */
function when(ts: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) + "T00:00:00Z");
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** local time parts in the user's time zone (the pod and Render run in UTC) */
function localParts(now: Date, timeZone: string): { weekday: string; hm: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return { weekday: parts.weekday!, hm: `${String(hour).padStart(2, "0")}:${parts.minute}`, hour };
}

export interface BuiltContext {
  system_prompt: string;
  opener_instruction: string | null;
  language: Lang;
  onboarding: boolean;
  /** the plan for this ride: item 0 is in the opener, the rest are fed by notes while the ride runs */
  agenda: AgendaItem[];
  /** something unconfirmed worth asking about once during this ride (sent as a note, never in the prompt) */
  confirm: string | null;
  profile: Record<string, unknown>;
}

/** as many whole items as fit in `maxChars` */
function fit(items: string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  let n = 0;
  for (const it of items.slice(0, maxItems)) {
    if (n + it.length > maxChars) break;
    out.push(it);
    n += it.length;
  }
  return out;
}

export function buildContext(mem: MemoryView, opts: { language?: Lang | null; journey?: Journey; now?: Date; timeZone?: string;
  /** the connection dropped mid-conversation: the last turns of the cut-off session */
  resume?: { role: "user" | "agent"; text: string }[];
  /** online lookups are connected (config and key): the persona then tells the model how to ask for one */
  lookup?: boolean;
  /** which tools beyond web search the same marker reaches (integrations/tools.ts) */
  tools?: { calendar?: boolean; music?: boolean };
  /** this user has WhatsApp linked (whatsapp/flow.ts) */
  whatsapp?: boolean }): BuiltContext {
  const p = mem.profile;
  let language: Lang = opts.language ?? p.preferredLanguage ?? "he";
  if (!["he", "en", "auto"].includes(language)) language = "he";
  const journey = opts.journey ?? {};
  const now = opts.now ?? new Date();
  const lt = localParts(now, opts.timeZone ?? "Asia/Jerusalem");
  const partOfDay = lt.hour < 12 ? "morning" : lt.hour < 17 ? "afternoon" : "evening";
  const minutes = journey.duration_min;
  const onboarding = mem.sessionCount === 0 && !opts.resume?.length;
  const addressing = addressingLine(p.addressing, language);

  const lines: string[] = [];
  if (onboarding) {
    lines.push(FIRST_RIDE);
    if (addressing) lines.push(addressing);
  } else {
    lines.push("## What you know about them");
    lines.push(`Their name: ${p.preferredName ?? "not known yet"} (you are Rolly).${addressing ? " " + addressing : ""}`);
    if (mem.digest) lines.push(clip(mem.digest, PROMPT.digest));
    else {
      lines.push(...fit(mem.facts, PROMPT.facts, PROMPT.factsChars));
      const interests = fit(p.interests, 4, PROMPT.interestsChars);
      if (interests.length) lines.push("Interests: " + interests.join(", "));
    }
    const prefs = fit(Object.values(p.preferences).map((v) => clip(v, 110)), PROMPT.prefs, PROMPT.prefsChars);
    if (prefs.length) lines.push("How they want you to talk: " + prefs.map((v) => v.replace(/[.;]+$/, "")).join("; ") + ".");
    for (const g of mem.goals.slice(0, PROMPT.goals)) {
      lines.push(`A goal of theirs: ${clip(g.content, 90).replace(/[.]+$/, "")}${g.status === "paused" ? " (on hold: do not push it)" : ""}.`
        + (g.stateNote ? ` Where it stands: ${clip(g.stateNote, PROMPT.goalState)}` : "")
        + (g.nextStep && g.status !== "paused" ? ` Next step: ${clip(g.nextStep, PROMPT.goalNext)}` : ""));
    }
    const tasks = fit(mem.tasks.map((t) => clip(t.content, 80)), PROMPT.tasks, PROMPT.tasksChars);
    if (tasks.length) lines.push("Open tasks they asked you to keep: " + tasks.map((t) => t.replace(/[.;]+$/, "")).join("; ") + ".");
    const last = mem.summaries[0];
    if (last) lines.push(`Last time (${when(last.createdAt, now, opts.timeZone ?? "Asia/Jerusalem")}): ${clip(last.content, PROMPT.summary)}`);
  }
  if (opts.resume?.length) {
    lines.push("", "## The conversation so far (the connection dropped a moment ago)");
    lines.push(...opts.resume.slice(-6).map((t) => `${t.role === "user" ? "THEM" : "YOU"}: ${clip(t.text, 140)}`));
  }
  lines.push("", `Local time: ${lt.weekday} ${lt.hm} (${partOfDay}).${minutes ? ` About ${Math.round(minutes)} minutes until they arrive.` : ""}`);

  const system_prompt = core(language, { lookup: opts.lookup, tools: opts.tools, whatsapp: opts.whatsapp }) + "\n\n" + lines.join("\n") + "\n";

  // the plan for this ride: made after the previous conversation, cut to the time there is now
  const agenda = onboarding || opts.resume?.length ? [] : adaptAgenda(mem.agenda, { minutes: minutes ?? null, now });

  let opener: string | null = null;
  if (journey.proactive ?? true) {
    const tag = "[journey_start - not said by the user] ";
    const hello = `a short hello for the ${partOfDay}${p.preferredName ? " using their name" : ""}`;
    if (opts.resume?.length) {
      opener = tag + "The connection dropped a moment ago and is back. Pick the conversation up in one short sentence, the way a friend would after a call drops. No greeting, no explanation.";
    } else if (onboarding) {
      opener = tag + `The first ride together has just started. Open now: a short hello for the ${partOfDay} and one light, specific question (their name, or what this drive is for). Under fifteen words, nothing about yourself.`;
    } else if (agenda[0] || mem.summaries.length) {
      // An easy start (P1-D35): a greeting and one light question about them. The plan's first item is NOT here: it comes
      // after their first short answer (voice/planFeeder.ts). Opening straight on a topic felt like the start of a task.
      const last = mem.lastOpener ? ` Your last opening was "${clip(mem.lastOpener, 100)}": open differently this time.` : "";
      opener = tag + `The ride has just started. Open now: ${hello}, and one easy, light question about them: how their morning or day is going, or how the ride is starting. Do not bring up anything from before, nothing about yourself. Under twelve words in total.${last}`;
    } else {
      // nothing to pick up (first rides, or they cleared their memory): a question about them. "Something you bring up
      // yourself" made the small model invent a life of its own ("אני ממש רעב… המזגן הזה", 2026-11-26).
      opener = tag + `The ride has just started. Open now: ${hello}, then one light, specific question about them: where this drive is going or what is waiting for them today. Under fifteen words in total, nothing about yourself.`;
    }
    if (language === "auto") opener += ` Speak this opening in ${p.preferredLanguage === "en" ? "English" : "Hebrew"}.`;
  }

  return {
    system_prompt, opener_instruction: opener, language, onboarding, agenda,
    confirm: !onboarding && mem.candidates[0] ? clip(mem.candidates[0].content, 140) : null,
    // the pod gets only what the pipeline needs; it stores nothing
    profile: { name: p.preferredName ?? null, preferred_language: p.preferredLanguage ?? null, name_pron: p.namePron ?? null },
  };
}

/**
 * The language the user is practising, when one of their goals or interests names it. The pod's voice then pronounces
 * unclear foreign phrases in that language (clear ones are recognised on the pod). Only what the voice model speaks.
 */
const PRACTICE: [RegExp, "es" | "it" | "de"][] = [[/ספרדית|spanish/i, "es"], [/איטלקית|italian/i, "it"], [/גרמנית|german/i, "de"]];
export function practiceLanguage(mem: MemoryView): "es" | "it" | "de" | null {
  const texts = [...mem.goals.filter((g) => g.status === "active").map((g) => g.content), ...mem.profile.travelGoals, ...mem.profile.interests];
  for (const t of texts) for (const [re, lang] of PRACTICE) if (re.test(t)) return lang;
  return null;
}

export function emptyMemory(): MemoryView {
  return {
    profile: { preferredName: null, preferredLanguage: null, interests: [], travelGoals: [], preferences: {}, addressing: { value: null, status: "unknown" } },
    goals: [], facts: [], summaries: [], openTopics: [], tasks: [], ideas: [], progress: [], candidates: [],
    digest: null, historyDigest: null, agenda: null, lastOpener: null, sessionCount: 0,
  };
}
