import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { END_MARKER, LANG, VOICE_STYLE } from "../src/persona/research.ts";
import { buildContext, emptyMemory, type MemoryView } from "../src/persona/promptBuilder.ts";
import { LEAD } from "../src/persona/phase1Sections.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const PY = resolve(ROOT, ".venv/bin/python");

describe("persona is identical to the research implementation", () => {
  it.skipIf(!existsSync(PY))("VOICE_STYLE, LANG and END_MARKER match memory/context.py", () => {
    const out = execFileSync(PY, ["-c",
      "import json; from memory.context import VOICE_STYLE, LANG, END_MARKER; print(json.dumps({'v':VOICE_STYLE,'l':LANG,'e':END_MARKER}))"],
    { cwd: ROOT, encoding: "utf8" });
    const py = JSON.parse(out) as { v: string; l: Record<string, [string, string]>; e: string };
    expect(VOICE_STYLE).toBe(py.v);
    expect(END_MARKER).toBe(py.e);
    expect(Object.fromEntries(Object.entries(LANG).map(([k, v]) => [k, [...v]]))).toEqual(py.l);
  });
});

describe("Rolly leads the conversation instead of interviewing (P1-D15)", () => {
  const withSession = (patch: Partial<MemoryView> = {}): MemoryView => ({ ...emptyMemory(), sessionCount: 1, ...patch });

  it("every conversation carries the lead section, first and later ones alike", () => {
    for (const mem of [emptyMemory(), withSession()]) {
      const ctx = buildContext(mem, { language: "he" });
      expect(ctx.system_prompt).toContain(LEAD);
      expect(ctx.system_prompt).toContain("Never ask two questions in a row");
      // last section, after the memory and the journey, where the small model weighs it most
      expect(ctx.system_prompt.trimEnd().endsWith(LEAD)).toBe(true);
      expect(ctx.system_prompt.indexOf(LEAD)).toBeGreaterThan(ctx.system_prompt.indexOf("## Current journey"));
    }
  });

  it("Rolly does not pretend to play music or use the phone", () => {
    expect(LEAD).toContain("You cannot play music");
    expect(LEAD).toContain("never pretend to do it");
  });

  it("the first conversation caps the getting-to-know questions and hands over to a topic", () => {
    const ctx = buildContext(emptyMemory(), { language: "he" });
    expect(ctx.onboarding).toBe(true);
    expect(ctx.system_prompt).toContain("at most two or three questions");
    expect(ctx.system_prompt).toContain("take it and run with it");
    expect(ctx.system_prompt).not.toContain("The main thing to explore");
  });

  it("later conversations ask about missing profile details at most once", () => {
    const ctx = buildContext(withSession(), { language: "he" });
    expect(ctx.onboarding).toBe(false);
    expect(ctx.system_prompt).toContain("At most one such question in the whole conversation");
  });

  it("with nothing known, the opener brings a topic as a statement instead of a question", () => {
    expect(buildContext(withSession(), { language: "he" }).opener_instruction)
      .toContain("said as a statement rather than a question");
    const known = withSession({ profile: { ...emptyMemory().profile, interests: ["פודקאסטים על היסטוריה"] } });
    expect(buildContext(known, { language: "he" }).opener_instruction).toContain("connected to their goals or interests");
  });

  it("the neutral Hebrew rule gives statement forms, not only questions", () => {
    expect(buildContext(emptyMemory(), { language: "he" }).system_prompt).toContain("it is not a reason to ask more questions");
  });
});
