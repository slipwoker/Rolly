/**
 * Which memories go into the prompt. Not "the newest N": that drops what matters most about a person as soon as a few
 * small things are learned after it. Each item gets a score from how important it is, how recently it came up, whether
 * the user confirmed it, and whether it has not been shown to the model for a while (so older things resurface), and
 * the best ones are taken within a fixed budget, because a longer prompt makes every reply slower.
 */
export interface Selectable {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt?: Date | null;
  importance?: number | null; // 1..3
  lastUsedAt?: Date | null;
  confirmed?: boolean;
}

const DAY = 86_400_000;
export const RECENCY_HALF_LIFE_DAYS = 30;
export const REST_DAYS = 14;

export function score(m: Selectable, now: Date): number {
  const last = Math.max(m.createdAt.getTime(), m.updatedAt?.getTime() ?? 0);
  const ageDays = Math.max(0, (now.getTime() - last) / DAY);
  const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS); // 1 now, 0.5 after a month
  const importance = Math.min(3, Math.max(1, m.importance ?? 2)) / 3; // 0.33 .. 1
  const rested = !m.lastUsedAt || (now.getTime() - m.lastUsedAt.getTime()) / DAY >= REST_DAYS ? 0.15 : 0;
  return importance * 1.2 + recency + (m.confirmed ? 0.2 : 0) + rested;
}

/** The best items within the budget, returned newest first (stable for the model's prompt cache between sessions). */
export function selectWithinBudget<T extends Selectable>(items: T[], budget: { maxItems: number; maxChars: number }, now = new Date()): T[] {
  const ranked = [...items].sort((a, b) => score(b, now) - score(a, now) || b.createdAt.getTime() - a.createdAt.getTime());
  const out: T[] = [];
  let chars = 0;
  for (const m of ranked) {
    if (out.length >= budget.maxItems) break;
    if (chars + m.content.length > budget.maxChars) continue; // a long item must not block shorter ones behind it
    out.push(m);
    chars += m.content.length;
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Words of a text without punctuation and niqqud, lower-cased (for comparing two statements). */
export function words(text: string): string[] {
  return text.toLowerCase().replace(/[\u0591-\u05C7]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * Two short statements say the same thing: equal after punctuation is ignored, or nearly all words shared. Used so that
 * a task saved during the ride ("להתקשר לרואה החשבון מחר בבוקר") is not added again when the summary extracts it with a
 * full stop or a word more. Deliberately strict: "works at a bank" and "works at Bank Leumi" stay two items.
 */
export function sameStatement(a: string, b: string, minShare = 0.8): boolean {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return false;
  if (wa.join(" ") === wb.join(" ")) return true;
  const sa = new Set(wa), sb = new Set(wb);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return Math.min(sa.size, sb.size) >= 3 && shared / Math.max(sa.size, sb.size) >= minShare;
}

/**
 * Budgets of the memory part of the system prompt, in characters (Hebrew is roughly two to three characters per token).
 * The fixed instructions are about 2,300 tokens; with these budgets and the clips in promptBuilder.ts the memory part
 * (plan for the ride included) stays under about 2,700 more, so the whole prompt is at most ~5,000 tokens of the model's
 * 16k window. The pod caches the prompt within a conversation, so its length is paid once, on the opener.
 */
export const BUDGET = {
  facts: { maxItems: 10, maxChars: 700 },
  interests: { maxItems: 8, maxChars: 250 },
  preferences: { maxItems: 5, maxChars: 300 },
  openTopics: { maxItems: 5, maxChars: 350 },
  tasks: { maxItems: 6, maxChars: 400 },
  ideas: { maxItems: 4, maxChars: 250 },
  goals: { maxItems: 4, maxChars: 1500 },
} as const;

/** Longest text of each kind that the prompt builder lets through (longer text is cut at a word boundary). */
export const CLIP = { summary: 300, digest: 400, historyDigest: 450, goalState: 160, goalNext: 90, candidates: 3, progress: 3 } as const;

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}
