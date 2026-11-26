/**
 * Client for the private WhatsApp gateway (apps/wa-gateway, docs/WHATSAPP_GATEWAY.md). The gateway is never exposed to
 * the app: only rolly-api calls it, with a bearer token. Chats are addressed by an opaque `ref`: phone numbers never
 * reach this service.
 */
import { fetch } from "undici";

export interface GatewayChat { ref: string; name: string; is_group: boolean; last_ts: number; unnamed?: boolean }
export interface GatewayMessage { id: string; ts: number; from_me: boolean; sender?: string; kind: string; text?: string; transcript?: string; can_transcribe?: boolean; transcribe_error?: string }
export interface GatewayDraft { draft_id: string; chat_ref: string; chat_name: string; is_group: boolean; text: string; expires_in_s: number }
export interface GatewaySent { message_id: string; ts: number; chat_name: string }
export type LinkState = "unlinked" | "pairing" | "connected" | "reconnecting" | "needs_relink" | "banned" | "conflict" | "client_outdated";

/** A failed call. `retryAfterS` is set for rate limits, `reason` for "daily_cap" | "too_fast". */
export class GatewayError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string, readonly retryAfterS?: number) { super(message); }
}

export interface Gateway {
  status(userId: string): Promise<{ state: LinkState }>;
  chats(userId: string, q: string, limit?: number): Promise<GatewayChat[]>;
  messages(userId: string, ref: string, o?: { since?: number; limit?: number; transcribe?: boolean }): Promise<{ chat: { ref: string; name: string }; messages: GatewayMessage[] }>;
  draft(userId: string, chatRef: string, text: string): Promise<GatewayDraft>;
  confirm(userId: string, draftId: string): Promise<GatewaySent>;
  cancel(userId: string, draftId: string): Promise<void>;
  link(userId: string, mode: "qr" | "code", phone?: string): Promise<Record<string, unknown>>;
  unlink(userId: string): Promise<void>;
}

export function httpGateway(cfg: { url: string; token: string }): Gateway {
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 8_000): Promise<T> {
    let r;
    try {
      r = await fetch(cfg.url + path, {
        method, headers: { Authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new GatewayError(0, `gateway unreachable: ${(e as Error).name}`); // never include message text
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new GatewayError(r.status, String(j.error ?? `HTTP ${r.status}`), typeof j.reason === "string" ? j.reason : undefined, typeof j.retry_after_s === "number" ? j.retry_after_s : undefined);
    return j as T;
  }
  const u = (userId: string) => `/v1/users/${encodeURIComponent(userId)}`;
  return {
    status: (userId) => call(`GET`, u(userId)),
    chats: async (userId, q, limit = 5) => (await call<{ chats: GatewayChat[] }>("GET", `${u(userId)}/chats?q=${encodeURIComponent(q)}&limit=${limit}`)).chats,
    messages: (userId, ref, o = {}) => call("GET", `${u(userId)}/chats/${ref}/messages?limit=${o.limit ?? 8}${o.since ? `&since=${o.since}` : ""}${o.transcribe ? "&transcribe=1" : ""}`, undefined, o.transcribe ? 12_000 : 8_000),
    draft: (userId, chatRef, text) => call("POST", `${u(userId)}/send/draft`, { chat_ref: chatRef, text }),
    confirm: (userId, draftId) => call("POST", `${u(userId)}/send/confirm`, { draft_id: draftId }, 15_000),
    cancel: async (userId, draftId) => { await call("DELETE", `${u(userId)}/send/drafts/${encodeURIComponent(draftId)}`); },
    link: (userId, mode, phone) => call("POST", `${u(userId)}/link`, { mode, ...(phone ? { phone } : {}) }, 20_000),
    unlink: async (userId) => { await call("DELETE", u(userId)); },
  };
}
