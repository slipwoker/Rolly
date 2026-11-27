/**
 * What the calendar says about the next two weeks, read in the background before the plan for the next ride is made
 * (P1-D42). Only with the user's standing consent for this source (signal_consent), only titles, times and places (never
 * descriptions or attendees), and never stored: the lines go into one model call and what is kept is the plan item, which
 * names its source and expires on the day of the event.
 */
import * as google from "../integrations/google.ts";
import type { Connections } from "../integrations/tools.ts";
import type { Http } from "../integrations/http.ts";

export interface SignalDeps { consent: (userId: string, source: "calendar") => Promise<boolean>; connections: Connections; google: google.GoogleConfig | null; http: Http }
export interface SignalRead { lines: string[]; read: number }

const day = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** Lines like "2026-12-04 14:00 Investor meeting (Tel Aviv)", or null when nothing may be read (no consent, not connected, Google refused). */
export async function readCalendar(d: SignalDeps, userId: string, now: Date, timeZone: string): Promise<SignalRead | null> {
  if (!d.google || !(await d.consent(userId, "calendar").catch(() => false))) return null;
  const refresh = await d.connections.googleRefresh(userId).catch(() => null);
  if (!refresh) return null;
  try {
    const token = await google.accessToken(d.http, d.google, refresh);
    const events = await google.calendarEvents(d.http, token, now, 14, timeZone);
    const lines = events.map((e) => {
      const when = e.allDay ? day(e.start, timeZone) : `${day(e.start, timeZone)} ${new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(e.start))}`;
      return `${when} ${e.title}${e.location ? ` (${e.location})` : ""}`;
    });
    return { lines, read: events.length };
  } catch (e) {
    if (e instanceof google.GoogleAuthLost) await d.connections.dropGoogle(userId).catch(() => {});
    return null;
  }
}
