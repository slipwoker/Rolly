/**
 * Looking something up online in the middle of a conversation (P1-D34).
 *
 * The conversation model on the pod cannot browse. When it needs a current or exact fact it says "checking" and marks
 * its reply with LOOKUP_MARKER; the pod reports that (session.lookup_requested), the voice session calls webLookup()
 * here, and the answer is handed back to the model as a marked message it then says in its own words.
 *
 * The search itself is the utility model with the provider's web search tool (UtilityLlm.search). What leaves the
 * system: the question and the last few turns, never the user's name or anything from memory.
 */
import type { UtilityLlm } from "../memory/llm.ts";

export { LOOKUP_MARKER } from "../persona/core.ts";

export const LOOKUP_PROMPT = `You are the research step of a voice companion that rides along with someone in a car. They asked it something
that needs current or exact information. Search the web and answer.

Rules for the answer:
- {language}, at most two short sentences that can be said aloud: the concrete facts (numbers, times, names, places).
- No links, no lists, no markdown, no "according to", no advice they did not ask for.
- Temperatures in Celsius, distances in kilometres, prices in the local currency of the place asked about.
- If the question does not say where or when, assume the user is in {country} and means now ({now}).
- If you cannot find it, say in one sentence what you did find, or that you found nothing.

The conversation so far:
{recent}

What to find out: {question}
`;

export interface LookupArgs { question: string; recent: { role: "user" | "agent"; text: string }[]; language: string; timeZone: string; now?: Date; country?: string }
export type LookupResult = { ok: true; answer: string; ms: number; searches: number } | { ok: false; reason: "unavailable" | "failed" | "limit"; ms: number; error?: string };

export function lookupPrompt(a: LookupArgs): string {
  const now = a.now ?? new Date();
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: a.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(now);
  return LOOKUP_PROMPT
    .replace("{language}", a.language === "en" ? "In English" : "In everyday spoken Hebrew, without niqqud")
    .replace("{country}", a.country ?? "Israel")
    .replace("{now}", `${when}, ${a.timeZone}`)
    .replace("{recent}", a.recent.slice(-6).map((t) => `${t.role === "agent" ? "COMPANION" : "USER"}: ${t.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(nothing yet)")
    .replace("{question}", a.question.replace(/\s+/g, " ").slice(0, 400));
}

/** One lookup. Never throws: a failure is a result the conversation can say ("the check did not work"). */
export async function webLookup(llm: UtilityLlm | null, a: LookupArgs): Promise<LookupResult> {
  const t0 = Date.now();
  if (!llm?.search) return { ok: false, reason: "unavailable", ms: 0 };
  try {
    // the token limit also covers the model's own reasoning: 500 cut an answer in the middle of a word
    const r = await llm.search(lookupPrompt(a), { maxTokens: 1200, timeoutMs: 12_000, timezone: a.timeZone });
    // spoken text only: no links, no markdown, no citation marks
    const answer = r.text.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[([]\s*[)\]]/g, " ").replace(/[*_#`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!answer) return { ok: false, reason: "failed", ms: Date.now() - t0, error: "empty answer" };
    return { ok: true, answer, ms: r.ms, searches: r.searches };
  } catch (e) {
    return { ok: false, reason: "failed", ms: Date.now() - t0, error: String(e).slice(0, 200) };
  }
}

/** What the conversation model is given once the lookup is back (sent as a marked message, never shown or stored as the user's). */
export const LOOKUP_TAG = "[lookup_result - not said by the user]";
export const LOOKUP_FAILED_TAG = "[lookup_failed - not said by the user]";
export function lookupMessage(r: LookupResult): string {
  if (r.ok) return `${LOOKUP_TAG} You checked online. What you found: ${r.answer}\nTell them now, in one or two short sentences, in your own words. Only what is written here; if it does not answer what they asked, say what you did find.`;
  if (r.reason === "limit") return `${LOOKUP_FAILED_TAG} You have used up today's online checks. Say so in a few words and go on with the conversation.`;
  return `${LOOKUP_FAILED_TAG} The online check did not work just now. Say so in a few words, do not guess the answer, and go on with the conversation.`;
}
