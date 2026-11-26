/**
 * Writes the prompt the CURRENT code builds for a made-up user into benchmarks/style/ (variant "lean"), so that
 * scripts/style-eval.ts measures exactly what production would send. The baseline files prompt_main_* / opener_main_*
 * were written the same way from the builder on main on 2026-11-26 (2,480 tokens) and are kept for comparison.
 *
 *   npx tsx scripts/style-fixtures.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SAMPLING } from "../src/config.ts";
import { buildContext, emptyMemory, type MemoryView } from "../src/persona/promptBuilder.ts";

const DIR = resolve(import.meta.dirname, "../../../benchmarks/style");
const now = new Date("2026-11-26T06:10:00Z");
const day = 86_400_000;

/** The same made-up user as the baseline: a founder who asked Rolly to be less robotic. */
const returning: MemoryView = {
  ...emptyMemory(), sessionCount: 4, lastOpener: "בוקר טוב דני, איך הבוקר?",
  profile: { ...emptyMemory().profile, preferredName: "דני", preferredLanguage: "he",
    preferences: { "noted 1": "מעדיף שלא כל שיחה תהיה רצינית; גם משהו קטן ומשעשע מתאים.", "noted 2": "רוצה שרולי יהיה יוזם ויציע עצות.", "noted 3": "רוצה שיחה אותנטית, פחות רובוטית." },
    addressing: { value: "masculine", status: "inferred" } },
  facts: ["עובד על סטארט-אפ בשם לומה, אפליקציה קולית לנהגים, וזה מעסיק אותו רוב הזמן."],
  summaries: [{ content: "דני סיפר שהוא נפגש עם חבר בבית קפה ואחר כך ממשיך לעבוד על הסטארט-אפ. הוא ביקש שרולי ידבר בצורה טבעית יותר.", createdAt: new Date(now.getTime() - day) }],
  // what the look-ahead step would have written after the last ride (memory/plan.ts): topics with Rolly's own take
  agenda: { created_at: new Date(now.getTime() - day).toISOString(), session_id: null, items: [
    { topic: "הגיוס של לומה", take: "עדיף משקיע קטן אחד שמאמין מאשר לרדוף חודשים אחרי קרן גדולה.", why: "", kind: "follow_up", ref_id: null },
    { topic: "למצוא זמן לספורט", take: "עשרים דקות הליכה אחרי הנסיעה שוות יותר ממנוי לחדר כושר שלא מגיעים אליו.", why: "", kind: "follow_up", ref_id: null },
    { topic: "פודקאסטים בנסיעה, מעשירים או סתם רעש רקע", take: "אתה בצד של שקט.", why: "", kind: "fresh", ref_id: null },
  ] },
};

/** A user Rolly has met but knows nothing about right now (they cleared their memory): no summary, no plan. */
const quiet: MemoryView = { ...emptyMemory(), sessionCount: 3 };

// `--as <name>` writes the files under another variant name (to keep a "before" next to the current code's "lean")
const AS = process.argv.includes("--as") ? process.argv[process.argv.indexOf("--as") + 1]! : "lean";
const plans: Record<string, unknown> = {};
for (const [name, mem] of [["returning", returning], ["first", emptyMemory()], ["quiet", quiet]] as const) {
  const c = buildContext(mem, { language: "he", now, journey: {} });
  writeFileSync(resolve(DIR, `prompt_${AS}_${name}.txt`), c.system_prompt);
  writeFileSync(resolve(DIR, `opener_${AS}_${name}.txt`), c.opener_instruction ?? "");
  plans[name] = c.agenda.map((a) => ({ topic: a.topic, take: a.take ?? null, kind: a.kind }));
  console.log(name, c.system_prompt.length, "chars; plan items:", c.agenda.length);
}
const file = resolve(DIR, "variants.json");
const variants = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
variants.main = { prompt: "main" };
// production as built: lean prompt, style guard, plan fed by conditional notes, the configured sampling
variants[AS] = { prompt: AS, guard: true, plan: plans.returning, sampling: { ...DEFAULT_SAMPLING } };
if (AS !== "lean") { writeFileSync(file, JSON.stringify(variants, null, 1)); process.exit(0); }
variants["lean-no-guard"] = { prompt: "lean", plan: plans.returning };
variants["lean-warmer"] = { prompt: "lean", guard: true, plan: plans.returning, sampling: { temperature: 0.7, repetition_penalty: 1.05 } };
writeFileSync(file, JSON.stringify(variants, null, 1));
