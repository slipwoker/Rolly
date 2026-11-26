/**
 * Runs the post-conversation steps against the REAL utility model (no pod, no audio): summary -> memory policy ->
 * look-ahead (goal notes, done tasks, next plan) -> live capture -> forget + scrub -> consolidation, on scripted Hebrew
 * transcripts, and prints what ended up in memory and in the next prompt.
 *
 *   DATABASE_URL=postgres://rolly:rolly@127.0.0.1/rolly_llmcheck OPENAI_API_KEY=... npx tsx scripts/llm-check.ts
 */
import { createPool, migrate } from "../src/db/index.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { openAiLlm } from "../src/memory/llm.ts";
import { summarizeSession } from "../src/memory/summarizer.ts";
import { fallbackAgenda, planNext } from "../src/memory/plan.ts";
import { handleCapture, handleLiveTurn } from "../src/memory/live.ts";
import { scrubUser } from "../src/memory/scrub.ts";
import { consolidate } from "../src/memory/consolidate.ts";
import { buildContext } from "../src/persona/promptBuilder.ts";
import type { SessionTurn } from "../src/voice/session.ts";

const db = createPool(process.env.DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_llmcheck");
await migrate(db);
const store = new MemoryStore(db, { candidateTtlDays: 14, transcriptRetentionDays: 30 });
const llm = openAiLlm({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY ?? "proxy-injected", model: process.env.ROLLY_UTILITY_LLM_MODEL ?? "gpt-6-luna", reasoning: "none" });
const uid = await store.createUser("llm-check");
const timings: Record<string, number[]> = {};
const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => { const t0 = Date.now(); const r = await f(); (timings[name] ??= []).push(Date.now() - t0); return r; };

let idx = 0;
// CLEAN=1: nobody else in the car (the "USER?" lines are left out), to see memory when the context is one-to-one
const conv = (lines: [("u" | "a" | "u?"), string][]): SessionTurn[] => lines.filter(([who]) => !(process.env.CLEAN && who === "u?")).map(([who, text]) => ({
  idx: idx++, role: who === "a" ? "agent" : "user", text, attribution: who === "u?" ? "uncertain" : "primary", startedAt: Date.now(), meta: {},
}));

async function ride(label: string, turns: SessionTurn[], live: number[] = []) {
  const sid = crypto.randomUUID();
  const before = await store.memoryView(uid);
  const built = buildContext(before, { language: "he", journey: { duration_min: 20 } });
  await store.startSession(sid, uid, "he", built.onboarding, new Date());
  for (const i of live) { // turns handled during the conversation
    const turn = turns[i]!;
    const recent = turns.slice(Math.max(0, i - 6), i + 1);
    const done = await timed("live", () => handleLiveTurn(store, llm, { userId: uid, sessionId: sid, turn, recent }));
    const cap = await timed("capture", () => handleCapture(store, llm, { userId: uid, sessionId: sid, turn, recent }));
    console.log(`  [live] "${turn.text}" ->`, JSON.stringify({ done: done.map((d) => d.split(":")[0]), saved: cap.saved.map((s) => `${s.kind}:${s.status}:${s.content}`), note: cap.note?.text }));
  }
  const view = await store.memoryView(uid);
  const summary = await timed("summary", () => summarizeSession(llm, turns, { openTopics: view.openTopics, known: view.knownIds, candidates: view.candidates }));
  const policy = await store.applySummary(uid, sid, summary, turns);
  await store.learnAddressing(uid, sid, turns);
  await store.finishSession({ sessionId: sid, userId: uid, turns, summary, stats: {}, endReason: "client_end", describe: {}, policy });
  const goals = (await store.goals(uid)).filter((g) => g.status === "active" || g.status === "paused");
  const tasks = await store.memories(uid, { kinds: ["action_item"], status: ["active"] });
  const plan = await timed("plan", () => planNext(llm, turns, {
    summary: summary.summary, language: summary.language, progress: summary.progress,
    goals: goals.map((g) => ({ id: g.id, content: g.content, state: [g.state_note, g.next_step ? `next: ${g.next_step}` : null].filter(Boolean).join(" ") || null })),
    tasks: tasks.map((t) => ({ id: t.id, content: t.content })), agenda: built.agenda,
  }));
  const applied = await store.applyPlan(uid, sid, plan, turns, policy.progressIds);
  if (!plan.next_agenda.length) await store.saveAgenda(uid, sid, fallbackAgenda(await store.memoryView(uid)));
  const scrub = await timed("scrub", () => scrubUser(store, llm, uid));
  const cons = await timed("consolidate", () => consolidate(store, llm, uid));
  console.log(`\n=== ${label}`);
  console.log("  had plan:", built.agenda.map((a) => a.topic));
  console.log("  summary:", summary.method, summary.error ?? "", "|", summary.summary);
  console.log("  policy:", policy.decisions.map((d) => `${d.kind}:${d.decision.status}(${d.decision.reason}):${d.content}`));
  console.log("  plan:", plan.method, plan.error ?? "", JSON.stringify({ applied: applied.applied.map((x) => x.split(":")[0]), refused: applied.refused.map((x) => x.replace(/:[0-9a-f-]{36}/, "")), outcome: plan.agenda_outcome }));
  console.log("  goals:", (await store.goals(uid)).map((g) => ({ goal: g.content, status: g.status, state: g.state_note, next: g.next_step, rides: g.sessions_count })));
  const v = await store.memoryView(uid);
  console.log("  tasks:", v.tasks.map((t) => t.content), "| ideas:", v.ideas, "| done:", (await store.memories(uid, { kinds: ["action_item", "idea"], done: true })).map((m) => m.content));
  console.log("  progress:", (await store.progress(uid)).slice(0, 4).map((p) => `${p.goal_id ? "[goal] " : ""}${p.text}`));
  console.log("  next plan:", v.agenda?.items.map((a) => `${a.kind}${a.ref_id ? "*" : ""}: ${a.topic} (${a.why})`));
  console.log("  scrub:", scrub, "| consolidate:", cons, "| digest:", v.digest);
}

await ride("ride 1: a goal is stated, a task and an idea are noted", conv([
  ["a", "בוקר טוב. מה השם, ומה מעסיק בדרך לעבודה?"], ["u", "היי, קוראים לי דני."],
  ["a", "נעים מאוד דני. האמת, נסיעות בוקר זה זמן טוב לחשוב על דברים גדולים."],
  ["u", "אני רוצה לנצל את הנסיעות כדי לתכנן את המעבר שלי לעבודה עצמאית."],
  ["a", "וואלה, צעד רציני. לדעתי הכי חשוב להתחיל מלקוחות, לא מלוגו."],
  ["u", "אני חושב שהצעד הראשון הוא לבנות רשימה של עשרה לקוחות אפשריים."],
  ["a", "סגור, רשימה של עשרה זה התחלה מעולה."], ["u", "תרשום לי להתקשר לרואה החשבון מחר בבוקר."],
  ["a", "רשמתי."], ["u", "ויש לי רעיון, תשמור אותו: לפתוח ניוזלטר שבועי ללקוחות."], ["a", "סגור, שמרתי."],
  ["u?", "אבא, אני רוצה גלידה אחרי הגן."], ["a", "רגע, זה אליי?"], ["u", "אני עובד בבנק לאומי כבר שמונה שנים, אגב."],
  ["a", "שמונה שנים זה הרבה ניסיון לקחת איתך."], ["u", "טוב, הגעתי, ביי."], ["a", "יאללה, בהצלחה עם הרשימה. ביי."],
]), process.env.CLEAN ? [7, 9] : [7, 9]);

await ride("ride 2: progress on the goal, the task is done, a passenger claims something", conv([
  ["a", "בוקר טוב דני. אז איך מתקדמת רשימת הלקוחות?"], ["u", "כן, התחלתי את הרשימה, יש לי כבר ארבעה שמות."],
  ["a", "ארבעה זה כמעט חצי. האמת, קולגות לשעבר הם בדרך כלל הלקוחות הראשונים."],
  ["u", "אני צריך עוד שישה, אולי אפנה לקולגות מהעבודה הקודמת."], ["a", "רעיון טוב."],
  ["u", "אה, והתקשרתי לרואה החשבון, זה סגור."], ["a", "אחלה, אחד פחות על הראש."],
  ["u?", "הוא כבר עצמאי מזמן, הוא סתם מדבר."], ["a", "נשמע שיש פה ויכוח ברכב."], ["u", "יאללה, נמשיך בפעם הבאה, ביי."], ["a", "ביי, נדבר על ההודעה ללקוחות."],
]));

const t3 = conv([
  ["a", "היי דני. חשבתי על ההודעה הראשונה ללקוחות, יש לי כיוון."], ["u", "רגע, קודם כל תשכח את מה שאמרתי על הבנק, אני לא רוצה שזה יישמר."],
  ["a", "סגור, שכחתי מזה."], ["u", "סיימתי את הרשימה, יש לי עשרה לקוחות."], ["a", "וואלה, כל הכבוד. עכשיו ההודעה."],
  ["u", "עכשיו אני רוצה לנסח הודעת פנייה ראשונה ללקוחות."], ["a", "לדעתי קצר ואישי עובד הכי טוב."], ["u", "ביי, הגעתי."], ["a", "ביי, בהצלחה."],
]);
await ride("ride 3: 'forget what I said about the bank', the goal moves again", t3, [1]);

const v = await store.memoryView(uid);
const p = buildContext(v, { language: "he", journey: { duration_min: 20 } });
console.log("\n=== the next ride's prompt (memory part)\n" + p.system_prompt.slice(p.system_prompt.indexOf("## About the user"), p.system_prompt.indexOf("Lead the conversation")));
console.log("opener:", p.opener_instruction);
const leaks = JSON.stringify(await store.exportAll(uid)).match(/[^"]{0,40}בנק[^"]{0,40}/g);
console.log("\nmentions of the bank left anywhere in the export:", leaks ?? "none");
console.log("scrub queue:", await store.scrubQueue(uid));
// long-term digests: enough confirmed notes and conversations older than the newest three
for (const f of ["גר ברמת גן", "נשוי ואב לשניים", "רץ פעמיים בשבוע", "אוהב פודקאסטים על כלכלה", "מעדיף שיחות קצרות ולעניין"]) {
  await store.addMemory(uid, { kind: "fact", content: f, status: "active", importance: 2, provenance: { confirmed: true } });
}
for (const [i, c] of ["דובר על חופשה משפחתית ביוון בקיץ; עוד לא הוחלט בין אתונה לאיים.", "דובר על חזרה לריצה; הוחלט לנסות בימי ראשון בבוקר."].entries()) {
  const id = await store.addMemory(uid, { kind: "summary", content: c, status: "active", provenance: {} });
  await db.query("UPDATE memories SET created_at = now() - make_interval(days => $2) WHERE id=$1", [id, 30 - i]);
}
console.log("personal notes:", (await store.memories(uid, { status: ["active"], kinds: ["name", "fact", "preference", "interest", "goal", "travel_goal"] })).length);
console.log("\nconsolidate:", await timed("consolidate", () => consolidate(store, llm, uid)));
const after = await store.memoryView(uid);
console.log("digest:", after.digest, "\nhistory digest:", after.historyDigest);
console.log("timings ms:", Object.fromEntries(Object.entries(timings).map(([k, a]) => [k, a.map((x) => Math.round(x))])));
await store.deleteAccount(uid);
await db.end();
