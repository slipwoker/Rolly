/**
 * Behavioural evaluation runner.
 *
 *   npm run eval -w @rolly/api -- [--target hybrid|pod|custom] [--scenarios s01,s05] [--repeats 2] [--label my-change]
 *                                  [--no-judge] [--no-question-guard] [--judge-model gpt-6.2-sol] [--offline]
 *
 * Targets (the conversation model under test):
 *   pod     the production model: vLLM on the GPU pod (Gemma-4 26B-A4B, served as "local").
 *           Needs ROLLY_EVAL_POD_LLM_URL (e.g. https://<pod-id>-8081.proxy.runpod.net/v1) and ROLLY_GPU_API_KEY.
 *           Sampling settings are read from config/providers.yaml (modular-selfhosted.llm).
 *   hybrid  gpt-6-luna with reasoning off, as configured for the `hybrid-api` provider (config/providers.render.yaml).
 *           NOT the production conversation model: use it for relative comparisons when the pod is unavailable.
 *   custom  --base-url, --model, --key-env, --token-param, --temperature, --reasoning.
 *
 * --offline builds every scenario's prompt and runs nothing (no network): a quick check that fixtures still build.
 * --rescore <results.json> re-applies the deterministic checks to saved transcripts (rewrites that file, no network).
 * --rejudge <results.json> re-scores saved transcripts with the current judge rubric (rewrites that file).
 * Results go to eval/results/<timestamp>_<label>.json; compare two with `npm run eval:compare -w @rolly/api -- A B`.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, type MemoryView } from "../src/persona/promptBuilder.ts";
import { PipelineMirror } from "./assemble.ts";
import { defaultChecks, metrics, openingWord, scenarioChecks, type AgentTurn, type CheckResult } from "./checks.ts";
import { JUDGE_VERSION, judgeConversation, type JudgeResult } from "./judge.ts";
import { chat, podLlmSettings, type ChatConfig } from "./llmClient.ts";
import { DEFAULT_NOW, SCENARIOS, addressingTimeline, type Scenario } from "./scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function targetConfig(): { cfg: ChatConfig; note: string } {
  const t = arg("target", "hybrid");
  if (t === "pod") {
    const s = podLlmSettings(ROOT);
    const url = arg("base-url", process.env.ROLLY_EVAL_POD_LLM_URL);
    if (!url) throw new Error("--target pod needs ROLLY_EVAL_POD_LLM_URL (the pod's vLLM, port 8081) or --base-url");
    return { cfg: { baseUrl: url, model: arg("model", "local")!, apiKeyEnv: "ROLLY_GPU_API_KEY", maxTokens: s.maxTokens, temperature: s.temperature,
      tokenParam: "max_tokens" }, note: `production conversation model on the pod; sampling from ${s.source}` };
  }
  if (t === "hybrid") {
    return { cfg: { baseUrl: "https://api.openai.com/v1", model: arg("model", "gpt-6-luna")!, apiKeyEnv: "OPENAI_API_KEY", maxTokens: 120,
      temperature: 0.6, tokenParam: "max_completion_tokens", reasoningEffort: "none" },
    note: "STAND-IN: hybrid-api's conversation LLM, not the production pod model (Gemma-4 26B-A4B)" };
  }
  return { cfg: { baseUrl: arg("base-url")!, model: arg("model")!, apiKeyEnv: arg("key-env"), maxTokens: Number(arg("max-tokens", "120")),
    temperature: arg("temperature") === "none" ? null : Number(arg("temperature", "0.6")),
    tokenParam: (arg("token-param", "max_tokens") as ChatConfig["tokenParam"]), reasoningEffort: arg("reasoning") ?? null },
  note: "custom target" };
}

function judgeConfig(): ChatConfig {
  return { baseUrl: arg("judge-base-url", "https://api.openai.com/v1")!, model: arg("judge-model", process.env.ROLLY_EVAL_JUDGE_MODEL ?? "gpt-6.2-sol")!,
    apiKeyEnv: "OPENAI_API_KEY", maxTokens: 3000, temperature: null, tokenParam: "max_completion_tokens", reasoningEffort: arg("judge-reasoning", "low") };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** hash of every file that shapes what the conversation model sees (prompt version, independent of git state) */
export function promptVersion(): string {
  const files = ["apps/api/src/persona/research.ts", "apps/api/src/persona/phase1Sections.ts", "apps/api/src/persona/promptBuilder.ts",
    "providers/modular/text.py", "providers/modular/pipeline.py", "config/providers.yaml"];
  return sha(files.map((f) => { try { return readFileSync(resolve(ROOT, f), "utf8"); } catch { return `missing:${f}`; } }).join("\0"));
}

function git(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "apps/api/src", "providers", "config"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return { commit, dirty };
  } catch { return { commit: "unknown", dirty: true }; }
}

export function buildScenarioContext(s: Scenario) {
  return buildContext(s.memory, { language: s.language, journey: { duration_min: 25, ...s.journey, proactive: true }, now: new Date(s.now ?? DEFAULT_NOW), timeZone: "Asia/Jerusalem" });
}

function describeContext(s: Scenario): string {
  const m: MemoryView = s.memory;
  const p = m.profile;
  const j = { duration_min: 25, ...s.journey };
  const parts = [
    `journey: about ${j.duration_min} minutes until arrival (ROLLY was told this), local time Thursday morning`,
    `name: ${p.preferredName ?? "unknown"}`,
    `addressing: ${p.addressing.status === "unknown" ? "unknown (must stay gender-neutral)" : `${p.addressing.value} (${p.addressing.status})`}`,
    p.professionalBackground ? `background: ${p.professionalBackground}` : "",
    p.interests.length ? `interests: ${p.interests.join("; ")}` : "",
    p.travelGoals.length ? `travel goals: ${p.travelGoals.join("; ")}` : "",
    m.facts.length ? `facts: ${m.facts.join("; ")}` : "",
    m.summaries.length ? `previous rides: ${m.summaries.map((s) => s.content).join(" | ")}` : "",
    m.openTopics.length ? `open topics: ${m.openTopics.join("; ")}` : "",
    m.actionItems.length ? `action items: ${m.actionItems.join("; ")}` : "",
    m.candidates.length ? `NOT confirmed (may be someone else's): ${m.candidates.map((c) => c.content).join("; ")}` : "",
    `completed sessions: ${m.sessionCount}`,
  ];
  return parts.filter(Boolean).join(". ");
}

export interface ScenarioRun {
  id: string; repeat: number; title: string; covers: string[]; prompt_sha: string; prompt_chars: number;
  transcript: { role: "user" | "rolly"; text: string; guard_applied?: boolean; interrupted?: boolean }[];
  checks: CheckResult[]; metrics: ReturnType<typeof metrics>; judge?: JudgeResult; error?: string;
}

function judgeRun(cfg: ChatConfig, s: Scenario, transcript: ScenarioRun["transcript"]): Promise<JudgeResult> {
  let n = 0;
  const shown = transcript.map((t) => t.role === "rolly" ? `ROLLY (turn ${n++}): ${t.text}${t.interrupted ? " —" : ""}` : `USER: ${t.text}`).join("\n");
  return judgeConversation(cfg, { title: s.title, focus: s.judge.focus, memory: describeContext(s), transcript: shown, criteria: s.judge.criteria });
}

/** the deterministic checks and metrics for a finished transcript */
function scoreTranscript(s: Scenario, transcript: ScenarioRun["transcript"]): Pick<ScenarioRun, "checks" | "metrics"> {
  const turns: AgentTurn[] = [];
  let lastUser: string | null = null;
  for (const t of transcript) {
    if (t.role === "user") { lastUser = t.text; continue; }
    turns.push({ idx: turns.length, text: t.text, userSaid: turns.length ? lastUser : null, guardApplied: !!t.guard_applied, interrupted: !!t.interrupted });
  }
  return {
    checks: [...defaultChecks(turns, { language: s.language, addressingAt: addressingTimeline(s), endExpectedAt: s.endExpectedAt }),
      ...scenarioChecks(turns, s.checks ?? [])],
    metrics: metrics(turns),
  };
}

/** Re-apply the current deterministic checks to saved transcripts (after a check or lexicon fix); no network. */
function rescore(file: string) {
  const old = JSON.parse(readFileSync(file, "utf8")) as { meta: Record<string, unknown>; runs: ScenarioRun[] };
  const runs = old.runs.map((r) => { const s = SCENARIOS.find((x) => x.id === r.id); return s && !r.error ? { ...r, ...scoreTranscript(s, r.transcript) } : r; });
  writeFileSync(file, JSON.stringify({ meta: { ...old.meta, rescored: new Date().toISOString() }, summary: summarize(runs), runs }, null, 1) + "\n");
  console.log(`re-scored ${runs.length} runs in ${file}`);
}

/** Re-score saved transcripts with the current judge (after a rubric change), without calling the target model again. */
async function rejudge(file: string, judge: ChatConfig) {
  const old = JSON.parse(readFileSync(file, "utf8")) as { meta: Record<string, unknown>; runs: ScenarioRun[] };
  const runs = await pool(old.runs, Number(arg("concurrency", "4")), async (r) => {
    const s = SCENARIOS.find((x) => x.id === r.id);
    return s && !r.error ? { ...r, judge: await judgeRun(judge, s, r.transcript) } : r;
  });
  const out = { meta: { ...old.meta, judge: { model: judge.model, reasoning: judge.reasoningEffort }, judge_version: JUDGE_VERSION, rejudged: new Date().toISOString() },
    summary: summarize(runs), runs };
  writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(`re-judged ${runs.length} runs in ${file}; judge:`, Object.entries(out.summary.judge).map(([k, v]) => `${k}=${v.mean}`).join("  "));
}

async function runScenario(s: Scenario, repeat: number, target: ChatConfig, opts: { guard: boolean; judge: ChatConfig | null }): Promise<ScenarioRun> {
  const built = buildScenarioContext(s);
  const conv = new PipelineMirror(built.system_prompt, { questionGuard: opts.guard });
  const turns: AgentTurn[] = [];
  const transcript: ScenarioRun["transcript"] = [];
  const out: ScenarioRun = { id: s.id, repeat, title: s.title, covers: s.covers, prompt_sha: sha(built.system_prompt), prompt_chars: built.system_prompt.length,
    transcript, checks: [], metrics: metrics([]) };
  try {
    // the proactive opener goes through the same path as a user turn and stays in history as the first user message
    const lines: { text: string; step?: Scenario["steps"][number] }[] = [{ text: built.opener_instruction! }, ...s.steps.map((st) => ({ text: st.say, step: st }))];
    for (let i = 0; i < lines.length; i++) {
      const { text, step } = lines[i]!;
      if (step?.interruptsPreviousAfterWords !== undefined) {
        conv.truncateLastReply(step.interruptsPreviousAfterWords);
        const prev = turns[turns.length - 1];
        if (prev) { prev.interrupted = true; transcript[transcript.length - 1]!.interrupted = true; }
      }
      if (step) transcript.push({ role: "user", text });
      const { msgs, guardApplied } = conv.messages(text);
      const r = await chat(target, msgs);
      const reply = r.text.trim();
      conv.commit(text, reply);
      turns.push({ idx: i, text: reply, userSaid: step ? text : null, guardApplied });
      transcript.push({ role: "rolly", text: reply, guard_applied: guardApplied || undefined });
    }
    Object.assign(out, scoreTranscript(s, transcript));
    if (opts.judge) out.judge = await judgeRun(opts.judge, s, transcript);
  } catch (e) {
    out.error = String((e as Error).message ?? e).slice(0, 400);
  }
  return out;
}

export function summarize(runs: ScenarioRun[]) {
  const checkStats: Record<string, { severity: string; n: number; passed: number }> = {};
  const judge: Record<string, number[]> = {};
  const byScenario: Record<string, { hard_failures: number; runs: number; judge_mean: number | null }> = {};
  for (const r of runs) {
    const sc = (byScenario[r.id] ??= { hard_failures: 0, runs: 0, judge_mean: null });
    sc.runs++;
    if (r.error || r.checks.some((c) => c.severity === "hard" && !c.pass)) sc.hard_failures++;
    for (const c of r.checks) {
      const k = (checkStats[c.id] ??= { severity: c.severity, n: 0, passed: 0 });
      k.n++; if (c.pass) k.passed++;
    }
    for (const [crit, v] of Object.entries(r.judge?.scores ?? {})) if (v?.score != null) (judge[crit] ??= []).push(v.score);
  }
  const mean = (xs: number[]) => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null;
  for (const [id, sc] of Object.entries(byScenario)) {
    const xs = runs.filter((r) => r.id === id).flatMap((r) => Object.values(r.judge?.scores ?? {}).map((v) => v?.score).filter((x): x is number => x != null));
    sc.judge_mean = mean(xs);
  }
  const ok = runs.filter((r) => !r.error);
  // suite-level repetition: the most common first word of replies (opener excluded) and its share
  const firsts = new Map<string, number>();
  let replies = 0;
  for (const r of ok) {
    let k = 0;
    for (const t of r.transcript) {
      if (t.role !== "rolly") continue;
      const w = openingWord({ idx: k++, text: t.text, userSaid: null, guardApplied: false });
      if (w) { replies++; firsts.set(w, (firsts.get(w) ?? 0) + 1); }
    }
  }
  const top = [...firsts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
  const self = ok.reduce((a, r) => ({ masculine: a.masculine + (r.metrics.rolly_self_gender?.masculine ?? 0), feminine: a.feminine + (r.metrics.rolly_self_gender?.feminine ?? 0) }), { masculine: 0, feminine: 0 });
  const avg = (f: (r: ScenarioRun) => number) => ok.length ? +(ok.reduce((a, r) => a + f(r), 0) / ok.length).toFixed(3) : null;
  return {
    runs: runs.length, errors: runs.filter((r) => r.error).length,
    scenarios_with_hard_failures: Object.values(byScenario).filter((s) => s.hard_failures > 0).length,
    checks: Object.fromEntries(Object.entries(checkStats).map(([k, v]) => [k, { ...v, rate: +(v.passed / v.n).toFixed(3) }])),
    judge: Object.fromEntries(Object.entries(judge).map(([k, v]) => [k, { n: v.length, mean: mean(v) }])),
    metrics: {
      question_ending_rate: avg((r) => r.metrics.question_ending_rate),
      consecutive_question_pairs_per_run: avg((r) => r.metrics.consecutive_question_pairs),
      mean_words: avg((r) => r.metrics.mean_words),
      guard_applied_per_run: avg((r) => r.metrics.guard_applied_turns),
      top_opening_word_share: replies ? +(top[0]![1] / replies).toFixed(3) : null,
    },
    top_opening_words: top.map(([w, n]) => `${w} ${n}/${replies}`),
    rolly_self_gender: self,
    by_scenario: byScenario,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

async function main() {
  const ids = arg("scenarios")?.split(",").map((x) => x.trim());
  const scenarios = ids ? SCENARIOS.filter((s) => ids.some((id) => s.id === id || s.id.startsWith(id + "_"))) : SCENARIOS;
  if (!scenarios.length) throw new Error("no scenario matches --scenarios");
  const rs = arg("rescore");
  if (rs) return rescore(resolve(rs));
  const rj = arg("rejudge");
  if (rj) return rejudge(resolve(rj), judgeConfig());
  if (flag("offline")) {
    for (const s of scenarios) {
      const b = buildScenarioContext(s);
      console.log(`${s.id.padEnd(40)} prompt ${String(b.system_prompt.length).padStart(6)} chars  onboarding=${b.onboarding}  opener=${b.opener_instruction ? "yes" : "no"}`);
    }
    return;
  }
  const { cfg: target, note } = targetConfig();
  const judge = flag("no-judge") ? null : judgeConfig();
  const repeats = Number(arg("repeats", "1"));
  const guard = !flag("no-question-guard");
  const label = (arg("label") ?? `${arg("target", "hybrid")}`).replace(/[^\w.-]+/g, "-");
  const jobs = scenarios.flatMap((s) => Array.from({ length: repeats }, (_, r) => ({ s, r })));
  console.log(`running ${jobs.length} conversations against ${target.model} (${note}); judge: ${judge?.model ?? "off"}`);
  const runs = await pool(jobs, Number(arg("concurrency", "4")), async ({ s, r }) => {
    const res = await runScenario(s, r, target, { guard, judge });
    const hard = res.checks.filter((c) => c.severity === "hard" && !c.pass).map((c) => c.id);
    console.log(`  ${s.id} #${r} ${res.error ? "ERROR " + res.error : hard.length ? "HARD FAIL " + hard.join(",") : "ok"}`);
    return res;
  });
  const result = {
    meta: {
      created: new Date().toISOString(), label, ...git(), prompt_version: promptVersion(),
      target: { ...target, note }, judge: judge ? { model: judge.model, reasoning: judge.reasoningEffort } : null, judge_version: judge ? JUDGE_VERSION : null,
      question_guard: guard, repeats, scenario_ids: scenarios.map((s) => s.id),
      caveats: "Text-level only: no speech recognition errors, timing or TTS. Scripted users do not adapt. Judge scores are a second opinion, not proof.",
    },
    summary: summarize(runs),
    runs,
  };
  const dir = resolve(HERE, arg("out", "results")!);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${result.meta.created.replace(/[:.]/g, "").slice(0, 15)}_${label}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1) + "\n");
  const s = result.summary;
  console.log(`\nscenarios with hard failures: ${s.scenarios_with_hard_failures}/${scenarios.length}, errors: ${s.errors}`);
  console.log("checks:", Object.entries(s.checks).map(([k, v]) => `${k}=${v.passed}/${v.n}${v.severity === "hard" ? "" : "~"}`).join("  "));
  console.log("judge:", Object.entries(s.judge).map(([k, v]) => `${k}=${v.mean}`).join("  "));
  console.log("metrics:", JSON.stringify(s.metrics), "top opening words:", s.top_opening_words.join(", "), "ROLLY self-gender:", JSON.stringify(s.rolly_self_gender));
  console.log(`saved ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
