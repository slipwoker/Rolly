import { describe, expect, it } from "vitest";
import { normalizeAgendaItems } from "../src/memory/plan.ts";
import { decide } from "../src/memory/policy.ts";
import { PlanFeeder } from "../src/voice/planFeeder.ts";
import type { Item } from "../src/memory/summarizer.ts";
import type { SessionTurn } from "../src/voice/session.ts";

const turn = (idx: number, role: "user" | "agent", text: string, attribution: "primary" | "uncertain" = "primary"): SessionTurn =>
  ({ idx, role, text, attribution, startedAt: 0 } as unknown as SessionTurn);
const item = (patch: Partial<Item>): Item => ({ content: "להגיע מוכן לפגישה עם המשקיע", confidence: 0.4, first_person: false, turn: 3, quote: "כן בדיוק", confirmed: true, ...patch });

describe("a direction becomes a goal only through the user's own yes", () => {
  it("keeps at most one direction item per plan", () => {
    const items = normalizeAgendaItems([{ topic: "a", kind: "direction" }, { topic: "b", kind: "direction" }, { topic: "c", kind: "fresh" }]);
    expect(items.map((i) => [i.topic, i.kind])).toEqual([["a", "direction"], ["c", "fresh"]]);
  });

  it("the direction item is only an observation; the say-it-back note comes after they engage, once", () => {
    const f = new PlanFeeder([{ topic: "הפגישה עם המשקיע", take: "מה חסר לכם?", kind: "direction" }, { topic: "ספורט", kind: "fresh" }]);
    const first = f.afterReply(null)!;
    expect(first.text).not.toContain("goal");
    expect(f.afterReply(2)?.text ?? "").not.toContain("goal"); // shown on a short answer; the next plan item is queued, nothing about a goal
    // a one-word answer: nothing about a goal
    expect(f.afterReply(1)?.text ?? "").not.toContain("keep it as a goal");
    // they engage with a long turn: the note to say the goal back comes
    const note = f.afterReply(9);
    expect(note?.text).toContain("keep it as a goal");
    // and only once
    for (const w of [12, 15, 20]) expect(f.afterReply(w)?.text ?? "").not.toContain("keep it as a goal");
  });

  const turns = [turn(1, "agent", "אז היעד לשבוע הקרוב זה להגיע מוכנים. להחזיק את זה כמטרה?"), turn(2, "user", "כן בדיוק")];
  it("an agreement in reply to an agent turn makes it active even at low confidence and without first person", () => {
    expect(decide(item({ turn: 2 }), turns, { otherSpeakersSuspected: true })).toMatchObject({ status: "active", reason: "user_confirmed_phrasing" });
  });
  it("not when the agreeing turn may be someone else's, or when no agent turn came before it, or when the model did not mark it", () => {
    expect(decide(item({ turn: 2 }), [turns[0]!, turn(2, "user", "כן בדיוק", "uncertain")], { otherSpeakersSuspected: false }).status).toBe("candidate");
    expect(decide(item({ turn: 2 }), [turn(1, "user", "משהו"), turns[1]!], { otherSpeakersSuspected: false }).status).toBe("candidate");
    expect(decide(item({ turn: 2, confirmed: false }), turns, { otherSpeakersSuspected: false }).status).toBe("candidate");
  });
});
