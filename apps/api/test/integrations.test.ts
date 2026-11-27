/** Calendar + mail (Google, read only) and music (Spotify) tools: planning, data fetching, sealing, failure handling. All with a fake HTTP layer. */
import { beforeEach, describe, expect, it } from "vitest";
import type { UtilityLlm } from "../src/memory/llm.ts";
import type { Http } from "../src/integrations/http.ts";
import { runTool, parsePlan, startOfDay, type ToolDeps } from "../src/integrations/tools.ts";
import { seal, unseal, signState, verifyState } from "../src/integrations/crypto.ts";
import { authUrl, GOOGLE_SCOPES } from "../src/integrations/google.ts";
import { resetSpotifyToken, playTarget, authUrl as spotifyAuthUrl, SPOTIFY_SCOPES } from "../src/integrations/spotify.ts";
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
  spotify: o.spotify === undefined ? { clientId: "sid", clientSecret: "ssec", market: "IL" } : o.spotify, spotifyUser: o.spotifyUser,
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

describe("playing music on the user's Spotify", () => {
  beforeEach(() => resetSpotifyToken());
  const track = { kind: "track" as const, title: "Bohemian Rhapsody", subtitle: "Queen", image: null, url: "https://open.spotify.com/track/abc123?si=x", provider: "spotify" as const };
  const user = { clientId: "sid", clientSecret: "ssec", redirectUri: "https://api/spotify/cb" };
  const saved: string[] = [];
  const conns = (refresh: string | null = "srt") => ({
    async googleRefresh() { return null; }, async dropGoogle() {}, async spotifyRefresh() { return refresh; },
    async saveSpotifyRefresh(_u: string, t: string) { saved.push(t); }, async dropSpotify() { saved.push("dropped"); } });
  const sp = (o: { product?: string; devices?: unknown[]; token?: unknown; playing?: unknown } = {}) => {
    const puts: { url: string; body: unknown }[] = [];
    const http = fakeHttp({
      "https://accounts.spotify.com/api/token": (_u, i) => Promise.resolve((i?.body ?? "").includes("refresh_token") ? (o.token ? ((o.token as { error?: string }).error ? { ok: false, status: 400, json: o.token } : ok(o.token)) : ok({ access_token: "ut" })) : ok({ access_token: "st", expires_in: 3600 })),
      "https://api.spotify.com/v1/me/player/devices": () => Promise.resolve(ok({ devices: o.devices ?? [{ id: "d1", name: "iPhone", type: "Smartphone", is_active: false, is_restricted: false }] })),
      "https://api.spotify.com/v1/me/player/play": (u, i) => { puts.push({ url: u, body: JSON.parse(i!.body!) }); return Promise.resolve({ ok: true, status: 204, json: null }); },
      "https://api.spotify.com/v1/me/player/pause": () => Promise.resolve({ ok: true, status: 204, json: null }),
      "https://api.spotify.com/v1/me/player": () => Promise.resolve(ok(o.playing ?? { is_playing: true, item: { uri: "spotify:track:abc123" } })),
      "https://api.spotify.com/v1/me": () => Promise.resolve(ok({ product: o.product ?? "premium" })),
      "https://api.spotify.com/v1/search": () => Promise.resolve(ok({ tracks: { items: [{ name: "Under Pressure", artists: [{ name: "Queen" }], album: { name: "Hot Space", images: [] }, external_urls: { spotify: "https://open.spotify.com/track/zzz9" } }] } })),
    });
    return { http, puts };
  };
  const d = (http: Http, c = conns()) => deps({ llm: llmFor({ tool: "music", action: "play" }), http, connections: c as never, spotifyUser: user } as never);
  const run = (http: Http, over: Partial<Parameters<typeof runTool>[1]> = {}, c = conns()) => runTool({ ...d(http, c), connections: c as never }, { ...base, question: "תנגן את זה", lastMedia: [track], ...over });

  it("turns a Spotify link into what the player takes", () => {
    expect(playTarget(track.url)).toEqual({ kind: "track", uri: "spotify:track:abc123", context: false });
    expect(playTarget("https://open.spotify.com/intl-he/album/XyZ1")).toEqual({ kind: "album", uri: "spotify:album:XyZ1", context: true });
    expect(playTarget("https://evil.example/track/abc")).toBeNull();
  });

  it("checks everything first, tells the model what it is putting on, and starts nothing until asked to", async () => {
    const { http, puts } = sp();
    const r = await run(http);
    expect(r).toMatchObject({ tool: "music", ok: true });
    expect(r.message).toContain('"Bohemian Rhapsody" (Queen)');
    expect(r.message).toContain("tap the screen");
    expect(r.media?.[0]?.url).toBe(track.url);
    expect(puts).toHaveLength(0); // the session starts it after Rolly has finished speaking
    expect(await r.playback!.start()).toBe(true);
    expect(puts[0]).toMatchObject({ body: { uris: ["spotify:track:abc123"] } });
    expect(puts[0]!.url).toContain("device_id=d1");
  });

  it("plays an album as a context, and what was named in the request when it was named", async () => {
    const { http, puts } = sp();
    const album = { ...track, kind: "album" as const, url: "https://open.spotify.com/album/al1" };
    await (await run(http, { lastMedia: [album] })).playback!.start();
    expect(puts[0]!.body).toEqual({ context_uri: "spotify:album:al1" });
    const named = await runTool({ ...d(http), llm: llmFor({ tool: "music", action: "play", query: "Queen Under Pressure", kind: "track" }) }, { ...base, question: "תנגן under pressure", lastMedia: [] });
    expect(named.media?.[0]).toMatchObject({ title: "Under Pressure", url: "https://open.spotify.com/track/zzz9" });
  });

  it("stillPlaying is true while it is the same thing, false when it ended or something else took over", async () => {
    expect(await (await run(sp().http)).playback!.stillPlaying()).toBe(true);
    expect(await (await run(sp({ playing: { is_playing: true, item: { uri: "spotify:track:other" } } }).http)).playback!.stillPlaying()).toBe(false);
    expect(await (await run(sp({ playing: { is_playing: false, item: null } }).http)).playback!.stillPlaying()).toBe(false);
  });

  it("refuses before promising anything: not connected, nothing to play, no device, access withdrawn", async () => {
    expect(await run(sp().http, {}, conns(null))).toMatchObject({ ok: false, reason: "not_connected" });
    expect(await run(sp().http, { lastMedia: [] })).toMatchObject({ ok: false, reason: "nothing" });
    const nodev = await run(sp({ devices: [] }).http);
    expect(nodev).toMatchObject({ ok: false, reason: "no_device" });
    expect(nodev.message).toContain("open the Spotify app");
    saved.length = 0;
    const lost = await run(sp({ token: { error: "invalid_grant" } }).http);
    expect(lost).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("a free account is found out when Spotify refuses to play: start() is false and nothing is promised as playing", async () => {
    const { http } = sp();
    const refusing: Http = async (u, i) => (u.startsWith("https://api.spotify.com/v1/me/player/play") ? { ok: false, status: 403, json: { error: { reason: "PREMIUM_REQUIRED" } } } : http(u, i));
    const r = await run(refusing);
    expect(await r.playback!.start()).toBe(false);
  });

  it("keeps a rotated refresh token", async () => {
    saved.length = 0;
    await run(sp({ token: { access_token: "ut", refresh_token: "srt2" } }).http);
    expect(saved).toEqual(["srt2"]);
  });

  it("only plays when the plan says play (a recommendation request does not)", async () => {
    const llm = llmFor({ tool: "music", action: "search", query: "queen", kind: "track" });
    const r = await runTool({ ...d(sp().http), llm }, { ...base, question: "תמליץ לי על משהו של קווין", lastMedia: [] });
    expect(r.playback).toBeUndefined();
  });

  it("asks Spotify for the playback scopes only", () => {
    const u = new URL(spotifyAuthUrl(user, "st"));
    expect(u.searchParams.get("scope")).toBe(SPOTIFY_SCOPES.join(" "));
    expect(SPOTIFY_SCOPES).not.toContain("user-read-email");
  });
});

describe("sealing and OAuth state", () => {
  it("seals a token so only the same secret opens it", () => {
    const s = seal("1//refresh", "secret-a");
    expect(s).not.toContain("refresh");
    expect(unseal(s, "secret-a")).toBe("1//refresh");
    expect(unseal(s, "secret-b")).toBeNull();
    expect(unseal("garbage", "secret-a")).toBeNull();
  });
  it("binds the callback to the user who started it, for ten minutes", () => {
    const st = signState("user-1", "k", NOW.getTime());
    expect(verifyState(st, "k", NOW.getTime() + 60_000)).toBe("user-1");
    expect(verifyState(st, "k", NOW.getTime() + 11 * 60_000)).toBeNull();
    expect(verifyState(st, "other", NOW.getTime())).toBeNull();
    expect(verifyState(st, "k", NOW.getTime(), "spotify")).toBeNull(); // a Google state does not open the Spotify callback
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
