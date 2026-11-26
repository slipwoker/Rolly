import { describe, expect, it } from "vitest";
import { adaptAgenda, fallbackAgenda, normalizeAgendaItems, normalizePlan, type StoredAgenda } from "../src/memory/plan.ts";
import { BUDGET, score, selectWithinBudget, type Selectable } from "../src/memory/select.ts";
import { buildContext, emptyMemory, type MemoryView } from "../src/persona/promptBuilder.ts";
import { LEAD, NOTES } from "../src/persona/phase1Sections.ts";

const DAY = 86_400_000;
const now = new Date("2026-11-26T08:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const stored = (days = 1): StoredAgenda => ({
  created_at: ago(days).toISOString(), session_id: null,
  items: [
    { topic: "הפגישה עם הלקוח", why: "נשאר פתוח", kind: "follow_up", ref_id: null },
    { topic: "רשימת עשרה לקוחות", why: "הצעד הבא במעבר לעצמאות", kind: "goal_step", ref_id: "g1" },
    { topic: "להתקשר לרואה החשבון", why: "", kind: "action_check", ref_id: "t1" },
  ],
});

describe("the plan for a ride", () => {
  it("is cut to the time there is", () => {
    expect(adaptAgenda(stored(), { minutes: 10, now }).map((i) => i.kind)).toEqual(["follow_up"]);
    expect(adaptAgenda(stored(), { minutes: 20, now })).toHaveLength(2);
    expect(adaptAgenda(stored(), { minutes: 40, now })).toHaveLength(3);
    expect(adaptAgenda(stored(), { minutes: null, now })).toHaveLength(3);
    expect(adaptAgenda(null, { minutes: 20, now })).toEqual([]);
  });
  it("after a week, 'where we stopped' gives way to goals; after a month it is dropped with the task check", () => {
    expect(adaptAgenda(stored(9), { minutes: 10, now }).map((i) => i.kind)).toEqual(["goal_step"]);
    expect(adaptAgenda(stored(40), { minutes: null, now }).map((i) => i.kind)).toEqual(["goal_step"]);
  });
  it("items about a goal or task that is gone are dropped", () => {
    expect(adaptAgenda(stored(), { minutes: null, now, validRefs: new Set(["g1"]) }).map((i) => i.kind)).toEqual(["follow_up", "goal_step"]);
  });
  it("normalises model output: unknown ids, at most one task check, three items", () => {
    const items = normalizeAgendaItems([
      { topic: "a", kind: "action_check", ref_id: "t1" }, { topic: "b", kind: "action_check", ref_id: "t2" },
      { topic: "c", kind: "weird", ref_id: "nope" }, { topic: "" }, { topic: "d", kind: "fresh" }, { topic: "e" },
    ], new Set(["t1", "t2"]));
    expect(items.map((i) => [i.topic, i.kind, i.ref_id])).toEqual([["a", "action_check", "t1"], ["c", "fresh", null], ["d", "fresh", null]]);
    const plan = normalizePlan({
      goal_updates: [{ goal_id: "g1", state_note: "x", status: "achieved", status_turn: 3, status_quote: "q", progress: [0, "1", -2, 1.5] }, { goal_id: "unknown", state_note: "y" }],
      completed_action_items: [{ id: "t1", turn: 2, quote: "עשיתי" }, { id: "t9" }], agenda_outcome: [{ index: 0, outcome: "done" }, { outcome: "skipped" }],
      next_agenda: [{ topic: "n", kind: "goal_step", ref_id: "g1" }],
    }, { goals: new Set(["g1"]), tasks: new Set(["t1"]) });
    expect(plan.goal_updates).toHaveLength(1);
    expect(plan.goal_updates[0]).toMatchObject({ goal_id: "g1", status: "achieved", progress: [0, 1] });
    expect(plan.completed_action_items.map((c) => c.id)).toEqual(["t1"]);
    expect(plan.agenda_outcome).toEqual([{ index: 0, outcome: "done" }]);
    expect(plan.next_agenda[0]!.ref_id).toBe("g1");
  });
  it("without a model there is still a plan: open topic, a goal's next step, one task", () => {
    const items = fallbackAgenda({
      openTopics: ["איך להתחיל ללמוד איטלקית"], tasks: [{ id: "t1", content: "להתקשר לרואה החשבון" }],
      goals: [{ id: "g0", content: "מושהה", nextStep: "x", status: "paused" }, { id: "g1", content: "מעבר לעצמאות", nextStep: "רשימת לקוחות", status: "active" }],
    });
    expect(items.map((i) => [i.kind, i.ref_id])).toEqual([["follow_up", null], ["goal_step", "g1"], ["action_check", "t1"]]);
    expect(fallbackAgenda({ openTopics: [], tasks: [], goals: [] })).toEqual([]);
  });
});

describe("the plan, goals, tasks and ideas in the prompt", () => {
  const mem = (patch: Partial<MemoryView> = {}): MemoryView => ({ ...emptyMemory(), sessionCount: 3, ...patch });
  const full = mem({
    agenda: stored(),
    goals: [
      { id: "g1", kind: "goal", content: "מעבר לעבודה עצמאית", status: "active", stateNote: "יש ארבעה לקוחות אפשריים ברשימה.", nextStep: "להשלים לעשרה" },
      { id: "g2", kind: "travel_goal", content: "ללמוד איטלקית", status: "paused", stateNote: null, nextStep: "למצוא פודקאסט" },
    ],
    tasks: [{ id: "t1", content: "להתקשר לרואה החשבון", createdAt: ago(3) }], ideas: ["ניוזלטר שבועי ללקוחות"],
    digest: "דני, יועץ שעובר לעצמאות.", historyDigest: "בעבר דובר על עזיבת העבודה.", summaries: [{ content: "דובר על רשימת הלקוחות.", createdAt: ago(1) }],
  });

  it("puts the plan right before LEAD, numbered, and tells the model it is a plan, not a script", () => {
    const ctx = buildContext(full, { language: "he", journey: { duration_min: 20 }, now });
    const p = ctx.system_prompt;
    expect(ctx.agenda.map((a) => a.topic)).toEqual(["הפגישה עם הלקוח", "רשימת עשרה לקוחות"]); // 20 minutes: two items
    expect(p).toContain("## Your plan for this ride");
    expect(p).toContain("1. הפגישה עם הלקוח (נשאר פתוח)");
    expect(p).toContain("2. רשימת עשרה לקוחות");
    expect(p).not.toContain("להתקשר לרואה החשבון [ask once");
    expect(p).toContain("It is a plan, not a script");
    expect(p.indexOf("## Your plan for this ride")).toBeGreaterThan(p.indexOf("## Current journey"));
    expect(p.trimEnd().endsWith(LEAD)).toBe(true);
    expect(ctx.opener_instruction).toContain('first item of your plan for this ride ("הפגישה עם הלקוח")');
  });
  it("a task check in the plan is marked 'ask once, lightly'", () => {
    const p = buildContext(full, { language: "he", now }).system_prompt;
    expect(p).toContain("3. להתקשר לרואה החשבון [ask once, lightly; if it is not done, do not push]");
  });
  it("shows where each goal stands, paused goals without a push, tasks with their age, ideas and digests", () => {
    const p = buildContext(full, { language: "he", now }).system_prompt;
    expect(p).toContain("- מעבר לעבודה עצמאית Where it stands: יש ארבעה לקוחות אפשריים ברשימה. Next step: להשלים לעשרה");
    expect(p).toContain("- ללמוד איטלקית (on hold for now: do not push it)");
    expect(p).not.toContain("למצוא פודקאסט"); // no next step for a paused goal
    expect(p).toContain("- להתקשר לרואה החשבון (3 days ago)");
    expect(p).toContain("Ideas the user asked you to keep:\n- ניוזלטר שבועי ללקוחות");
    expect(p).toContain("In short: דני, יועץ שעובר לעצמאות.");
    expect(p).toContain("- (earlier conversations) בעבר דובר על עזיבת העבודה.");
    expect(p).toContain(NOTES);
  });
  it("no plan in the first conversation, after a dropped connection, or when none is stored", () => {
    expect(buildContext({ ...full, sessionCount: 0 }, { language: "he", now }).system_prompt).not.toContain("## Your plan for this ride");
    expect(buildContext(full, { language: "he", now, resume: [{ role: "user", text: "היי" }] }).system_prompt).not.toContain("## Your plan for this ride");
    const none = buildContext(mem({ summaries: full.summaries }), { language: "he", now });
    expect(none.system_prompt).not.toContain("## Your plan for this ride");
    expect(none.opener_instruction).toContain("unresolved thing from your memory");
  });
  it("stays within the prompt budget with every section full, however long the stored text is", () => {
    const long = (n: number, chars: number) => { const each = Math.floor(chars / n); return Array.from({ length: n }, (_, i) => `פריט ${i} ` + "מ".repeat(Math.max(1, each - 8))); };
    const big = mem({
      agenda: stored(), goals: Array.from({ length: BUDGET.goals.maxItems }, (_, i) => ({ id: `g${i}`, kind: "goal" as const, content: "מטרה " + "א".repeat(60), status: "active" as const, stateNote: "ב ".repeat(400), nextStep: "ג ".repeat(300) })),
      facts: long(BUDGET.facts.maxItems, BUDGET.facts.maxChars), openTopics: long(BUDGET.openTopics.maxItems, BUDGET.openTopics.maxChars), ideas: long(BUDGET.ideas.maxItems, BUDGET.ideas.maxChars),
      tasks: long(BUDGET.tasks.maxItems, BUDGET.tasks.maxChars).map((c, i) => ({ id: `t${i}`, content: c, createdAt: ago(i) })),
      summaries: Array.from({ length: 6 }, () => ({ content: "ס ".repeat(900), createdAt: ago(2) })), progress: long(8, 640),
      candidates: long(9, 540).map((c, i) => ({ id: `c${i}`, content: c })), digest: "ד ".repeat(2000), historyDigest: "ה ".repeat(2000),
      profile: { ...emptyMemory().profile, preferredName: "דני", interests: long(BUDGET.interests.maxItems, BUDGET.interests.maxChars), preferences: { a: "ב".repeat(BUDGET.preferences.maxChars) } },
    });
    const fixed = buildContext(mem(), { language: "he", now }).system_prompt.length;
    const p = buildContext(big, { language: "he", journey: { duration_min: 40 }, now }).system_prompt;
    // the memory part with the plan: at most ~7,200 characters, mostly Hebrew at about 2.5 characters per token, so about
    // 2,700 tokens on top of the fixed instructions (~2,300): the whole prompt stays near 5,000 tokens of the model's 16k window
    expect(p.length - fixed).toBeLessThan(7_200);
    expect(fixed).toBeLessThan(9_000);
  });
});

describe("which memories go into the prompt", () => {
  const m = (id: string, patch: Partial<Selectable> = {}): Selectable => ({ id, content: `fact ${id}`, createdAt: ago(1), ...patch });
  it("importance outweighs recency: a central old fact beats a passing new one", () => {
    expect(score(m("old", { createdAt: ago(60), importance: 3 }), now)).toBeGreaterThan(score(m("new", { createdAt: ago(0), importance: 1 }), now));
  });
  it("confirmed and long-unused items get a lift; something just mentioned again counts as recent", () => {
    expect(score(m("a", { confirmed: true }), now)).toBeGreaterThan(score(m("b"), now));
    expect(score(m("rested", { lastUsedAt: ago(20) }), now)).toBeGreaterThan(score(m("used", { lastUsedAt: ago(1) }), now));
    expect(score(m("again", { createdAt: ago(90), updatedAt: ago(0) }), now)).toBeGreaterThan(score(m("stale", { createdAt: ago(90) }), now));
  });
  it("takes the best within the budget, lets short items through after a long one, returns newest first", () => {
    const items = [
      m("central", { createdAt: ago(100), importance: 3 }), m("minor1", { createdAt: ago(2), importance: 1, lastUsedAt: ago(1) }),
      m("minor2", { createdAt: ago(3), importance: 1, lastUsedAt: ago(1) }), m("huge", { createdAt: ago(0), importance: 2, content: "x".repeat(500) }),
      m("useful", { createdAt: ago(5), importance: 2 }),
    ];
    const picked = selectWithinBudget(items, { maxItems: 3, maxChars: 100 }, now).map((x) => x.id);
    expect(picked).toContain("central");
    expect(picked).toContain("useful");
    expect(picked).not.toContain("huge"); // does not fit
    expect(picked).toHaveLength(3);
    expect(picked[picked.length - 1]).toBe("central"); // oldest last
  });
});
