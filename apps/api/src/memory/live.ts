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

/** What the pod's voice front end reads a name as, in different places of a sentence (null: no answer). */
export interface NameReadings { candidates(word: string): Promise<string[] | null> }

/** The user is saying how their name is pronounced ("קוראים לי מאור, לא מאיר", "אתה אומר את השם שלי לא נכון"). */
export const NAME_CUE = /(קוראים לי|שמי|השם שלי|השם שלי|את השם|ההגייה|הגייה|תבטא|לבטא|מבטא|אומר(ת)? את|קורא(ת)? לי|pronounc|my name is|say my name|call me)/i;

const NAME_PROMPT = `A voice companion said the user's first name aloud, and the user may be saying how it is really pronounced.
The voice reads the name in one of these ways (phonemes: ʔ is alef/ayin, ʁ resh, χ chet, ˈ comes before the stressed vowel):
{options}

Recent conversation:
{recent}

The user's last words: {last}

Return ONLY JSON: {"choice": <number of the reading that matches how the user says their name, or null>}
Use null if the user is not talking about how their name is pronounced, or if none of the readings matches what they say.
`;

/** Picks, among the readings the voice's own front end produced, the one the user says is right. Never writes phonemes. */
export async function handleNamePronunciation(store: MemoryStore, llm: UtilityLlm | null, readings: NameReadings | null,
  args: { userId: string; sessionId: string; turn: SessionTurn; recent: SessionTurn[] }): Promise<{ word: string; ipa: string } | null> {
  const { userId, turn } = args;
  if (!llm || !readings || turn.role !== "user" || turn.attribution !== "primary" || !NAME_CUE.test(turn.text)) return null;
  const name = (await store.profile(userId)).preferred_name;
  const word = (name ?? "").split(/\s+/)[0]?.replace(/[^א-ת]/g, "");
  if (!word || word.length < 2) return null;
  const candidates = await readings.candidates(word).catch(() => null);
  if (!candidates || candidates.length < 2) return null; // one reading only: nothing to choose between
  const prompt = NAME_PROMPT
    .replace("{options}", candidates.map((c, i) => `${i + 1}. ${c}`).join("\n"))
    .replace("{recent}", args.recent.map((t) => `${t.role === "agent" ? "AGENT" : "USER"}: ${t.text}`).join("\n"))
    .replace("{last}", turn.text);
  const r = await llm.json(prompt, { maxTokens: 60, purpose: "name_pron" });
  const n = typeof r.obj.choice === "number" ? Math.round(r.obj.choice) : null;
  const ipa = n !== null && n >= 1 && n <= candidates.length ? candidates[n - 1]! : null;
  if (!ipa) return null;
  await store.setNamePron(userId, { name: name!, ipa, source: "user" });
  return { word, ipa };
}

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
  const r = await llm.json(prompt, { maxTokens: 400, purpose: "live_command" });
  const actions = Array.isArray(r.obj.actions) ? r.obj.actions as { memory_id?: string; action?: string; new_content?: string | null }[] : [];
  const valid = new Set(view.knownIds.map((m) => m.id));
  for (const a of actions) {
    if (!a.memory_id || !valid.has(a.memory_id)) continue;
    if (a.action === "delete" && await store.deleteMemory(userId, a.memory_id, "voice", sessionId)) {
      done.push(`delete:${a.memory_id}`);
      turn.meta.forget_request = true; // the line naming what to forget is not kept in the transcript
    }
    if (a.action === "replace" && a.new_content && await store.correctMemory(userId, a.memory_id, a.new_content, "voice", sessionId, turn.text)) done.push(`correct:${a.memory_id}`);
  }
  return done;
}

// ------------------------------------------------------------------ "note that for me": tasks and ideas saved at once
export const CAPTURE_CUE = /(תרשום|תרשמי|תכתוב|תכתבי|תשמור|תשמרי|תזכיר|תזכירי|תוסיף|תוסיפי|שים לי|שימי לי|רשום לי|לרשום|note (that|this|it|down)|write (that|this|it) down|remind me|save (that|this|the idea|it)|(add|put) (that|this|it) (to|on) (my|the) list|make a note)/i;

const CAPTURE_PROMPT = `The user of a voice companion may have just asked it to note a task or an idea for them.
Return ONLY JSON: {"intent": "note" | "other", "items": [{"kind": "task" | "idea", "content": "<short, in the user's language, phrased as the task or idea itself>"}]}
- "note" only if the user asked to note, save, write down or be reminded of something. A question about what is on the list, a request to recall something, or anything else is "other" with an empty list.
- The thing to note may be in the user's earlier words or in what the companion just said ("תרשום את זה", "note that").
- task = something the user means to do (keep a time or date they mentioned in the content); idea = a thought worth keeping.
- If it is a request to note something but you cannot tell what, return "note" with an empty list.
- Do not repeat anything already on the list.

Already on the list:
{existing}

Recent conversation:
{recent}

The user's last words: {last}
`;

export interface CaptureResult {
  saved: { id: string; kind: "action_item" | "idea"; content: string; status: "active" | "candidate" }[];
  /** something to tell the conversation model on its next turn (only when the save did not happen as the user expects) */
  note?: { text: string; turns: number };
}

/**
 * Saves what the user asked to note while the conversation is still running, so it is on their list at once and not
 * only if the end-of-conversation summary happens to pick it up. A turn with a hint of another speaker is saved as an
 * unconfirmed candidate, like every other claim.
 */
export async function handleCapture(store: MemoryStore, llm: UtilityLlm | null, args: { userId: string; sessionId: string; turn: SessionTurn; recent: SessionTurn[] }): Promise<CaptureResult> {
  const { userId, sessionId, turn } = args;
  const out: CaptureResult = { saved: [] };
  if (turn.role !== "user" || !llm || !CAPTURE_CUE.test(turn.text)) return out;
  const existing = await store.memories(userId, { kinds: ["action_item", "idea"], status: ["active", "candidate"], limit: 40 });
  const prompt = CAPTURE_PROMPT
    .replace("{existing}", existing.map((m) => `- ${m.content}`).join("\n") || "- (empty)")
    .replace("{recent}", args.recent.map((t) => `${t.role === "agent" ? "COMPANION" : "USER"}: ${t.text}`).join("\n"))
    .replace("{last}", turn.text);
  const r = await llm.json(prompt, { maxTokens: 300, purpose: "capture" });
  if (r.obj.intent !== "note") return out;
  const items = (Array.isArray(r.obj.items) ? r.obj.items : []) as { kind?: unknown; content?: unknown }[];
  const status = turn.attribution === "primary" ? "active" as const : "candidate" as const;
  for (const it of items.slice(0, 3)) {
    const content = typeof it.content === "string" ? it.content.trim().slice(0, 300) : "";
    if (!content) continue;
    const kind = it.kind === "idea" ? "idea" as const : "action_item" as const;
    const id = await store.addMemory(userId, { kind, content, status, confidence: status === "active" ? 1 : 0.5, sessionId,
      provenance: { source: "user_voice", session_id: sessionId, quote: turn.text.slice(0, 300), turn: turn.idx, attribution: turn.attribution,
        confirmed: status === "active", reason: status === "active" ? "asked_to_note" : "uncertain_speaker" } });
    out.saved.push({ id, kind, content, status });
  }
  if (!out.saved.length) {
    out.note = { turns: 1, text: "The user asked you to note something, but it was not clear what, so nothing was saved yet. Ask in a few words what exactly to write down." };
  }
  return out;
}
