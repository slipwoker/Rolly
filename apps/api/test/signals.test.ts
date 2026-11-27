import { describe, expect, it } from "vitest";
import { adaptAgenda, labelCalendarItems, normalizeAgendaItems, planNext } from "../src/memory/plan.ts";
import { PlanFeeder } from "../src/voice/planFeeder.ts";
import { readCalendar } from "../src/signals/calendar.ts";

const now = new Date("2026-11-27T08:00:00Z");
const stored = (items: any[]) => ({ created_at: now.toISOString(), session_id: null, items });

describe("calendar signals (P1-D41)", () => {
  it("keeps source and a valid expiry on a plan item, and drops a malformed date", () => {
    const [a, b] = normalizeAgendaItems([{ topic: "הפגישה", kind: "direction", source: "calendar", expires_at: "2026-12-04T10:00:00Z" }, { topic: "x", kind: "fresh", source: "sms", expires_at: "tomorrow" }]);
    expect(a).toMatchObject({ source: "calendar", expires_at: "2026-12-04" });
    expect(b!.source).toBeUndefined();
    expect(b!.expires_at).toBeUndefined();
  });

  it("an item about an event is dropped the day after it, not before", () => {
    const items = [{ topic: "אתמול", why: "", kind: "direction", ref_id: null, expires_at: "2026-11-26" }, { topic: "היום", why: "", kind: "direction", ref_id: null, expires_at: "2026-11-27" }, { topic: "בלי", why: "", kind: "fresh", ref_id: null }];
    expect(adaptAgenda(stored(items), { minutes: null, now }).map((i) => i.topic)).toEqual(["היום", "בלי"]);
  });

  it("the model cannot claim a calendar source when no calendar was read", async () => {
    const llm = { name: "fake", json: async () => ({ ms: 1, obj: { next_agenda: [{ topic: "פגישה", kind: "direction", source: "calendar", expires_at: "2026-12-04" }] } }) } as any;
    const turns = [{ idx: 0, role: "user", text: "היי", attribution: "primary", startedAt: 0 }] as any;
    const base = { summary: "s", language: "he", progress: [], goals: [], tasks: [], agenda: [] };
    expect((await planNext(llm, turns, base)).next_agenda[0]!.source).toBeUndefined();
    expect((await planNext(llm, turns, { ...base, calendar: ["2026-12-04 10:00 Investor"] })).next_agenda[0]!.source).toBe("calendar");
  });

  it("the model cannot claim mail or WhatsApp as a source: those items are made, and labelled, by code", async () => {
    const llm = { name: "fake", json: async () => ({ ms: 1, obj: { next_agenda: [{ topic: "משהו", kind: "direction", source: "whatsapp" }, { topic: "אחר", kind: "fresh", source: "mail" }] } }) } as any;
    const turns = [{ idx: 0, role: "user", text: "היי", attribution: "primary", startedAt: 0 }] as any;
    const p = await planNext(llm, turns, { summary: "s", language: "he", progress: [], goals: [], tasks: [], agenda: [], calendar: ["2026-12-04 10:00 משהו אחר"] });
    expect(p.next_agenda.map((i) => i.source ?? null)).not.toContain("whatsapp");
    expect(p.next_agenda.map((i) => i.source ?? null)).not.toContain("mail");
  });

  it("an item about an event always says so, a calendar 'task' is dropped, and the item expires with the event", () => {
    const cal = ["2026-12-04 10:00 פגישה עם משקיע - קרן אלפא (תל אביב)", "2026-11-30 09:00 טסט לרכב", "2026-12-03 14:00 שיחת צוות"];
    const items = labelCalendarItems([
      { topic: "הפגישה עם משקיע - קרן אלפא", why: "", kind: "follow_up", ref_id: null },
      { topic: "הטסט לרכב", why: "", kind: "action_check", ref_id: null },
      { topic: "שיחת צוות", take: "מעניין", why: "", kind: "fresh", ref_id: null },
      { topic: "שקט בנסיעה", why: "", kind: "fresh", ref_id: null },
      { topic: "המשימה שלי", why: "", kind: "action_check", ref_id: "t1" },
    ], cal);
    expect(items.map((i) => [i.topic, i.source ?? null, i.expires_at ?? null])).toEqual([
      ["הפגישה עם משקיע - קרן אלפא", "calendar", "2026-12-04"], ["שיחת צוות", "calendar", "2026-12-03"], ["שקט בנסיעה", null, null], ["המשימה שלי", null, null]]);
  });

  it("when the item comes from the calendar, Rolly is told to say so", () => {
    const note = new PlanFeeder([{ topic: "הפגישה עם המשקיע", kind: "direction", source: "calendar" }]).afterReply(null)!;
    expect(note.text).toContain("from their calendar");
    expect(new PlanFeeder([{ topic: "x", kind: "fresh" }]).afterReply(null)!.text).not.toContain("calendar");
  });

  it("reads the calendar only with consent, a connection and Google's answer; never the description", async () => {
    let calls = 0;
    const http = (async (url: string) => {
      calls++;
      if (url.includes("oauth2.googleapis.com/token")) return { ok: true, status: 200, json: { access_token: "t" } };
      return { ok: true, status: 200, json: { items: [{ summary: "Investor meeting", description: "SECRET NOTES", attendees: [{ email: "a@b.c" }], start: { dateTime: "2026-12-04T12:00:00Z" }, end: { dateTime: "2026-12-04T13:00:00Z" }, location: "Tel Aviv" }] } };
    }) as any;
    const mk = (consent: boolean, refresh: string | null) => ({ consent: async () => consent, connections: { googleRefresh: async () => refresh, dropGoogle: async () => {} }, google: { clientId: "i", clientSecret: "s", redirectUri: "r" }, http });
    expect(await readCalendar(mk(false, "rt"), "u", now, "Asia/Jerusalem")).toBeNull();
    expect(await readCalendar(mk(true, null), "u", now, "Asia/Jerusalem")).toBeNull();
    expect(calls).toBe(0); // nothing was fetched without consent and a connection
    const r = (await readCalendar(mk(true, "rt"), "u", now, "Asia/Jerusalem"))!;
    expect(r.read).toBe(1);
    expect(r.lines[0]).toContain("Investor meeting");
    expect(r.lines[0]).toContain("Tel Aviv");
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(JSON.stringify(r)).not.toContain("a@b.c");
  });
});
