/**
 * "Bot-speak": the habits that make a reply sound like an assistant instead of a person. Counted, not guessed:
 * in the owner's conversation of 2026-11-26, 12 of 26 replies opened by agreeing or acknowledging ("הבנתי אותך",
 * "צודק", "סגור"), 6 were general life wisdom ("לפעמים פשוט להיות שם..."), 5 apologised, and none said anything concrete.
 *
 * Used by scripts/style-eval.ts to compare prompts against the real conversation model, and by the style guard in the
 * voice session, which tells the model on its NEXT turn what to stop doing (a note next to the turn is followed far more
 * reliably by the small model than a rule in the system prompt, P1-D16).
 */

export interface StyleMarks {
  /** opens by agreeing with, acknowledging or evaluating what the user said */
  ack: boolean;
  /** general wisdom instead of something about this situation */
  platitude: boolean;
  apology: boolean;
  /** promises to behave differently instead of doing it */
  promise: boolean;
  /** names the user's feeling back to them, the way a help line does */
  therapist: boolean;
  /**
   * claims a body or a life of its own: hungry, tired, at home, at work, something "around" it. Rolly has opinions and
   * tastes, not a body (owner's decision, 2026-11-26: "אני ממש רעב… המזגן הזה" confused a tester: "אין פה שום מזגן").
   */
  self_body: boolean;
  /** ends with a question */
  question: boolean;
  words: number;
}

const strip = (t: string) => t.replace(/[֑-ׇ]/g, "").replace(/<end_session\/>/g, "").trim();

// the first words of a reply, after an optional interjection ("אה,", "אוי,")
const ACK_HE = /^(?:(?:אה|אוי|אהה|אוקיי|או קיי|טוב)[,.!]?\s+)?(?:הבנתי|מבין|מבינה|צודק|צודקת|נכון|בדיוק|סגור|אוקיי|או קיי|בסדר גמור|בסדר|אין בעיה|ברור|מובן|נשמע (?:טוב|כמו|מעולה|אחלה|לי ש?)|איזה (?:כיף|יופי)|מעולה|אחלה|יפה|סבבה|זה (?:באמת|בסדר|מובן|הגיוני)|כל הכבוד|מגניב|נהדר|כן[,.!])/;
const ACK_EN = /^(?:(?:oh|ah|well|okay|ok)[,.!]?\s+)?(?:i (?:understand|see|get it|hear you)|got it|right|exactly|sure|of course|absolutely|that makes sense|makes sense|sounds (?:good|great|like)|great|nice|okay|ok|fair enough|good point|you'?re right|no problem|totally)\b/i;
const PLATITUDE = /(לפעמים|בסופו של דבר|בסוף היום|הכי חשוב (?:זה|ש)|מה שחשוב (?:זה|ש)|אני תמיד (?:חושב|אומר)|כל אחד צריך|החיים (?:הם|זה)|זה חלק מה|sometimes|at the end of the day|the most important thing|it'?s all about|everyone needs)/i;
const APOLOGY = /(סליחה|מצטער|מצטערת|טעות שלי|התבלבלתי|לא התכוונתי|sorry|my (?:bad|mistake)|i apologi[sz]e)/i;
const PROMISE = /(אשתדל|אני אנסה|אנסה ל|אני אקשיב|אני אהיה יותר|מעכשיו אני|i'?ll try|i will try|from now on i)/i;
const THERAPIST = /(זה באמת (?:מציק|קשה|מתסכל|מעצבן|חשוב|לא פשוט)|נשמע ש(?:זה|אתה|את|עובר)|אני (?:מבין|מבינה) (?:אותך|למה|ש)|זה (?:לגמרי )?(?:מובן|לגיטימי|טבעי) ש|it sounds like you|that must be|i can imagine|that'?s (?:completely )?(?:understandable|valid))/i;

const ADV = "(?:ממש |קצת |כל כך |כבר |תמיד |גם |פשוט |בדיוק |עכשיו |די |לא |עוד |אישית )*";
const SELF_BODY = new RegExp(
  `(?:אני|הייתי|ואני|שאני) ${ADV}(?:רעב|צמא|עייף|מת מ|קפוא|מזיע|שבע|חולה|בבית|במשרד|בעבודה|בדרך ל|יושב|שוכב|שותה|נוהג|לוקח איתי|ישן|נרדם|מעדיף לשבת|(?:צריך|חייב) (?:קפה|לאכול|לישון|לנוח)|עובד ב|גר ב)`
  + "|קר לי|חם לי|כואב לי|המזגן|הבטן שלי|הקפה שלי|אצלי ב(?:בית|משרד|עבודה)|כשאני (?:נוסע|טס|נוהג|אוכל|ישן)"
  + "|\\bi(?:'m| am) (?:so |really |a bit |just )?(?:hungry|thirsty|tired|cold|sleepy|at home|at work|sitting|driving)\\b|\\bmy (?:coffee|stomach|office|house)\\b", "i");

export function markStyle(reply: string): StyleMarks {
  const t = strip(reply);
  return {
    ack: ACK_HE.test(t) || ACK_EN.test(t),
    platitude: PLATITUDE.test(t),
    apology: APOLOGY.test(t),
    promise: PROMISE.test(t),
    therapist: THERAPIST.test(t),
    self_body: SELF_BODY.test(t),
    question: /[?？]["'”״)\s]*$/.test(t),
    words: t.split(/\s+/).filter(Boolean).length,
  };
}

export interface StyleCounts { replies: number; ack: number; platitude: number; apology: number; promise: number; therapist: number;
  self_body: number; question: number; questions_in_a_row: number; avg_words: number; clean: number }

/** Totals over a conversation. `clean` = replies with none of the habits (a question at the end is not a habit). */
export function countBotSpeak(replies: string[]): StyleCounts {
  const m = replies.map(markStyle);
  const n = (k: keyof StyleMarks) => m.filter((x) => x[k] === true).length;
  let inRow = 0;
  for (let i = 1; i < m.length; i++) if (m[i]!.question && m[i - 1]!.question) inRow++;
  return {
    replies: m.length, ack: n("ack"), platitude: n("platitude"), apology: n("apology"), promise: n("promise"), therapist: n("therapist"),
    self_body: n("self_body"), question: n("question"), questions_in_a_row: inRow,
    avg_words: m.length ? Math.round((m.reduce((s, x) => s + x.words, 0) / m.length) * 10) / 10 : 0,
    clean: m.filter((x) => !x.ack && !x.platitude && !x.apology && !x.promise && !x.therapist).length,
  };
}

/**
 * What to tell the model before its next turn, from its last replies. One short note, for one turn. Nothing when the
 * last reply was fine: a guard that speaks every turn becomes one more thing the model learns to ignore.
 */
export function styleGuardNote(recentReplies: string[]): string | null {
  const last = recentReplies.at(-1);
  if (!last) return null;
  const a = markStyle(last);
  const b = recentReplies.length > 1 ? markStyle(recentReplies.at(-2)!) : null;
  const parts: string[] = [];
  if (a.ack && b?.ack) parts.push("Your last two replies opened by agreeing or acknowledging. This time skip the opener: start with what you actually have to say.");
  if (a.platitude) parts.push("Your last reply was general life wisdom. This time say something specific about this situation, or your own blunt opinion.");
  if (a.promise) parts.push("Do not promise to talk differently. Just talk differently, starting now.");
  if (a.therapist && b?.therapist) parts.push("Stop naming the user's feelings back to them. React the way a friend would: with your own take.");
  if (a.apology && b?.apology) parts.push("No more apologies. Move on to something real.");
  return parts.length ? parts.slice(0, 2).join(" ") : null;
}
