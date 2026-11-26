import { describe, expect, it } from "vitest";
import { END_MARKER, NOTE, core } from "../src/persona/core.ts";
import { buildContext, emptyMemory, resolveLanguage, type MemoryView } from "../src/persona/promptBuilder.ts";
import { PROMPT } from "../src/memory/select.ts";

const now = new Date("2026-11-26T06:10:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const mem = (patch: Partial<MemoryView> = {}): MemoryView => ({ ...emptyMemory(), sessionCount: 3, ...patch });
/** rough token count: Latin text about four characters per token, Hebrew about 2.3 (checked against the model's own count) */
const tokens = (s: string) => { const he = (s.match(/[֐-׿]/g) ?? []).length; return Math.round((s.length - he) / 4 + he / 2.3); };

describe("the system prompt stays small (P1-D24)", () => {
  it("the persona alone is about 500 tokens", () => {
    expect(core("he").length).toBeLessThan(2_300);
    expect(tokens(core("he"))).toBeLessThan(600);
  });

  it("a full prompt never exceeds the budget, however much is stored about the user", () => {
    const long = (n: number, each: number) => Array.from({ length: n }, (_, i) => `פריט ${i} ` + "מילה ".repeat(Math.ceil(each / 5)));
    const big = mem({
      profile: { ...emptyMemory().profile, preferredName: "דני", interests: long(12, 60), preferences: Object.fromEntries(long(9, 300).map((v, i) => [`noted ${i}`, v])),
        addressing: { value: null, status: "unknown" } },
      goals: Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, kind: "goal" as const, content: "מטרה " + "א".repeat(200), status: "active" as const, stateNote: "מצב ".repeat(200), nextStep: "צעד ".repeat(100) })),
      facts: long(30, 200), tasks: long(20, 200).map((c, i) => ({ id: `t${i}`, content: c, createdAt: ago(i) })),
      summaries: Array.from({ length: 6 }, () => ({ content: "סיכום ".repeat(400), createdAt: ago(1) })),
      openTopics: long(10, 100), ideas: long(10, 100), progress: long(10, 100), candidates: long(9, 100).map((c, i) => ({ id: `c${i}`, content: c })),
      historyDigest: "היסטוריה ".repeat(400),
      agenda: { created_at: ago(1).toISOString(), session_id: null, items: [{ topic: "נושא ".repeat(60), take: "דעה ".repeat(100), why: "", kind: "fresh", ref_id: null }] },
    });
    for (const m of [big, { ...big, digest: "תקציר ".repeat(400) }]) {
      const ctx = buildContext(m, { language: "he", journey: { duration_min: 40 }, now, resume: undefined });
      expect(ctx.system_prompt.length).toBeLessThan(PROMPT.total);
      expect(tokens(ctx.system_prompt)).toBeLessThan(1_300);
      expect(ctx.opener_instruction!.length).toBeLessThan(700);
    }
    // a dropped connection adds the last turns, still within the budget
    const resumed = buildContext(big, { language: "he", now, resume: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "agent" as const : "user" as const, text: "משפט ".repeat(80) })) });
    expect(resumed.system_prompt.length).toBeLessThan(PROMPT.total + 900);
  });

  it("holds no plan, no list of open topics, no ideas, no unconfirmed items: those arrive as notes when they apply", () => {
    const m = mem({
      agenda: { created_at: ago(1).toISOString(), session_id: null, items: [{ topic: "הגיוס של לומה", take: "עדיף משקיע קטן שמאמין", why: "", kind: "follow_up", ref_id: null }, { topic: "ספורט", why: "", kind: "fresh", ref_id: null }] },
      openTopics: ["נושא פתוח כלשהו"], ideas: ["רעיון שמור"], candidates: [{ id: "c1", content: "אולי גר בחיפה" }], progress: ["התקדמות"],
      summaries: [{ content: "דובר על הגיוס.", createdAt: ago(1) }],
    });
    const ctx = buildContext(m, { language: "he", now });
    const p = ctx.system_prompt;
    for (const absent of ["נושא פתוח כלשהו", "רעיון שמור", "אולי גר בחיפה", "התקדמות", "ספורט", "עדיף משקיע קטן"]) expect(p).not.toContain(absent);
    expect(ctx.agenda.map((a) => a.topic)).toEqual(["הגיוס של לומה", "ספורט"]); // handed to the session, fed by notes
    expect(ctx.confirm).toBe("אולי גר בחיפה");
    expect(NOTE.confirm(ctx.confirm!)).toContain("אולי גר בחיפה");
    // the first item, with its take, opens the ride
    expect(ctx.opener_instruction).toContain('bring up "הגיוס של לומה"');
    expect(ctx.opener_instruction).toContain("עדיף משקיע קטן שמאמין");
  });
});

describe("what the prompt does say", () => {
  it("the persona: a friend with opinions, short turns, substance first, no bot-speak, nothing invented", () => {
    const c = core("he");
    for (const must of ["You are Rolly", "You have opinions", "about fifteen words", "Start with the substance", "No general wisdom about life",
      "Never apologise, never promise", "Never invent facts", "You cannot play music", "Others may be in the car", END_MARKER]) expect(c).toContain(must);
    // no Hebrew example phrases (the small model parrots them) and no "react first" rule (it produced the stock openers)
    expect(c).not.toMatch(/[֐-׿]/);
    expect(c.toLowerCase()).not.toContain("react");
    expect(core("en")).toContain("everyday spoken English");
    expect(core("auto")).toContain("turn by turn");
  });

  it("what is known about the user, compactly", () => {
    const p = buildContext(mem({
      profile: { ...emptyMemory().profile, preferredName: "דני", preferences: { "noted 1": "רוצה שרולי יהיה יוזם.", "noted 2": "לא כל שיחה רצינית" }, addressing: { value: "feminine", status: "confirmed" } },
      facts: ["עובדת על סטארט-אפ בשם לומה"], goals: [{ id: "g", kind: "goal", content: "לעבור לעבודה עצמאית.", status: "active", stateNote: "יש ארבעה לקוחות ברשימה.", nextStep: "להשלים לעשרה" },
        { id: "h", kind: "travel_goal", content: "ללמוד איטלקית", status: "paused", stateNote: null, nextStep: "למצוא פודקאסט" }],
      tasks: [{ id: "t", content: "להתקשר לרואה החשבון", createdAt: ago(2) }], summaries: [{ content: "דובר על הרשימה.", createdAt: ago(1) }, { content: "שיחה ישנה יותר", createdAt: ago(5) }],
    }), { language: "he", journey: { duration_min: 20 }, now }).system_prompt;
    expect(p).toContain("Their name: דני (you are Rolly). Address them in feminine forms (they asked for it)");
    expect(p).toContain("עובדת על סטארט-אפ בשם לומה");
    expect(p).toContain("How they want you to talk: רוצה שרולי יהיה יוזם; לא כל שיחה רצינית.");
    expect(p).toContain("A goal of theirs: לעבור לעבודה עצמאית. Where it stands: יש ארבעה לקוחות ברשימה. Next step: להשלים לעשרה");
    expect(p).toContain("A goal of theirs: ללמוד איטלקית (on hold: do not push it).");
    expect(p).not.toContain("למצוא פודקאסט");
    expect(p).toContain("Open tasks they asked you to keep: להתקשר לרואה החשבון.");
    expect(p).toContain("Last time (yesterday): דובר על הרשימה.");
    expect(p).not.toContain("שיחה ישנה יותר"); // one summary, not three
    expect(p).toContain("About 20 minutes until they arrive.");
  });

  it("addressing: neutral wording while unknown, nothing in English", () => {
    expect(buildContext(mem(), { language: "he", now }).system_prompt).toContain("without gendered second person");
    expect(buildContext(mem(), { language: "en", now }).system_prompt).not.toContain("gendered");
    expect(buildContext(mem({ profile: { ...emptyMemory().profile, addressing: { value: "masculine", status: "inferred" } } }), { language: "he", now }).system_prompt)
      .toContain("Address them in masculine forms; if they correct you, switch at once.");
  });

  it("the first ride: a short section instead of what is known, and a light opener", () => {
    const ctx = buildContext(emptyMemory(), { language: "he", now });
    expect(ctx.onboarding).toBe(true);
    expect(ctx.system_prompt).toContain("## First ride together");
    expect(ctx.system_prompt).not.toContain("## What you know about them");
    expect(ctx.opener_instruction).toContain("one light, specific question");
    expect(ctx.agenda).toEqual([]);
  });

  it("openers: the plan's first item, else last time, else something of its own; a task check asks lightly", () => {
    const withSummary = mem({ summaries: [{ content: "דובר על משהו.", createdAt: ago(1) }] });
    expect(buildContext(withSummary, { language: "he", now }).opener_instruction).toContain("what you talked about last time");
    expect(buildContext(mem(), { language: "he", now }).opener_instruction).toContain("one light, concrete thing you bring up yourself, as a statement");
    const check = mem({ agenda: { created_at: ago(1).toISOString(), session_id: null, items: [{ topic: "השיחה עם רואה החשבון", why: "", kind: "action_check", ref_id: null }] } });
    expect(buildContext(check, { language: "he", now }).opener_instruction).toContain("asking lightly whether it got done");
    expect(buildContext(withSummary, { language: "he", now, resume: [{ role: "user", text: "היי" }] }).opener_instruction).toContain("connection dropped");
    expect(buildContext(mem(), { language: "auto", now }).opener_instruction).toContain("Speak this opening in Hebrew.");
  });
});

describe("the language of a conversation never follows an app default", () => {
  it("an app that merely sends a language (older builds, the phone's system language) gets the profile's language", () => {
    expect(resolveLanguage({ language: "en" }, "he")).toEqual({ language: "he", chosen: null });
    expect(resolveLanguage({ language: "en", language_explicit: false }, "he").language).toBe("he");
    expect(resolveLanguage({}, "en").language).toBe("en");
  });
  it("Hebrew when nothing is known", () => {
    expect(resolveLanguage({ language: "en" }, null).language).toBe("he");
    expect(resolveLanguage({}, null).language).toBe("he");
  });
  it("the user's own choice wins, including automatic detection", () => {
    expect(resolveLanguage({ language: "en", language_explicit: true }, "he")).toEqual({ language: "en", chosen: "en" });
    expect(resolveLanguage({ language: "auto", language_explicit: true }, "he").language).toBe("auto");
    expect(resolveLanguage({ language: "xx" as never, language_explicit: true }, "he").language).toBe("he");
  });
});
