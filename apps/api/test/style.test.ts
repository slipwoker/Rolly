import { describe, expect, it } from "vitest";
import { countBotSpeak, markStyle, styleGuardNote } from "../src/persona/style.ts";
import { DRY_WORDS, PlanFeeder } from "../src/voice/planFeeder.ts";

describe("bot-speak is counted", () => {
  it("openers that agree, acknowledge or praise", () => {
    for (const t of ["הבנתי אותך. זה קורה.", "צודק, פספסתי.", "סגור, נמשיך.", "אה, הבנתי. אתה נוסע?", "נשמע כמו תוכנית טובה.", "איזה כיף.", "אוקיי, הבנתי.", "בדיוק.", "זה באמת משהו חשוב.", "Got it, moving on.", "That makes sense."]) {
      expect(markStyle(t).ack, t).toBe(true);
    }
    for (const t of ["בלי עמדת טעינה בבית זה כאב ראש.", "אני הייתי מוותר על זה.", "מה סתם?", "עדיף משקיע קטן שמאמין בך.", "No charger at home is a daily headache."]) {
      expect(markStyle(t).ack, t).toBe(false);
    }
  });
  it("general wisdom, apologies, promises and feelings named back", () => {
    expect(markStyle("לפעמים פשוט להיות שם זה מספיק.").platitude).toBe(true);
    expect(markStyle("בסופו של דבר הכל מסתדר.").platitude).toBe(true);
    expect(markStyle("סליחה, התבלבלתי.").apology).toBe(true);
    expect(markStyle("אני אשתדל להיות יותר עצמי.").promise).toBe(true);
    expect(markStyle("זה באמת מציק כשזה מרגיש ככה.").therapist).toBe(true);
    const clean = markStyle("בחורף הסוללה נותנת פחות בגלל החימום.");
    expect([clean.ack, clean.platitude, clean.apology, clean.promise, clean.therapist]).toEqual([false, false, false, false, false]);
    expect(markStyle("אז כמה פגישות יש השבוע?").question).toBe(true);
    expect(markStyle("ביי, יום טוב. <end_session/>").question).toBe(false);
  });
  it("totals over a conversation, questions in a row counted inside it", () => {
    const c = countBotSpeak(["הבנתי. מה שלומך?", "לפעמים זה ככה. ואיך בעבודה?", "בלי טעינה בבית זה לא שווה."]);
    expect(c).toMatchObject({ replies: 3, ack: 1, platitude: 1, question: 2, questions_in_a_row: 1, clean: 1 });
  });
});

describe("the style guard speaks only when there is something to stop", () => {
  it("nothing after a clean reply, or after a single acknowledgement", () => {
    expect(styleGuardNote([])).toBeNull();
    expect(styleGuardNote(["בלי טעינה בבית זה לא שווה."])).toBeNull();
    expect(styleGuardNote(["בלי טעינה בבית זה לא שווה.", "הבנתי. אז נוותר."])).toBeNull(); // one opener is not a habit
  });
  it("two agreeing openers in a row, general wisdom, a promise", () => {
    expect(styleGuardNote(["הבנתי אותך.", "צודק, נכון."])).toContain("skip the opener");
    expect(styleGuardNote(["לפעמים פשוט צריך לנוח."])).toContain("specific");
    expect(styleGuardNote(["בדיוק. אני אשתדל להיות יותר עצמי."])).toContain("Do not promise");
    // at most two things at once: the model follows a short note
    const all = styleGuardNote(["הבנתי. סליחה.", "צודק, סליחה. לפעמים אני אשתדל, זה באמת קשה."])!;
    expect(all.split(". ").length).toBeLessThan(8);
  });
});

describe("the plan is fed one item at a time", () => {
  const items = [{ topic: "הגיוס", take: "משקיע קטן" }, { topic: "ספורט", take: "הליכה קצרה" }, { topic: "פודקאסטים", kind: "fresh" }, { topic: "רואה החשבון", kind: "action_check" }];
  it("the opener has the first item; the next waits on the pod for a dry turn and is shown once", () => {
    const f = new PlanFeeder(items);
    expect(f.shown).toEqual([0]);
    const first = f.afterReply(null)!; // after the opener: queue item 1, conditionally
    expect(first).toMatchObject({ turns: 1, maxUserWords: DRY_WORDS });
    expect(first.text).toContain("Bring up this now: ספורט. Your own take on it: הליכה קצרה");
    expect(f.afterReply(9)).toBeNull(); // a real answer: the item keeps waiting, nothing new is queued
    expect(f.afterReply(12)).toBeNull();
    const next = f.afterReply(1)!; // a one-word answer: the pod showed it; queue the following one
    expect(f.shown).toEqual([0, 1]);
    expect(next.text).toContain("פודקאסטים");
    expect(next.text).not.toContain("take");
  });
  it("halfway through the ride the waiting item is sent at once, with the same text so the pod replaces it", () => {
    const f = new PlanFeeder(items);
    const waiting = f.afterReply(null)!;
    const forced = f.afterReply(null, true)!;
    expect(forced.text).toBe(waiting.text);
    expect(forced.maxUserWords).toBeUndefined();
    expect(f.remaining).toBe(2);
  });
  it("a task check is asked once, lightly; an empty plan does nothing", () => {
    const f = new PlanFeeder([items[0]!, items[3]!]);
    expect(f.afterReply(null)!.text).toContain("Ask about it once, lightly");
    expect(f.afterReply(1)).toBeNull(); // shown, nothing left
    expect(new PlanFeeder([]).afterReply(1)).toBeNull();
    expect(new PlanFeeder([items[0]!]).afterReply(null)).toBeNull();
  });
});
