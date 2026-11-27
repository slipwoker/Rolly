/** UI strings. Hebrew is the default UI language and is laid out right-to-left. */
import { getLocales } from "expo-localization";
import { I18nManager, Platform } from "react-native";

const he = {
  hi: "שלום", hiName: "שלום, {name}", morning: "בוקר טוב", afternoon: "צהריים טובים", evening: "ערב טוב",
  intro: "ROLLY פותח את השיחה, זוכר מה סיכמתם וממשיך מאיפה שעצרתם.", lastTime: "בפעם הקודמת", nextUp: "הבא בתור",
  tripLen: "כמה זמן הנסיעה?", minShort: "{n} דק׳", anyLen: "לא משנה",
  progressSub: "מטרות, משימות ושיחות אחרונות.", memorySub: "לתקן, לאשר או למחוק.", speakingTo: "מדבר עם ROLLY", sayIt: "פשוט לדבר — ROLLY רושם", menu: "תפריט", transcript: "תמליל", endConv: "לסיים את השיחה", back: "חזרה", startHint: "לחיצה על המיקרופון מתחילה שיחה",
  waitingFirst: "ROLLY תכף מתחיל לדבר…",
  conversation: "שיחה", progress: "התקדמות", personalisation: "התאמה אישית",
  start: "התחלה", stop: "סיום", connecting: "מתחבר…", listening: "מקשיב", user_speaking: "שומע אותך", agent_speaking: "ROLLY מדבר",
  reconnecting: "החיבור נפל, מתחבר מחדש…", paused: "מושהה (שיחה או אפליקציה אחרת)", music: "נפתח ב-Spotify", tapToTalk: "כשתחזרו, לחצו על המיקרופון כדי לדבר שוב", ended: "השיחה הסתיימה", error: "תקלה", idle: "מוכן",
  captions: "כתוביות (לבדיקה)", latency: "זמן תגובה", language: "שפת שיחה", hebrew: "עברית", english: "English", auto: "אוטומטי",
  ideas: "רעיונות", doneItems: "בוצע לאחרונה", noTasks: "אין משימות פתוחות. אפשר לבקש מ-ROLLY לרשום משהו.", nextStep: "הצעד הבא", achieved: "הושג", goalPaused: "בהמתנה", shareList: "לשתף את הרשימה",
  goals: "מטרות", moved: "מה קידמנו", recent: "שיחות אחרונות", actionItems: "משימות", nothingYet: "עוד אין כאן כלום. אחרי השיחה הראשונה זה יתמלא.", goalsEmpty: "מטרות נבנות מתוך מה שחשוב לך, תוך כדי שיחה. כשמשהו יתגבש, זה יופיע כאן.",
  remembers: "מה ROLLY זוכר", unconfirmed: "לא מאושר (אולי נאמר על ידי מישהו אחר)", confirm: "לאשר", edit: "לתקן", delete: "למחוק", save: "שמירה", cancel: "ביטול",
  addressing: "פנייה בעברית", addrUnknown: "עוד לא ידוע — ROLLY מדבר בניסוח ניטרלי", addrInferred: "נלמד מהשיחה", addrConfirmed: "נקבע על ידך",
  masculine: "זכר", feminine: "נקבה", plural: "רבים", reset: "לאפס", name: "שם",
  kTrack: "שיר", kArtist: "אמן", kAlbum: "אלבום", kShow: "פודקאסט", kEpisode: "פרק", openInSpotify: "פתיחה ב-Spotify",
  showAll: "הצגת הכל ({n})", showLess: "הצגת פחות", yourData: "המידע שלך", deleteItem: "למחוק את הפריט?", editItem: "לתקן", profile: "איך לדבר איתך",
  services: "שירותים מחוברים", soon: "בקרוב", connect: "לחבר", disconnect: "לנתק", connected: "מחובר",
  signalsCalendar: "להבין מה חשוב לי מהיומן", signalsCalendarWhy: "לפני נסיעה ROLLY יציץ ביומן ל-14 הימים הקרובים (כותרות, שעות ומקום בלבד, בלי תיאורים) כדי לשאול על מה שמתקרב. פועל כברירת מחדל כשהשירות מחובר. אפשר לכבות בכל רגע, וזה מוחק מה שנלקח משם.", signalsMail: "להבין מה חשוב לי מהמייל", signalsMailWhy: "לפני נסיעה ROLLY יחפש במייל דברים הקשורים למה שמתקרב ביומן (שולח, נושא ותקציר קצר של עד שמונה הודעות, בלי תוכן מלא). פועל כברירת מחדל כשהשירות מחובר. אפשר לכבות בכל רגע, וזה מוחק מה שנלקח משם.", signalsWhatsapp: "להבין מה חשוב לי מהוואטסאפ", signalsWhatsappWhy: "לפני נסיעה ROLLY יקרא את ההודעות האחרונות (עד שלושה ימים) בעד חמש שיחות אישיות אחרונות. לא קבוצות, לא הודעות קוליות, ולא יזכיר מי כתב מה. פועל כברירת מחדל כשהשירות מחובר. אפשר לכבות בכל רגע, וזה מוחק מה שנלקח משם.", turnOn: "להפעיל", turnOff: "לכבות", signalsOn: "פועל",  googleService: "Google: יומן ומייל", googleWhy: "ROLLY יוכל לספר מה ביומן ומה חדש במייל, לשלוח מייל ולקבוע פגישות (רק אחרי שתאשרו בקול)", googleUpdateWhy: "מחובר לקריאה בלבד. כדי ש-ROLLY יוכל גם לשלוח מייל ולקבוע פגישות צריך לאשר הרשאות נוספות", updatePerms: "עדכון הרשאות", musicService: "Spotify: מוזיקה ופודקאסטים", musicWhy: "מחפש, ממליץ ופותח שירים ופודקאסטים ב-Spotify שבטלפון", exportData: "ייצוא המידע שלי", deleteAccount: "מחיקת החשבון וכל המידע",
  waService: "WhatsApp", waWhy: "ROLLY יקריא לך הודעות וישלח הודעות בקול. בכל שליחה הוא מקריא ומחכה שתאשר.", open: "פתח",
  waNotLinked: "לא מחובר", waPairing: "ממתין לקוד…", waConnected: "מחובר", waReconnecting: "מתחבר מחדש…", waNeedsRelink: "צריך לחבר מחדש", waBanned: "WhatsApp הגבילה את החשבון. אפשר לנתק.", waConflict: "חיבור כפול, נסה לחבר מחדש", waUnavailable: "לא זמין כרגע",
  waTermsTitle: "לפני שמחברים", waTerm1: "זה חיבור לא רשמי. WhatsApp לא מאשרת אותו, והיא עלולה להגביל או לחסום את המספר שלך.", waTerm2: "ROLLY מתחבר כמכשיר מקושר, כמו WhatsApp Web.", waTerm3: "ההודעות נשמרות מוצפנות 30 יום ואז נמחקות. הודעות קוליות מתומללות רק כשמבקשים.", waTerm4: "ROLLY לא שולח כלום בלי שתאשר בקול אחרי שהוא מקריא לך.", waTerm5: "אפשר לנתק בכל רגע, וזה מוחק את כל מה ש-ROLLY שמר.", waAgree: "הבנתי ואני רוצה להתחבר", waContinue: "המשך",
  waPhoneTitle: "מה המספר שלך ב-WhatsApp?", waPhoneHint: "הקוד נשלח למספר הזה. WhatsApp רגיל בלבד כרגע.", waPhonePlaceholder: "050-123-4567", waGetCode: "לקבל קוד",
  waCodeTitle: "הקלד את הקוד ב-WhatsApp", waStep1: "פתח את WhatsApp", waStep2: "הגדרות ← מכשירים מקושרים ← קישור מכשיר", waStep3: "בחר \"קישור עם מספר טלפון במקום זאת\" והקלד את הקוד", waExpires: "הקוד תקף עוד {n} שניות", waExpired: "הקוד פג", waBusinessNote: "אם זה WhatsApp Business, הקישור בקוד לא נתמך כרגע.", waNewCode: "קוד חדש",
  waConnectedText: "ROLLY יכול לקרוא הודעות ולשלוח אותן בשבילך.", waDisconnectAsk: "לנתק את WhatsApp? זה מוחק את כל מה ש-ROLLY שמר מההודעות.", waRelinkText: "החיבור נותק. צריך לחבר מחדש כדי ש-ROLLY ימשיך לקרוא ולשלוח.",
  waErrBusy: "WhatsApp כבר מחובר", waErrPhone: "המספר לא נראה תקין", waErrLimit: "יותר מדי ניסיונות. נסה שוב מאוחר יותר.", waErrGeneric: "לא הצלחנו להתחבר. נסה שוב.",
  waMethodTitle: "איך מחברים?", waMethodHint: "הקוד בטלפון לא תמיד עובד כרגע. הדרך הבטוחה: קוד QR על מסך אחר, למשל מחשב. אנחנו נותנים קישור שפותחים שם.", waByEmail: "שלח לי קישור במייל", waByShare: "שתף קישור (AirDrop, הודעות…)", waByCode: "קוד בטלפון (ניסיוני)",
  waEmailTitle: "לאיזו כתובת לשלוח את הקישור?", waEmailPlaceholder: "name@example.com", waSendLink: "שלח", waWaitTitle: "פתח את הקישור במחשב", waWaitSent: "שלחנו קישור אל {email}.", waWaitShared: "הקישור נשלח דרך השיתוף.", waWaitStep1: "פתח את הקישור במחשב", waWaitStep2: "בטלפון: WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר", waWaitStep3: "סרוק את הקוד שעל מסך המחשב", waWaitLeft: "הקישור תקף עוד {n} דקות", waNewLink: "קישור חדש", waErrEmail: "כתובת המייל לא נראית תקינה", waErrEmailOff: "שליחת מייל לא זמינה כרגע. אפשר לשתף את הקישור.",
  sure: "להמשיך? אי אפשר לבטל את זה.", noSpeakerId: "ROLLY לא יודע לזהות מי מדבר. דברים שנאמרו כשלא ברור מי אמר אותם נשמרים כלא מאושרים עד שתאשרו.",
};
type Strings = typeof he;
const en: Strings = {
  hi: "Hi", hiName: "Hi, {name}", morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening",
  intro: "ROLLY opens the conversation, remembers what you agreed and picks up where you left off.", lastTime: "Last time", nextUp: "Next up",
  tripLen: "How long is the drive?", minShort: "{n} min", anyLen: "Any",
  progressSub: "Goals, to-dos and recent conversations.", memorySub: "Correct, confirm or delete.", speakingTo: "Speaking to ROLLY", sayIt: "Just talk — ROLLY takes notes", menu: "Menu", transcript: "Transcript", endConv: "End conversation", back: "Back", startHint: "Tap the mic to start a conversation",
  waitingFirst: "ROLLY is about to speak…",
  conversation: "Conversation", progress: "Progress", personalisation: "Personalisation",
  start: "Start", stop: "Stop", connecting: "Connecting…", listening: "Listening", user_speaking: "Hearing you", agent_speaking: "ROLLY is talking",
  reconnecting: "Connection lost, reconnecting…", paused: "Paused (call or another app)", music: "Opened in Spotify", tapToTalk: "When you are back, tap the microphone to talk again", ended: "Conversation ended", error: "Problem", idle: "Ready",
  captions: "Captions (debug)", latency: "Reply time", language: "Conversation language", hebrew: "עברית", english: "English", auto: "Automatic",
  ideas: "Ideas", doneItems: "Recently done", noTasks: "No open tasks. Ask ROLLY to note something.", nextStep: "Next step", achieved: "Achieved", goalPaused: "On hold", shareList: "Share the list",
  goals: "Goals", moved: "What we moved forward", recent: "Recent conversations", actionItems: "Tasks", nothingYet: "Nothing here yet. It fills in after the first conversation.", goalsEmpty: "Goals are built from what matters to you, in conversation. When something takes shape, it shows up here.",
  remembers: "What ROLLY remembers", unconfirmed: "Not confirmed (maybe said by someone else)", confirm: "Confirm", edit: "Correct", delete: "Delete", save: "Save", cancel: "Cancel",
  addressing: "Hebrew addressing", addrUnknown: "Not known yet — ROLLY uses neutral phrasing", addrInferred: "Learned from conversation", addrConfirmed: "Set by you",
  masculine: "Masculine", feminine: "Feminine", plural: "Plural", reset: "Reset", name: "Name",
  kTrack: "Song", kArtist: "Artist", kAlbum: "Album", kShow: "Podcast", kEpisode: "Episode", openInSpotify: "Open in Spotify",
  showAll: "Show all ({n})", showLess: "Show less", yourData: "Your data", deleteItem: "Delete this item?", editItem: "Correct", profile: "How to talk to you",
  services: "Connected services", soon: "Coming later", connect: "Connect", disconnect: "Disconnect", connected: "Connected",
  signalsCalendar: "Understand what matters to me from my calendar", signalsCalendarWhy: "Before a ride ROLLY looks at your next 14 days (titles, times and place only, never descriptions) to ask about what is coming up. It is on by default while the service is connected. You can turn it off any time, which removes what came from it.", signalsMail: "Understand what matters to me from my mail", signalsMailWhy: "Before a ride ROLLY looks in your mail for things tied to what is coming up (sender, subject and a short snippet of up to eight messages, never full bodies). It is on by default while the service is connected. You can turn it off any time, which removes what came from it.", signalsWhatsapp: "Understand what matters to me from WhatsApp", signalsWhatsappWhy: "Before a ride ROLLY reads the latest messages (up to three days) in up to five recent one-to-one chats. Never groups, never voice notes, and it will not say who wrote what. It is on by default while the service is connected. You can turn it off any time, which removes what came from it.", turnOn: "Turn on", turnOff: "Turn off", signalsOn: "On",  googleService: "Google: calendar and mail", googleWhy: "ROLLY can tell you what is on your calendar and what is new in your mail, send email and set up meetings (only after you say yes out loud)", googleUpdateWhy: "Connected for reading only. To let ROLLY also send email and set up meetings, approve the extra permissions", updatePerms: "Update permissions", musicService: "Spotify: music and podcasts", musicWhy: "Finds, recommends and opens songs and podcasts in the Spotify app on your phone", exportData: "Export my data", deleteAccount: "Delete account and all data",
  waService: "WhatsApp", waWhy: "ROLLY reads your messages aloud and sends messages by voice. Before every send it reads the message back and waits for your yes.", open: "Open",
  waNotLinked: "Not connected", waPairing: "Waiting for the code…", waConnected: "Connected", waReconnecting: "Reconnecting…", waNeedsRelink: "Needs to be connected again", waBanned: "WhatsApp restricted the account. You can disconnect.", waConflict: "Double connection, try connecting again", waUnavailable: "Not available right now",
  waTermsTitle: "Before connecting", waTerm1: "This is an unofficial connection. WhatsApp does not approve it and may restrict or block your number.", waTerm2: "ROLLY connects as a linked device, like WhatsApp Web.", waTerm3: "Messages are kept encrypted for 30 days, then deleted. Voice notes are transcribed only when you ask.", waTerm4: "ROLLY never sends anything without your spoken yes after reading it back to you.", waTerm5: "You can disconnect at any time, and that deletes everything ROLLY kept.", waAgree: "I understand and want to connect", waContinue: "Continue",
  waPhoneTitle: "What is your WhatsApp number?", waPhoneHint: "The code is made for this number. Regular WhatsApp only for now.", waPhonePlaceholder: "050-123-4567", waGetCode: "Get a code",
  waCodeTitle: "Type the code in WhatsApp", waStep1: "Open WhatsApp", waStep2: "Settings → Linked devices → Link a device", waStep3: "Choose \"Link with phone number instead\" and type the code", waExpires: "The code is valid for {n} more seconds", waExpired: "The code expired", waBusinessNote: "If this is WhatsApp Business, linking by code is not supported right now.", waNewCode: "New code",
  waConnectedText: "ROLLY can read messages and send them for you.", waDisconnectAsk: "Disconnect WhatsApp? This deletes everything ROLLY kept from your messages.", waRelinkText: "The connection was cut. Connect again so ROLLY can keep reading and sending.",
  waErrBusy: "WhatsApp is already connected", waErrPhone: "That number does not look right", waErrLimit: "Too many tries. Try again later.", waErrGeneric: "We could not connect. Try again.",
  waMethodTitle: "How to connect?", waMethodHint: "The code on the phone does not always work right now. The reliable way is a QR code on another screen, such as a computer. We give you a link to open there.", waByEmail: "Email me a link", waByShare: "Share a link (AirDrop, Messages…)", waByCode: "Code on this phone (experimental)",
  waEmailTitle: "Which address should we send the link to?", waEmailPlaceholder: "name@example.com", waSendLink: "Send", waWaitTitle: "Open the link on a computer", waWaitSent: "We sent a link to {email}.", waWaitShared: "The link was sent through sharing.", waWaitStep1: "Open the link on a computer", waWaitStep2: "On your phone: WhatsApp → Settings → Linked devices → Link a device", waWaitStep3: "Scan the code on the computer screen", waWaitLeft: "The link is valid for {n} more minutes", waNewLink: "New link", waErrEmail: "That email address does not look right", waErrEmailOff: "Email is not available right now. You can share the link instead.",
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
