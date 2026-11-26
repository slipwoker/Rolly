/**
 * "Forget that" must also reach text DERIVED from the forgotten fact: conversation summaries, open topics, progress notes,
 * goal notes, the long-term digests and the plan for the next ride. Deleting the memory row alone would let the fact come
 * back into the next prompt through a summary.
 *
 * deleteMemory / correctMemory put the forgotten content into scrub_queue. This pass asks the utility LLM which derived
 * texts mention it and rewrites those without it (or with the corrected version). Only then is the queue row, the last
 * copy of the forgotten content, deleted. Until then MemoryStore.memoryView() keeps derived text out of prompts.
 */
import type { UtilityLlm } from "./llm.ts";
import type { MemoryStore } from "./store.ts";

export const SCRUB_PROMPT = `You maintain the notes of a voice companion. The user asked it to forget or correct something. Some of the notes below may
still mention it. Rewrite ONLY the notes that state or clearly imply the forgotten information, or say what it was that the user
asked to forget, so that they no longer do.
Keep everything else in a note unchanged, in the same language, and keep it natural. If a note is about nothing else, return an empty text for it.
{replacement}
Return ONLY JSON: {"rewrites": [{"key": "<key>", "text": "<the rewritten note, or empty to remove it>"}]} — only for notes that needed a change; an empty list if none did.

Forgotten information:
{forgotten}

Notes (key: text):
{notes}
`;

export interface DerivedText { key: string; text: string }

export async function scrubUser(store: MemoryStore, llm: UtilityLlm | null, userId: string): Promise<{ scrubbed: number; pending: number }> {
  const queue = await store.scrubQueue(userId);
  if (!queue.length) return { scrubbed: 0, pending: 0 };
  if (!llm) return { scrubbed: 0, pending: queue.length };
  let scrubbed = 0;
  for (const q of queue) {
    try {
      const texts = await store.derivedTexts(userId);
      if (texts.length) {
        const prompt = SCRUB_PROMPT
          .replace("{replacement}", q.replacement ? `The correct information is: ${q.replacement}. Where a note states the old information, state the correct one instead.` : "")
          .replace("{forgotten}", q.content)
          .replace("{notes}", texts.map((t) => `- ${t.key}: ${t.text.replace(/\s+/g, " ")}`).join("\n"));
        const r = await llm.json(prompt, { maxTokens: 2500 });
        const valid = new Map(texts.map((t) => [t.key, t.text]));
        const rewrites = (Array.isArray(r.obj.rewrites) ? r.obj.rewrites : []) as { key?: unknown; text?: unknown }[];
        for (const w of rewrites) {
          const key = typeof w.key === "string" ? w.key : "";
          if (!valid.has(key) || typeof w.text !== "string") continue;
          await store.rewriteDerived(userId, key, w.text.trim());
        }
      }
      await store.scrubDone(q.id);
      scrubbed++;
    } catch {
      await store.scrubFailed(q.id);
    }
  }
  return { scrubbed, pending: (await store.scrubQueue(userId)).length };
}
