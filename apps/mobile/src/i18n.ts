/** UI strings. Hebrew is the default UI language and is laid out right-to-left. */
import { getLocales } from "expo-localization";
import { I18nManager, Platform } from "react-native";

const he = {
  hi: "שלום", hiName: "שלום, {name}",
  progressSub: "מטרות, משימות ושיחות אחרונות.", memorySub: "לתקן, לאשר או למחוק.", speakingTo: "מדבר עם ROLLY", sayIt: "פשוט לדבר — ROLLY רושם", menu: "תפריט", transcript: "תמליל", endConv: "לסיים את השיחה", back: "חזרה", startHint: "לחיצה על המיקרופון מתחילה שיחה",
  waitingFirst: "ROLLY תכף מתחיל לדבר…",
  conversation: "שיחה", progress: "התקדמות", personalisation: "התאמה אישית",
  start: "התחלה", stop: "סיום", connecting: "מתחבר…", listening: "מקשיב", user_speaking: "שומע אותך", agent_speaking: "ROLLY מדבר",
  reconnecting: "החיבור נפל, מתחבר מחדש…", paused: "מושהה (שיחה או אפליקציה אחרת)", ended: "השיחה הסתיימה", error: "תקלה", idle: "מוכן",
  captions: "כתוביות (לבדיקה)", latency: "זמן תגובה", language: "שפת שיחה", hebrew: "עברית", english: "English", auto: "אוטומטי",
  goals: "מטרות לזמן הנסיעה", moved: "מה קידמנו", recent: "שיחות אחרונות", actionItems: "דברים שלקחת על עצמך", nothingYet: "עוד אין כאן כלום. אחרי השיחה הראשונה זה יתמלא.",
  remembers: "מה ROLLY זוכר", unconfirmed: "לא מאושר (אולי נאמר על ידי מישהו אחר)", confirm: "לאשר", edit: "לתקן", delete: "למחוק", save: "שמירה", cancel: "ביטול",
  addressing: "פנייה בעברית", addrUnknown: "עוד לא ידוע — ROLLY מדבר בניסוח ניטרלי", addrInferred: "נלמד מהשיחה", addrConfirmed: "נקבע על ידך",
  masculine: "זכר", feminine: "נקבה", plural: "רבים", reset: "לאפס", name: "שם",
  services: "שירותים מחוברים", soon: "בקרוב", exportData: "ייצוא המידע שלי", deleteAccount: "מחיקת החשבון וכל המידע",
  sure: "להמשיך? אי אפשר לבטל את זה.", noSpeakerId: "ROLLY לא יודע לזהות מי מדבר. דברים שנאמרו כשלא ברור מי אמר אותם נשמרים כלא מאושרים עד שתאשרו.",
};
type Strings = typeof he;
const en: Strings = {
  hi: "Hi", hiName: "Hi, {name}",
  progressSub: "Goals, to-dos and recent conversations.", memorySub: "Correct, confirm or delete.", speakingTo: "Speaking to ROLLY", sayIt: "Just talk — ROLLY takes notes", menu: "Menu", transcript: "Transcript", endConv: "End conversation", back: "Back", startHint: "Tap the mic to start a conversation",
  waitingFirst: "ROLLY is about to speak…",
  conversation: "Conversation", progress: "Progress", personalisation: "Personalisation",
  start: "Start", stop: "Stop", connecting: "Connecting…", listening: "Listening", user_speaking: "Hearing you", agent_speaking: "ROLLY is talking",
  reconnecting: "Connection lost, reconnecting…", paused: "Paused (call or another app)", ended: "Conversation ended", error: "Problem", idle: "Ready",
  captions: "Captions (debug)", latency: "Reply time", language: "Conversation language", hebrew: "עברית", english: "English", auto: "Automatic",
  goals: "Goals for travel time", moved: "What we moved forward", recent: "Recent conversations", actionItems: "Things you took on", nothingYet: "Nothing here yet. It fills in after the first conversation.",
  remembers: "What ROLLY remembers", unconfirmed: "Not confirmed (maybe said by someone else)", confirm: "Confirm", edit: "Correct", delete: "Delete", save: "Save", cancel: "Cancel",
  addressing: "Hebrew addressing", addrUnknown: "Not known yet — ROLLY uses neutral phrasing", addrInferred: "Learned from conversation", addrConfirmed: "Set by you",
  masculine: "Masculine", feminine: "Feminine", plural: "Plural", reset: "Reset", name: "Name",
  services: "Connected services", soon: "Coming later", exportData: "Export my data", deleteAccount: "Delete account and all data",
  sure: "Are you sure? This cannot be undone.", noSpeakerId: "ROLLY cannot tell who is speaking. Things said when it is unclear who said them are kept as unconfirmed until you confirm them.",
};

export const uiLang: "he" | "en" = getLocales()[0]?.languageCode === "en" ? "en" : "he";
export const t: Strings = uiLang === "he" ? he : en;
export const isRTL = uiLang === "he";

/**
 * Layout direction applied explicitly on every root view (screens, modals). I18nManager.forceRTL only takes effect
 * after the app restarts, so without this the very first launch would be laid out left-to-right.
 */
export const dirStyle = { direction: isRTL ? "rtl" : "ltr" } as const;

/** Text-input alignment to the reading start (right in Hebrew). Native flips "left" under an RTL layout; web does not. */
export const inputAlign: "left" | "right" = Platform.OS === "web" && isRTL ? "right" : "left";

/** "{name}"-style placeholders. */
export const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

/** RTL takes effect after a restart of the JS bundle; done once on first launch. */
export function ensureDirection() {
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL !== isRTL) I18nManager.forceRTL(isRTL);
}
