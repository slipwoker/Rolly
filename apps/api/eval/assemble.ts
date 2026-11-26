/**
 * Runtime-faithful message assembly for text-level evaluation.
 *
 * The system prompt and opener come from the real builder (src/persona/promptBuilder.ts), exactly as rolly-api sends
 * them to the pod. What the pod then does per turn lives in Python (providers/modular/pipeline.py `_messages` and
 * `_finalize_committed`, helpers in providers/modular/text.py); it is mirrored here because the sandbox cannot open the
 * pod's WebSocket. test/eval.test.ts fails if the mirrored constants drift from the Python ones.
 *
 * Not mirrored (audio-only): speech recognition errors, turn-taking timing, echo/false-interruption handling,
 * history compaction after 24 turns, TTS pronunciation.
 */
import { END_MARKER } from "../src/persona/research.ts";

export type Role = "system" | "user" | "assistant";
export interface Msg { role: Role; content: string }

/** Mirror of QUESTION_GUARD_NOTE in providers/modular/text.py (parity: test/eval.test.ts). */
export const QUESTION_GUARD_NOTE =
  "[Note for this turn only, not said by the user: your previous reply ended with a question. "
  + "This time do not ask anything. React briefly, then say something of your own: an opinion, an idea, "
  + "something interesting, or pick one concrete topic and start talking about it. "
  + "End with a statement, not a question.]";

const QUESTION_END = /\?[\s"'”’»)\]]*$/;

/** Mirror of ends_with_question() in providers/modular/text.py. */
export function endsWithQuestion(text: string): boolean {
  const t = (text ?? "").split(END_MARKER).join(" ").trim().replace(/[—-]+$/, "").trim();
  return QUESTION_END.test(t);
}

const STRIP = /[*_#`~>|]+|\[(?:[^\]]*)\]\([^)]*\)/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}☀-➿️]/gu;

/** Mirror of clean_for_speech() in providers/modular/text.py: what is spoken and stored in history. */
export function cleanForSpeech(text: string): string {
  return text.split(END_MARKER).join(" ").replace(STRIP, " ").replace(EMOJI, "").replace(/\s+/g, " ").trim();
}

/**
 * The pod's per-session conversation state, reduced to what reaches the language model.
 * Usage per turn: `const { msgs } = conv.messages(userText)` -> call the model -> `conv.commit(userText, reply)`.
 */
export class PipelineMirror {
  readonly history: Msg[] = [];

  constructor(readonly systemPrompt: string, readonly opts: { questionGuard: boolean } = { questionGuard: true }) {}

  /** `_messages(user_text)`: system + history + this turn, with the one-turn question-guard note when it applies. */
  messages(userText: string): { msgs: Msg[]; guardApplied: boolean } {
    const msgs: Msg[] = [{ role: "system", content: this.systemPrompt }, ...this.history.map((m) => ({ ...m }))];
    const last = msgs[msgs.length - 1]!;
    if (last.role === "user") last.content += "\n" + userText;
    else msgs.push({ role: "user", content: userText });
    let guardApplied = false;
    if (this.opts.questionGuard) {
      const prevAgent = [...this.history].reverse().find((m) => m.role === "assistant");
      if (prevAgent && endsWithQuestion(prevAgent.content)) {
        msgs[msgs.length - 1]!.content += "\n\n" + QUESTION_GUARD_NOTE;
        guardApplied = true;
      }
    }
    return { msgs, guardApplied };
  }

  /**
   * `_finalize_committed`: the user text and what the user actually heard of the reply go into history.
   * `heardWords` simulates a barge-in: only the first N words were heard, stored with a trailing " —" as the pod does.
   */
  commit(userText: string, reply: string, heardWords?: number): string {
    const last = this.history[this.history.length - 1];
    if (last && last.role === "user") last.content += "\n" + userText;
    else this.history.push({ role: "user", content: userText });
    let spoken = cleanForSpeech(reply);
    if (heardWords !== undefined) spoken = spoken.split(/\s+/).slice(0, heardWords).join(" ") + " —";
    if (spoken) this.history.push({ role: "assistant", content: spoken });
    return spoken;
  }

  /** Apply a barge-in after the fact: the previous reply was cut after N words (pipeline keeps "heard + ' —'"). */
  truncateLastReply(heardWords: number): void {
    const last = this.history[this.history.length - 1];
    if (last?.role !== "assistant") return;
    const words = last.content.replace(/ —$/, "").split(/\s+/);
    if (words.length > heardWords) last.content = words.slice(0, heardWords).join(" ") + " —";
  }
}
