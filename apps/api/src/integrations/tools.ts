/**
 * The companion's tools beyond web search: the user's calendar and mail (Google, read only) and music / podcasts (Spotify).
 *
 * The conversation model asks for any of them with the same marker as an online lookup (<lookup/>); the pod needs no
 * change. Here a small planning call decides WHICH tool the question needs and with what query, the tool runs, and a
 * second call turns the raw data into one or two spoken sentences. Results go back to the model as a marked message,
 * exactly like a web lookup (lookup/web.ts), and count against the same daily allowance.
 *
 * What leaves the system: the question, the last turns, and for mail/calendar the headers+snippets of at most five
 * messages / fifteen events fetched for this one question. Never the user's name or anything from memory.
 */
import type { UtilityLlm } from "../memory/llm.ts";
import { LOOKUP_FAILED_TAG, LOOKUP_TAG, lookupMessage, webLookup } from "../lookup/web.ts";
import * as google from "./google.ts";
import * as spotify from "./spotify.ts";
import type { Http } from "./http.ts";
import type { MediaItem } from "@rolly/contracts";

export type ToolName = "web" | "calendar" | "email" | "music";
export interface ToolPlan { tool: ToolName; action: "search" | "play"; query: string; kind: spotify.MusicKind; fromDay: number; days: number }
export interface ToolArgs { /** what Rolly last showed as cards: "play this" means the first of them */ lastMedia?: MediaItem[]; userId: string; question: string; recent: { role: "user" | "agent"; text: string }[]; language: string; timeZone: string; now?: Date }
export interface ToolOutcome { message: string; ok: boolean; reason?: string; tool: ToolName;
  /** music: the results Rolly talks about, shown as cards in the chat */ media?: MediaItem[];
  /** music to start once Rolly has finished speaking (the voice session pauses listening while it plays) */
  playback?: Playback }

/** One song/show to be played on the user's Spotify. The voice session decides WHEN (after Rolly's reply). */
export interface Playback {
  title: string;
  /** starts it; false = Spotify refused */
  start(): Promise<boolean>;
  /** false = it ended, was stopped, or Spotify moved on to something else */
  stillPlaying(): Promise<boolean | "error">;
  /** the user tapped to talk: pause the music */
  stop(): Promise<void>;
}

/** Where the user's Google refresh token lives (the database, sealed); dropped when Google says access was withdrawn. */
export interface Connections {
  googleRefresh(userId: string): Promise<string | null>; dropGoogle(userId: string): Promise<void>;
  spotifyRefresh?(userId: string): Promise<string | null>; saveSpotifyRefresh?(userId: string, refreshToken: string): Promise<void>; dropSpotify?(userId: string): Promise<void>;
}
export interface ToolDeps { llm: UtilityLlm | null; http: Http; connections: Connections; google: google.GoogleConfig | null; spotify: spotify.SpotifyConfig | null;
  /** the user-account side of Spotify (playback); null = not configured */ spotifyUser?: spotify.SpotifyOAuth | null }

export const PLAN_PROMPT = `You route one request from a voice companion's user to the right tool. Reply with JSON only.

Tools:
- "calendar": the user's own schedule (meetings, appointments, what is on today/tomorrow, when something is).
- "email": the user's own mail (new or unread messages, did someone write, what did X send).
- "music": find a song, artist, album, podcast or podcast episode, or recommend music or podcasts to listen to.
- "web": anything else that needs current facts from the internet.

JSON: {"tool": "calendar"|"email"|"music"|"web", "action": "search"|"play", "query": string, "kind": "track"|"artist"|"album"|"show"|"episode"|"any", "from_day": number, "days": number}
- email: query is a Gmail search ("is:unread newer_than:2d", "from:dana", "subject:flight"); default "is:unread newer_than:3d".
- music: action "play" ONLY when the user asks to play / put on something ("תנגן", "תשים", "play"); asking about or for a recommendation is "search". For "play": query is what to play when they named it ("Bohemian Rhapsody Queen"), or "" when they mean what was just mentioned ("play that", "תנגן את זה"). For "search": query is what to search the catalogue for: the title/artist the user named, or for a recommendation a few well-chosen search terms (genre, mood, a similar artist, a podcast topic). kind "show" for podcasts, "episode" for a specific episode, "any" if unsure.
- calendar: from_day = days from today (0 = today, 1 = tomorrow), days = how many days to cover (1-7).
- Unused fields: action "search", query "", kind "any", from_day 0, days 1.

The conversation so far:
{recent}

Request: {question}
`;

export const COMPOSE_PROMPT = `You are the last step of a voice companion that rides along with someone in a car. Use ONLY the data below to answer their request.
Rules: {language}, at most two short sentences that can be said aloud. No links, no lists, no markdown. Names of songs, artists and shows stay as written.
{task}
If the data is empty or does not answer it, say that in one sentence. Do not invent anything. Now: {now}.

Request: {question}
Data:
{data}

Reply with JSON only: {"answer": string, "picks": number[]}
"picks": music only: the "i" of each result you mention in the answer (at most two), else [].`;

const TASKS: Record<Exclude<ToolName, "web">, string> = {
  calendar: "Say what is coming up in the order it happens, with the time in 24-hour form (and the place if there is one). If many events, the first three and how many more.",
  email: "Say how many messages and who they are from and what they are about, the newest first, at most three. Do not read long text; never repeat passwords, codes or numbers that look like one.",
  music: "If they asked for a specific song, artist or show, say what you found. If they asked for a recommendation, pick one or two of the results and say in a few words why they fit; do not list everything.",
};

const lang = (l: string) => (l === "en" ? "In English" : "In everyday spoken Hebrew, without niqqud");
const fill = (t: string, v: Record<string, string>) => Object.entries(v).reduce((s, [k, x]) => s.split(`{${k}}`).join(x), t);
const recentText = (r: ToolArgs["recent"]) => r.slice(-6).map((t) => `${t.role === "agent" ? "COMPANION" : "USER"}: ${t.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(nothing yet)";
const spoken = (s: string) => s.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[*_#`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 500);

export function parsePlan(obj: Record<string, unknown>): ToolPlan {
  const tool = (["calendar", "email", "music", "web"] as const).find((t) => t === obj.tool) ?? "web";
  const kind = (["track", "artist", "album", "show", "episode", "any"] as const).find((k) => k === obj.kind) ?? "any";
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return { tool, action: obj.action === "play" && tool === "music" ? "play" : "search", kind, query: typeof obj.query === "string" ? obj.query.slice(0, 200) : "", fromDay: n(obj.from_day, 0, 30, 0), days: n(obj.days, 1, 7, 1) };
}

export async function planTool(llm: UtilityLlm | null, a: ToolArgs, canRoute = true): Promise<ToolPlan> {
  const fallback: ToolPlan = { tool: "web", action: "search", query: "", kind: "any", fromDay: 0, days: 1 };
  if (!llm || !canRoute) return fallback;
  try {
    const r = await llm.json(fill(PLAN_PROMPT, { recent: recentText(a.recent), question: a.question.replace(/\s+/g, " ").slice(0, 400) }), { maxTokens: 200, purpose: "tool_plan" });
    return parsePlan(r.obj);
  } catch { return fallback; }
}

const say = (tool: ToolName, answer: string): ToolOutcome => ({ tool, ok: true,
  message: `${LOOKUP_TAG} You checked. What you found: ${answer}\nTell them now, in one or two short sentences, in your own words. Only what is written here; if it does not answer what they asked, say what you did find.` });
const note = (tool: ToolName, text: string, reason: string): ToolOutcome => ({ tool, ok: false, reason, message: `${LOOKUP_FAILED_TAG} ${text} Say so in a few words, do not guess the answer, and go on with the conversation.` });
const NOT_CONNECTED: Record<"calendar" | "email" | "music", string> = {
  calendar: "Their Google account is not connected, so you cannot see their calendar. They can connect it in the app under connected services.",
  email: "Their Google account is not connected, so you cannot see their mail. They can connect it in the app under connected services.",
  music: "Music search is not available right now.",
};
const FAILED = "That check did not work just now.";

/** Local midnight of "today" in `timeZone`, as an instant (so "today" means the user's day, not the server's). */
export function startOfDay(now: Date, timeZone: string, plusDays: number): Date {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const sinceMidnight = (g("hour") * 3600 + g("minute") * 60 + g("second")) * 1000;
  // DST days are 23/25 h; shifting by whole days from local midnight then re-snapping keeps "tomorrow" at tomorrow's 00:00 +-1h, which is within the window anyway
  return new Date(now.getTime() - sinceMidnight + plusDays * 86_400_000);
}

async function compose(llm: UtilityLlm | null, a: ToolArgs, tool: Exclude<ToolName, "web">, data: unknown): Promise<{ answer: string; picks: number[] } | null> {
  if (!llm) return null;
  const now = a.now ?? new Date();
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: a.timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(now);
  const r = await llm.json(fill(COMPOSE_PROMPT, { language: lang(a.language), task: TASKS[tool], now: `${when}, ${a.timeZone}`,
    question: a.question.replace(/\s+/g, " ").slice(0, 400), data: JSON.stringify(data).slice(0, 6000) }), { maxTokens: 400, purpose: "tool" });
  const ans = typeof r.obj.answer === "string" ? spoken(r.obj.answer) : "";
  const picks = Array.isArray(r.obj.picks) ? (r.obj.picks as unknown[]).filter((n): n is number => Number.isInteger(n)) : [];
  return ans ? { answer: ans, picks } : null;
}

const PLAY_NOTES = {
  not_connected: "Their Spotify account is not connected, so you cannot play anything. They can connect it in the app under connected services.",
  nothing: "There is nothing to play yet: ask them in a few words what they want to hear.",
  premium: "Spotify only lets Premium accounts be played from outside its own app, so you cannot play it for them.",
  no_device: "Spotify is not open on their phone. Ask them to open the Spotify app once and then ask you again.",
  revoked: "Their Spotify access was withdrawn. They can connect it again in the app.",
};

/**
 * "Play it": the user's own Spotify, on their phone. Everything that can fail is checked BEFORE Rolly answers (Premium,
 * a device that can play), so Rolly never promises music that will not start. The music itself starts later, once Rolly
 * has finished speaking (voice/session.ts), and the session stops listening while it plays.
 */
async function playMusic(d: ToolDeps, a: ToolArgs, plan: ToolPlan): Promise<ToolOutcome> {
  const user = d.spotifyUser, c = d.connections;
  if (!user || !c.spotifyRefresh || !c.saveSpotifyRefresh) return note("music", PLAY_NOTES.not_connected, "not_connected");
  const refresh = await c.spotifyRefresh(a.userId);
  if (!refresh) return note("music", PLAY_NOTES.not_connected, "not_connected");

  // what to play: what they named, else what Rolly just showed
  let item: MediaItem | undefined;
  if (plan.query) {
    const hit = (await spotify.search(d.http, d.spotify!, plan.query, plan.kind === "any" ? "track" : plan.kind)).find((h) => h.url && spotify.playTarget(h.url));
    if (hit) item = { kind: hit.kind, title: hit.name, subtitle: hit.by, image: hit.image, url: hit.url!, provider: "spotify" };
  } else item = a.lastMedia?.find((m) => spotify.playTarget(m.url));
  const target = item && spotify.playTarget(item.url);
  if (!item || !target) return note("music", PLAY_NOTES.nothing, "nothing");

  // an access token for this user (Spotify may rotate the refresh token: keep the new one)
  let current = refresh, access = "", expires = 0;
  const token = async () => {
    if (access && Date.now() < expires) return access;
    const t = await spotify.userToken(d.http, user, current);
    if (t.refreshToken && t.refreshToken !== current) { current = t.refreshToken; await c.saveSpotifyRefresh!(a.userId, current); }
    access = t.accessToken; expires = Date.now() + 50 * 60_000;
    return access;
  };
  let check: spotify.PlayCheck;
  try { check = await spotify.canPlay(d.http, await token()); }
  catch (e) {
    if (e instanceof spotify.SpotifyAuthLost) { await c.dropSpotify?.(a.userId); return note("music", PLAY_NOTES.revoked, "revoked"); }
    throw e;
  }
  if (!check.ok) return note("music", check.reason === "failed" ? FAILED : PLAY_NOTES[check.reason], check.reason);
  const device = check.deviceId;
  const playback: Playback = {
    title: item.title,
    async start() { try { return await spotify.startPlayback(d.http, await token(), device, target); } catch { return false; } },
    async stillPlaying() { try { return await spotify.stillPlaying(d.http, await token(), target); } catch { return "error"; } },
    async stop() { try { await spotify.pausePlayback(d.http, await token()); } catch { /* the song ends by itself */ } },
  };
  return { tool: "music", ok: true, media: [item], playback, message: `${LOOKUP_TAG} You are going to play "${item.title}"${item.subtitle ? ` (${item.subtitle})` : ""} on their Spotify, on their phone.
Tell them in a few words what you are putting on, in your own words. The music starts the moment you stop talking and you will not hear them while it plays: they tap the screen to talk again. Do not ask anything.` };
}

/** One tool call for one question. Never throws: every failure is an outcome the conversation can say. */
export async function runTool(d: ToolDeps, a: ToolArgs): Promise<ToolOutcome> {
  // with neither Google nor Spotify configured there is nothing to choose between: straight to the web, no extra call
  const plan = await planTool(d.llm, a, Boolean(d.google || d.spotify));
  try {
    if (plan.tool === "web") {
      const r = await webLookup(d.llm, { question: a.question, recent: a.recent, language: a.language, timeZone: a.timeZone, now: a.now });
      return { tool: "web", ok: r.ok, message: lookupMessage(r), ...(r.ok ? {} : { reason: r.reason }) };
    }
    if (plan.tool === "music") {
      if (!d.spotify) return note("music", NOT_CONNECTED.music, "unavailable");
      if (plan.action === "play") return await playMusic(d, a, plan);
      const hits = await spotify.search(d.http, d.spotify, plan.query || a.question, plan.kind);
      // the composer sees the results numbered, without links or pictures; the ones it names become cards
      const c = await compose(d.llm, a, "music", hits.map(({ url: _u, image: _i, ...h }, i) => ({ i, ...h })));
      if (!c) return note("music", FAILED, "failed");
      const chosen = [...new Set(c.picks)].map((i) => hits[i]).filter((h): h is spotify.MusicHit => Boolean(h?.url)).slice(0, 2);
      const media: MediaItem[] = (chosen.length ? chosen : hits.filter((h) => h.url).slice(0, 1))
        .map((h) => ({ kind: h.kind, title: h.name, subtitle: h.by, image: h.image, url: h.url!, provider: "spotify" as const }));
      return { ...say("music", c.answer), ...(media.length ? { media } : {}) };
    }
    // calendar / email: the user's own Google account
    if (!d.google) return note(plan.tool, NOT_CONNECTED[plan.tool], "unavailable");
    const refresh = await d.connections.googleRefresh(a.userId);
    if (!refresh) return note(plan.tool, NOT_CONNECTED[plan.tool], "not_connected");
    let token: string;
    try { token = await google.accessToken(d.http, d.google, refresh); }
    catch (e) {
      if (e instanceof google.GoogleAuthLost) { await d.connections.dropGoogle(a.userId); return note(plan.tool, "Their Google access was withdrawn, so you cannot see it any more. They can connect it again in the app.", "revoked"); }
      throw e;
    }
    const data = plan.tool === "calendar"
      ? await google.calendarEvents(d.http, token, startOfDay(a.now ?? new Date(), a.timeZone, plan.fromDay), plan.days, a.timeZone)
      : await google.mailSearch(d.http, token, plan.query || "is:unread newer_than:3d");
    const c = await compose(d.llm, a, plan.tool, data);
    return c ? say(plan.tool, c.answer) : note(plan.tool, FAILED, "failed");
  } catch (e) {
    return note(plan.tool, FAILED, String(e).slice(0, 80));
  }
}
