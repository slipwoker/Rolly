/**
 * Mail that bears on what is coming up, read in the background before a ride (P1-D42), only with the standing consent for
 * mail and a Google connection. Gmail's own headers and snippet only, never bodies; at most eight messages. What to look for
 * comes from the next calendar events (their distinctive words); without calendar lines, the last three days of real mail
 * (no promotions or social). Every line goes through `sanitize` and is cut. Nothing is stored.
 */
import * as google from "../integrations/google.ts";
import type { Connections } from "../integrations/tools.ts";
import type { Http } from "../integrations/http.ts";
import { sanitize } from "../whatsapp/format.ts";
import type { MessageRead } from "./whatsapp.ts";

export interface MailSignalDeps { consent: (userId: string, source: "mail") => Promise<boolean>; connections: Connections; google: google.GoogleConfig | null; http: Http }

const STOP = new Set(["with", "meeting", "call", "the", "and", "עם", "של", "את", "על"]);
/** the most distinctive words of an event title ("פגישה עם משקיע - קרן אלפא" -> פגישה, משקיע, אלפא) */
export function keywords(title: string): string[] {
  const words = title.replace(/\([^)]*\)/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3);
}

export function queries(calendar: string[]): string[] {
  const qs = calendar.slice(0, 3).map((l) => keywords(l.replace(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})? /, ""))).filter((k) => k.length).map((k) => `newer_than:14d (${k.join(" OR ")})`);
  return qs.length ? qs : ["newer_than:3d -category:promotions -category:social"];
}

export async function readMail(d: MailSignalDeps, userId: string, calendar: string[]): Promise<MessageRead | null> {
  if (!d.google || !(await d.consent(userId, "mail").catch(() => false))) return null;
  const refresh = await d.connections.googleRefresh(userId).catch(() => null);
  if (!refresh) return null;
  try {
    const token = await google.accessToken(d.http, d.google, refresh);
    const seen = new Set<string>(), lines: string[] = [];
    for (const q of queries(calendar)) {
      for (const m of await google.mailSearch(d.http, token, q)) {
        const line = `${sanitize(m.from, 60)} - ${sanitize(m.subject, 120)} - ${sanitize(m.snippet, 160)}`;
        if (!seen.has(line) && lines.length < 8) { seen.add(line); lines.push(line); }
      }
    }
    return { lines, read: lines.length };
  } catch (e) {
    if (e instanceof google.GoogleAuthLost) await d.connections.dropGoogle(userId).catch(() => {});
    return null;
  }
}
