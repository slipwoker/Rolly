import { describe, expect, it } from "vitest";
import { countBotSpeak, markStyle, styleGuardNote } from "../src/persona/style.ts";
import { DRY_WORDS, FIRST_REPLY_WORDS, PlanFeeder } from "../src/voice/planFeeder.ts";

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
  it("the first item goes with the first SHORT answer after the easy opener; the next waits for a dry turn and is shown once", () => {
    const f = new PlanFeeder(items);
    expect(f.shown).toEqual([]); // the opener carries no item
    const first = f.afterReply(null)!; // after the opener: item 0, for a short first answer
    expect(first).toMatchObject({ turns: 1, maxUserWords: FIRST_REPLY_WORDS, minStreak: 1 });
    expect(first.text).toContain("Bring up this now: הגיוס. Your own take on it: משקיע קטן");
    expect(f.afterReply(4)).toMatchObject({ maxUserWords: DRY_WORDS, minStreak: 2 }); // shown on the 4-word answer: item 1 is queued the usual way
    expect(f.shown).toEqual([0]);
    expect(f.afterReply(9)).toBeNull(); // a real answer: item 1 keeps waiting, nothing new is queued
    expect(f.afterReply(12)).toBeNull();
    const next = f.afterReply(1)!; // a one-word answer: the pod showed item 1; queue the following one
    expect(f.shown).toEqual([0, 1]);
    expect(next.text).toContain("פודקאסטים");
    expect(next.text).not.toContain("take");
  });
  it("a long first answer means the user has their own topic: the first item then waits for the conversation to run dry", () => {
    const f = new PlanFeeder(items);
    f.afterReply(null);
    const again = f.afterReply(18)!; // 18 words: the pod did not show it
    expect(f.shown).toEqual([]);
    expect(again).toMatchObject({ turns: 1, maxUserWords: DRY_WORDS, minStreak: 2 });
    expect(again.text).toContain("הגיוס"); // the same item (the pod replaces the note with the same text)
    expect(f.afterReply(7)).toBeNull(); // still waiting, nothing new
    expect(f.afterReply(1)!.text).toContain("ספורט"); // a one-word answer: item 0 was shown, item 1 queued
    expect(f.shown).toEqual([0]);
  });
  it("halfway through the ride the waiting item is sent at once, with the same text so the pod replaces it", () => {
    const f = new PlanFeeder(items);
    const waiting = f.afterReply(null)!;
    const forced = f.afterReply(null, true)!;
    expect(forced.text).toBe(waiting.text);
    expect(forced.maxUserWords).toBeUndefined();
    expect(f.remaining).toBe(3);
  });
  it("a task check is asked once, lightly; an empty plan does nothing", () => {
    const f = new PlanFeeder([items[3]!, items[0]!]);
    expect(f.afterReply(null)!.text).toContain("Ask about it once, lightly");
    expect(f.afterReply(1)!.text).toContain("הגיוס"); // shown, the next one queued
    expect(f.afterReply(1)).toBeNull(); // shown, nothing left
    expect(new PlanFeeder([]).afterReply(1)).toBeNull();
    expect(new PlanFeeder([]).afterReply(null)).toBeNull();
  });
});

describe("claims a body or a life of its own", () => {
  it("is counted, and opinions and tastes are not", () => {
    for (const bad of ["היי, צהריים טובים. אני ממש רעב, בערך בגלל שהמזגן הזה פתאום נתן לי תחושת רעב.", "אני מעדיף לשבת בבית עם קפה כשזה יורד ככה.",
      "אני תמיד לוקח איתי אוזניות איכותיות כדי לא להשתגע בטיסות כאלה.", "אני תמיד ישן בטיסות ארוכות, זה פשוט מציל חיים.", "קר לי רק מלחשוב על זה."])
      expect(markStyle(bad).self_body, bad).toBe(true);
    for (const fine of ["עם ילדים הייתי הולך על אי רגוע, אתונה נשמעת לי קצת עמוסה מדי.", "אני בעד ניוזלטר קצר עם רעיון שימושי אחד.",
      "אני חושב שזה תלוי אם את טיפוס של שינה.", "אין לי אפשרות לבדוק מזג אוויר בזמן אמת.", "אני לא יכול לנגן מוזיקה."])
      expect(markStyle(fine).self_body, fine).toBe(false);
    expect(countBotSpeak(["אני ממש רעב.", "ביי."]).self_body).toBe(1);
  });
});

