import { describe, expect, it } from "vitest";
import { adaptAgenda, fallbackAgenda, normalizeAgendaItems, normalizePlan, type StoredAgenda } from "../src/memory/plan.ts";
import { sameStatement, score, selectWithinBudget, type Selectable } from "../src/memory/select.ts";

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
  it("what opened the last ride and was not taken up does not open this one", () => {
    const again = { ...stored(), opened_with: "הפגישה עם הלקוח" };
    expect(adaptAgenda(again, { minutes: null, now }).map((i) => i.topic)).toEqual(["רשימת עשרה לקוחות", "להתקשר לרואה החשבון", "הפגישה עם הלקוח"]);
    expect(adaptAgenda({ ...stored(), opened_with: "משהו אחר" }, { minutes: 10, now })[0]!.topic).toBe("הפגישה עם הלקוח");
  });
  it("a take is kept with its item", () => {
    expect(normalizeAgendaItems([{ topic: "הגיוס", take: "עדיף משקיע קטן שמאמין", kind: "follow_up" }, { topic: "ספורט" }])).toMatchObject([{ take: "עדיף משקיע קטן שמאמין" }, { topic: "ספורט" }]);
    expect(normalizeAgendaItems([{ topic: "ספורט" }])[0]).not.toHaveProperty("take");
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

describe("the same statement twice is one item", () => {
  it("ignores punctuation, niqqud and a word more or less in a long statement", () => {
    expect(sameStatement("להתקשר לרואה החשבון מחר בבוקר", "להתקשר לרואה החשבון מחר בבוקר.")).toBe(true);
    expect(sameStatement("לפתוח ניוזלטר שבועי ללקוחות", "לפתוח ניוזלטר שבועי ללקוחות שלי")).toBe(true);
    expect(sameStatement("Call the accountant tomorrow morning", "call the accountant, tomorrow morning!")).toBe(true);
    expect(sameStatement("דני", "דני.")).toBe(true);
  });
  it("is strict: related but different statements stay apart", () => {
    expect(sameStatement("עובד בבנק", "עובד בבנק לאומי")).toBe(false);
    expect(sameStatement("ללמוד ספרדית", "ללמוד איטלקית")).toBe(false);
    expect(sameStatement("להתקשר לרואה החשבון", "להתקשר לעורך הדין מחר")).toBe(false);
    expect(sameStatement("", "x")).toBe(false);
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
