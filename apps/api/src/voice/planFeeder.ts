/**
 * The plan for the ride, handed to the conversation model one item at a time.
 *
 * Measured against the real model (scripts/style-eval.ts): with the whole plan in the system prompt the small model
 * treats it as a script — it pushes an item while the user is talking about something else and repeats the same "take"
 * several times in a ride. And a note is obeyed as a command: told "if they give you little again, bring up X", it
 * brought up X in answer to a real question. So:
 *  - the system prompt carries no plan, and neither does the opener: the ride starts easy (a greeting and one light
 *    question, P1-D35) and the first item comes right after the user's first answer, if that answer is short;
 *  - every item waits on the pod as a CONDITIONAL note (`max_user_words`): the pod shows it to the model only on a turn
 *    where the user said little. The pod decides, because only the pod knows what the user said before the reply is
 *    generated. The first item takes any answer of up to FIRST_REPLY_WORDS words; a longer first answer means the user
 *    has something of their own to say, so the item then waits for the conversation to run dry (a word or two, twice);
 *  - halfway through the ride the pending item is sent unconditionally (pacing).
 * Each item is shown once.
 */
export interface PlanItem { topic: string; take?: string | null; kind?: string; source?: "calendar" | "mail" | "whatsapp" | null }
export interface FeederNote { text: string; turns: number; maxUserWords?: number; minStreak?: number }

/** a user turn of at most this many words means "the conversation has run dry" */
export const DRY_WORDS = 2;
/** after the easy start, a first answer of up to this many words ("fine, and you?") makes room for the first item */
export const FIRST_REPLY_WORDS = 6;
/** after a "direction" item: a user turn of at least this many words means they took it up */
export const ENGAGED_WORDS = 6;
/** how many user turns after a "direction" item Rolly may be told to say the goal back */
const GOAL_CHANCES = 3;
/** a note of its own, not part of the direction item: that note lives for one turn, and this one belongs to the turn after they engage */
export const GOAL_NOTE = "They have been talking with you about this. If it is clear what they are after, say it back in one short sentence and ask whether to keep it as a goal of theirs. Ask it once, and nothing else in this turn.";

export class PlanFeeder {
  private next = 0;
  private waiting = false; // item `next` is queued on the pod as a conditional note
  private waitingMax = DRY_WORDS; // the word limit that note was queued with
  private firstPending = false; // item 0 was queued for the first answer and has not been shown yet
  readonly shown: number[] = [];
  /** after a "direction" item is shown: user turns left in which, once they engage, Rolly is told to say the goal back (once) */
  private goalChances = 0;
  private goalAsked = false;

  constructor(private readonly items: PlanItem[]) {}

  get remaining(): number { return Math.max(0, this.items.length - this.next); }

  /** The same text whether the item waits for a dry turn or is sent at once: the pod replaces a note with the same text. */
  private text(item: PlanItem): string {
    const take = item.take ? ` Your own take on it: ${item.take}` : "";
    // said openly: where it comes from, so it never feels like a guess about their life
    const FROM: Record<string, string> = {
      calendar: " You know this from their calendar: say so in a few words (the event and the day only, nothing else from it).",
      mail: " You know this from their mail: say so in a few words (what it is about only; never quote it or name who wrote).",
      whatsapp: " You know this from their WhatsApp: say so in a few words (what it is about only; never quote a message or name who wrote it).",
    };
    const from = item.source ? FROM[item.source] ?? "" : "";
    const how = item.kind === "action_check" ? "Ask about it once, lightly; if it is not done, do not push."
      : item.kind === "direction" ? "Say it as one short statement about what you noticed, then stop."
      : "Say it in your own words, as one short statement.";
    return `Bring up this now: ${item.topic.replace(/[.]+$/, "")}.${take}${from} ${how}`;
  }

  /**
   * Call after each of Rolly's replies with the number of words of the user turn it answered (null for the opener).
   * Returns the note to queue on the pod, or null when nothing changes.
   */
  afterReply(userWords: number | null, halfway = false): FeederNote | null {
    let armedNow = false;
    // the pod showed the waiting item exactly when the user's turn was within the limit it was queued with
    if (this.waiting && userWords !== null) {
      if (userWords <= this.waitingMax) {
        if (this.items[this.next]?.kind === "direction") { this.goalChances = GOAL_CHANCES; armedNow = true; }
        this.shown.push(this.next);
        this.next++;
        this.waiting = false;
        this.firstPending = false;
      } else if (this.firstPending) {
        // a long first answer: the user has their own topic. The item waits for the conversation to run dry instead.
        this.firstPending = false;
        this.waitingMax = DRY_WORDS;
        return { text: this.text(this.items[this.next]!), turns: 1, maxUserWords: DRY_WORDS, minStreak: 2 };
      }
    }
    // the user took a direction up: the turn after it, Rolly says the goal back (once)
    if (this.goalChances > 0 && !armedNow && userWords !== null) {
      this.goalChances--;
      if (userWords >= ENGAGED_WORDS && !this.goalAsked) { this.goalAsked = true; this.goalChances = 0; return { text: GOAL_NOTE, turns: 1 }; }
    }
    const item = this.items[this.next];
    if (!item) return null;
    if (halfway) {
      if (item.kind === "direction") this.goalChances = GOAL_CHANCES;
      this.shown.push(this.next);
      this.next++;
      this.waiting = false;
      this.firstPending = false;
      return { text: this.text(item), turns: 1 };
    }
    if (this.waiting) return null;
    this.waiting = true;
    if (userWords === null && this.next === 0) {
      // the opener has just been said: the first item goes with the user's first short answer
      this.firstPending = true;
      this.waitingMax = FIRST_REPLY_WORDS;
      return { text: this.text(item), turns: 1, maxUserWords: FIRST_REPLY_WORDS, minStreak: 1 };
    }
    this.waitingMax = DRY_WORDS;
    return { text: this.text(item), turns: 1, maxUserWords: DRY_WORDS, minStreak: 2 };
  }
}
