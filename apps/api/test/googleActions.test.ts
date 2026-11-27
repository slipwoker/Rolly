/** Sending email and adding calendar events: the draft -> read back -> later yes rule, the safety checks, and the Google calls. */
import { describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.ts";
import type { UtilityLlm } from "../src/memory/llm.ts";
import { GoogleActions } from "../src/integrations/actions.ts";
import { addMinutesLocal, EMAIL, findPeople, rawMessage, zonedToDate } from "../src/integrations/googleWrite.ts";
import { grants, SCOPE_CALENDAR_EVENTS, SCOPE_GMAIL_READ, SCOPE_GMAIL_SEND } from "../src/integrations/google.ts";
import { runTool, parsePlan } from "../src/integrations/tools.ts";

const NOW = new Date("2026-11-27T14:00:00Z"); // 16:00 in Jerusalem, a Friday
const TZ = "Asia/Jerusalem";
const ALL = [SCOPE_CALENDAR_EVENTS, SCOPE_GMAIL_READ, SCOPE_GMAIL_SEND].join(" ");
const ok = (json: unknown) => ({ ok: true, status: 200, json });

function google(over: Record<string, (u: string, i?: Parameters<Http>[1]) => ReturnType<Http>> = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const routes: Record<string, (u: string, i?: Parameters<Http>[1]) => ReturnType<Http>> = {
    "https://oauth2.googleapis.com/token": () => Promise.resolve(ok({ access_token: "at" })),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": () => Promise.resolve(ok({ id: "m" })),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?": () => Promise.resolve(ok({ messages: [{ id: "m1" }, { id: "m2" }] })),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": () => Promise.resolve(ok({ payload: { headers: [{ name: "From", value: "\"Dana Levi\" <Dana@Example.com>" }, { name: "To", value: "me@x.com" }] } })),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/m2": () => Promise.resolve(ok({ payload: { headers: [{ name: "From", value: "Dana Levi <dana@example.com>" }] } })),
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates": () => Promise.resolve(ok({ id: "e" })),
    "https://www.googleapis.com/calendar/v3/calendars/primary/events": () => Promise.resolve(ok({ items: [] })),
    ...over,
  };
  const http: Http = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? (() => { try { return JSON.parse(init.body!); } catch { return init.body; } })() : null });
    const k = Object.keys(routes).sort((a, b) => b.length - a.length).find((r) => url.startsWith(r));
    if (!k) throw new Error("unexpected " + url);
    return routes[k]!(url, init);
  };
  return { http, calls, sends: () => calls.filter((c) => c.url.endsWith("/messages/send")), creates: () => calls.filter((c) => c.method === "POST" && c.url.includes("/calendar/v3/calendars/primary/events")) };
}

const actions = (h: Http, o: { scopes?: string | null; refresh?: string | null } = {}) => new GoogleActions({ http: h, cfg: { clientId: "c", clientSecret: "s", redirectUri: "r" }, timeZone: TZ, now: () => NOW,
  connections: { async googleRefresh() { return o.refresh === undefined ? "rt" : o.refresh; }, async dropGoogle() {}, async googleScopes() { return o.scopes === undefined ? ALL : o.scopes; } } });
const who = (turn: number, extra: Record<string, unknown> = {}) => ({ userId: "u", sessionId: "s", language: "he", userTurns: turn, attribution: "primary" as const, ...extra });
const mail = { to: "Dana", subject: "מאחר", body: "אני מאחר בעשר דקות" };

describe("time helpers", () => {
  it("turns wall-clock time in a zone into the right instant, winter and summer", () => {
    expect(zonedToDate("2026-11-28T10:00", TZ)!.toISOString()).toBe("2026-11-28T08:00:00.000Z");
    expect(zonedToDate("2026-07-01T10:00", TZ)!.toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedToDate("2026-02-31T10:00", TZ)).toBeNull();
    expect(zonedToDate("tomorrow", TZ)).toBeNull();
    expect(addMinutesLocal("2026-11-28T23:30", 60)).toBe("2026-11-29T00:30");
  });
  it("tells what a stored connection may do", () => {
    expect(grants("https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly")).toEqual({ read: true, sendMail: false, writeCalendar: false });
    expect(grants(ALL)).toEqual({ read: true, sendMail: true, writeCalendar: true });
    expect(grants("")).toEqual({ read: false, sendMail: false, writeCalendar: false });
  });
});

describe("the message that is sent", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
  it("is UTF-8 with an encoded subject and a base64 body (Hebrew survives)", () => {
    const m = decode(rawMessage({ to: "dana@example.com", toName: "דנה לוי", subject: "מאחר", body: "אני מאחר" }, null));
    expect(m).toContain("To: =?UTF-8?B?");
    expect(m).toContain("<dana@example.com>");
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    const body = m.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("אני מאחר");
  });
  it("cannot be given extra headers through a name or a subject", () => {
    const m = decode(rawMessage({ to: "dana@example.com", toName: "Dana\r\nBcc: evil@x.com", subject: "hi\r\nBcc: evil@x.com", body: "x" }, null));
    expect(m.split("\r\n").filter((l) => /^bcc:/i.test(l))).toEqual([]);
  });
  it("only accepts a plain address", () => {
    expect(EMAIL.test("dana@example.com")).toBe(true);
    for (const bad of ["dana", "a@b", "Dana <d@x.com>", "d@x.com, e@y.com", "d@x.com\r\nBcc: e@y.com"]) expect(EMAIL.test(bad)).toBe(false);
  });
});

describe("finding who a name is, from the user's own mail", () => {
  it("returns one address for one person, case-folded, found in several messages", async () => {
    const g = google();
    expect(await findPeople(g.http, "at", "Dana")).toEqual([{ name: "Dana Levi", address: "dana@example.com" }]);
  });
  it("does not take someone whose name does not match", async () => {
    const g = google({ "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": () => Promise.resolve(ok({ payload: { headers: [{ name: "From", value: "Boss <boss@corp.com>" }, { name: "To", value: "Dana Levi <dana@example.com>" }] } })) });
    expect(await findPeople(g.http, "at", "Dana")).toEqual([{ name: "Dana Levi", address: "dana@example.com" }]);
  });
});

describe("sending an email", () => {
  it("makes a draft, sends nothing on the same turn, and sends once on a later yes", async () => {
    const g = google(); const a = actions(g.http);
    const d = await a.draftEmail(who(1), mail);
    expect(d).toMatchObject({ ok: true });
    expect(d.message).toContain("It is NOT sent");
    expect(d.message).toContain("Dana Levi");
    expect(a.waiting("s")).toContain("Dana Levi");
    // the yes in the same turn as the draft does nothing
    expect(await a.confirm(who(1))).toMatchObject({ ok: false, reason: "same_turn" });
    expect(g.sends()).toHaveLength(0);
    const sent = await a.confirm(who(2));
    expect(sent).toMatchObject({ ok: true });
    expect(g.sends()).toHaveLength(1);
    expect(a.waiting("s")).toBeNull();
    // a second yes finds nothing waiting
    expect(await a.confirm(who(3))).toMatchObject({ ok: false, reason: "nothing_waiting" });
    expect(g.sends()).toHaveLength(1);
  });

  it("a yes with nothing waiting sends nothing", async () => {
    const g = google(); const a = actions(g.http);
    expect(await a.confirm(who(5))).toMatchObject({ ok: false, reason: "nothing_waiting" });
    expect(g.sends()).toHaveLength(0);
  });

  it("a no throws the draft away", async () => {
    const g = google(); const a = actions(g.http);
    await a.draftEmail(who(1), mail);
    expect(a.cancel(who(2)).message).toContain("nothing was sent");
    expect(await a.confirm(who(3))).toMatchObject({ reason: "nothing_waiting" });
    expect(g.sends()).toHaveLength(0);
  });

  it("a new draft replaces the old one (a changed wording is a new draft)", async () => {
    const g = google(); const a = actions(g.http);
    await a.draftEmail(who(1), mail);
    await a.draftEmail(who(2), { ...mail, body: "אני מאחר בחצי שעה" });
    await a.confirm(who(3));
    const raw = (g.sends()[0]!.body as { raw: string }).raw;
    const body = Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("אני מאחר בחצי שעה");
  });

  it("a draft that nobody confirmed for ten minutes is gone", async () => {
    const g = google(); const a = actions(g.http);
    await a.draftEmail(who(1), mail);
    const realNow = Date.now; Date.now = () => realNow() + 11 * 60_000;
    try { expect(await a.confirm(who(2))).toMatchObject({ reason: "nothing_waiting" }); } finally { Date.now = realNow; }
    expect(g.sends()).toHaveLength(0);
  });

  it("does nothing when the voice may be someone else's, for the draft and for the yes", async () => {
    const g = google(); const a = actions(g.http);
    expect(await a.draftEmail(who(1, { attribution: "uncertain" }), mail)).toMatchObject({ ok: false, reason: "not_user_voice" });
    await a.draftEmail(who(1), mail);
    expect(await a.confirm(who(2, { attribution: "uncertain" }))).toMatchObject({ ok: false, reason: "not_user_voice" });
    expect(g.sends()).toHaveLength(0);
  });

  it("a connection that can only read is sent to update its permissions, and nothing is drafted", async () => {
    const g = google(); const a = actions(g.http, { scopes: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly" });
    const r = await a.draftEmail(who(1), mail);
    expect(r).toMatchObject({ ok: false, reason: "needs_update" });
    expect(r.message).toContain("update the permissions in the app");
    expect(a.waiting("s")).toBeNull();
  });

  it("asks instead of guessing: not connected, nobody by that name, two people by that name, no text", async () => {
    expect(await actions(google().http, { refresh: null }).draftEmail(who(1), mail)).toMatchObject({ reason: "not_connected" });
    const none = google({ "https://gmail.googleapis.com/gmail/v1/users/me/messages?": () => Promise.resolve(ok({ messages: [] })) });
    expect(await actions(none.http).draftEmail(who(1), mail)).toMatchObject({ ok: false, reason: "no_address" });
    const two = google({ "https://gmail.googleapis.com/gmail/v1/users/me/messages/m2": () => Promise.resolve(ok({ payload: { headers: [{ name: "From", value: "Dana Cohen <dana@other.org>" }] } })) });
    const amb = await actions(two.http).draftEmail(who(1), mail);
    expect(amb).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(amb.message).toContain("example.com");
    expect(amb.message).toContain("other.org");
    expect(await actions(google().http).draftEmail(who(1), { ...mail, body: "  " })).toMatchObject({ reason: "no_text" });
    expect(await actions(google().http).draftEmail(who(1), { ...mail, to: "" })).toMatchObject({ reason: "no_recipient" });
  });

  it("takes an address the user said, without looking in the mail", async () => {
    const g = google(); const a = actions(g.http);
    const d = await a.draftEmail(who(1), { ...mail, to: "dana@example.com" });
    expect(d.message).toContain("dana@example.com");
    expect(g.calls.some((c) => c.url.includes("/messages?"))).toBe(false);
  });

  it("says so when Google refuses to send, and keeps nothing waiting", async () => {
    const g = google({ "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": () => Promise.resolve({ ok: false, status: 403, json: null }) });
    const a = actions(g.http);
    await a.draftEmail(who(1), mail);
    expect(await a.confirm(who(2))).toMatchObject({ ok: false, reason: "failed" });
  });

  it("limits how many it sends in an hour", async () => {
    const g = google(); const a = actions(g.http);
    for (let i = 0; i < 10; i++) { await a.draftEmail(who(2 * i + 1), mail); expect(await a.confirm(who(2 * i + 2))).toMatchObject({ ok: true }); }
    await a.draftEmail(who(30), mail);
    expect(await a.confirm(who(31))).toMatchObject({ ok: false, reason: "limit" });
    expect(g.sends()).toHaveLength(10);
  });
});

describe("adding an event", () => {
  const ev = { title: "פגישה עם דנה", start: "2026-11-28T10:00", durationMin: 45, location: null as string | null, attendees: [] as string[] };

  it("drafts, then adds it only on a later yes, in the user's time zone", async () => {
    const g = google(); const a = actions(g.http);
    const d = await a.draftEvent(who(1), ev);
    expect(d).toMatchObject({ ok: true });
    expect(d.message).toContain("NOT added");
    expect(d.message).toContain("Saturday 28 November at 10:00");
    expect(d.message).toContain("45 minutes");
    expect(g.creates()).toHaveLength(0);
    await a.confirm(who(2));
    const [c] = g.creates();
    expect(c!.body).toMatchObject({ summary: "פגישה עם דנה", start: { dateTime: "2026-11-28T10:00:00", timeZone: TZ }, end: { dateTime: "2026-11-28T10:45:00", timeZone: TZ } });
    expect(c!.url).toContain("sendUpdates=none");
  });

  it("invites guests only by addresses found or said, and then Google sends the invitation", async () => {
    const g = google(); const a = actions(g.http);
    const d = await a.draftEvent(who(1), { ...ev, attendees: ["Dana"] });
    expect(d.message).toContain("they get an invitation");
    await a.confirm(who(2));
    const [c] = g.creates();
    expect(c!.url).toContain("sendUpdates=all");
    expect((c!.body as { attendees: unknown[] }).attendees).toEqual([{ email: "dana@example.com", displayName: "Dana Levi" }]);
  });

  it("refuses a time that has passed, a missing time, and a missing title; asks for them", async () => {
    const a = actions(google().http);
    expect(await a.draftEvent(who(1), { ...ev, start: "2026-11-27T09:00" })).toMatchObject({ reason: "past" });
    expect(await a.draftEvent(who(1), { ...ev, start: "" })).toMatchObject({ reason: "no_time" });
    expect(await a.draftEvent(who(1), { ...ev, title: "" })).toMatchObject({ reason: "no_title" });
  });

  it("tells about an event that is already at that time", async () => {
    const g = google({ "https://www.googleapis.com/calendar/v3/calendars/primary/events": () => Promise.resolve(ok({ items: [{ summary: "רופא שיניים", start: { dateTime: "2026-11-28T10:15:00+02:00" }, end: { dateTime: "2026-11-28T11:00:00+02:00" } }] })) });
    const d = await actions(g.http).draftEvent(who(1), ev);
    expect(d.message).toContain('they already have "רופא שיניים" at that time');
  });

  it("needs the calendar permission, not only the mail one", async () => {
    const a = actions(google().http, { scopes: [SCOPE_GMAIL_READ, SCOPE_GMAIL_SEND].join(" ") });
    expect(await a.draftEvent(who(1), ev)).toMatchObject({ reason: "needs_update" });
  });
});

describe("how a request reaches the actions", () => {
  const plannerFor = (plan: Record<string, unknown>): UtilityLlm & { prompts: string[] } => {
    const prompts: string[] = [];
    return { name: "fake", prompts, async json(p) { prompts.push(p); return { obj: plan, ms: 1 }; } };
  };
  const base = { userId: "u", sessionId: "s", language: "he", timeZone: TZ, now: NOW, recent: [] as { role: "user" | "agent"; text: string }[] };

  it("normalises the planner's fields and only allows send/create on the right tool", () => {
    expect(parsePlan({ tool: "email", action: "send", to: "Dana", subject: "x", body: "y" })).toMatchObject({ tool: "email", action: "send", to: "Dana", body: "y" });
    expect(parsePlan({ tool: "calendar", action: "send" }).action).toBe("search");
    expect(parsePlan({ tool: "music", action: "create" }).action).toBe("search");
    expect(parsePlan({ tool: "calendar", action: "create", attendees: ["a", 5, "", "b"], duration_min: 9999 })).toMatchObject({ attendees: ["a", "b"], durationMin: 480 });
  });

  it("an email request makes a draft; the yes (as planned by the model, with the draft waiting) sends it", async () => {
    const g = google(); const a = actions(g.http);
    const draftPlan = plannerFor({ tool: "email", action: "send", to: "Dana", subject: "מאחר", body: "אני מאחר" });
    const deps = (llm: UtilityLlm) => ({ llm, http: g.http, connections: a["d"].connections, google: { clientId: "c", clientSecret: "s", redirectUri: "r" }, spotify: null, actions: a });
    const r1 = await runTool(deps(draftPlan), { ...base, question: "תשלח מייל לדנה שאני מאחר", userTurns: 1, attribution: "primary" });
    expect(r1.message).toContain("NOT sent");
    expect(draftPlan.prompts[0]).toContain("Waiting for their answer: (nothing)");
    expect(draftPlan.prompts[0]).toContain("Now: Friday, 27 November 2026 at 16:00");
    const yes = plannerFor({ tool: "confirm" });
    const r2 = await runTool(deps(yes), { ...base, question: "כן שלח", userTurns: 2, attribution: "primary" });
    expect(r2).toMatchObject({ ok: true, tool: "confirm" });
    expect(yes.prompts[0]).toContain('Waiting for their answer: an email to Dana Levi, subject "מאחר"');
    expect(g.sends()).toHaveLength(1);
  });

  it("a yes that the model plans for nothing waiting sends nothing and is not a web search", async () => {
    const g = google(); const a = actions(g.http);
    const r = await runTool({ llm: plannerFor({ tool: "confirm" }), http: g.http, connections: a["d"].connections, google: { clientId: "c", clientSecret: "s", redirectUri: "r" }, spotify: null, actions: a }, { ...base, question: "כן", userTurns: 3 });
    expect(r).toMatchObject({ ok: false, reason: "nothing_waiting" });
    expect(g.sends()).toHaveLength(0);
  });

  it("without the actions (no Google keys) a write request is refused, not turned into a search", async () => {
    const r = await runTool({ llm: plannerFor({ tool: "email", action: "send", to: "Dana", body: "x" }), http: google().http, connections: { async googleRefresh() { return null; }, async dropGoogle() {} }, google: { clientId: "c", clientSecret: "s", redirectUri: "r" }, spotify: null }, { ...base, question: "תשלח מייל" });
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("persona", () => {
  it("says writing is possible only for connections that allow it, and always in three steps", async () => {
    const { core } = await import("../src/persona/core.ts");
    const readOnly = core("he", { lookup: true, tools: { calendar: true } });
    expect(readOnly).toContain("reading only: you cannot send");
    const write = core("he", { lookup: true, tools: { calendar: true, write: true } });
    expect(write).toContain("send an email for them and add an event");
    expect(write).toContain("only their yes in their NEXT turn sends it");
    expect(write).not.toContain("reading only");
  });
});
