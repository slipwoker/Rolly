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
import type { GoogleActions } from "./actions.ts";
import type { Http } from "./http.ts";
import type { MediaItem } from "@rolly/contracts";

export type ToolName = "web" | "calendar" | "email" | "music" | "confirm" | "cancel" | "how";
export interface ToolPlan { tool: ToolName; action: "search" | "play" | "send" | "create"; query: string; kind: spotify.MusicKind; fromDay: number; days: number;
  /** email to send */ to: string; subject: string; body: string;
  /** event to add: start is local "YYYY-MM-DDTHH:mm" */ title: string; start: string; durationMin: number; location: string | null; attendees: string[] }
export interface ToolArgs { sessionId?: string; /** "uncertain" when weak hints suggest another voice */ attribution?: "primary" | "uncertain"; /** user turns so far: a draft can only be confirmed by a later turn */ userTurns?: number;
  /** what Rolly last showed as cards: "play this" means the first of them */ lastMedia?: MediaItem[]; userId: string; question: string; recent: { role: "user" | "agent"; text: string }[]; language: string; timeZone: string; now?: Date }
export interface ToolOutcome { message: string; ok: boolean; reason?: string; tool: ToolName;
  /** music: the results Rolly talks about, shown as cards in the chat */ media?: MediaItem[];
  /** play it: open this Spotify link on the phone once Rolly has finished speaking */
  open?: { url: string } }

/** Where the user's Google refresh token lives (the database, sealed); dropped when Google says access was withdrawn. */
export interface Connections { googleRefresh(userId: string): Promise<string | null>; dropGoogle(userId: string): Promise<void>;
  /** the scopes this user granted (space separated), to know whether writing is allowed */ googleScopes?(userId: string): Promise<string | null> }
export interface ToolDeps { llm: UtilityLlm | null; http: Http; connections: Connections; google: google.GoogleConfig | null; spotify: spotify.SpotifyConfig | null;
  /** sending email and adding events (after a spoken yes); null = off */ actions?: GoogleActions | null }

export const PLAN_PROMPT = `You route one request from a voice companion's user to the right tool. Reply with JSON only.

Tools:
- "calendar": the user's own schedule (meetings, appointments, what is on today/tomorrow, when something is).
- "email": the user's own mail (new or unread messages, did someone write, what did X send).
- "music": find a song, artist, album, podcast or podcast episode, or recommend music or podcasts to listen to.
- "web": anything else that needs current facts from the internet.
- "how": they ask WHETHER or WHAT you can do ("can you send email?", "אתה יכול לשלוח מייל?", "what can you do with my calendar?"): a question about the ability, not a request to do it.
- "confirm" / "cancel": ONLY when something is waiting for their answer (see below): "confirm" when their words clearly say yes to it (yes, send it, go ahead, כן, שלח, תוסיף), "cancel" when they say no, stop, never mind. If nothing is waiting never use them.

JSON: {"tool": "calendar"|"email"|"music"|"web"|"confirm"|"cancel"|"how", "action": "search"|"play"|"send"|"create", "to": string, "subject": string, "body": string, "title": string, "start": string, "duration_min": number, "location": string, "attendees": string[], "query": string, "kind": "track"|"artist"|"album"|"show"|"episode"|"any", "from_day": number, "days": number}
- email, action "send": they ask to write or send an email ("תשלח מייל לדנה ש...", "write to Dana"). to = the person's name as they said it, or the address if they said it (spoken "dana at gmail dot com" becomes dana@gmail.com); subject = a short subject in their language; body = the message itself in first person, as they would write it, only what they said (no greeting, sign-off or details they did not say). Every other email request is action "search" (reading mail).
- email, action "search": query is a Gmail search ("is:unread newer_than:2d", "from:dana", "subject:flight"); default "is:unread newer_than:3d".
- music: anything about a song, artist, album, podcast or Spotify is "music", never "web".
  action "play": the user wants it played or opened: "play", "put on", "open it", "send/give me the link" ("תנגן", "תשים", "תפתח", "תן לי קישור", "פתחת?"). action "search": they ask about something or for a recommendation.
  For "play": query = the song or show to play, from the conversation: what they named, else what the companion just named or recommended ("Three Little Birds Bob Marley"). Leave query "" only when "shown as cards" below lists it and they mean that. For "search": query = what to search the catalogue for: the title/artist the user named, or for a recommendation a few well-chosen search terms (genre, mood, a similar artist, a podcast topic). kind "show" for podcasts, "episode" for a specific episode, "track" for a song, "any" if unsure.
- calendar, action "create": they ask to add, schedule or set a meeting or appointment ("קבע לי פגישה", "תוסיף ליומן", "זמן את דנה"). title = what it is; start = local date and time "YYYY-MM-DDTHH:mm" worked out from Now below (the next such day if they say only a weekday; leave "" if they gave no time); duration_min = minutes (60 if they said nothing); location = "" if none; attendees = names or addresses of the people to invite ([] if none). Every other calendar request is action "search" (reading).
- calendar, action "search": from_day = days from today (0 = today, 1 = tomorrow), days = how many days to cover (1-7).
- Unused fields: action "search", to/subject/body/title/start/location "", duration_min 60, attendees [], query "", kind "any", from_day 0, days 1.

The conversation so far:
{recent}

Shown to the user as cards just now: {shown}
Waiting for their answer: {waiting}
Now: {now}

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

const TASKS: Record<Exclude<ToolName, "web" | "confirm" | "cancel" | "how">, string> = {
  calendar: "Say what is coming up in the order it happens, with the time in 24-hour form (and the place if there is one). If many events, the first three and how many more.",
  email: "Say how many messages and who they are from and what they are about, the newest first, at most three. Do not read long text; never repeat passwords, codes or numbers that look like one.",
  music: "If they asked for a specific song, artist or show, say what you found. If they asked for a recommendation, pick one or two of the results and say in a few words why they fit; do not list everything.",
};

const lang = (l: string) => (l === "en" ? "In English" : "In everyday spoken Hebrew, without niqqud");
const fill = (t: string, v: Record<string, string>) => Object.entries(v).reduce((s, [k, x]) => s.split(`{${k}}`).join(x), t);
const recentText = (r: ToolArgs["recent"]) => r.slice(-6).map((t) => `${t.role === "agent" ? "COMPANION" : "USER"}: ${t.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(nothing yet)";
const spoken = (s: string) => s.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[*_#`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 500);

export function parsePlan(obj: Record<string, unknown>): ToolPlan {
  const tool = (["calendar", "email", "music", "web", "confirm", "cancel", "how"] as const).find((t) => t === obj.tool) ?? "web";
  const kind = (["track", "artist", "album", "show", "episode", "any"] as const).find((k) => k === obj.kind) ?? "any";
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
  const action = tool === "music" && obj.action === "play" ? "play" : tool === "email" && obj.action === "send" ? "send" : tool === "calendar" && obj.action === "create" ? "create" : "search";
  return { tool, action, to: str(obj.to, 120), subject: str(obj.subject, 200), body: str(obj.body, 2000), title: str(obj.title, 200), start: str(obj.start, 16), location: str(obj.location, 200) || null,
    durationMin: n(obj.duration_min, 5, 480, 60), attendees: Array.isArray(obj.attendees) ? (obj.attendees as unknown[]).map((x) => str(x, 120)).filter(Boolean).slice(0, 5) : [], kind, query: typeof obj.query === "string" ? obj.query.slice(0, 200) : "", fromDay: n(obj.from_day, 0, 30, 0), days: n(obj.days, 1, 7, 1) };
}

export async function planTool(llm: UtilityLlm | null, a: ToolArgs, canRoute = true, d?: Pick<ToolDeps, "actions">): Promise<ToolPlan> {
  const fallback: ToolPlan = { tool: "web", action: "search", query: "", kind: "any", fromDay: 0, days: 1, to: "", subject: "", body: "", title: "", start: "", durationMin: 60, location: null, attendees: [] };
  if (!llm || !canRoute) return fallback;
  try {
    const r = await llm.json(fill(PLAN_PROMPT, { recent: recentText(a.recent), waiting: (d?.actions && a.sessionId ? d.actions.waiting(a.sessionId) : null) ?? "(nothing)",
      now: new Intl.DateTimeFormat("en-GB", { timeZone: a.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(a.now ?? new Date()) + `, ${a.timeZone}`, shown: a.lastMedia?.map((m) => `${m.title}${m.subtitle ? ` (${m.subtitle})` : ""}`).join("; ") || "(nothing)", question: a.question.replace(/\s+/g, " ").slice(0, 400) }), { maxTokens: 700, purpose: "tool_plan" });
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

async function compose(llm: UtilityLlm | null, a: ToolArgs, tool: Exclude<ToolName, "web" | "confirm" | "cancel" | "how">, data: unknown): Promise<{ answer: string; picks: number[] } | null> {
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
  nothing: "There is nothing to play yet: ask them in a few words what they want to hear.",
};

/**
 * "Play it": the song's link is opened in the Spotify app on the user's phone, after Rolly has said so (voice/session.ts).
 * No Spotify account is connected and no player API is used, so it works for every user and every plan (Spotify limits its
 * player API to a handful of allowlisted users). What to play: what they named, else what Rolly just showed as a card.
 */
async function playMusic(d: ToolDeps, a: ToolArgs, plan: ToolPlan): Promise<ToolOutcome> {
  let item: MediaItem | undefined;
  if (plan.query) {
    const hit = (await spotify.search(d.http, d.spotify!, plan.query, plan.kind === "any" ? "track" : plan.kind)).find((h) => h.url && spotify.playTarget(h.url));
    if (hit) item = { kind: hit.kind, title: hit.name, subtitle: hit.by, image: hit.image, url: hit.url!, provider: "spotify" };
  } else item = a.lastMedia?.find((m) => spotify.playTarget(m.url));
  if (!item) return note("music", PLAY_NOTES_NOTHING, "nothing");
  return { tool: "music", ok: true, media: [item], open: { url: item.url },
    message: `${LOOKUP_TAG} You are going to open "${item.title}"${item.subtitle ? ` (${item.subtitle})` : ""} in Spotify on their phone.
Tell them in a few words, in your own words, that you are opening it. The screen switches to Spotify the moment you stop talking and you will not hear them until they come back and tap the screen. Do not ask anything.` };
}
const PLAY_NOTES_NOTHING = "There is nothing to play yet: ask them in a few words what they want to hear.";

/** "Can you send email?": what Rolly can do for THIS user, from what is connected and allowed (not a web search). */
async function abilities(d: ToolDeps, a: ToolArgs): Promise<string> {
  const lines: string[] = [];
  if (d.google) {
    const connected = Boolean(await d.connections.googleRefresh(a.userId).catch(() => null));
    const g = google.grants((await d.connections.googleScopes?.(a.userId).catch(() => null)) ?? "");
    if (!connected) lines.push("Their calendar and mail: you can read them, send email and add events, but their Google account is not connected yet: they connect it in the app under connected services.");
    else {
      if (g.calendarRead || g.mailRead) lines.push(`Read: ${[g.calendarRead && "what is on their calendar", g.mailRead && "what is new in their mail"].filter(Boolean).join(" and ")}.`);
      if (g.sendMail && d.actions) lines.push("Send an email for them: they say to whom and what; you read it back and send it only after their yes in their next turn.");
      if (g.writeCalendar && d.actions) lines.push("Add an event or a meeting to their calendar (and invite people): same way, you read it back and add it only after their yes.");
      if (!(g.sendMail && g.writeCalendar)) lines.push("Some permissions are missing for sending email or adding events: they tap update permissions in the app under connected services and tick all the boxes.");
      lines.push("You cannot reply inside a thread, delete or change anything that exists.");
    }
  }
  if (d.spotify) lines.push("Music and podcasts: find and recommend them, and open one in their Spotify app when they ask (you do not hear them while it plays).");
  return `${LOOKUP_TAG} They asked what you can do. These are the facts about what you can do for them:\n${lines.join("\n") || "Nothing of this is set up."}\nAnswer exactly what they asked, in one or two short sentences in your own words. Do not check anything else.`;
}

/** One tool call for one question. Never throws: every failure is an outcome the conversation can say. */
export async function runTool(d: ToolDeps, a: ToolArgs): Promise<ToolOutcome> {
  // with neither Google nor Spotify configured there is nothing to choose between: straight to the web, no extra call
  const plan = await planTool(d.llm, a, Boolean(d.google || d.spotify), d);
  try {
    // writing (an email, an event) and the yes or no to a draft: integrations/actions.ts, which holds the safety rules
    const writes = plan.tool === "confirm" || plan.tool === "cancel" || (plan.tool === "email" && plan.action === "send") || (plan.tool === "calendar" && plan.action === "create");
    if (writes) {
      if (!d.actions || !a.sessionId) return note(plan.tool, "You cannot do that here.", "unavailable");
      const who = { userId: a.userId, sessionId: a.sessionId, language: a.language, attribution: a.attribution, userTurns: a.userTurns };
      const r = plan.tool === "confirm" ? await d.actions.confirm(who) : plan.tool === "cancel" ? d.actions.cancel(who)
        : plan.tool === "email" ? await d.actions.draftEmail(who, { to: plan.to, subject: plan.subject, body: plan.body })
        : await d.actions.draftEvent(who, { title: plan.title, start: plan.start, durationMin: plan.durationMin, location: plan.location, attendees: plan.attendees });
      return { tool: plan.tool, ok: r.ok, message: r.message, ...(r.reason ? { reason: r.reason } : {}) };
    }
    if (plan.tool === "how") return { tool: "how", ok: true, message: await abilities(d, a) };
    if (plan.tool === "web" || plan.tool === "confirm" || plan.tool === "cancel") {
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
    // Google's consent screen lets the user untick a permission: say what is missing instead of failing with a 403
    const sc = await d.connections.googleScopes?.(a.userId);
    if (sc !== undefined && sc !== null) {
      const g = google.grants(sc);
      if (plan.tool === "calendar" ? !g.calendarRead : !g.mailRead)
        return note(plan.tool, `Their Google connection does not include permission for their ${plan.tool === "calendar" ? "calendar" : "mail"} (on Google's screen each permission has a box that can be left unticked). They can fix it in the app under connected services: tap update permissions and tick all the boxes.`, "needs_update");
    }
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
    return note(plan.tool, FAILED, String(e).slice(0, 200));
  }
}
