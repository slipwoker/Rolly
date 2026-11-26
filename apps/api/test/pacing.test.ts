import { describe, expect, it } from "vitest";
import { Pacer, parseRemainingMinutes, schedule } from "../src/voice/pacing.ts";

const MIN = 60_000;

describe("schedule()", () => {
  it("a 20-minute ride: halfway at 11, wrap-up 3 minutes before the end, last word 1 minute before", () => {
    expect(schedule(20 * MIN)).toEqual({ half: 11 * MIN, wrap: 17 * MIN, last: 19 * MIN });
  });
  it("short rides get fewer nudges, very short ones none", () => {
    const s = schedule(5 * MIN);
    expect(s.half).toBeUndefined();
    expect(s.wrap).toBe(3 * MIN);
    expect(s.last).toBe(5 * MIN - 45_000);
    expect(schedule(90_000)).toEqual({});
  });
});

describe("Pacer", () => {
  it("fires each nudge once, in order, and nothing without an expected length", () => {
    const p = new Pacer(0, 20);
    expect(p.due(10 * MIN)).toEqual([]);
    expect(p.due(11 * MIN).map((n) => n.event)).toEqual(["half"]);
    expect(p.due(12 * MIN)).toEqual([]);
    expect(p.due(17 * MIN).map((n) => n.event)).toEqual(["wrap"]);
    expect(p.due(19 * MIN + 1).map((n) => n.event)).toEqual(["last"]);
    expect(p.due(40 * MIN)).toEqual([]);
    const none = new Pacer(0, null);
    expect(none.active).toBe(false);
    expect(none.due(60 * MIN)).toEqual([]);
  });
  it("after a long gap only the latest overdue nudge is sent", () => {
    const p = new Pacer(0, 20);
    expect(p.due(19.5 * MIN).map((n) => n.event)).toEqual(["last"]);
    expect(p.due(20 * MIN)).toEqual([]);
  });
  it("the user's 'five minutes left' resets the clock; a longer ride lets nudges come again", () => {
    const p = new Pacer(0, 40);
    p.setRemaining(5, 10 * MIN); // ends at 15: wrap at 12, last at 14
    expect(p.remainingMs(10 * MIN)).toBe(5 * MIN);
    expect(p.due(10 * MIN)).toEqual([]); // "half" (8.25) is behind and wrap is ahead: nothing to replay
    expect(p.due(12 * MIN).map((n) => n.event)).toEqual(["wrap"]);
    p.setRemaining(20, 13 * MIN); // traffic: ends at 33, wrap at 30
    expect(p.due(14 * MIN)).toEqual([]);
    expect(p.due(30 * MIN).map((n) => n.event)).toEqual(["wrap"]);
    const q = new Pacer(0, null); // no chip chosen: the spoken time starts the pacing
    q.setRemaining(10, 2 * MIN);
    expect(q.active).toBe(true);
    expect(q.due(9 * MIN).map((n) => n.event)).toEqual(["wrap"]);
  });
  it("a time scale compresses everything (self-tests)", () => {
    const p = new Pacer(0, 20, 0.1);
    expect(p.due(1.1 * MIN).map((n) => n.event)).toEqual(["half"]);
    expect(p.due(1.7 * MIN).map((n) => n.event)).toEqual(["wrap"]);
  });
});

describe("parseRemainingMinutes()", () => {
  it.each([
    ["עוד רבע שעה אני מגיע", 15], ["יש לי חמש דקות", 5], ["נשארו לי עשרים וחמש דקות", 25], ["עוד חצי שעה אנחנו שם", 30],
    ["אני מגיע בעוד 12 דקות", 12], ["עוד שתי דקות אני שם", 2], ["עוד דקה אני מגיע", 1], ["נשארה לי שעה", 60], ["עוד עשר דקות", 10],
    ["I have about ten minutes left", 10], ["we'll be there in 25 minutes", 25], ["another half an hour", 30], ["I've got twenty five minutes", 25],
  ])("%s -> %i", (text, minutes) => { expect(parseRemainingMinutes(text)).toBe(minutes); });

  it.each([
    "דיברתי איתו עשר דקות", "הפגישה הייתה שעה", "מה נשמע", "אני מגיע מחר", "the meeting took ten minutes", "five minutes of fame", "",
  ])("not about the ride: %s", (text) => { expect(parseRemainingMinutes(text)).toBeNull(); });
});
