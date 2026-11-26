import { describe, expect, it } from "vitest";
import { applyObservations, confirm, emptyEvidence, observe, type AddressingRecord } from "../src/memory/addressing.ts";
import { addressingLine } from "../src/persona/core.ts";

const fresh = (): AddressingRecord => ({ value: null, status: "unknown", evidence: emptyEvidence() });
const feed = (rec: AddressingRecord, texts: string[], attribution: "primary" | "uncertain" = "primary") =>
  texts.reduce((r, t) => applyObservations(r, observe(t), attribution), rec);

describe("observe()", () => {
  it("finds gendered self-references", () => {
    expect(observe("אני חושבת שזה רעיון טוב").map((o) => o.form)).toEqual(["feminine"]);
    expect(observe("אני ממש עייף היום").map((o) => o.form)).toEqual(["masculine"]);
    expect(observe("אני לא בטוחה").map((o) => o.form)).toEqual(["feminine"]);
    expect(observe("הייתי לחוצה אתמול").map((o) => o.form)).toEqual(["feminine"]);
  });
  it("ignores ungendered forms: past tense, neutral present, other people", () => {
    expect(observe("עשיתי את זה אתמול")).toEqual([]);
    expect(observe("אני רוצה לדבר על העבודה")).toEqual([]);
    expect(observe("אני מנסה")).toEqual([]);
    expect(observe("הוא חושב")).toEqual([]);
    expect(observe("I think so")).toEqual([]);
  });
  it("reads common spoken forms: dropped pronoun, repeated pronoun, everyday words", () => {
    expect(observe("וואלה, לא יודע, משהו כזה").map((o) => o.form)).toEqual(["masculine"]);
    expect(observe("לא בטוחה.").map((o) => o.form)).toEqual(["feminine"]);
    expect(observe("אני אני אמור לנסוע שבוע הבא").map((o) => o.form)).toEqual(["masculine"]);
    expect(observe("אין לי מושג, אני לא מכיר את רומא.").map((o) => o.form)).toEqual(["masculine"]);
    expect(observe("ואני קצת רדומה עכשיו").map((o) => o.form)).toEqual(["feminine"]);
    expect(observe("אני בת 35").map((o) => o.form)).toEqual(["feminine"]);
  });
  it("does not read a dropped pronoun in a question, mid-sentence or about someone else", () => {
    expect(observe("לא יודע?")).toEqual([]);
    expect(observe("הוא לא יודע")).toEqual([]);
    expect(observe("אתה לא יודע")).toEqual([]);
    expect(observe("בואו נדבר על לא יודע מה")).toEqual([]);
    expect(observe("אני בן אדם")).toEqual([]);
  });
  it("detects explicit requests", () => {
    expect(observe("תדבר אליי בלשון נקבה בבקשה")).toEqual([{ form: "feminine", kind: "explicit", quote: "תדבר אליי בלשון נקבה בבקשה" }]);
    expect(observe("תפנה אליי בלשון זכר")[0]!.form).toBe("masculine");
    expect(observe("עדיף לפנות אליי בלשון רבים")[0]!.form).toBe("plural");
  });
});

describe("addressing state machine", () => {
  it("infers from a real ride where the pronoun is mostly dropped", () => {
    const r = feed(fresh(), ["‫לא יודע, מה התוכנית להיום?", "אני אני אמור לנסוע שבוע הבא לאיטליה", "אין לי מושג, אני לא מכיר את רומא."]);
    expect(r).toMatchObject({ value: "masculine", status: "inferred" });
  });

  it("stays unknown below the threshold, infers with consistent evidence", () => {
    let r = feed(fresh(), ["אני חושבת שכן", "אני עייפה"]);
    expect(r.status).toBe("unknown");
    expect(r.value).toBeNull();
    r = feed(r, ["אני לא בטוחה"]);
    expect(r).toMatchObject({ value: "feminine", status: "inferred" });
    expect(r.evidence.feminine).toBe(3);
  });

  it("contradictory evidence returns to neutral", () => {
    let r = feed(fresh(), ["אני חושב", "אני עייף", "אני בטוח"]);
    expect(r).toMatchObject({ value: "masculine", status: "inferred" });
    r = feed(r, ["אני חושבת", "אני עייפה"]);
    expect(r).toMatchObject({ value: null, status: "unknown" });
  });

  it("uncertain-speaker evidence never changes the stored preference", () => {
    let r = feed(fresh(), ["אני חושב", "אני עייף", "אני בטוח"]);
    const before = { value: r.value, status: r.status };
    r = feed(r, ["אני חושבת", "אני עייפה", "אני בטוחה", "תדבר אליי בלשון נקבה"], "uncertain");
    expect({ value: r.value, status: r.status }).toEqual(before);
    expect(r.evidence.ignored_uncertain).toBe(4);
  });

  it("explicit request confirms immediately and later self-references do not override it", () => {
    let r = feed(fresh(), ["אני חושב", "אני עייף", "אני בטוח"]);
    r = feed(r, ["רגע, תדבר אליי בלשון נקבה"]);
    expect(r).toMatchObject({ value: "feminine", status: "confirmed" });
    r = feed(r, ["אני חושב", "אני עייף", "אני בטוח", "אני מוכן"]);
    expect(r).toMatchObject({ value: "feminine", status: "confirmed" });
  });

  it("app correction confirms; reset returns to unknown", () => {
    let r = confirm(fresh(), "plural");
    expect(r).toMatchObject({ value: "plural", status: "confirmed" });
    r = confirm(r, null);
    expect(r).toMatchObject({ value: null, status: "unknown" });
  });
});

describe("addressing line in the prompt", () => {
  it("neutral wording while unknown, the form once known, nothing for English", () => {
    expect(addressingLine({ value: null, status: "unknown" }, "he")).toContain("never ask about it");
    expect(addressingLine({ value: "feminine", status: "inferred" }, "he")).toContain("feminine");
    expect(addressingLine({ value: "feminine", status: "confirmed" }, "en")).toBeNull();
  });
});
