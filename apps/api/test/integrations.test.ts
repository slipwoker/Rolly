/** Calendar + mail (Google, read only) and music (Spotify) tools: planning, data fetching, sealing, failure handling. All with a fake HTTP layer. */
import { beforeEach, describe, expect, it } from "vitest";
import type { UtilityLlm } from "../src/memory/llm.ts";
import type { Http } from "../src/integrations/http.ts";
import { runTool, parsePlan, startOfDay, type ToolDeps } from "../src/integrations/tools.ts";
import { TokenVault, signState, verifyState } from "../src/integrations/crypto.ts";
import { authUrl, GOOGLE_SCOPES } from "../src/integrations/google.ts";
import { resetSpotifyToken, playTarget } from "../src/integrations/spotify.ts";
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
  connections: o.connections ?? { async googleRefresh() { return o.refresh === undefined ? "rt" : o.refresh; }, async dropGoogle(u) { o.dropped?.push(u); } },
  google: o.google === undefined ? { clientId: "cid", clientSecret: "sec", redirectUri: "https://api/cb" } : o.google,
  spotify: o.spotify === undefined ? { clientId: "sid", clientSecret: "ssec", market: "IL" } : o.spotify,
});

describe("planning", () => {
  it("normalises whatever the model returns", () => {
    expect(parsePlan({ tool: "calendar", from_day: 1, days: 99 })).toMatchObject({ tool: "calendar", fromDay: 1, days: 7 });
    expect(parsePlan({ tool: "rm -rf" })).toMatchObject({ tool: "web", kind: "any", days: 1 });
    expect(parsePlan({ tool: "music", kind: "show", query: "x".repeat(500) }).query).toHaveLength(200);
  });
  it("the planner sees the conversation and the cards, so 'give me the link' means the song just talked about", async () => {
    const llm = llmFor({ tool: "music", action: "play", query: "Three Little Birds Bob Marley", kind: "track" });
    const r = await runTool(deps({ llm, http: fakeHttp({
      "https://accounts.spotify.com/api/token": () => Promise.resolve(ok({ access_token: "st", expires_in: 3600 })),
      "https://api.spotify.com/v1/search": () => Promise.resolve(ok({ tracks: { items: [{ name: "Three Little Birds", artists: [{ name: "Bob Marley & The Wailers" }], album: { images: [] }, external_urls: { spotify: "https://open.spotify.com/track/tlb" } }] } })),
    }) }), { ...base, question: "תן לי קישור", lastMedia: [], recent: [{ role: "user", text: "תמליץ לי על שיר של בוב מרלי" }, { role: "agent", text: "\"Three Little Birds\" הוא קלאסיקה." }] });
    expect(r.open?.url).toBe("https://open.spotify.com/track/tlb");
    const prompt = llm.prompts[0]!;
    expect(prompt).toContain("Three Little Birds\" הוא קלאסיקה");
    expect(prompt).toContain("Shown to the user as cards just now: (nothing)");
    expect(prompt).toContain("תן לי קישור");
    const shown = llmFor({ tool: "music", action: "play" });
    await runTool(deps({ llm: shown }), { ...base, question: "תנגן את זה", lastMedia: [{ kind: "track", title: "Under Pressure", subtitle: "Queen", image: null, url: "https://open.spotify.com/track/zzz9", provider: "spotify" }] });
    expect(shown.prompts[0]).toContain("Shown to the user as cards just now: Under Pressure (Queen)");
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
      shows: { items: [
        { name: "Hidden Brain", publisher: "NPR", description: "Psychology", external_urls: { spotify: "https://open.spotify.com/show/1" }, images: [{ url: "https://i.scdn.co/big" }, { url: "https://i.scdn.co/mid" }, { url: "https://i.scdn.co/small" }] },
        { name: "Other Show", publisher: "X", external_urls: { spotify: "https://open.spotify.com/show/2" }, images: [] }, null] } })),
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

  it("returns the results it names as cards (cover, title, link), at most two, and never invented ones", async () => {
    const llm = llmFor({ tool: "music", query: "psychology", kind: "show" }, "תנסה את Hidden Brain");
    const orig = llm.json.bind(llm);
    llm.json = async (p, o) => { const r = await orig(p, o); return o?.purpose === "tool" ? { ...r, obj: { ...r.obj, picks: [0, 0, 7] } } : r; };
    const r = await runTool(deps({ llm, http: spotify() }), { ...base, question: "פודקאסט על פסיכולוגיה" });
    expect(r.media).toEqual([{ kind: "show", title: "Hidden Brain", subtitle: "NPR", image: "https://i.scdn.co/mid", url: "https://open.spotify.com/show/1", provider: "spotify" }]);
    expect(llm.prompts.at(-1)).toContain('"i":0');
    expect(llm.prompts.at(-1)).not.toContain("i.scdn.co");
  });

  it("with no valid pick, shows the best match rather than nothing", async () => {
    const r = await runTool(deps({ llm: llmFor({ tool: "music", kind: "show" }), http: spotify() }), { ...base, question: "Hidden Brain" });
    expect(r.media?.map((m) => m.title)).toEqual(["Hidden Brain"]);
  });

  it("calendar and mail never produce cards", async () => {
    const http = fakeHttp({ "https://oauth2.googleapis.com/token": () => Promise.resolve(ok({ access_token: "at" })), "https://www.googleapis.com/calendar": () => Promise.resolve(ok({ items: [] })) });
    expect((await runTool(deps({ llm: llmFor({ tool: "calendar" }), http }), { ...base, question: "מה ביומן" })).media).toBeUndefined();
  });

  it("reports when Spotify is not configured", async () => {
    const r = await runTool(deps({ llm: llmFor({ tool: "music" }), spotify: null }), { ...base, question: "שיר של קווין" });
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("playing music: the song's link is opened in Spotify on the phone", () => {
  beforeEach(() => resetSpotifyToken());
  const track = { kind: "track" as const, title: "Bohemian Rhapsody", subtitle: "Queen", image: null, url: "https://open.spotify.com/track/abc123?si=x", provider: "spotify" as const };
  const search = () => fakeHttp({
    "https://accounts.spotify.com/api/token": () => Promise.resolve(ok({ access_token: "st", expires_in: 3600 })),
    "https://api.spotify.com/v1/search": () => Promise.resolve(ok({ tracks: { items: [{ name: "Under Pressure", artists: [{ name: "Queen" }], album: { name: "Hot Space", images: [] }, external_urls: { spotify: "https://open.spotify.com/track/zzz9" } }] } })),
  });
  const play = (over: Partial<Parameters<typeof runTool>[1]> = {}, llm = llmFor({ tool: "music", action: "play" })) =>
    runTool(deps({ llm, http: search() }), { ...base, question: "תנגן את זה", lastMedia: [track], ...over });

  it("recognises Spotify links and nothing else", () => {
    expect(playTarget(track.url)).toEqual({ kind: "track", uri: "spotify:track:abc123", context: false });
    expect(playTarget("https://open.spotify.com/intl-he/album/XyZ1")).toEqual({ kind: "album", uri: "spotify:album:XyZ1", context: true });
    expect(playTarget("https://evil.example/track/abc")).toBeNull();
  });

  it("'play that' opens what Rolly just showed, for any user: no account, no player API", async () => {
    const r = await play();
    expect(r).toMatchObject({ tool: "music", ok: true, open: { url: track.url } });
    expect(r.media?.[0]).toMatchObject({ title: "Bohemian Rhapsody" });
    expect(r.message).toContain(`"Bohemian Rhapsody" (Queen) in Spotify on their phone`);
  });

  it("opens what was named in the request, found by search", async () => {
    const r = await play({ question: "תנגן under pressure", lastMedia: [] }, llmFor({ tool: "music", action: "play", query: "Queen Under Pressure", kind: "track" }));
    expect(r.open?.url).toBe("https://open.spotify.com/track/zzz9");
    expect(r.media?.[0]).toMatchObject({ title: "Under Pressure", subtitle: "Queen" });
  });

  it("with nothing shown and nothing named, asks what to play instead of opening something", async () => {
    const r = await play({ lastMedia: [] });
    expect(r).toMatchObject({ ok: false, reason: "nothing" });
    expect(r.open).toBeUndefined();
  });

  it("never opens a link that is not a Spotify one", async () => {
    const r = await play({ lastMedia: [{ ...track, url: "https://evil.example/track/abc123" }] });
    expect(r.open).toBeUndefined();
  });

  it("a recommendation request does not open anything", async () => {
    const r = await play({ question: "תמליץ לי על משהו של קווין", lastMedia: [] }, llmFor({ tool: "music", action: "search", query: "queen", kind: "track" }));
    expect(r.open).toBeUndefined();
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
    expect(verifyState(st, "k", NOW.getTime(), "spotify")).toBeNull(); // a Google state does not open the Spotify callback
    expect(verifyState(st.replace(/.$/, "x"), "k", NOW.getTime())).toBeNull();
  });
  it("asks Google for offline access with the narrowest scopes that read mail, send mail and add events", () => {
    const u = new URL(authUrl({ clientId: "cid", clientSecret: "s", redirectUri: "https://api/cb" }, "st"));
    expect(u.searchParams.get("access_type")).toBe("offline");
    // no full-access scopes: not gmail.modify / mail.google.com (delete, change), not the whole calendar scope
    expect(GOOGLE_SCOPES.filter((s) => /calendar|gmail/.test(s)).sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]);
    expect(u.searchParams.get("scope")).toContain("gmail.send");
  });
});

describe("persona", () => {
  it("mentions calendar, mail and music only when they are connected, and says reading only", () => {
    expect(core("he", { lookup: true })).not.toContain("calendar");
    const p = core("he", { lookup: true, tools: { calendar: true, music: true } });
    expect(p).toContain("their calendar and their mail (reading only");
    expect(p).toContain("music and podcasts");
    expect(core("he", { lookup: true, tools: { music: true, play: true } })).toContain("you ALWAYS use the check");
    expect(core("he", { lookup: false, tools: { calendar: true } })).not.toContain("calendar");
  });
});
