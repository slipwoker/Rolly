import { describe, expect, it } from "vitest";
import { applyObservations, confirm, emptyEvidence, observe, type AddressingRecord } from "../src/memory/addressing.ts";
import { addressingLine } from "../src/persona/core.ts";
import { attributionFor } from "../src/voice/session.ts";

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
    expect(observe("הוא חושב שאני צודק")).toEqual([]); // "צודק" not after אני directly in the lexicon
    expect(observe("I think so")).toEqual([]);
  });
  it("detects explicit requests", () => {
    expect(observe("תדבר אליי בלשון נקבה בבקשה")).toEqual([{ form: "feminine", kind: "explicit", quote: "תדבר אליי בלשון נקבה בבקשה" }]);
    expect(observe("תפנה אליי בלשון זכר")[0]!.form).toBe("masculine");
    expect(observe("עדיף לפנות אליי בלשון רבים")[0]!.form).toBe("plural");
  });
});

describe("addressing state machine", () => {
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

describe("said in so many words", () => {
  it("'אני בת' / 'אני בן' decide at once, like an explicit request", () => {
    expect(observe("אני בת")).toEqual([{ form: "feminine", kind: "explicit", quote: "אני בת" }]);
    expect(observe("לא, אני אישה")[0]).toMatchObject({ form: "feminine", kind: "explicit" });
    expect(observe("תקשיב, אני גבר, כן?")[0]).toMatchObject({ form: "masculine", kind: "explicit" });
    expect(observe("אני בן שלושים וחמש")[0]).toMatchObject({ form: "masculine", kind: "explicit" });
    let r = feed(fresh(), ["אני חושב", "אני עייף", "אני בטוח"]); // inferred masculine from a mis-heard conversation
    r = feed(r, ["אני בת"]);
    expect(r).toMatchObject({ value: "feminine", status: "confirmed" });
  });
  it("is not triggered by 'אני בן אדם', a negation, or both in one sentence", () => {
    expect(observe("אני בן אדם, לא רובוט")).toEqual([]);
    expect(observe("אני לא בת")).toEqual([]);
    expect(observe("אז אתה בת או בן?")).toEqual([]); // asked about Rolly
    expect(observe("אני בת או אני בן, מה זה משנה").filter((o) => o.kind === "explicit")).toEqual([]);
  });
  it("'מתכנת' no longer counts: speech recognition hears it for 'מתכננת'", () => {
    expect(observe("מה אני מתכנת לעשות שם")).toEqual([]);
    expect(observe("אני מהנדס")[0]).toMatchObject({ form: "masculine", kind: "self_noun" });
  });
});

describe("whose voice: only a much quieter utterance is a hint of someone else", () => {
  it("a loud utterance is the owner speaking up; a faint one may be a passenger", () => {
    expect(attributionFor({ level_db: -17.6, ref_level_db: -29 })).toEqual({ attribution: "primary" });
    expect(attributionFor({ level_db: -41.6, ref_level_db: -27 })).toEqual({ attribution: "uncertain", why: "much_quieter_than_reference" });
    expect(attributionFor({ level_db: -25, ref_level_db: -27 })).toEqual({ attribution: "primary" });
    expect(attributionFor({ level_db: -25, ref_level_db: null })).toEqual({ attribution: "primary" });
  });
});

describe("addressing line in the prompt", () => {
  it("neutral wording while unknown, the form once known, nothing for English", () => {
    expect(addressingLine({ value: null, status: "unknown" }, "he")).toContain("never ask about it");
    expect(addressingLine({ value: "feminine", status: "inferred" }, "he")).toContain("feminine");
    expect(addressingLine({ value: "feminine", status: "confirmed" }, "en")).toBeNull();
  });
});
