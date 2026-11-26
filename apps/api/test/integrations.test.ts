/** Calendar + mail (Google, read only) and music (Spotify) tools: planning, data fetching, sealing, failure handling. All with a fake HTTP layer. */
import { beforeEach, describe, expect, it } from "vitest";
import type { UtilityLlm } from "../src/memory/llm.ts";
import type { Http } from "../src/integrations/http.ts";
import { runTool, parsePlan, startOfDay, type ToolDeps } from "../src/integrations/tools.ts";
import { TokenVault, signState, verifyState } from "../src/integrations/crypto.ts";
import { authUrl, GOOGLE_SCOPES } from "../src/integrations/google.ts";
import { resetSpotifyToken } from "../src/integrations/spotify.ts";
import { core } from "../src/persona/core.ts";

const NOW = new Date("2026-11-26T10:38:00Z");
const base = { userId: "u1", recent: [], language: "he", timeZone: "Asia/Jerusalem", now: NOW };

/** a utility model that plans as told and composes from whatever data it is given */
const llmFor = (plan: Record<string, unknown>, answer = "תשובה"): UtilityLlm & { prompts: string[] } => {
  const prompts: string[] = [];
  return { name: "fake", prompts,
    async json(p, o) { prompts.push(p); return { obj: o?.purpose === "tool_plan" ? plan : { answer }, ms: 1 }; },
    async search() { return { text: "web answer", ms: 1, searches: 1 }; } };
};
const ok = (json: unknown) => ({ ok: true, status: 200, json });

function fakeHttp(routes: Record<string, (url: string, init?: Parameters<Http>[1]) => ReturnType<Http>>): Http & { calls: string[] } {
  const calls: string[] = [];
  const h = (async (url, init) => {
    calls.push(url);
    const k = Object.keys(routes).find((r) => url.startsWith(r));
    if (!k) throw new Error("unexpected " + url);
    return routes[k]!(url, init);
  }) as Http & { calls: string[] };
  h.calls = calls;
  return h;
}

const deps = (o: Partial<ToolDeps> & { refresh?: string | null; dropped?: string[] } = {}): ToolDeps => ({
  llm: o.llm ?? llmFor({ tool: "web" }), http: o.http ?? fakeHttp({}),
  connections: { async googleRefresh() { return o.refresh === undefined ? "rt" : o.refresh; }, async dropGoogle(u) { o.dropped?.push(u); } },
  google: o.google === undefined ? { clientId: "cid", clientSecret: "sec", redirectUri: "https://api/cb" } : o.google,
  spotify: o.spotify === undefined ? { clientId: "sid", clientSecret: "ssec", market: "IL" } : o.spotify,
});

describe("planning", () => {
  it("normalises whatever the model returns", () => {
    expect(parsePlan({ tool: "calendar", from_day: 1, days: 99 })).toMatchObject({ tool: "calendar", fromDay: 1, days: 7 });
    expect(parsePlan({ tool: "rm -rf" })).toMatchObject({ tool: "web", kind: "any", days: 1 });
    expect(parsePlan({ tool: "music", kind: "show", query: "x".repeat(500) }).query).toHaveLength(200);
  });
  it("with neither Google nor Spotify configured, goes to the web without an extra planning call", async () => {
    const llm = llmFor({ tool: "calendar" });
    const r = await runTool(deps({ llm, google: null, spotify: null }), { ...base, question: "מה מזג האוויר" });
    expect(r).toMatchObject({ tool: "web", ok: true });
    expect(llm.prompts).toHaveLength(0);
  });
  it("computes the start of the user's day in their time zone", () => {
    expect(startOfDay(NOW, "Asia/Jerusalem", 0).toISOString()).toBe("2026-11-25T22:00:00.000Z");
    expect(startOfDay(NOW, "Asia/Jerusalem", 1).toISOString()).toBe("2026-11-26T22:00:00.000Z");
  });
});

describe("calendar and mail", () => {
  const google = (extra: Record<string, ReturnType<typeof fakeHttp> extends never ? never : (u: string, i?: Parameters<Http>[1]) => ReturnType<Http>> = {}) => fakeHttp({
    "https://oauth2.googleapis.com/token": () => Promise.resolve(ok({ access_token: "at" })),
    "https://www.googleapis.com/calendar/v3/calendars/primary/events": (u) => Promise.resolve(ok({ items: [
      { summary: "Dentist", start: { dateTime: "2026-11-26T14:00:00+02:00" }, end: { dateTime: "2026-11-26T15:00:00+02:00" }, location: "Dizengoff 5" },
      { summary: "Old", status: "cancelled", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } }] })),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?": () => Promise.resolve(ok({ messages: [{ id: "m1" }] })),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": () => Promise.resolve(ok({ snippet: "see you", labelIds: ["UNREAD"],
      payload: { headers: [{ name: "From", value: "\"Dana\" <dana@x.com>" }, { name: "Subject", value: "Dinner" }, { name: "Date", value: "Thu" }] } })),
    ...extra,
  });

  it("reads today's events (not cancelled ones) and hands them to the composer, without sending anything", async () => {
    const llm = llmFor({ tool: "calendar", from_day: 0, days: 1 }, "יש לך רופא שיניים ב-14:00");
    const http = google();
    const r = await runTool(deps({ llm, http }), { ...base, question: "מה יש לי היום ביומן?" });
    expect(r).toMatchObject({ tool: "calendar", ok: true });
    expect(r.message).toContain("יש לך רופא שיניים ב-14:00");
    const compose = llm.prompts.at(-1)!;
    expect(compose).toContain("Dentist");
    expect(compose).not.toContain("Old");
    expect(http.calls.find((c) => c.includes("/events"))).toContain("timeMin=2026-11-25T22%3A00%3A00.000Z");
    expect(http.calls.every((c) => !/send|insert|delete/i.test(c))).toBe(true);
  });

  it("searches mail with the planned query and passes only headers and the snippet", async () => {
    const llm = llmFor({ tool: "email", query: "is:unread from:dana" }, "דנה כתבה על ארוחת ערב");
    const http = google();
    const r = await runTool(deps({ llm, http }), { ...base, question: "דנה כתבה לי משהו?" });
    expect(r).toMatchObject({ tool: "email", ok: true });
    expect(http.calls.find((c) => c.includes("/messages?"))).toContain("q=is%3Aunread+from%3Adana");
    expect(llm.prompts.at(-1)).toContain("Dinner");
    expect(llm.prompts.at(-1)).toContain("Dana");
  });

  it("says so when Google is not connected", async () => {
    const r = await runTool(deps({ llm: llmFor({ tool: "calendar" }), refresh: null }), { ...base, question: "מה יש ביומן" });
    expect(r).toMatchObject({ ok: false, reason: "not_connected" });
    expect(r.message).toContain("connect it in the app");
  });

  it("drops the connection when the user withdrew access", async () => {
    const dropped: string[] = [];
    const http = google({ "https://oauth2.googleapis.com/token": () => Promise.resolve({ ok: false, status: 400, json: { error: "invalid_grant" } }) });
    const r = await runTool(deps({ llm: llmFor({ tool: "email" }), http, dropped }), { ...base, question: "יש מיילים?" });
    expect(r).toMatchObject({ ok: false, reason: "revoked" });
    expect(dropped).toEqual(["u1"]);
  });

  it("never throws: a Google outage is a result", async () => {
    const http = google({ "https://www.googleapis.com/calendar/v3/calendars/primary/events": () => Promise.resolve({ ok: false, status: 503, json: null }) });
    const r = await runTool(deps({ llm: llmFor({ tool: "calendar" }), http }), { ...base, question: "מה יש ביומן" });
    expect(r).toMatchObject({ tool: "calendar", ok: false });
    expect(r.message).toContain("did not work");
  });
});

describe("music", () => {
  beforeEach(() => resetSpotifyToken());
  const spotify = () => fakeHttp({
    "https://accounts.spotify.com/api/token": () => Promise.resolve(ok({ access_token: "st", expires_in: 3600 })),
    "https://api.spotify.com/v1/search": () => Promise.resolve(ok({
      shows: { items: [{ name: "Hidden Brain", publisher: "NPR", description: "Psychology", external_urls: { spotify: "https://open.spotify.com/show/1" } }, null] } })),
  });

  it("searches podcasts with the planned query and keeps links out of the composer's data", async () => {
    const llm = llmFor({ tool: "music", query: "psychology podcast", kind: "show" }, "תנסה את Hidden Brain");
    const http = spotify();
    const r = await runTool(deps({ llm, http }), { ...base, question: "תמליץ לי על פודקאסט על פסיכולוגיה" });
    expect(r).toMatchObject({ tool: "music", ok: true });
    const url = http.calls.find((c) => c.includes("/v1/search"))!;
    expect(url).toContain("type=show");
    expect(url).toContain("market=IL");
    expect(llm.prompts.at(-1)).toContain("Hidden Brain");
    expect(llm.prompts.at(-1)).not.toContain("open.spotify.com");
  });

  it("reports when Spotify is not configured", async () => {
    const r = await runTool(deps({ llm: llmFor({ tool: "music" }), spotify: null }), { ...base, question: "שיר של קווין" });
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("sealing and OAuth state", () => {
  it("seals a token so only the same key opens it", () => {
    const a = new TokenVault("k".repeat(32), null), b = new TokenVault("j".repeat(32), null);
    const s = a.seal("1//refresh");
    expect(s).not.toContain("refresh");
    expect(a.unseal(s)).toBe("1//refresh");
    expect(b.unseal(s)).toBeNull();
    expect(a.unseal("garbage")).toBeNull();
  });
  it("binds the callback to the user who started it, for ten minutes", () => {
    const st = signState("user-1", "k", NOW.getTime());
    expect(verifyState(st, "k", NOW.getTime() + 60_000)).toBe("user-1");
    expect(verifyState(st, "k", NOW.getTime() + 11 * 60_000)).toBeNull();
    expect(verifyState(st, "other", NOW.getTime())).toBeNull();
    expect(verifyState(st.replace(/.$/, "x"), "k", NOW.getTime())).toBeNull();
  });
  it("asks Google for read-only access, offline", () => {
    const u = new URL(authUrl({ clientId: "cid", clientSecret: "s", redirectUri: "https://api/cb" }, "st"));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(GOOGLE_SCOPES.filter((s) => /calendar|gmail/.test(s)).every((s) => s.endsWith(".readonly"))).toBe(true);
    expect(u.searchParams.get("scope")).toContain("gmail.readonly");
  });
});

describe("persona", () => {
  it("mentions calendar, mail and music only when they are connected, and says reading only", () => {
    expect(core("he", { lookup: true })).not.toContain("calendar");
    const p = core("he", { lookup: true, tools: { calendar: true, music: true } });
    expect(p).toContain("their calendar and their mail (reading only");
    expect(p).toContain("music and podcasts");
    expect(core("he", { lookup: false, tools: { calendar: true } })).not.toContain("calendar");
  });
});
