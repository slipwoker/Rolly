/**
 * What did the user ask for? The conversation model only says "on it" and appends the lookup marker (the same marker as
 * web lookups, so the pod needs no change); this step reads the user's last words and decides: read messages, write one,
 * say yes or no to a draft that was read back, or something else (then it is a web lookup).
 * The utility model is told the messages it will never see; it cannot be steered by message content because none is sent.
 */
import type { UtilityLlm } from "../memory/llm.ts";

export type Intent =
  | { kind: "read"; contact: string | null; sinceHours: number | null }
  | { kind: "send"; contact: string | null; text: string }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "disconnect" }
  | { kind: "how" } // "can you send WhatsApp?": a question about the ability itself
  | { kind: "other" };

export interface IntentArgs { question: string; recent: { role: "user" | "agent"; text: string }[]; pending: { chatName: string; text: string } | null; language: string }

export function intentPrompt(a: IntentArgs): string {
  const recent = a.recent.slice(-6).map((t) => `${t.role === "agent" ? "ROLLY" : "USER"}: ${t.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(nothing)";
  return `You route requests for a voice companion used while driving. Decide what the USER's last words ask for, as JSON.

kinds:
- "read": they want to hear their WhatsApp messages (from one person or group, or what came in lately).
- "send": they want a WhatsApp message sent to someone, or they change the wording of the message that is waiting.
- "confirm": ONLY when a message is waiting (see below) and they clearly agree to send it as read back (yes, send it, go ahead).
- "cancel": a message is waiting and they say no, stop, never mind, or change their mind.
- "disconnect": they want to disconnect or unlink WhatsApp from Rolly, or delete what Rolly keeps from WhatsApp.
- "how": they ask WHAT you can do with WhatsApp, or whether you can read or send messages ("can you send WhatsApp?", "do you read my messages?"). Not an actual request.
- "other": anything else (weather, chat, facts, a question about something online).

${a.pending ? `A message is waiting for their yes or no: to "${a.pending.chatName}": "${a.pending.text.slice(0, 300)}".` : "No message is waiting, so \"confirm\" and \"cancel\" are not possible."}

Fields:
- "contact": just the name of the person or group as the user said it (no words like "group", "chat", "the"), or null if they gave none. Never invent a name.
- "text": for "send" only: the message itself, first person, as the user would write it, without "tell him that" wrapping; keep their language. Never add words they did not say. For an edit, the whole new message.
- "since_hours": for "read": how far back they mean (e.g. "today" = 24, "this morning" = 12), or null.

The conversation so far:
${recent}

The user's last words: ${a.question.replace(/\s+/g, " ").slice(0, 400)}

Answer with JSON only: {"kind":"read|send|confirm|cancel|disconnect|how|other","contact":string|null,"text":string|null,"since_hours":number|null}`;
}

const clean = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f‮​]/g, "").trim().slice(0, max) : null);

export function parseIntent(obj: Record<string, unknown>, _pendingExists = false): Intent {
  const contact = clean(obj.contact, 80);
  switch (obj.kind) {
    case "read": {
      const h = typeof obj.since_hours === "number" && obj.since_hours > 0 ? Math.min(obj.since_hours, 24 * 14) : null;
      return { kind: "read", contact, sinceHours: h };
    }
    case "send": {
      const text = clean(obj.text, 1000);
      return text ? { kind: "send", contact, text } : { kind: "other" };
    }
    // with nothing waiting the flow answers "nothing is waiting" (flow.ts); it must not become a web search for "yes"
    case "confirm": return { kind: "confirm" };
    case "cancel": return { kind: "cancel" };
    case "disconnect": return { kind: "disconnect" };
    case "how": return { kind: "how" };
    default: return { kind: "other" };
  }
}

export async function interpret(llm: UtilityLlm, a: IntentArgs): Promise<Intent> {
  try {
    const r = await llm.json(intentPrompt(a), { maxTokens: 300, purpose: "whatsapp" });
    return parseIntent(r.obj, a.pending !== null);
  } catch {
    return { kind: "other" };
  }
}
