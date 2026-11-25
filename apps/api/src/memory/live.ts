/**
 * Corrections that take effect during the conversation, not only after it:
 *  - an explicit addressing request ("תדבר אליי בלשון נקבה") is stored at once (the model already follows it in-session);
 *  - "forget that" / "that's wrong, ..." is resolved against the active memories by the utility LLM and applied at once,
 *    so the Personalisation screen and the next session already reflect it.
 * Only turns without hints of another speaker can change memory.
 */
import type { SessionTurn } from "../voice/session.ts";
import { applyObservations, observe } from "./addressing.ts";
import type { UtilityLlm } from "./llm.ts";
import type { MemoryStore } from "./store.ts";

export const MEMORY_CUE = /(תשכח|תשכחי|תמחק|תמחקי|למחוק|לשכוח|זה לא נכון|לא נכון|טעית|לא מדויק|תתקן|תתקני|forget|delete that|remove that|that'?s (not )?(wrong|right|true)|not true|you got (it|that) wrong|correct that)/i;

const PROMPT = `You manage the memory of a voice companion. The user just said something that may be a request to correct or forget
something the companion remembers about them. Decide which remembered items it refers to.
Return ONLY JSON: {"actions": [{"memory_id": "<id>", "action": "delete" | "replace", "new_content": "<corrected text or null>"}]}
Use an empty list if the user did not ask to change memory, or if it is unclear which item they mean.

Remembered items (id: content):
{known}

Recent conversation:
{recent}

The user's last words: {last}
`;

export async function handleLiveTurn(store: MemoryStore, llm: UtilityLlm | null, args: { userId: string; sessionId: string; turn: SessionTurn; recent: SessionTurn[] }): Promise<string[]> {
  const { userId, sessionId, turn } = args;
  const done: string[] = [];
  if (turn.role !== "user" || turn.attribution !== "primary") return done;
  const obs = observe(turn.text).filter((o) => o.kind === "explicit");
  if (obs.length) {
    const rec = applyObservations(await store.addressing(userId), obs, "primary", { session_id: sessionId });
    await store.saveAddressing(userId, rec, "voice", sessionId);
    done.push(`addressing:${rec.value}`);
  }
  if (!llm || !MEMORY_CUE.test(turn.text)) return done;
  const view = await store.memoryView(userId);
  if (!view.knownIds.length) return done;
  const prompt = PROMPT
    .replace("{known}", view.knownIds.map((m) => `- ${m.id}: ${m.content}`).join("\n"))
    .replace("{recent}", args.recent.map((t) => `${t.role === "agent" ? "AGENT" : "USER"}: ${t.text}`).join("\n"))
    .replace("{last}", turn.text);
  const r = await llm.json(prompt, { maxTokens: 400 });
  const actions = Array.isArray(r.obj.actions) ? r.obj.actions as { memory_id?: string; action?: string; new_content?: string | null }[] : [];
  const valid = new Set(view.knownIds.map((m) => m.id));
  for (const a of actions) {
    if (!a.memory_id || !valid.has(a.memory_id)) continue;
    if (a.action === "delete" && await store.deleteMemory(userId, a.memory_id, "voice", sessionId)) done.push(`delete:${a.memory_id}`);
    if (a.action === "replace" && a.new_content && await store.correctMemory(userId, a.memory_id, a.new_content, "voice", sessionId, turn.text)) done.push(`correct:${a.memory_id}`);
  }
  return done;
}
