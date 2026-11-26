/**
 * Keeping long-term memory compact as it grows:
 *  - `digest`: a short portrait of the user (who they are, what matters to them now), rewritten from the ACTIVE memories;
 *  - `history_digest`: conversation summaries older than the three most recent, folded into one paragraph, so the model
 *    still knows what happened a month ago without every old summary in the prompt.
 * Both are derived text: they are rebuilt from what is currently remembered, never from candidates, and the scrub pass
 * (scrub.ts) rewrites them when the user asks to forget something. Runs after a conversation, never during one.
 */
import type { UtilityLlm } from "./llm.ts";
import type { MemoryStore } from "./store.ts";

export const DIGEST_MIN_MEMORIES = 6; // below this the plain list is short enough: no digest
export const KEEP_SUMMARIES = 3; // the newest summaries stay verbatim in the prompt

export const CONSOLIDATE_PROMPT = `You keep the long-term notes of a voice companion about the one person it talks with.
Return ONLY a JSON object with:
  "digest": a short portrait of this person for the companion, at most {digest_words} words, in {language}: who they are, what they care about and are working towards right now, and how they like to talk. Only from the confirmed notes below. No lists, no dates, nothing speculative.
  "history_digest": one paragraph, at most {history_words} words, in {language}, that folds the earlier conversations below into what is still worth knowing (what was discussed, decided and left open). Use null if there are no earlier conversations.
Write about the person in the third person without guessing their gender: use their name or neutral wording.

Confirmed notes about the person:
{notes}

Earlier conversations (oldest first){previous}:
{history}
`;

export async function consolidate(store: MemoryStore, llm: UtilityLlm | null, userId: string): Promise<{ digest: boolean; history: boolean; skipped?: string }> {
  if (!llm) return { digest: false, history: false, skipped: "no_llm" };
  if ((await store.scrubQueue(userId)).length) return { digest: false, history: false, skipped: "scrub_pending" };
  const p = await store.profile(userId);
  const personal = await store.memories(userId, { status: ["active"], kinds: ["name", "fact", "preference", "interest", "goal", "travel_goal"], limit: 120 });
  const summaries = await store.memories(userId, { status: ["active"], kinds: ["summary"], limit: 60 }); // newest first
  const older = summaries.slice(KEEP_SUMMARIES).reverse();
  // only summaries not yet folded in (profiles.digest_at = creation time of the newest one that was)
  const fresh = p.digest_at ? older.filter((s) => s.created_at > p.digest_at!) : older;
  const needDigest = personal.length >= DIGEST_MIN_MEMORIES;
  const needHistory = fresh.length > 0;
  if (!needDigest && !needHistory) return { digest: false, history: false, skipped: "nothing_to_do" };
  const language = p.preferred_language === "en" ? "English" : "Hebrew";
  const prompt = CONSOLIDATE_PROMPT
    .replaceAll("{language}", language).replace("{digest_words}", "110").replace("{history_words}", "130")
    .replace("{notes}", personal.map((m) => `- [${m.kind}] ${m.content}`).join("\n") || "- (none)")
    .replace("{previous}", p.history_digest ? `; what was already folded in: "${p.history_digest}"` : "")
    .replace("{history}", fresh.map((s) => `- ${s.content}`).join("\n") || "- (none)");
  const r = await llm.json(prompt, { maxTokens: 700 });
  const digest = needDigest && typeof r.obj.digest === "string" ? r.obj.digest.trim().slice(0, 900) : null;
  const history = needHistory && typeof r.obj.history_digest === "string" ? r.obj.history_digest.trim().slice(0, 1100) : null;
  // a forget request may have arrived while the model was working: do not write text that could contain it
  if ((await store.scrubQueue(userId)).length) return { digest: false, history: false, skipped: "scrub_pending" };
  await store.saveDigests(userId, { digest, history_digest: history, historyThrough: fresh.at(-1)?.created_at ?? null });
  return { digest: !!digest, history: !!history };
}
