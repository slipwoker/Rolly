/**
 * Writing to the user's Google account from a conversation: send one email, add one event to the calendar.
 *
 * Safety rules enforced here (same as WhatsApp, whatsapp/flow.ts):
 *  1. Nothing is sent or created from the user's first request: it makes a DRAFT, Rolly reads it back, and only a yes in a
 *     LATER user turn does it. A yes in the same turn that made the draft, or with nothing waiting, never does anything.
 *  2. Nothing is drafted or done when the turn may be someone else's voice (attribution "uncertain"), also for the yes.
 *  3. Recipients come only from what the user said or from names in their own mail headers; an unknown or ambiguous name
 *     is asked about, never guessed. Mail text is never read here.
 *  4. Only what the user's words say goes into the message or the event: this module adds nothing.
 *  5. Rate limited per user; connections that were made read-only are told to reconnect in the app.
 */
import { LOOKUP_FAILED_TAG, LOOKUP_TAG } from "../lookup/web.ts";
import { RateLimiter } from "../auth.ts";
import * as google from "./google.ts";
import * as gw from "./googleWrite.ts";
import type { Http } from "./http.ts";
import type { Connections } from "./tools.ts";

export interface ActionArgs { userId: string; sessionId: string; language: string; attribution?: "primary" | "uncertain"; userTurns?: number }
export interface ActionResult { message: string; ok: boolean; reason?: string }
export interface EmailFields { to: string; subject: string; body: string }
export interface EventFields { title: string; start: string; durationMin: number; location: string | null; attendees: string[] }

type Pending =
  | { kind: "email"; draft: gw.MailDraft; atUserTurn: number; at: number }
  | { kind: "event"; draft: gw.EventDraft; startsAt: Date; atUserTurn: number; at: number };

const TTL_MS = 10 * 60_000;
const ok = (text: string): ActionResult => ({ ok: true, message: `${LOOKUP_TAG} ${text}` });
const no = (reason: string, text: string): ActionResult => ({ ok: false, reason, message: `${LOOKUP_FAILED_TAG} ${text} Say so in a few words, do not guess, and go on with the conversation.` });

export class GoogleActions {
  private pending = new Map<string, Pending>(); // by session
  private mailLimit = new RateLimiter(10, 3600_000);
  private eventLimit = new RateLimiter(15, 3600_000);

  constructor(private readonly d: { http: Http; cfg: google.GoogleConfig; connections: Connections; timeZone: string; now?: () => Date }) {}

  private now() { return this.d.now?.() ?? new Date(); }

  /** What is waiting for a yes, in a line for the planner ("confirm" and "cancel" only make sense then). */
  waiting(sessionId: string): string | null {
    const p = this.pending.get(sessionId);
    if (!p || Date.now() - p.at > TTL_MS) return null;
    return p.kind === "email" ? `an email to ${p.draft.toName ?? p.draft.to}, subject "${p.draft.subject}"` : `a calendar event "${p.draft.title}" at ${p.draft.start}`;
  }

  endSession(sessionId: string) { this.pending.delete(sessionId); }

  // ------------------------------------------------------------------ common
  /** A token for this user's Google, or why not. `need`: the permission this action needs. */
  private async access(a: ActionArgs, need: "sendMail" | "writeCalendar"): Promise<{ token: string } | { error: ActionResult }> {
    if (a.attribution === "uncertain") return { error: no("not_user_voice", "You are not sure it was them speaking, so you cannot do this for now.") };
    const refresh = await this.d.connections.googleRefresh(a.userId);
    if (!refresh) return { error: no("not_connected", "Their Google account is not connected. They can connect it in the app under connected services.") };
    const granted = google.grants((await this.d.connections.googleScopes?.(a.userId)) ?? "");
    if (!granted[need]) return { error: no("needs_update", `Their Google connection only lets you read. To ${need === "sendMail" ? "send email" : "add events"} they need to update the permissions in the app under connected services (one tap), then ask again.`) };
    try { return { token: await google.accessToken(this.d.http, this.d.cfg, refresh) }; }
    catch (e) {
      if (e instanceof google.GoogleAuthLost) { await this.d.connections.dropGoogle(a.userId); return { error: no("revoked", "Their Google access was withdrawn. They can connect it again in the app.") }; }
      return { error: no("failed", "That did not work just now.") };
    }
  }

  /** One address for a name, or what to ask. */
  private async person(token: string, who: string): Promise<{ person: gw.Person } | { error: ActionResult }> {
    const s = who.trim();
    if (gw.EMAIL.test(s)) return { person: { name: null, address: s.toLowerCase() } };
    const found = await gw.findPeople(this.d.http, token, s).catch(() => null);
    if (found === null) return { error: no("failed", "That did not work just now.") };
    if (found.length === 0) return { error: no("no_address", `You found no email address for "${s}" in their mail. Ask them to say the address.`) };
    if (found.length > 1) return { error: no("ambiguous", `Several addresses match "${s}": ${found.map((p) => `${p.name ?? "(no name)"} at ${p.address.split("@")[1]}`).join("; ")}. Ask which one.`) };
    return { person: found[0]! };
  }

  // ------------------------------------------------------------------ email
  async draftEmail(a: ActionArgs, f: EmailFields): Promise<ActionResult> {
    const body = f.body.trim();
    if (!f.to.trim()) return no("no_recipient", "You do not know who to write to. Ask them.");
    if (!body) return no("no_text", "You do not know what to write. Ask them.");
    const acc = await this.access(a, "sendMail"); if ("error" in acc) return acc.error;
    const r = await this.person(acc.token, f.to); if ("error" in r) return r.error;
    const subject = f.subject.trim() || body.split(/\s+/).slice(0, 6).join(" ");
    this.pending.set(a.sessionId, { kind: "email", draft: { to: r.person.address, toName: r.person.name, subject, body }, atUserTurn: a.userTurns ?? 0, at: Date.now() });
    return ok(`An email draft is ready. It is NOT sent.
To: ${r.person.name ?? r.person.address}${r.person.name ? ` (${r.person.address.split("@")[1]})` : ""}
Subject: ${subject}
Text: "${body}"
Read it back in a few words (who, and what it says) and ask if to send it. It is sent only if they say yes in their NEXT turn; if they change it, make a new draft.`);
  }

  // ------------------------------------------------------------------ event
  async draftEvent(a: ActionArgs, f: EventFields): Promise<ActionResult> {
    if (!f.title.trim()) return no("no_title", "You do not know what the event is. Ask them.");
    const startsAt = gw.zonedToDate(f.start, this.d.timeZone);
    if (!startsAt) return no("no_time", "You do not know when. Ask them for the day and the time.");
    if (startsAt.getTime() < this.now().getTime() - 5 * 60_000) return no("past", "That time has already passed. Ask for another.");
    const minutes = Math.min(480, Math.max(5, Math.round(f.durationMin || 60)));
    const acc = await this.access(a, "writeCalendar"); if ("error" in acc) return acc.error;
    const guests: gw.Person[] = [];
    for (const who of f.attendees.slice(0, 5)) {
      const r = await this.person(acc.token, who); if ("error" in r) return r.error;
      guests.push(r.person);
    }
    const end = gw.addMinutesLocal(f.start, minutes);
    const endsAt = gw.zonedToDate(end, this.d.timeZone)!;
    // what is already there at that time, so Rolly can say so
    const clash = await google.calendarEvents(this.d.http, acc.token, startsAt, 1, this.d.timeZone).then((evs) => evs.filter((e) => !e.allDay
      && new Date(e.start).getTime() < endsAt.getTime() && new Date(e.end).getTime() > startsAt.getTime())).catch(() => []);
    const draft: gw.EventDraft = { title: f.title.trim(), start: f.start, end, timeZone: this.d.timeZone, location: f.location?.trim() || null, attendees: guests };
    this.pending.set(a.sessionId, { kind: "event", draft, startsAt, atUserTurn: a.userTurns ?? 0, at: Date.now() });
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: this.d.timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(startsAt);
    return ok(`A calendar event draft is ready. It is NOT added yet.
Title: ${draft.title}
When: ${when}, ${minutes} minutes${draft.location ? `\nWhere: ${draft.location}` : ""}${guests.length ? `\nInvited (they get an invitation): ${guests.map((g) => g.name ?? g.address).join(", ")}` : ""}${clash.length ? `\nNote: they already have "${clash[0]!.title}" at that time: say so.` : ""}
Read it back in a few words and ask if to add it. It is added only if they say yes in their NEXT turn; if they change it, make a new draft.`);
  }

  // ------------------------------------------------------------------ yes / no
  async confirm(a: ActionArgs): Promise<ActionResult> {
    const p = this.pending.get(a.sessionId);
    if (!p || Date.now() - p.at > TTL_MS) { this.pending.delete(a.sessionId); return no("nothing_waiting", "Nothing is waiting for their yes (nothing was sent or added)."); }
    // the yes must come in a user turn AFTER the one that produced the draft
    if ((a.userTurns ?? 0) <= p.atUserTurn) return no("same_turn", "They have not answered yet: read it back and wait for their answer. Nothing was done.");
    const acc = await this.access(a, p.kind === "email" ? "sendMail" : "writeCalendar"); if ("error" in acc) return acc.error;
    if (!(p.kind === "email" ? this.mailLimit : this.eventLimit).allow(a.userId)) return no("limit", "They have reached the limit for now (to protect their account). It was not done.");
    this.pending.delete(a.sessionId);
    const done = p.kind === "email" ? await gw.sendMail(this.d.http, acc.token, p.draft, null).catch(() => false) : await gw.createEvent(this.d.http, acc.token, p.draft).catch(() => false);
    if (!done) return no("failed", p.kind === "email" ? "The email was not sent." : "The event was not added.");
    return ok(p.kind === "email" ? `The email to ${p.draft.toName ?? p.draft.to} was sent. Tell them in a few words.` : `The event "${p.draft.title}" was added to their calendar. Tell them in a few words.`);
  }

  cancel(a: ActionArgs): ActionResult {
    const had = this.pending.delete(a.sessionId);
    return ok(had ? "Cancelled: nothing was sent or added. Tell them in a few words." : "Nothing was waiting, so nothing was sent or added. Tell them in a few words.");
  }
}
