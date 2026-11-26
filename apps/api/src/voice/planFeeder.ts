/**
 * The plan for the ride, handed to the conversation model one item at a time.
 *
 * Measured against the real model (scripts/style-eval.ts): with the whole plan in the system prompt the small model
 * treats it as a script — it pushes an item while the user is talking about something else and repeats the same "take"
 * several times in a ride. And a note is obeyed as a command: told "if they give you little again, bring up X", it
 * brought up X in answer to a real question. So:
 *  - the system prompt carries no plan; the opener gets the first item;
 *  - every further item waits on the pod as a CONDITIONAL note (`max_user_words`): the pod shows it to the model only
 *    on a turn where the user said a word or two, i.e. when the conversation has run dry. The pod decides, because
 *    only the pod knows what the user said before the reply is generated;
 *  - halfway through the ride the pending item is sent unconditionally (pacing).
 * Each item is shown once.
 */
export interface PlanItem { topic: string; take?: string | null; kind?: string }
export interface FeederNote { text: string; turns: number; maxUserWords?: number }

/** a user turn of at most this many words means "the conversation has run dry" */
export const DRY_WORDS = 2;

export class PlanFeeder {
  private next: number;
  private waiting = false; // item `next` is queued on the pod as a conditional note
  readonly shown: number[] = [];

  /** `openerUsesFirst`: the opener instruction already carries item 0. */
  constructor(private readonly items: PlanItem[], openerUsesFirst = true) {
    this.next = openerUsesFirst && items.length ? 1 : 0;
    if (openerUsesFirst && items.length) this.shown.push(0);
  }

  get remaining(): number { return Math.max(0, this.items.length - this.next); }

  private text(item: PlanItem, now: boolean): string {
    const take = item.take ? ` Your own take on it: ${item.take}` : "";
    const how = item.kind === "action_check" ? "Ask about it once, lightly; if it is not done, do not push." : "Say it in your own words, as one short statement.";
    return `${now ? "Move on to this now" : "They gave you little: bring up this now"}: ${item.topic}.${take} ${how}`;
  }

  /**
   * Call after each of Rolly's replies with the number of words of the user turn it answered (null for the opener).
   * Returns the note to queue on the pod, or null when nothing changes.
   */
  afterReply(userWords: number | null, halfway = false): FeederNote | null {
    // the pod showed the waiting item exactly when the user's turn was dry
    if (this.waiting && userWords !== null && userWords <= DRY_WORDS) {
      this.shown.push(this.next);
      this.next++;
      this.waiting = false;
    }
    const item = this.items[this.next];
    if (!item) return null;
    if (halfway) {
      this.shown.push(this.next);
      this.next++;
      this.waiting = false;
      return { text: this.text(item, true), turns: 1 };
    }
    if (this.waiting) return null;
    this.waiting = true;
    return { text: this.text(item, false), turns: 1, maxUserWords: DRY_WORDS };
  }
}
