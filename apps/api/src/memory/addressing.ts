/**
 * Hebrew grammatical addressing: learned only from the user's own words.
 *
 * Evidence = gendered first-person self-references in the user's speech ("אני חושב" / "אני חושבת", "אני עייף" / "אני עייפה",
 * "הייתי עייפה", and with the pronoun dropped at the start of a clause: "לא יודע" / "לא יודעת"). First-person past-tense verbs ("עשיתי") carry no gender and are not counted. Explicit requests
 * ("תדבר אליי בלשון נקבה") confirm the preference. Never: voice pitch, name, interests. Never asked unprompted.
 *
 * Evidence from turns whose speaker is uncertain is counted separately and never changes the stored preference.
 */
import type { AddressingStatus, AddressingValue } from "../persona/phase1Sections.ts";

export type Form = "masculine" | "feminine";

/** masculine -> feminine pairs of present-tense verbs and adjectives that people use about themselves */
const PAIRS: [string, string][] = [
  ["חושב", "חושבת"], ["עייף", "עייפה"], ["צריך", "צריכה"], ["יכול", "יכולה"], ["מרגיש", "מרגישה"], ["יודע", "יודעת"],
  ["אוהב", "אוהבת"], ["נוסע", "נוסעת"], ["עובד", "עובדת"], ["לחוץ", "לחוצה"], ["שמח", "שמחה"], ["עסוק", "עסוקה"],
  ["מתכנן", "מתכננת"], ["הולך", "הולכת"], ["חוזר", "חוזרת"], ["לומד", "לומדת"], ["מסכים", "מסכימה"], ["בטוח", "בטוחה"],
  ["מבין", "מבינה"], ["זוכר", "זוכרת"], ["שונא", "שונאת"], ["מעדיף", "מעדיפה"], ["מתחיל", "מתחילה"], ["מחפש", "מחפשת"],
  ["נהנה", "נהנית"], ["רעב", "רעבה"], ["מוכן", "מוכנה"], ["מאחר", "מאחרת"], ["נוהג", "נוהגת"], ["כותב", "כותבת"],
  ["מדבר", "מדברת"], ["שומע", "שומעת"], ["מתעניין", "מתעניינת"], ["מתלבט", "מתלבטת"], ["חושש", "חוששת"], ["מודאג", "מודאגת"],
  ["מבסוט", "מבסוטה"], ["גמור", "גמורה"], ["תקוע", "תקועה"], ["מאושר", "מאושרת"], ["עצבני", "עצבנית"], ["רגוע", "רגועה"],
  ["סקרן", "סקרנית"], ["מתרגש", "מתרגשת"], ["מפחד", "מפחדת"], ["מצטער", "מצטערת"], ["נשוי", "נשואה"], ["רווק", "רווקה"],
  ["מנהל", "מנהלת"], ["מתכוון", "מתכוונת"], ["מתגעגע", "מתגעגעת"], ["חולה", "חולה"], ["מקשיב", "מקשיבה"], ["משתדל", "משתדלת"],
  ["מאמין", "מאמינה"], ["מנסה", "מנסה"], ["רוצה", "רוצה"], ["רואה", "רואה"], ["מקווה", "מקווה"], ["קורא", "קוראת"],
  ["מוטרד", "מוטרדת"], ["מרוצה", "מרוצה"], ["מותש", "מותשת"], ["ערני", "ערנית"], ["מבולבל", "מבולבלת"], ["מסוגל", "מסוגלת"],
  ["מכיר", "מכירה"], ["אמור", "אמורה"], ["רדום", "רדומה"], ["חייב", "חייבת"], ["מוכרח", "מוכרחה"], ["מעוניין", "מעוניינת"],
  ["זקוק", "זקוקה"], ["צודק", "צודקת"], ["נמצא", "נמצאת"], ["יושב", "יושבת"], ["עומד", "עומדת"], ["מגיע", "מגיעה"],
  ["יוצא", "יוצאת"], ["נכנס", "נכנסת"], ["עובר", "עוברת"], ["יורד", "יורדת"], ["בא", "באה"], ["שוכח", "שוכחת"],
  ["מבקש", "מבקשת"], ["מסתכל", "מסתכלת"], ["מחליט", "מחליטה"], ["משחק", "משחקת"], ["אוכל", "אוכלת"], ["גר", "גרה"],
  ["חי", "חיה"], ["ישן", "ישנה"], ["מצליח", "מצליחה"], ["מתעסק", "מתעסקת"], ["מתמודד", "מתמודדת"], ["מתאמן", "מתאמנת"],
  ["מרוויח", "מרוויחה"], ["משלם", "משלמת"], ["מסיים", "מסיימת"], ["ממשיך", "ממשיכה"], ["מחזיק", "מחזיקה"], ["שואל", "שואלת"],
  ["מצטרף", "מצטרפת"], ["נשאר", "נשארת"], ["נרדם", "נרדמת"], ["מקבל", "מקבלת"], ["נותן", "נותנת"], ["לוקח", "לוקחת"],
  ["מבשל", "מבשלת"], ["מטייל", "מטיילת"], ["מסתדר", "מסתדרת"], ["מתבאס", "מתבאסת"], ["מתעצבן", "מתעצבנת"], ["מתלהב", "מתלהבת"],
  ["מפספס", "מפספסת"], ["מקנא", "מקנאת"], ["מבטיח", "מבטיחה"], ["מוותר", "מוותרת"], ["מחובר", "מחוברת"], ["מת", "מתה"],
  ["כועס", "כועסת"], ["עצוב", "עצובה"], ["מאוכזב", "מאוכזבת"], ["מופתע", "מופתעת"], ["נרגש", "נרגשת"], ["משועמם", "משועממת"],
  ["חלש", "חלשה"], ["בריא", "בריאה"], ["מבוגר", "מבוגרת"], ["שבור", "שבורה"], ["הרוס", "הרוסה"], ["מסודר", "מסודרת"],
  ["סגור", "סגורה"], ["פנוי", "פנויה"], ["גרוש", "גרושה"], ["ער", "ערה"], ["קם", "קמה"], ["מתקשר", "מתקשרת"],
];
/**
 * Spoken Hebrew often drops the pronoun: "לא יודע", "לא בטוחה". These count only at the start of a clause (after optional
 * discourse words), right after "לא", and not in a question ("לא יודע?" may be said to ROLLY).
 */
const PRODROP = new Set(["יודע", "יודעת", "בטוח", "בטוחה", "זוכר", "זוכרת", "מכיר", "מכירה", "מבין", "מבינה", "מסכים", "מסכימה",
  "שומע", "שומעת"]);
const DISCOURSE = new Set(["וואלה", "ואלה", "אז", "כן", "טוב", "אוקיי", "אוקי", "אה", "אמ", "אממ", "יאללה", "תכלס", "בקיצור", "האמת",
  "נו", "רגע", "שמע", "תשמע", "אבל", "אחי", "ממש", "פשוט", "באמת", "עדיין", "כבר", "גם", "סתם"]);
/** self-descriptive nouns: stronger evidence (weight 2), still only "inferred", never "confirmed" */
const NOUNS: [string, string][] = [["גבר", "אישה"], ["בחור", "בחורה"], ["אבא", "אמא"], ["סטודנט", "סטודנטית"], ["מורה", "מורה"],
  ["מהנדס", "מהנדסת"], ["מתכנת", "מתכנתת"], ["רופא", "רופאה"], ["עורך", "עורכת"], ["יועץ", "יועצת"], ["מעצב", "מעצבת"], ["נהג", "נהגת"],
  ["אח", "אחות"], ["פרילנסר", "פרילנסרית"], ["יזם", "יזמית"], ["חייל", "חיילת"], ["פנסיונר", "פנסיונרית"], ["בן", "בת"],
  ["ילד", "ילדה"], ["מייסד", "מייסדת"], ["עורך דין", "עורכת דין"]];

const LEX = new Map<string, Form>();
for (const [m, f] of PAIRS) if (m !== f) { LEX.set(m, "masculine"); LEX.set(f, "feminine"); }
const NOUN_LEX = new Map<string, Form>();
for (const [m, f] of NOUNS) if (m !== f) { NOUN_LEX.set(m, "masculine"); NOUN_LEX.set(f, "feminine"); }

const FILLERS = new Set(["לא", "ממש", "די", "כל", "כך", "קצת", "עדיין", "גם", "כבר", "נורא", "מאוד", "מאד", "סתם", "פשוט", "באמת", "בכלל",
  "יותר", "פחות", "תמיד", "אף", "פעם", "כרגע", "עכשיו", "היום", "רק", "בטח", "דווקא", "קצת", "ממש", "תכלס", "וואלה", "נראה", "לי", "שאני", "ש"]);

export interface Observation {
  form: Form | "plural";
  kind: "self_reference" | "self_noun" | "explicit";
  quote: string;
}

function tokens(text: string): string[] {
  return text.replace(/[^֐-׿a-zA-Z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
    .map((t) => t.replace(/[֑-ׇ]/g, "")); // strip niqqud
}

const EXPLICIT: [RegExp, Form | "plural"][] = [
  [/(לשון|בלשון)\s+נקבה/, "feminine"],
  [/(לשון|בלשון)\s+זכר/, "masculine"],
  [/(לשון|בלשון)\s+רבים/, "plural"],
];
const ADDRESS_ME = /(אליי|אלי|איתי|לי|אותי)/;

/** Gendered self-references and explicit addressing requests in one utterance of the user. */
const SELF = new Set(["אני", "ואני", "שאני", "כשאני", "הייתי", "אהיה"]);

export function observe(text: string): Observation[] {
  const out: Observation[] = [];
  for (const [re, form] of EXPLICIT) {
    if (re.test(text) && ADDRESS_ME.test(text)) out.push({ form, kind: "explicit", quote: text.slice(0, 160) });
  }
  if (out.length) return out; // an explicit request decides; do not also count the words in it
  // clauses, so that a dropped pronoun is only read at the start of one; a "?" marks the clause as a question
  for (const m of text.matchAll(/([^.,!?;:…\n]+)([.,!?;:…\n]*)/g)) {
    const t = tokens(m[1]!);
    const question = m[2]!.includes("?");
    for (let i = 0; i < t.length; i++) {
      const w = t[i]!;
      if (!SELF.has(w)) continue;
      // skip a few fillers and a repeated pronoun ("אני ממש לא בטוחה", "אני אני אמור")
      let j = i + 1;
      while (j < t.length && j - i <= 4 && (FILLERS.has(t[j]!) || t[j] === "אני")) j++;
      const next = t[j];
      if (!next) continue;
      const bare = next.replace(/^ו/, "");
      const f = LEX.get(next) ?? LEX.get(bare);
      if (f) { out.push({ form: f, kind: "self_reference", quote: t.slice(i, j + 1).join(" ") }); i = j; continue; }
      if (w === "אני" || w === "ואני") {
        const two = t[j + 1] ? `${next} ${t[j + 1]}` : "";
        const n = NOUN_LEX.get(two) ?? (t[j + 1] === "אדם" ? undefined : NOUN_LEX.get(next)); // "אני בן אדם" is said by anyone
        if (n) { out.push({ form: n, kind: "self_noun", quote: t.slice(i, j + (NOUN_LEX.has(two) ? 2 : 1)).join(" ") }); i = j; }
      }
    }
    if (question) continue;
    let k = 0;
    while (k < t.length && DISCOURSE.has(t[k]!)) k++;
    if (t[k] === "לא" && t[k + 1] && PRODROP.has(t[k + 1]!)) {
      out.push({ form: LEX.get(t[k + 1]!)!, kind: "self_reference", quote: `לא ${t[k + 1]}` });
    }
  }
  return out;
}

export interface AddressingEvidence {
  masculine: number;
  feminine: number;
  ignored_uncertain: number;
  examples: { quote: string; form: string; session_id?: string; at: string }[];
}

export interface AddressingRecord {
  value: AddressingValue | null;
  status: AddressingStatus;
  evidence: AddressingEvidence;
}

export const INFER_MIN = 3; // weighted evidence needed before inferring
export const INFER_SHARE = 0.8; // share of the majority form needed

export function emptyEvidence(): AddressingEvidence {
  return { masculine: 0, feminine: 0, ignored_uncertain: 0, examples: [] };
}

/**
 * Apply the observations of one user utterance.
 * `attribution` "uncertain" => only counted as ignored; the stored value and status never change.
 */
export function applyObservations(rec: AddressingRecord, obs: Observation[], attribution: "primary" | "uncertain",
  meta: { session_id?: string; at?: Date } = {}): AddressingRecord {
  if (!obs.length) return rec;
  const ev: AddressingEvidence = { ...emptyEvidence(), ...rec.evidence, examples: [...(rec.evidence.examples ?? [])] };
  if (attribution === "uncertain") {
    ev.ignored_uncertain += obs.length;
    return { ...rec, evidence: ev };
  }
  let value = rec.value, status = rec.status;
  const at = (meta.at ?? new Date()).toISOString();
  for (const o of obs) {
    // the same utterance can be applied live and again after the session: count it once
    if (ev.examples.some((e) => e.quote === o.quote && e.session_id === meta.session_id && e.form === o.form)) continue;
    ev.examples.push({ quote: o.quote, form: o.form, session_id: meta.session_id, at });
    if (o.kind === "explicit") { value = o.form; status = "confirmed"; continue; }
    if (o.form === "plural") continue;
    ev[o.form] += o.kind === "self_noun" ? 2 : 1;
  }
  ev.examples = ev.examples.slice(-10);
  if (status !== "confirmed") {
    const total = ev.masculine + ev.feminine;
    const major: Form = ev.feminine > ev.masculine ? "feminine" : "masculine";
    const share = total ? ev[major] / total : 0;
    if (total >= INFER_MIN && share >= INFER_SHARE) { value = major; status = "inferred"; }
    else { value = null; status = "unknown"; } // not enough, or contradictory: back to neutral phrasing
  }
  return { value, status, evidence: ev };
}

/** The user set or corrected it explicitly (in the app or by voice). */
export function confirm(rec: AddressingRecord, value: AddressingValue | null): AddressingRecord {
  if (value === null) return { value: null, status: "unknown", evidence: { ...emptyEvidence(), ignored_uncertain: rec.evidence.ignored_uncertain } };
  return { ...rec, value, status: "confirmed" };
}
