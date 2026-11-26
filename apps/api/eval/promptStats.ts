/**
 * Prompt Debt metrics: size, instruction count, prohibitions, themes repeated across sections, near-duplicate rules.
 * Deterministic, no network. Run before and after any prompt change and record the snapshot.
 *
 *   npm run prompt:stats -w @rolly/api               print the report
 *   npm run prompt:stats -w @rolly/api -- --save     also append a line to eval/prompt-debt/history.jsonl
 *   npm run prompt:stats -w @rolly/api -- --json     machine-readable output
 *
 * "Instructions" are bullet lines and sentences of the instruction text the conversation model receives on every turn
 * (system prompt without the memory/journey data, the opener instruction, the per-turn question-guard note).
 * Token counts are estimates (characters / 4 for English text, / 2.5 for Hebrew); the production tokenizer is Gemma's.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { END_MARKER, LANG, VOICE_STYLE } from "../src/persona/research.ts";
import { LEAD, MEMORY_CONTROL, ONBOARDING, OTHER_VOICES, addressingSection, onboardingGapsSection } from "../src/persona/phase1Sections.ts";
import { buildContext, emptyMemory } from "../src/persona/promptBuilder.ts";
import { QUESTION_GUARD_NOTE } from "./assemble.ts";
import { promptVersion } from "./run.ts";
import { DEFAULT_NOW, SCENARIOS } from "./scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export function estTokens(text: string): number {
  const he = (text.match(/[֐-׿]/g) ?? []).length;
  return Math.round(he / 2.5 + (text.length - he) / 4);
}

/** instruction sections as they are composed at runtime (Hebrew session; addressing unknown and known variants) */
export function sections(): Record<string, string> {
  const style = VOICE_STYLE.split("{language_name}").join(LANG.he[0]).split("{language_rules}").join(LANG.he[1]).split("{end_marker}").join(END_MARKER);
  return {
    VOICE_STYLE: style,
    ADDRESSING_NEUTRAL: addressingSection({ value: null, status: "unknown" }, "he")!,
    ADDRESSING_KNOWN: addressingSection({ value: "feminine", status: "confirmed" }, "he")!,
    OTHER_VOICES, MEMORY_CONTROL, ONBOARDING,
    GAPS: onboardingGapsSection({ name: true, travelGoals: true })!,
    LEAD,
    QUESTION_GUARD_NOTE,
    OPENER_RETURNING: buildContext(SCENARIOS.find((s) => s.id.startsWith("s02"))!.memory, { language: "he", now: new Date(DEFAULT_NOW) }).opener_instruction ?? "",
    OPENER_ONBOARDING: buildContext(emptyMemory(), { language: "he", now: new Date(DEFAULT_NOW) }).opener_instruction ?? "",
  };
}

/** one instruction per bullet line; non-bullet text split into sentences */
export function instructions(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("- ")) out.push(line.slice(2));
    else if (!line.endsWith(":")) out.push(...line.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.length > 12));
  }
  return out;
}

const PROHIBITION = /\b(never|do not|don't|not|no|avoid|must not|stop)\b/i;

/** behavioural themes; a theme governed in many places is a consolidation candidate */
export const THEMES: Record<string, RegExp> = {
  questions: /\bquestion|\bask(s|ing)?\b|interview/i,
  menus_and_choices: /\bmenu\b|choice|options|\bA or B\b/i,
  length_and_brevity: /\bshort\b|sentence|words in total|twenty-five|keep it short/i,
  corrections: /\bcorrect/i,
  topic_changes: /change the subject|switch|new angle|go with it/i,
  bring_own_content: /opinion|something of your own|you bring|idea|story|disagree/i,
  name_use: /\bname\b/i,
  empathy_reactions: /react|reaction|stressed|annoying/i,
  identity_and_capabilities: /\bAI\b|assistant|cannot play|pretend|help/i,
};

/** sections that never appear together in one session (an opener variant, an addressing variant, onboarding vs gaps) */
const EXCLUSIVE: string[][] = [["ADDRESSING_NEUTRAL", "ADDRESSING_KNOWN"], ["OPENER_RETURNING", "OPENER_ONBOARDING"], ["ONBOARDING", "GAPS"]];
const exclusive = (a: string, b: string) => a === b || EXCLUSIVE.some((g) => g.includes(a) && g.includes(b));

function jaccard(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/[a-z]{4,}/g) ?? []), B = new Set(b.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

export function report() {
  const secs = sections();
  const all = Object.entries(secs).flatMap(([name, text]) => instructions(text).map((t) => ({ name, t })));
  const fixtures = {
    onboarding_he: buildContext(emptyMemory(), { language: "he", now: new Date(DEFAULT_NOW) }).system_prompt,
    returning_he: buildContext(SCENARIOS.find((s) => s.id.startsWith("s02"))!.memory, { language: "he", now: new Date(DEFAULT_NOW) }).system_prompt,
    returning_en: buildContext(SCENARIOS.find((s) => s.id.startsWith("s20"))!.memory, { language: "en", now: new Date(DEFAULT_NOW) }).system_prompt,
  };
  const themes = Object.fromEntries(Object.entries(THEMES).map(([k, re]) => {
    const hits = all.filter((x) => re.test(x.t));
    return [k, { instructions: hits.length, sections: [...new Set(hits.map((h) => h.name))] }];
  }));
  const dups: { a: string; b: string; sim: number }[] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (exclusive(all[i]!.name, all[j]!.name)) continue;
    const sim = jaccard(all[i]!.t, all[j]!.t);
    if (sim >= 0.3) dups.push({ a: `${all[i]!.name}: ${all[i]!.t.slice(0, 90)}`, b: `${all[j]!.name}: ${all[j]!.t.slice(0, 90)}`, sim: +sim.toFixed(2) });
  }
  dups.sort((x, y) => y.sim - x.sim);
  return {
    date: new Date().toISOString().slice(0, 10), prompt_version: promptVersion(),
    system_prompt: Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, { chars: v.length, est_tokens: estTokens(v) }])),
    sections: Object.fromEntries(Object.entries(secs).map(([k, v]) => {
      const ins = instructions(v);
      return [k, { chars: v.length, est_tokens: estTokens(v), instructions: ins.length, prohibitions: ins.filter((x) => PROHIBITION.test(x)).length }];
    })),
    totals: { instructions: all.length, prohibitions: all.filter((x) => PROHIBITION.test(x.t)).length },
    themes,
    near_duplicates: dups.slice(0, 15),
  };
}

function main() {
  const r = report();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 1)); }
  else {
    console.log(`prompt version ${r.prompt_version} (${r.date})\n\nsystem prompt per fixture:`);
    for (const [k, v] of Object.entries(r.system_prompt)) console.log(`  ${k.padEnd(16)} ${String(v.chars).padStart(6)} chars  ~${v.est_tokens} tokens`);
    console.log("\nsections                 chars  ~tokens  instructions  prohibitions");
    for (const [k, v] of Object.entries(r.sections)) console.log(`  ${k.padEnd(20)} ${String(v.chars).padStart(6)} ${String(v.est_tokens).padStart(7)} ${String(v.instructions).padStart(12)} ${String(v.prohibitions).padStart(12)}`);
    console.log(`  ${"TOTAL".padEnd(20)} ${" ".repeat(14)} ${String(r.totals.instructions).padStart(12)} ${String(r.totals.prohibitions).padStart(12)}`);
    console.log("\nthemes governed in several places (consolidation candidates):");
    for (const [k, v] of Object.entries(r.themes)) console.log(`  ${k.padEnd(26)} ${String(v.instructions).padStart(3)} instructions in ${v.sections.length} sections: ${v.sections.join(", ")}`);
    console.log("\nnear-duplicate instructions across sections (word overlap >= 0.3):");
    for (const d of r.near_duplicates) console.log(`  ${d.sim}  ${d.a}\n        ${d.b}`);
  }
  if (process.argv.includes("--save")) {
    const dir = resolve(HERE, "prompt-debt");
    mkdirSync(dir, { recursive: true });
    const line = { date: r.date, prompt_version: r.prompt_version, system_prompt: r.system_prompt, totals: r.totals,
      themes: Object.fromEntries(Object.entries(r.themes).map(([k, v]) => [k, v.instructions])), near_duplicates: r.near_duplicates.length };
    appendFileSync(resolve(dir, "history.jsonl"), JSON.stringify(line) + "\n");
    console.log(`\nappended to ${resolve(dir, "history.jsonl")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
