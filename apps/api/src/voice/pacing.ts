/**
 * Pacing a ride: when to nudge the conversation model to move on and when to start wrapping up, from the expected length
 * of the ride (the chips on the home screen) or from what the user says ("עוד רבע שעה אני מגיע").
 *
 * Nudges are notes for the model's next turn (the pod's note channel): they never interrupt speech and never end the
 * conversation. The expected length is an estimate, so nothing here closes a session; it ends when the user says so.
 * Pure logic, no timers: the session asks `due(now)` once a second.
 */

export type PacingEvent = "half" | "wrap" | "last";

export interface PacingNote { event: PacingEvent; text: string; turns: number }

export const PACING_NOTES: Record<PacingEvent, { text: string; turns: number }> = {
  half: { turns: 1, text: "About half of the ride is over. If the current topic has run its course, bring up something new and concrete with a short, natural bridge." },
  wrap: { turns: 3, text: "About three minutes of the ride are left. Start wrapping up over your next turns: bring the current topic to a point, say the one takeaway and the next step in a short sentence. Do not open a new topic. Do not say goodbye yet." },
  last: { turns: 2, text: "The ride is about to end. In one short sentence, name the main takeaway or the next step, and that you will pick it up next time. If the user keeps talking, keep going with them; say goodbye only when they do." },
};

const MIN = 60_000;

/** When each event is due, in ms after the start, for a ride of `totalMs`. Short rides get fewer events. */
export function schedule(totalMs: number): Partial<Record<PacingEvent, number>> {
  const s: Partial<Record<PacingEvent, number>> = {};
  if (totalMs < 2 * MIN) return s; // too short to pace
  if (totalMs >= 8 * MIN) s.half = Math.round(totalMs * 0.55);
  s.wrap = totalMs >= 6 * MIN ? totalMs - 3 * MIN : Math.round(totalMs * 0.6);
  s.last = totalMs - Math.min(MIN, Math.round(totalMs * 0.15));
  return s;
}

export class Pacer {
  private fired = new Set<PacingEvent>();
  private plan: Partial<Record<PacingEvent, number>> = {};
  private endsAt: number | null = null;

  /** `scale` < 1 compresses time (server-side self-tests only): 0.1 makes a 20-minute ride pace over 2 minutes. */
  constructor(private readonly startedAt: number, durationMin: number | null | undefined, private readonly scale = 1) {
    if (durationMin && durationMin > 0) this.setTotal(durationMin * MIN * scale);
  }

  private setTotal(totalMs: number) {
    this.plan = Object.fromEntries(Object.entries(schedule(totalMs / this.scale)).map(([k, v]) => [k, this.startedAt + v * this.scale]));
    this.endsAt = this.startedAt + totalMs;
  }

  get active(): boolean { return this.endsAt !== null; }
  remainingMs(now: number): number | null { return this.endsAt === null ? null : Math.max(0, this.endsAt - now); }

  /**
   * The user said how long is left. Events that are already behind the new clock are not replayed, except the nearest
   * one: with five minutes left, "wrap" is still worth saying; "half" is not.
   */
  setRemaining(minutes: number, now: number): void {
    const remaining = minutes * MIN * this.scale;
    const total = now - this.startedAt + remaining;
    this.setTotal(total);
    const order: PacingEvent[] = ["half", "wrap", "last"];
    // the ride got longer than thought: what is ahead again may be said again when its time comes
    for (const e of order) if (this.plan[e] !== undefined && this.plan[e]! > now) this.fired.delete(e);
    // what is already behind the new clock: "halfway" is never replayed; of wrap-up and last word only the later one is
    if (this.plan.half !== undefined && this.plan.half <= now) this.fired.add("half");
    const past = order.filter((e) => this.plan[e] !== undefined && this.plan[e]! <= now && !this.fired.has(e));
    for (const e of past.slice(0, -1)) this.fired.add(e);
  }

  /** Events that became due since the last call (each fires once). */
  due(now: number): PacingNote[] {
    const out: PacingNote[] = [];
    for (const e of ["half", "wrap", "last"] as PacingEvent[]) {
      const at = this.plan[e];
      if (at === undefined || this.fired.has(e) || now < at) continue;
      this.fired.add(e);
      out.push({ event: e, ...PACING_NOTES[e] });
    }
    // if several became due at once (a long pause), only the latest matters
    return out.slice(-1);
  }
}

// ------------------------------------------------------------------ "how long is left", said by the user
const HE_UNITS: Record<string, number> = {
  "אחת": 1, "אחד": 1, "שתיים": 2, "שניים": 2, "שתי": 2, "שני": 2, "שלוש": 3, "שלושה": 3, "ארבע": 4, "ארבעה": 4, "חמש": 5, "חמישה": 5,
  "שש": 6, "שישה": 6, "שבע": 7, "שבעה": 7, "שמונה": 8, "תשע": 9, "תשעה": 9, "עשר": 10, "עשרה": 10,
  "עשרים": 20, "שלושים": 30, "ארבעים": 40, "חמישים": 50,
};
const EN_UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, a: 1, an: 1,
};
/** words that make a duration a statement about the ride (and not "we talked for ten minutes") */
const HE_CUE = /(עוד|נשאר|נשארו|נותר|נותרו|יש לי|יש לנו|מגיע|מגיעה|מגיעים|שם בעוד|אהיה)/;
const EN_CUE = /\b(in|left|have|got|about|another|arrive|arriving|there in|away)\b/i;

function heNumber(words: string[]): number | null {
  // "עשרים וחמש", "חמש", "25"
  let total = 0, any = false;
  for (const w0 of words) {
    const w = w0.replace(/^ו/, "");
    if (/^\d+$/.test(w0)) { total += Number(w0); any = true; } else if (HE_UNITS[w] !== undefined) { total += HE_UNITS[w]!; any = true; } else if (HE_UNITS[w0] !== undefined) { total += HE_UNITS[w0]!; any = true; }
  }
  return any ? total : null;
}

/** Minutes the user says are left of the ride, or null when the sentence is not about that. */
export function parseRemainingMinutes(text: string): number | null {
  const t = text.replace(/[.,!?״"']/g, " ").replace(/\s+/g, " ").trim();
  const ok = (n: number | null) => (n !== null && n >= 1 && n <= 180 ? n : null);

  if (HE_CUE.test(t)) {
    if (/שעה וחצי/.test(t)) return 90;
    if (/שלושת רבעי שעה/.test(t)) return 45;
    if (/חצי שעה/.test(t)) return 30;
    if (/רבע שעה/.test(t)) return 15;
    if (/(?:^| )דקותיים(?: |$)/.test(t) || /שתי דקות/.test(t)) return 2;
    if (/(?:עוד|נשארה?|יש לי) דקה(?: |$)/.test(t)) return 1;
    const m = t.match(/((?:[א-ת]+|\d+)(?: ו?[א-ת]+)?) דקות/);
    if (m) {
      const words = m[1]!.split(" ");
      const n = ok(heNumber(words)) ?? ok(heNumber(words.slice(-1)));
      if (n) return n;
    }
    if (/(?:עוד|נשארה?(?: לי| לנו)?|בעוד) שעה(?: |$)/.test(t)) return 60;
  }
  if (EN_CUE.test(t)) {
    if (/half an hour/i.test(t)) return 30;
    if (/quarter of an hour/i.test(t)) return 15;
    const m = t.match(/\b(\d+|[a-z]+)(?:[ -](\d+|[a-z]+))? (?:more )?min(?:ute)?s?\b/i);
    if (m) {
      const val = (w?: string) => (w === undefined ? null : /^\d+$/.test(w) ? Number(w) : EN_UNITS[w.toLowerCase()] ?? null);
      const a = val(m[1]), b = val(m[2]);
      const n = ok(b !== null ? (a !== null && a >= 20 && b < 10 ? a + b : b) : a);
      if (n) return n;
    }
    if (/\b(?:in|about|another) an hour\b/i.test(t)) return 60;
  }
  return null;
}
