/**
 * Compare two evaluation results (baseline -> candidate) and flag regressions.
 *
 *   npm run eval:compare -w @rolly/api -- eval/results/<baseline>.json eval/results/<candidate>.json [--fail-on-regression]
 *
 * A comparison is only meaningful with the same target model, judge model and scenario set; differences are printed.
 * Thresholds are deliberately loose: with temperature 0.6 and 1-3 repeats, small moves are noise. Read the transcripts.
 */
import { readFileSync } from "node:fs";

type Result = {
  meta: { label: string; commit: string; prompt_version: string; target: { model: string }; judge: { model: string } | null; judge_version?: string | null; repeats: number; scenario_ids: string[] };
  summary: {
    checks: Record<string, { severity: string; n: number; passed: number; rate: number }>;
    judge: Record<string, { n: number; mean: number | null }>;
    metrics: Record<string, number | null>;
    by_scenario: Record<string, { hard_failures: number; runs: number; judge_mean: number | null }>;
  };
};

const JUDGE_DROP = 0.5;
const SIGNAL_DROP = 0.2;

function main() {
  const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  if (!a || !b) { console.error("usage: compare <baseline.json> <candidate.json> [--fail-on-regression]"); process.exit(2); }
  const A = JSON.parse(readFileSync(a, "utf8")) as Result;
  const B = JSON.parse(readFileSync(b, "utf8")) as Result;
  const regressions: string[] = [];
  const f = (x: number | null | undefined) => (x == null ? "  -  " : x.toFixed(2).padStart(5));

  console.log(`baseline : ${A.meta.label} @${A.meta.commit} prompt ${A.meta.prompt_version} model ${A.meta.target.model} judge ${A.meta.judge?.model ?? "-"} x${A.meta.repeats}`);
  console.log(`candidate: ${B.meta.label} @${B.meta.commit} prompt ${B.meta.prompt_version} model ${B.meta.target.model} judge ${B.meta.judge?.model ?? "-"} x${B.meta.repeats}`);
  if (A.meta.target.model !== B.meta.target.model) console.log("WARNING: different target models - this compares models, not prompt versions");
  if ((A.meta.judge?.model ?? "") !== (B.meta.judge?.model ?? "")) console.log("WARNING: different judge models - judge scores are not comparable");
  else if ((A.meta.judge_version ?? "") !== (B.meta.judge_version ?? "")) console.log("WARNING: different judge rubric versions - re-judge one side (run.ts --rejudge) before comparing judge scores");
  if (A.meta.scenario_ids.join() !== B.meta.scenario_ids.join()) console.log("WARNING: different scenario sets - compare per scenario only");

  console.log("\nscenario                                   hard-fail runs   judge mean");
  for (const id of new Set([...Object.keys(A.summary.by_scenario), ...Object.keys(B.summary.by_scenario)])) {
    const x = A.summary.by_scenario[id], y = B.summary.by_scenario[id];
    const fr = (s?: { hard_failures: number; runs: number }) => (s ? `${s.hard_failures}/${s.runs}` : "-");
    let mark = "";
    if (x && y && y.hard_failures / y.runs > x.hard_failures / x.runs) { mark = "  << more hard failures"; regressions.push(`${id}: hard failures ${fr(x)} -> ${fr(y)}`); }
    if (x?.judge_mean != null && y?.judge_mean != null && y.judge_mean <= x.judge_mean - JUDGE_DROP) { mark += "  << judge drop"; regressions.push(`${id}: judge ${x.judge_mean} -> ${y.judge_mean}`); }
    console.log(`${id.padEnd(42)} ${fr(x).padStart(5)} -> ${fr(y).padEnd(5)} ${f(x?.judge_mean)} -> ${f(y?.judge_mean)}${mark}`);
  }

  console.log("\ncheck                                     baseline  candidate");
  for (const id of new Set([...Object.keys(A.summary.checks), ...Object.keys(B.summary.checks)])) {
    const x = A.summary.checks[id], y = B.summary.checks[id];
    const sev = (x ?? y)!.severity;
    let mark = "";
    if (x && y && ((sev === "hard" && y.rate < x.rate) || (sev !== "hard" && y.rate <= x.rate - SIGNAL_DROP))) {
      mark = "  <<"; regressions.push(`check ${id} (${sev}): ${x.rate} -> ${y.rate}`);
    }
    console.log(`${(id + (sev === "hard" ? "" : " ~")).padEnd(42)} ${f(x?.rate)}  ${f(y?.rate)}${mark}`);
  }

  console.log("\njudge criterion                           baseline  candidate");
  for (const id of new Set([...Object.keys(A.summary.judge), ...Object.keys(B.summary.judge)])) {
    const x = A.summary.judge[id]?.mean, y = B.summary.judge[id]?.mean;
    let mark = "";
    if (x != null && y != null && y <= x - JUDGE_DROP) { mark = "  <<"; regressions.push(`judge ${id}: ${x} -> ${y}`); }
    console.log(`${id.padEnd(42)} ${f(x)}  ${f(y)}${mark}`);
  }

  console.log("\nmetric                                    baseline  candidate");
  for (const id of Object.keys({ ...A.summary.metrics, ...B.summary.metrics })) {
    console.log(`${id.padEnd(42)} ${f(A.summary.metrics[id])}  ${f(B.summary.metrics[id])}`);
  }

  console.log(regressions.length ? `\n${regressions.length} possible regression(s):\n- ${regressions.join("\n- ")}` : "\nno regression beyond the thresholds");
  console.log("(~ = heuristic signal; judge thresholds: drop of 0.5 or more; read the transcripts before concluding)");
  if (regressions.length && process.argv.includes("--fail-on-regression")) process.exit(1);
}

main();
