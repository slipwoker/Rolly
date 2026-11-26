/**
 * System prompt + proactive opener, ported from memory/context.py build_context().
 * Divergences from the research version (recorded in docs/PHASE1_DECISIONS.md P1-D4):
 *  - the profile comes from PostgreSQL (MemoryView) instead of the SQLite store;
 *  - Phase 1 sections are appended: lead (bring content, never two questions in a row), addressing, other voices,
 *    memory control, onboarding / gaps, unconfirmed candidates (P1-D15 for "lead");
 *  - the opener does not use a name when none is known, and the first conversation gets an onboarding opener;
 *  - only ACTIVE memories are presented as facts; candidates are listed separately as "not confirmed".
 */
import { END_MARKER, LANG, VOICE_STYLE } from "./research.ts";
import {
  LEAD, MEMORY_CONTROL, ONBOARDING, OTHER_VOICES, addressingSection, onboardingGapsSection, type AddressingState,
} from "./phase1Sections.ts";

export type Lang = "he" | "en" | "auto";

export interface MemoryView {
  profile: {
    preferredName: string | null;
    preferredLanguage: "he" | "en" | null;
    professionalBackground?: string | null;
    interests: string[];
    travelGoals: string[];
    preferences: Record<string, string>;
    addressing: AddressingState;
  };
  facts: string[]; // active facts/preferences/goals worth knowing (not candidates)
  summaries: { content: string; createdAt: Date }[]; // most recent first
  openTopics: string[];
  actionItems: string[];
  progress: string[]; // recent "what we moved forward"
  candidates: { id: string; content: string }[]; // unconfirmed, NOT facts
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

function when(ts: Date, now: Date): string {
  const days = Math.floor((now.getTime() - ts.getTime()) / 86_400_000);
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
  profile: Record<string, unknown>;
}

export function buildContext(mem: MemoryView, opts: { language?: Lang | null; journey?: Journey; now?: Date; timeZone?: string;
  /** the connection dropped mid-conversation: the last turns of the cut-off session */
  resume?: { role: "user" | "agent"; text: string }[] }): BuiltContext {
  const p = mem.profile;
  let language: Lang = opts.language ?? p.preferredLanguage ?? "auto";
  if (!(language in LANG)) language = "auto";
  const journey = opts.journey ?? {};
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? "Asia/Jerusalem";
  const [langName, langRules] = LANG[language];
  const onboarding = mem.sessionCount === 0 && !opts.resume?.length;

  let style = VOICE_STYLE;
  for (const [k, v] of [["{language_name}", langName], ["{language_rules}", langRules], ["{end_marker}", END_MARKER]] as const) {
    style = style.split(k).join(v);
  }

  const sections: string[] = [];
  const addr = addressingSection(p.addressing, language);
  if (addr) sections.push(addr);
  sections.push(OTHER_VOICES, MEMORY_CONTROL);
  if (onboarding) sections.push(ONBOARDING);
  else {
    const gaps = onboardingGapsSection({ name: !p.preferredName, travelGoals: p.travelGoals.length === 0 });
    if (gaps) sections.push(gaps);
  }

  const lines: string[] = ["", "## About the user"];
  lines.push(`Name: ${p.preferredName ?? "not known yet"}`);
  if (p.professionalBackground) lines.push(`Professional background: ${p.professionalBackground}`);
  if (p.interests.length) lines.push("Personal interests: " + p.interests.join(", "));
  if (p.travelGoals.length) {
    lines.push("What they want from their travel time:");
    lines.push(...p.travelGoals.map((g) => `- ${g}`));
  }
  const prefs = Object.entries(p.preferences);
  if (prefs.length) lines.push("Conversation preferences: " + prefs.map(([k, v]) => `${k}: ${v}`).join("; "));
  if (mem.facts.length) {
    lines.push("Known facts:");
    lines.push(...mem.facts.map((f) => `- ${f}`));
  }

  lines.push("", "## Memory of previous conversations");
  if (mem.summaries.length) for (const s of mem.summaries) lines.push(`- (${when(s.createdAt, now)}) ${s.content}`);
  else lines.push("- This is the first conversation with this user.");
  if (mem.openTopics.length) { lines.push("Unresolved topics:"); lines.push(...mem.openTopics.map((t) => `- ${t}`)); }
  if (mem.actionItems.length) { lines.push("Open action items the user took on:"); lines.push(...mem.actionItems.map((a) => `- ${a}`)); }
  if (mem.progress.length) { lines.push("What you moved forward together recently:"); lines.push(...mem.progress.map((a) => `- ${a}`)); }
  if (mem.candidates.length) {
    lines.push("Not confirmed (possibly said by someone else; not facts; ask before relying on them):");
    lines.push(...mem.candidates.map((c) => `- ${c.content}`));
  }

  const minutes = journey.duration_min;
  const lt = localParts(now, tz);
  const partOfDay = lt.hour < 12 ? "morning" : lt.hour < 17 ? "afternoon" : "evening";
  lines.push("", "## Current journey");
  lines.push(`Local time: ${lt.weekday} ${lt.hm} (${partOfDay}).`);
  if (minutes) lines.push(`Estimated time until arrival: about ${Math.round(minutes)} minutes. Pace the conversation to fit.`);
  if (journey.origin || journey.destination) lines.push(`Route: ${journey.origin ?? "?"} to ${journey.destination ?? "?"}.`);
  if (journey.mode) lines.push(`Travel mode: ${journey.mode}.`);

  if (opts.resume?.length) {
    lines.push("", "## The conversation so far (the connection dropped a moment ago)");
    lines.push(...opts.resume.map((t) => `${t.role === "user" ? "USER" : "YOU"}: ${t.text}`));
  }

  // LEAD goes last: the conversation model (a small MoE) weighs the end of a long system prompt most (P1-D15, round 2)
  const system_prompt = style.trimEnd() + "\n\n" + sections.join("\n\n") + "\n" + lines.join("\n") + "\n\n" + LEAD + "\n";

  let opener: string | null = null;
  if (journey.proactive ?? true) {
    const hasName = Boolean(p.preferredName);
    const tag = "[journey_start event - this is not something the user said] ";
    if (opts.resume?.length) {
      opener = tag + "The connection dropped a moment ago in the middle of the conversation shown above and is back now. "
        + "Pick it up in one short sentence, the way a friend would after a call drops (\"sorry, lost you for a second — you were saying?\" "
        + "or continue the last point). Do not greet again and do not explain what happened.";
    } else if (onboarding) {
      opener = tag + "This is your very first conversation with this user and you know nothing about them yet. "
        + `Open it yourself, right now, like a friendly person meeting someone for the first ride together: a casual hello for the ${partOfDay}, `
        + "and one light, specific question that starts getting to know them (for example what they usually do with their time on the road, or simply their name). "
        + "Two short sentences, under twenty-five words. Do not introduce yourself at length, do not explain what you can do, do not list options.";
    } else if (!mem.summaries.length && !mem.openTopics.length) {
      const knowsSomething = p.interests.length > 0 || p.travelGoals.length > 0 || mem.facts.length > 0;
      opener = tag + "The user has just started a journey. Open the conversation yourself the way a friend would, in two short sentences: "
        + `a casual hello${hasName ? " using their name" : ""}, and `
        + (knowsSomething
          ? "one specific remark or question about something connected to their goals or interests."
          : "one light, concrete topic you bring up yourself, said as a statement rather than a question.");
    } else {
      opener = tag + `The user has just started a journey${minutes ? ` of about ${Math.round(minutes)} minutes` : ""}. `
        + "Open the conversation yourself, right now, the way a friend does when you get in the car: "
        + `a casual hello for the ${partOfDay}${hasName ? " using their name" : ""}, then one specific question about the single most relevant `
        + "unresolved thing from your memory (name what was actually discussed, as in 'so, what happened with ...?'). "
        + "Two short sentences, under twenty-five words in total. Do not mention how long the journey is, do not list options, "
        + "and do not announce what you are going to talk about.";
    }
    if (language === "auto") {
      const pref = p.preferredLanguage === "he" ? "Hebrew" : p.preferredLanguage === "en" ? "English" : "Hebrew";
      opener += ` Speak this opening in ${pref}${p.preferredLanguage ? ", the user's preferred language" : ""}.`;
    }
  }

  return {
    system_prompt, opener_instruction: opener, language, onboarding,
    // the pod gets only what the pipeline needs; it stores nothing
    profile: { name: p.preferredName ?? null, preferred_language: p.preferredLanguage ?? null },
  };
}

export function emptyMemory(): MemoryView {
  return {
    profile: { preferredName: null, preferredLanguage: null, interests: [], travelGoals: [], preferences: {}, addressing: { value: null, status: "unknown" } },
    facts: [], summaries: [], openTopics: [], actionItems: [], progress: [], candidates: [], sessionCount: 0,
  };
}
