/**
 * Google: the user's calendar and mail. Reading (gmail.readonly, and events through calendar.events), and, only after the
 * user's spoken yes to a draft that was read back (integrations/actions.ts): sending an email (gmail.send) and adding an
 * event to the calendar (calendar.events). Nothing is deleted, and existing events and mail threads are never changed.
 * OAuth 2.0 authorization-code flow with offline access: the phone opens the consent page in the browser, Google
 * redirects to /v1/integrations/google/callback on the API, which stores the refresh token sealed.
 */
import { form, type Http } from "./http.ts";

export const SCOPE_CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
export const SCOPE_GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_SCOPES = [SCOPE_CALENDAR_EVENTS, SCOPE_GMAIL_READ, SCOPE_GMAIL_SEND, "https://www.googleapis.com/auth/userinfo.email"];

/** What a stored connection may do. Connections made before writing existed only have the read-only calendar scope. */
export function grants(scopes: string): { read: boolean; mailRead: boolean; calendarRead: boolean; sendMail: boolean; writeCalendar: boolean } {
  const has = (x: string) => scopes.split(/\s+/).includes(x);
  // Google's consent screen lets the user untick individual permissions: each one is checked on its own
  const calendarRead = has(SCOPE_CALENDAR_EVENTS) || has("https://www.googleapis.com/auth/calendar.readonly"), mailRead = has(SCOPE_GMAIL_READ);
  return { read: mailRead || calendarRead, mailRead, calendarRead, sendMail: has(SCOPE_GMAIL_SEND), writeCalendar: has(SCOPE_CALENDAR_EVENTS) };
}

/** Google says why in the body ({"error":{"message":..., "errors":[{"reason":...}]}}); the audit shows it */
export const why = (j: unknown): string => {
  const e = (j as { error?: { message?: string; errors?: { reason?: string }[] } | string } | null)?.error;
  const m = typeof e === "string" ? e : [e?.errors?.[0]?.reason, e?.message].filter(Boolean).join(": ");
  return m ? `: ${m}`.slice(0, 200) : "";
};

export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }

export function authUrl(c: GoogleConfig, state: string): string {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + form({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
}

/** Code from the callback -> refresh token and the account's email. */
export async function exchangeCode(http: Http, c: GoogleConfig, code: string): Promise<{ refreshToken: string; email: string | null; scopes: string } | null> {
  const r = await http("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code" }) });
  const j = r.json as { refresh_token?: string; access_token?: string; scope?: string } | null;
  if (!r.ok || !j?.refresh_token) return null;
  let email: string | null = null;
  if (j.access_token) {
    const u = await http("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${j.access_token}` } }).catch(() => null);
    email = (u?.json as { email?: string } | null)?.email ?? null;
  }
  return { refreshToken: j.refresh_token, email, scopes: j.scope ?? "" };
}

export class GoogleAuthLost extends Error {}

export async function accessToken(http: Http, c: GoogleConfig, refreshToken: string): Promise<string> {
  const r = await http("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }) });
  const j = r.json as { access_token?: string; error?: string } | null;
  if (r.status === 400 && j?.error === "invalid_grant") throw new GoogleAuthLost("the user revoked access"); // consent withdrawn
  if (!r.ok || !j?.access_token) throw new Error(`google token HTTP ${r.status}`);
  return j.access_token;
}

export async function revoke(http: Http, refreshToken: string): Promise<void> {
  await http("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: refreshToken }) }).catch(() => {});
}

export interface CalEvent { title: string; start: string; end: string; allDay: boolean; location: string | null }

/** Events from `from` (inclusive) for `days` days, across the user's primary calendar, in start order. */
export async function calendarEvents(http: Http, token: string, from: Date, days: number, timeZone: string): Promise<CalEvent[]> {
  const to = new Date(from.getTime() + Math.min(Math.max(days, 1), 14) * 86_400_000);
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + form({
    timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "15", timeZone,
  });
  const r = await http(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`calendar HTTP ${r.status}${why(r.json)}`);
  const items = ((r.json as { items?: Record<string, unknown>[] } | null)?.items ?? []);
  return items.filter((e) => e.status !== "cancelled").map((e) => {
    const s = e.start as { dateTime?: string; date?: string } | undefined, en = e.end as { dateTime?: string; date?: string } | undefined;
    return { title: String(e.summary ?? "(no title)").slice(0, 120), start: s?.dateTime ?? s?.date ?? "", end: en?.dateTime ?? en?.date ?? "",
      allDay: !s?.dateTime, location: e.location ? String(e.location).slice(0, 100) : null };
  });
}

export interface MailItem { from: string; subject: string; snippet: string; date: string; unread: boolean }

/** Up to 5 messages matching a Gmail search (`is:unread`, `from:x`, …), newest first. Headers and Google's snippet only, never full bodies. */
export async function mailSearch(http: Http, token: string, q: string): Promise<MailItem[]> {
  const auth = { Authorization: `Bearer ${token}` };
  const list = await http("https://gmail.googleapis.com/gmail/v1/users/me/messages?" + form({ q: q || "in:inbox", maxResults: "5" }), { headers: auth });
  if (!list.ok) throw new Error(`gmail HTTP ${list.status}${why(list.json)}`);
  const ids = ((list.json as { messages?: { id: string }[] } | null)?.messages ?? []).map((m) => m.id);
  const out = await Promise.all(ids.map(async (id) => {
    const r = await http(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth });
    if (!r.ok) return null;
    const m = r.json as { snippet?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };
    const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    return { from: h("from").replace(/<[^>]*>/g, "").replace(/"/g, "").trim().slice(0, 80), subject: h("subject").slice(0, 120), snippet: (m.snippet ?? "").slice(0, 200),
      date: h("date"), unread: Boolean(m.labelIds?.includes("UNREAD")) } satisfies MailItem;
  }));
  return out.filter((x): x is MailItem => x !== null);
}
