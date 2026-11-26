/**
 * WhatsApp inside a conversation. The model says "on it" and appends the lookup marker; the voice session calls the
 * lookup hook; this flow decides (intent.ts) whether it was about WhatsApp and does it through the gateway.
 *
 * Safety rules enforced here (docs/WHATSAPP_GATEWAY.md):
 *  1. Sending is draft -> read back -> a SEPARATE later user turn that says yes -> confirm. A yes in the same turn that
 *     created the draft, or before it, never confirms.
 *  2. Nothing is read or sent when the turn may be someone else's voice (attribution "uncertain").
 *  3. Message content is data: it is sanitised and wrapped (format.ts), and no code path acts on it.
 *  4. Only the gateway's own caps and the user's words move a message; this module never sends on its own.
 */
import type { UtilityLlm } from "../memory/llm.ts";
import { GatewayError, type Gateway, type GatewayChat, type GatewayMessage } from "./gateway.ts";
import * as F from "./format.ts";
import { interpret, type Intent } from "./intent.ts";

export interface FlowArgs {
  userId: string; sessionId: string; question: string; language: string;
  recent: { role: "user" | "agent"; text: string }[];
  /** "uncertain" when weak hints suggest another voice (session.ts attributionFor) */
  attribution?: "primary" | "uncertain";
  /** how many user turns the conversation has so far (a draft can only be confirmed by a LATER turn) */
  userTurns?: number;
}
export interface FlowResult { message: string; ok: boolean; reason?: string }

interface Pending { draftId: string; chatName: string; text: string; atUserTurn: number; at: number }

const norm = (s: string) => s.toLowerCase().replace(/["'׳״`.,\-_\s]+/g, "");

export class WhatsAppFlow {
  private pending = new Map<string, Pending>(); // by session
  private linkedCache = new Map<string, { ok: boolean; at: number }>();

  constructor(private readonly gw: Gateway, private readonly llm: UtilityLlm, private readonly opts: { tz: string; now?: () => Date } = { tz: "Asia/Jerusalem" }) {}

  private now() { return this.opts.now?.() ?? new Date(); }

  /** Does this user have WhatsApp linked? Cached for 30 s; a gateway that does not answer counts as not linked. */
  async linked(userId: string): Promise<boolean> {
    const hit = this.linkedCache.get(userId);
    if (hit && Date.now() - hit.at < 30_000) return hit.ok;
    let ok = false;
    try { const s = await this.gw.status(userId); ok = s.state === "connected" || s.state === "reconnecting"; } catch { ok = false; }
    this.linkedCache.set(userId, { ok, at: Date.now() });
    return ok;
  }

  /** the link state changed (linked, unlinked): ask the gateway again next time */
  forget(userId: string) { this.linkedCache.delete(userId); }

  endSession(sessionId: string, userId: string) {
    const p = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (p) void this.gw.cancel(userId, p.draftId).catch(() => {}); // a draft nobody confirmed is dropped
  }

  /** null = not about WhatsApp (the caller does a web lookup). */
  async handle(a: FlowArgs): Promise<FlowResult | null> {
    if (!(await this.linked(a.userId))) return null;
    const p = this.pending.get(a.sessionId) ?? null;
    const intent = await interpret(this.llm, { question: a.question, recent: a.recent, language: a.language, pending: p ? { chatName: p.chatName, text: p.text } : null });
    if (intent.kind === "other") return null;
    if (a.attribution === "uncertain") return { message: F.notYourVoiceMessage(), ok: false, reason: "not_user_voice" };
    try {
      switch (intent.kind) {
        case "read": return await this.read(a, intent);
        case "send": return await this.draft(a, intent);
        case "confirm": return await this.confirm(a);
        case "cancel": return await this.cancel(a);
      }
    } catch (e) {
      return this.failure(e);
    }
  }

  private failure(e: unknown): FlowResult {
    if (e instanceof GatewayError) {
      if (e.status === 429) return { message: F.limitMessage(e.reason, e.retryAfterS), ok: false, reason: e.reason ?? "limit" };
      if (e.status === 409) return { message: F.notConnectedMessage(), ok: false, reason: "not_connected" };
      if (e.status === 0) return { message: F.failedMessage(), ok: false, reason: "gateway_unreachable" };
    }
    return { message: F.failedMessage(), ok: false, reason: "failed" };
  }

  // ------------------------------------------------------------------ choosing a chat
  /** One chat, or why not. A send is never to a guess: several matches means asking which. */
  private async resolve(userId: string, contact: string): Promise<{ chat: GatewayChat } | { error: FlowResult }> {
    const search = async (q: string) => this.gw.chats(userId, q, 5);
    // Hebrew attaches "to/from/the" to the name: "לדני", "מדני", "המשפחה"
    const bare = /^[למהבו]/.test(contact) && contact.length > 2 ? contact.slice(1) : null;
    let found = await search(contact);
    if (!found.length && bare) found = await search(bare);
    const exact = found.filter((c) => norm(c.name) === norm(contact) || (bare !== null && norm(c.name) === norm(bare)));
    if (exact.length === 1) return { chat: exact[0]! };
    if (!found.length) return { error: { message: F.noChatMessage(contact), ok: false, reason: "no_chat" } };
    if (found.length === 1) return { chat: found[0]! };
    return { error: { message: F.ambiguousMessage(found.slice(0, 3).map((c) => c.name || "(no name)")), ok: false, reason: "ambiguous" } };
  }

  // ------------------------------------------------------------------ reading
  private async read(a: FlowArgs, i: Extract<Intent, { kind: "read" }>): Promise<FlowResult> {
    const now = this.now();
    if (!i.contact) return this.inbox(a, now);
    const r = await this.resolve(a.userId, i.contact);
    if ("error" in r) return r.error;
    const since = i.sinceHours ? Math.floor(now.getTime() / 1000 - i.sinceHours * 3600) : undefined;
    let page: { messages: GatewayMessage[] };
    try {
      page = await this.gw.messages(a.userId, r.chat.ref, { since, limit: 6, transcribe: true });
    } catch (e) {
      if (!(e instanceof GatewayError) || e.status !== 0) throw e;
      page = await this.gw.messages(a.userId, r.chat.ref, { since, limit: 6 }); // transcription too slow: read what is there
    }
    return { message: F.readMessage({ chatName: r.chat.name, isGroup: r.chat.is_group, messages: page.messages, now, tz: this.opts.tz, language: a.language }), ok: true };
  }

  /** "what came in?": the latest incoming message of the most recently active chats */
  private async inbox(a: FlowArgs, now: Date): Promise<FlowResult> {
    const chats = (await this.gw.chats(a.userId, "", 6));
    const items: F.InboxItem[] = [];
    await Promise.all(chats.map(async (c) => {
      const page = await this.gw.messages(a.userId, c.ref, { limit: 2, since: Math.floor(now.getTime() / 1000 - 24 * 3600), transcribe: false }).catch(() => null);
      const last = page?.messages.filter((m) => !m.from_me).at(-1);
      if (last) items.push({ chat: c, last });
    }));
    items.sort((x, y) => y.last.ts - x.last.ts);
    return { message: F.inboxMessage(items.slice(0, 4), now, this.opts.tz, a.language), ok: true };
  }

  // ------------------------------------------------------------------ writing
  private async draft(a: FlowArgs, i: Extract<Intent, { kind: "send" }>): Promise<FlowResult> {
    const old = this.pending.get(a.sessionId);
    let contact = i.contact;
    if (!contact && old) contact = old.chatName; // "change it to ...": same person
    if (!contact) return { message: F.askWhoMessage(), ok: false, reason: "no_contact" };
    const r = await this.resolve(a.userId, contact);
    if ("error" in r) return r.error;
    if (old) { await this.gw.cancel(a.userId, old.draftId).catch(() => {}); this.pending.delete(a.sessionId); }
    const d = await this.gw.draft(a.userId, r.chat.ref, i.text);
    this.pending.set(a.sessionId, { draftId: d.draft_id, chatName: d.chat_name, text: d.text, atUserTurn: a.userTurns ?? 0, at: Date.now() });
    return { message: F.draftMessage(d), ok: true };
  }

  private async confirm(a: FlowArgs): Promise<FlowResult> {
    const p = this.pending.get(a.sessionId);
    if (!p) return { message: F.nothingWaiting(), ok: false, reason: "nothing_waiting" };
    // the yes must come in a user turn AFTER the one that produced the draft
    if ((a.userTurns ?? 0) <= p.atUserTurn) return { message: F.awaitingAnswer(), ok: false, reason: "same_turn" };
    try {
      const sent = await this.gw.confirm(a.userId, p.draftId);
      this.pending.delete(a.sessionId);
      return { message: F.sentMessage(sent.chat_name), ok: true };
    } catch (e) {
      if (e instanceof GatewayError && (e.status === 404 || e.status === 410)) { this.pending.delete(a.sessionId); return { message: F.expiredMessage(), ok: false, reason: "expired" }; }
      throw e; // a rate limit leaves the draft in place: they can say yes again a moment later
    }
  }

  private async cancel(a: FlowArgs): Promise<FlowResult> {
    const p = this.pending.get(a.sessionId);
    if (p) { this.pending.delete(a.sessionId); await this.gw.cancel(a.userId, p.draftId).catch(() => {}); }
    return { message: F.cancelledMessage(), ok: true };
  }
}
