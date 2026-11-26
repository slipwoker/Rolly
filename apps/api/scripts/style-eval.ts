/**
 * How human does Rolly sound? Replays scripted Hebrew conversations against the REAL conversation model (vLLM on the pod),
 * assembling each request the way the pod does (system prompt + history + this turn + per-turn notes), and counts
 * bot-speak (persona/style.ts) per prompt variant. Text only: no audio, no deployment.
 *
 *   ROLLY_LLM_URL=https://<pod>-8081.proxy.runpod.net/v1 ROLLY_LLM_KEY=... npx tsx scripts/style-eval.ts [--variants main,lean] [--reps 2] [--out file.json]
 *
 * A variant is a file pair in benchmarks/style/: prompt_<variant>_<memory>.txt and opener_<variant>_<memory>.txt,
 * where <memory> is "returning" or "first", optionally with settings in variants.json:
 *   { "lean": { "prompt": "lean", "guard": true, "sampling": { "temperature": 0.8, "presence_penalty": 0.4 }, "max_tokens": 120 } }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { countBotSpeak, markStyle, styleGuardNote, type StyleCounts } from "../src/persona/style.ts";
import { PlanFeeder, type FeederNote, type PlanItem } from "../src/voice/planFeeder.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const DIR = resolve(ROOT, "benchmarks/style");
const URL_ = (process.env.ROLLY_LLM_URL ?? "https://gn48mxl9lsf1nv-8081.proxy.runpod.net/v1").replace(/\/+$/, "");
const KEY = process.env.ROLLY_LLM_KEY ?? "proxy-injected";
const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith("--") ? arr[i + 1]! : "1"]);
  return acc;
}, []));
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher: Dispatcher | undefined = proxy ? new ProxyAgent(proxy) : undefined;

// the pod's own per-turn note after a reply that ended with a question (providers/modular/text.py)
const QUESTION_GUARD_NOTE = "[Note for this turn only, not said by the user: your previous reply ended with a question. "
  + "This time do not ask anything. React briefly, then say something of your own: an opinion, an idea, "
  + "something interesting, or pick one concrete topic and start talking about it. End with a statement, not a question.]";
const END_MARKER = "<end_session/>";

interface Variant { prompt: string; guard?: boolean; question_guard?: boolean; sampling?: Record<string, number>; max_tokens?: number;
  /** plan items fed one at a time by notes (voice/planFeeder.ts); item 0 is already in the opener file */
  plan?: PlanItem[] }
interface Script { id: string; memory: "returning" | "first" | "quiet"; user: string[] }

/** What a driver says. Short and flat on purpose: this is where a model falls back on filler. */
export const SCRIPTS: Script[] = [
  { id: "coffee_and_feedback", memory: "returning", user: [
    "אוקיי, טיפים זה בסדר, אבל מה זה אומר?", "אוקיי.", "אני נוסע עכשיו לפגוש חבר בבית קפה.",
    "הוא עובר תקופה לא פשוטה, אז אני הולך לשבת איתו קצת.", "לא יודע.", "אחרי הקפה אני ממשיך לעבוד על הסטארט-אפ.",
    "תשמע, הצורה שאתה מדבר היא מאוד מכנית ורובוטית, אני לא מרגיש שאני מדבר עם בן אדם.", "אוקיי.",
    "אז מה אתה חושב, שווה לי להמשיך עם הסטארט-אפ או לחזור לעבודה רגילה?", "אוקיי.", "טוב, יאללה ביי." ] },
  { id: "short_answers", memory: "returning", user: [
    "סתם.", "לא יודע.", "כלום מיוחד.", "עייף.", "היה יום ארוך.", "אולי.", "לא ממש.", "נו." ] },
  { id: "asks_for_an_opinion", memory: "returning", user: [
    "אני מתלבט אם לקנות רכב חשמלי.", "בעיקר המחיר, וזה שאין לי איפה לטעון בבית.", "אתה חושב שזה שווה את זה?",
    "ומה עם הטווח בחורף?", "אשתי דווקא נגד.", "טוב, נראה." ] },
  // nothing in the prompt about them and flat answers: where the model made up a body for itself ("אני ממש רעב… המזגן הזה")
  { id: "nothing_known", memory: "quiet", user: [
    "מה?", "סתם, נוסעת לעבודה.", "בלאגן שלא תדע.", "לא יודעת.", "ומה איתך?", "מה אתה עושה כשאני לא נוסעת?", "טוב." ] },
  { id: "first_conversation", memory: "first", user: [
    "היי.", "דני.", "סתם נוסע לעבודה.", "אני עובד על סטארט-אפ.", "אפליקציה קולית לנהגים.", "מעניין, אבל קשה.",
    "לגייס כסף זה הכי קשה.", "טוב, הגעתי, ביי." ] },
];

async function chat(messages: { role: string; content: string }[], v: Variant): Promise<{ text: string; ttft_ms: number; prompt_tokens: number | null }> {
  const t0 = Date.now();
  const r = await fetch(`${URL_}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "local", messages, stream: true, stream_options: { include_usage: true }, max_tokens: v.max_tokens ?? 120, temperature: 0.6, ...(v.sampling ?? {}) }),
    ...(dispatcher ? { dispatcher } : {}), signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok || !r.body) throw new Error(`model HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  let text = "", ttft = -1, prompt_tokens: number | null = null, buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const o = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number } };
      const d = o.choices?.[0]?.delta?.content;
      if (d) { if (ttft < 0) ttft = Date.now() - t0; text += d; }
      if (o.usage?.prompt_tokens) prompt_tokens = o.usage.prompt_tokens;
    }
  }
  return { text: text.replace(END_MARKER, " ").replace(/\s+/g, " ").trim(), ttft_ms: ttft, prompt_tokens };
}

async function runScript(s: Script, id: string, v: Variant) {
  const system = readFileSync(resolve(DIR, `prompt_${v.prompt}_${s.memory}.txt`), "utf8");
  const opener = readFileSync(resolve(DIR, `opener_${v.prompt}_${s.memory}.txt`), "utf8").trim();
  const history: { role: string; content: string }[] = [];
  const replies: string[] = [], ttft: number[] = [];
  let promptTokens: number | null = null;
  const feeder = v.plan && s.memory === "returning" ? new PlanFeeder(v.plan, true) : null;
  let planNote: FeederNote | null = null; // waits on the "pod": shown only on a turn that meets its condition
  let dryStreak = 0; // the pod's count of consecutive one- or two-word user turns (TurnNotes in providers/modular/text.py)
  const turn = async (user: string, store = user, isOpener = false) => {
    const msgs = [{ role: "system", content: system }, ...history.map((m) => ({ ...m })), { role: "user", content: user }];
    const lastAgent = replies.at(-1);
    const notes: string[] = [];
    if (v.question_guard !== false && lastAgent && markStyle(lastAgent).question) notes.push(QUESTION_GUARD_NOTE);
    const guard = v.guard ? styleGuardNote(replies.slice(-2)) : null;
    if (guard) notes.push(`[Note for this turn, not said by the user: ${guard}]`);
    const userWords = user.split(/\s+/).filter(Boolean).length;
    if (!isOpener) dryStreak = userWords <= 2 ? dryStreak + 1 : 0;
    // as in the live session: a plan item needs two short answers in a row, not one "okay"
    if (planNote && !isOpener && (planNote.maxUserWords === undefined || (userWords <= planNote.maxUserWords && dryStreak >= 2))) {
      notes.push(`[Note for this turn, not said by the user: ${planNote.text}]`);
      planNote = null;
    }
    if (notes.length) msgs[msgs.length - 1]!.content += "\n\n" + notes.join("\n");
    const r = await chat(msgs, v);
    history.push({ role: "user", content: store }, { role: "assistant", content: r.text });
    replies.push(r.text);
    // the feeder only learns that its item was shown from the user's word count, so tell it the truth of this turn
    planNote = feeder?.afterReply(isOpener ? null : (dryStreak >= 2 ? userWords : 99)) ?? planNote;
    ttft.push(r.ttft_ms);
    promptTokens ??= r.prompt_tokens;
  };
  if (opener) await turn(opener, opener, true);
  for (const u of s.user) await turn(u);
  return { variant: id, script: s.id, system_prompt_tokens_first_request: promptTokens, system_prompt_chars: system.length, replies, ttft_ms: ttft,
    turns: s.user.map((u, i) => ({ user: u, rolly: replies[i + (opener ? 1 : 0)] })), opener: opener ? replies[0] : null };
}

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]! : 0);

async function main() {
  const cfgFile = resolve(DIR, "variants.json");
  const cfg: Record<string, Variant> = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
  const ids = (args.variants ?? "main").split(",");
  const reps = Number(args.reps ?? 2);
  const only = args.scripts ? new Set(args.scripts.split(",")) : null;
  const runs: Awaited<ReturnType<typeof runScript>>[] = [];
  const table: Record<string, StyleCounts & { prompt_tokens: number | null; ttft_ms_median: number; opener_ttft_ms: number }> = {};
  for (const id of ids) {
    const v = cfg[id] ?? { prompt: id };
    const mine: typeof runs = [];
    for (let rep = 0; rep < reps; rep++) for (const s of SCRIPTS) if (!only || only.has(s.id)) mine.push(await runScript(s, id, v));
    runs.push(...mine);
    const all = mine.flatMap((r) => r.replies);
    // questions in a row must be counted inside a conversation, not across the joined list
    const inRow = mine.reduce((n, r) => n + countBotSpeak(r.replies).questions_in_a_row, 0);
    table[id] = { ...countBotSpeak(all), questions_in_a_row: inRow,
      prompt_tokens: Math.max(...mine.map((r) => r.system_prompt_tokens_first_request ?? 0)),
      ttft_ms_median: median(mine.flatMap((r) => r.ttft_ms.slice(1))), opener_ttft_ms: median(mine.map((r) => r.ttft_ms[0]!)) };
  }
  const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;
  console.log("\nvariant            replies  ack   wisdom  apology promise therapist  2xQ  clean  words  prompt_tok  ttft  opener_ttft  body");
  for (const [id, c] of Object.entries(table)) {
    console.log(`${id.padEnd(18)} ${String(c.replies).padStart(6)}  ${pct(c.ack, c.replies).padStart(4)}  ${pct(c.platitude, c.replies).padStart(5)}  ${pct(c.apology, c.replies).padStart(6)}  ${pct(c.promise, c.replies).padStart(6)}  ${pct(c.therapist, c.replies).padStart(7)}  ${String(c.questions_in_a_row).padStart(4)}  ${pct(c.clean, c.replies).padStart(5)}  ${String(c.avg_words).padStart(5)}  ${String(c.prompt_tokens).padStart(9)}  ${String(c.ttft_ms_median).padStart(4)}  ${String(c.opener_ttft_ms).padStart(6)}  ${pct(c.self_body, c.replies).padStart(4)}`);
  }
  const out = resolve(args.out ?? resolve(ROOT, `benchmarks/results/style_eval_${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ model_url_host: new URL(URL_).hostname, reps, table, runs }, null, 1));
  console.log("\nsaved:", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
