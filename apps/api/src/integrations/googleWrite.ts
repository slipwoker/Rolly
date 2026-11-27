/**
 * Writing to the user's Google account: one email, one calendar event. Only ever called by integrations/actions.ts after the
 * user said yes to a draft that was read back. Never deletes or edits anything that exists.
 */
import { form, type Http } from "./http.ts";

const AUTH = (t: string) => ({ Authorization: `Bearer ${t}` });
export const EMAIL = /^[^\s@<>",;:()\[\]\\]+@[^\s@<>",;:()\[\]\\]+\.[^\s@<>",;:()\[\]\\]{2,}$/;
/** no line breaks or control characters in anything that goes into a header */
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029‮]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export interface MailDraft { to: string; toName: string | null; subject: string; body: string }

/** RFC 5322 message, UTF-8, base64 body (Hebrew safe), subject as an RFC 2047 encoded word. */
export function rawMessage(d: MailDraft, fromEmail: string | null): string {
  const to = d.toName ? `${encodeWord(oneLine(d.toName, 80))} <${d.to}>` : d.to;
  const lines = [
    ...(fromEmail && EMAIL.test(fromEmail) ? [`From: ${fromEmail}`] : []),
    `To: ${to}`,
    `Subject: ${encodeWord(oneLine(d.subject, 200))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(d.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export async function sendMail(http: Http, token: string, d: MailDraft, fromEmail: string | null): Promise<boolean> {
  if (!EMAIL.test(d.to)) return false;
  const r = await http("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { ...AUTH(token), "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawMessage(d, fromEmail) }) });
  return r.ok;
}

export interface Person { name: string | null; address: string }

/**
 * A name from the user's own mail: addresses in the From/To headers of recent messages whose display name matches. Only
 * addresses and names are used (never message text). One person, or several to ask about, or nobody.
 */
export async function findPeople(http: Http, token: string, name: string): Promise<Person[]> {
  const q = name.replace(/["\\]/g, " ").trim().slice(0, 60);
  if (!q) return [];
  const list = await http("https://gmail.googleapis.com/gmail/v1/users/me/messages?" + form({ q: `from:"${q}" OR to:"${q}"`, maxResults: "10" }), { headers: AUTH(token) });
  if (!list.ok) throw new Error(`gmail HTTP ${list.status}`);
  const ids = ((list.json as { messages?: { id: string }[] } | null)?.messages ?? []).map((m) => m.id);
  const norm = (s: string) => s.toLowerCase().replace(/["'׳״`.,\-_\s]+/g, "");
  const want = norm(q);
  const found = new Map<string, Person>();
  await Promise.all(ids.map(async (id) => {
    const r = await http(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To`, { headers: AUTH(token) });
    const headers = (r.json as { payload?: { headers?: { name: string; value: string }[] } } | null)?.payload?.headers ?? [];
    for (const h of headers) for (const part of h.value.split(",")) {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part) ?? /^\s*()([^\s<>]+@[^\s<>]+)\s*$/.exec(part);
      if (!m) continue;
      const display = oneLine(m[1] ?? "", 80), address = m[2]!.trim().toLowerCase();
      if (!EMAIL.test(address)) continue;
      // the name must be in what the person is called in their mail, or be their address; "from"/"to" alone is not a match
      if (!norm(display).includes(want) && !address.startsWith(want)) continue;
      if (!found.has(address)) found.set(address, { name: display || null, address });
    }
  }));
  return [...found.values()].slice(0, 4);
}

export interface EventDraft { title: string; start: string; end: string; timeZone: string; location: string | null; attendees: Person[] }

/** `start` and `end` are local "YYYY-MM-DDTHH:mm" in `timeZone`. Guests, if any, get Google's invitation. */
export async function createEvent(http: Http, token: string, e: EventDraft): Promise<boolean> {
  const body = {
    summary: oneLine(e.title, 200),
    ...(e.location ? { location: oneLine(e.location, 200) } : {}),
    start: { dateTime: `${e.start}:00`, timeZone: e.timeZone }, end: { dateTime: `${e.end}:00`, timeZone: e.timeZone },
    ...(e.attendees.length ? { attendees: e.attendees.filter((a) => EMAIL.test(a.address)).map((a) => ({ email: a.address, ...(a.name ? { displayName: a.name } : {}) })) } : {}),
  };
  const r = await http("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + form({ sendUpdates: e.attendees.length ? "all" : "none" }), { method: "POST",
    headers: { ...AUTH(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.ok;
}

/** Wall-clock "YYYY-MM-DDTHH:mm" in a time zone -> the instant. */
export function zonedToDate(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(asUtc).getUTCMonth() !== mo - 1) return null; // 31 February
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t); // once more: the offset at the real instant (daylight saving)
  return new Date(t);
}

/** local "YYYY-MM-DDTHH:mm" plus minutes, in the same zone (done on wall-clock time: the event is for that clock time) */
export function addMinutesLocal(local: string, minutes: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)!;
  const t = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) + minutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}
