/**
 * The evaluation framework itself (eval/): deterministic checks, runtime-mirror parity with the pod's Python, fixtures.
 * These tests do not call any model.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PipelineMirror, QUESTION_GUARD_NOTE, cleanForSpeech, endsWithQuestion } from "../eval/assemble.ts";
import { defaultChecks, scenarioChecks, type AgentTurn } from "../eval/checks.ts";
import { buildScenarioContext } from "../eval/run.ts";
import { SCENARIOS, addressingTimeline } from "../eval/scenarios.ts";
import { report } from "../eval/promptStats.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const PY = resolve(ROOT, ".venv/bin/python");
const turn = (idx: number, text: string): AgentTurn => ({ idx, text, userSaid: idx ? "x" : null, guardApplied: false });
const byId = (checks: { id: string; pass: boolean }[], id: string) => checks.find((c) => c.id === id)!;

describe("runtime mirror matches the pod pipeline (providers/modular/text.py)", () => {
  it.skipIf(!existsSync(PY))("QUESTION_GUARD_NOTE, ends_with_question and clean_for_speech agree with Python", () => {
    const samples = ["מה נשמע?", "סבבה. מה איתך? —", "ok.", "really?\" ", "שאלה? <end_session/>", "**bold** text 😀 here"];
    const out = execFileSync(PY, ["-c",
      "import json,sys; from providers.modular.text import QUESTION_GUARD_NOTE, ends_with_question, clean_for_speech; "
      + "s=json.loads(sys.argv[1]); print(json.dumps({'note': QUESTION_GUARD_NOTE, 'q': [ends_with_question(x) for x in s], 'c': [clean_for_speech(x) for x in s]}))",
      JSON.stringify(samples)], { cwd: ROOT, encoding: "utf8" });
    const py = JSON.parse(out) as { note: string; q: boolean[]; c: string[] };
    expect(QUESTION_GUARD_NOTE).toBe(py.note);
    expect(samples.map(endsWithQuestion)).toEqual(py.q);
    expect(samples.map(cleanForSpeech)).toEqual(py.c);
  });

  it("the guard note is added to the turn after a question and never stored in history", () => {
    const c = new PipelineMirror("SYS");
    c.commit("[journey_start]", "בוקר טוב! איך הלילה?");
    const { msgs, guardApplied } = c.messages("סבבה");
    expect(guardApplied).toBe(true);
    expect(msgs.at(-1)!.content.endsWith(QUESTION_GUARD_NOTE)).toBe(true);
    c.commit("סבבה", "יאללה.");
    expect(c.history.map((m) => m.content).join("\n")).not.toContain("Note for this turn");
    expect(c.messages("x").guardApplied).toBe(false);
  });

  it("a barge-in keeps only the heard words with a trailing dash", () => {
    const c = new PipelineMirror("SYS");
    c.commit("hi", "one two three four five six seven");
    c.truncateLastReply(3);
    expect(c.history.at(-1)!.content).toBe("one two three —");
  });
});

describe("deterministic checks", () => {
  const he = { language: "he" as const, addressingAt: () => null };

  it("flags spoken-gendered words while addressing is unknown, but not neutral phrasing or הלך/מלך", () => {
    expect(byId(defaultChecks([turn(0, "מה שלומך? מה עשית היום?")], he), "addressing_form").pass).toBe(false);
    expect(byId(defaultChecks([turn(0, "יאללה נדבר על זה. איך היה? המלך הלך הביתה.")], he), "addressing_form").pass).toBe(true);
  });

  it("feminine user: masculine forms fail, feminine forms pass", () => {
    const fem = { language: "he" as const, addressingAt: () => "feminine" as const };
    expect(byId(defaultChecks([turn(0, "אתה צריך לנסות את זה.")], fem), "addressing_form").pass).toBe(false);
    expect(byId(defaultChecks([turn(0, "את חייבת לנסות, תגידי לי איך היה.")], fem), "addressing_form").pass).toBe(true);
  });

  it("interviewing, menus, formulaic empathy and repeated openers are signals", () => {
    const t = [turn(0, "וואלה, מה נשמע?"), turn(1, "וואלה, ומה עוד?"), turn(2, "וואלה. אני מבין. יש חשק לדבר על עבודה או על ספורט?")];
    const c = defaultChecks(t, he);
    expect(byId(c, "no_consecutive_questions").pass).toBe(false);
    expect(byId(c, "no_menu_offer").pass).toBe(false);
    expect(byId(c, "no_formulaic_empathy").pass).toBe(false);
    expect(byId(c, "varied_openings").pass).toBe(false);
    expect(c.filter((x) => !x.pass).every((x) => x.severity === "signal")).toBe(true);
  });

  it("end marker is a hard failure unless the user asked to stop at that turn", () => {
    const t = [turn(0, "היי"), turn(1, "יאללה ביי, סע בזהירות. <end_session/>")];
    expect(byId(defaultChecks(t, he), "end_marker_only_on_request").pass).toBe(false);
    expect(byId(defaultChecks(t, { ...he, endExpectedAt: 1 }), "end_marker_only_on_request").pass).toBe(true);
    expect(scenarioChecks(t, [{ kind: "expect_end_marker", id: "e", turn: 1 }])[0]!.pass).toBe(true);
  });

  it("scenario checks select turns", () => {
    const t = [turn(0, "מה קורה עם אפליקציית ההסעות?"), turn(1, "סבבה."), turn(2, "המרתון? עזוב.")];
    expect(scenarioChecks(t, [{ kind: "expect_any", id: "a", turns: "opener", keywords: ["הסעות"] }])[0]!.pass).toBe(true);
    expect(scenarioChecks(t, [{ kind: "expect_none", id: "b", turns: { from: 2 }, keywords: ["מרתון"] }])[0]!.pass).toBe(false);
    expect(scenarioChecks(t, [{ kind: "max_question_turns", id: "c", turns: "all", max: 1 }])[0]!.pass).toBe(false);
  });
});

describe("scenario fixtures", () => {
  it("cover every behaviour the regression suite must protect", () => {
    const covered = new Set(SCENARIOS.flatMap((s) => s.covers));
    for (const c of ["onboarding", "proactive_initiation", "no_agenda", "constructive_disagreement", "user_challenges_opinion", "avoid_excessive_empathy",
      "no_automatic_agreement", "maintaining_initiative", "topic_transitions", "interruptions", "continuity", "hebrew_naturalness",
      "grammatical_addressing", "memory_personalization", "uncertain_speaker_attribution", "productivity_vs_casual"]) expect(covered).toContain(c);
  });

  it("build with the real prompt builder; ids are unique; addressing timeline switches on request", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      const b = buildScenarioContext(s);
      expect(b.system_prompt.length).toBeGreaterThan(1000);
      expect(b.opener_instruction).toBeTruthy();
    }
    const s15 = SCENARIOS.find((s) => s.id.startsWith("s15"))!;
    const at = addressingTimeline(s15);
    expect([at(0), at(1), at(2), at(3)]).toEqual([null, null, "feminine", "feminine"]);
  });

  it("prompt-debt report runs offline", () => {
    const r = report();
    expect(r.totals.instructions).toBeGreaterThan(0);
    expect(r.system_prompt.onboarding_he.chars).toBeGreaterThan(r.system_prompt.returning_en.chars);
  });
});
