/**
 * The latest messages of the user's most recent one-to-one WhatsApp chats, read in the background before a ride (P1-D42),
 * only with the standing consent for WhatsApp and only while the account is linked. Limits, all deliberate:
 * groups are never read (many people's words, none of whom agreed); at most five chats active in the last three days and
 * six text messages from each; no voice transcription; no chat name or number leaves this function ("chat 1"); every
 * message goes through `sanitize` (tags, links, control characters) and is cut to 200 characters. Nothing is stored.
 */
import type { Gateway } from "../whatsapp/gateway.ts";
import { sanitize } from "../whatsapp/format.ts";

export interface WhatsAppSignalDeps { consent: (userId: string, source: "whatsapp") => Promise<boolean>; gateway: Gateway | null }
export interface MessageRead { lines: string[]; read: number }

const DAYS = 3, CHATS = 5, PER_CHAT = 6;

export async function readWhatsApp(d: WhatsAppSignalDeps, userId: string, now: Date): Promise<MessageRead | null> {
  if (!d.gateway || !(await d.consent(userId, "whatsapp").catch(() => false))) return null;
  try {
    if ((await d.gateway.status(userId)).state !== "connected") return null;
    const since = Math.floor(now.getTime() / 1000 - DAYS * 86_400);
    const chats = (await d.gateway.chats(userId, "", 12)).filter((c) => !c.is_group && c.last_ts >= since).slice(0, CHATS);
    const lines: string[] = [];
    let read = 0;
    await Promise.all(chats.map(async (c, i) => {
      const page = await d.gateway!.messages(userId, c.ref, { since, limit: PER_CHAT, transcribe: false }).catch(() => null);
      const msgs = (page?.messages ?? []).filter((m) => m.kind === "text" && m.text).slice(-PER_CHAT);
      if (!msgs.length) return;
      read++;
      lines[i] = `chat ${i + 1}: ` + msgs.map((m) => `${m.from_me ? "me" : "them"}: ${sanitize(m.text!, 200)}`).join(" | ");
    }));
    return { lines: lines.filter(Boolean), read };
  } catch {
    return null;
  }
}
