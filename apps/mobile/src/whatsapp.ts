/**
 * WhatsApp linking: the parts that are plain logic (phone numbers, the pairing code, what a state means), kept out of the
 * screen so they can be tested. The server side is apps/wa-gateway behind rolly-api (/v1/whatsapp, docs/WHATSAPP_GATEWAY.md).
 */

/**
 * The number WhatsApp needs: digits with the country code, no plus. A leading 0 is an Israeli local number
 * (050-123-4567 -> 972501234567); a leading + or 00 means the country code is already there. null = not a usable number.
 */
export function normalizePhone(input: string, defaultCountryCode = "972"): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let full: string;
  if (trimmed.startsWith("+")) full = digits;
  else if (digits.startsWith("00")) full = digits.slice(2);
  else if (digits.startsWith("0")) full = defaultCountryCode + digits.slice(1);
  else full = digits;
  if (full.length < 8 || full.length > 15) return null;
  if (full.startsWith(defaultCountryCode) && defaultCountryCode === "972" && full.length !== 12) return null; // Israeli mobile: 972 + 9 digits
  return full;
}

/** "CQGYY2FZ" or "cqgy-y2fz" -> "CQGY-Y2FZ", the way WhatsApp shows the code. */
export function formatCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export type LinkState = "unlinked" | "pairing" | "connected" | "reconnecting" | "needs_relink" | "banned" | "conflict" | "client_outdated" | "unavailable";

/** What the screen offers for each state. `text` is a key of the UI strings (i18n.ts). */
export interface StateView { text: "waNotLinked" | "waPairing" | "waConnected" | "waReconnecting" | "waNeedsRelink" | "waBanned" | "waConflict" | "waUnavailable"; canLink: boolean; canUnlink: boolean; warn: boolean }

export function stateView(state: string): StateView {
  switch (state) {
    case "connected": return { text: "waConnected", canLink: false, canUnlink: true, warn: false };
    case "reconnecting": return { text: "waReconnecting", canLink: false, canUnlink: true, warn: false };
    case "pairing": return { text: "waPairing", canLink: true, canUnlink: false, warn: false };
    case "needs_relink": return { text: "waNeedsRelink", canLink: true, canUnlink: true, warn: true };
    case "banned": return { text: "waBanned", canLink: false, canUnlink: true, warn: true };
    case "conflict": return { text: "waConflict", canLink: false, canUnlink: true, warn: true };
    case "unlinked": return { text: "waNotLinked", canLink: true, canUnlink: false, warn: false };
    default: return { text: "waUnavailable", canLink: false, canUnlink: false, warn: false }; // client_outdated, unavailable, anything new
  }
}

/** The HTTP status inside the error `api()` throws ("/path: HTTP 409"), or null. */
export function httpStatus(e: unknown): number | null {
  const m = /HTTP (\d{3})/.exec(e instanceof Error ? e.message : String(e));
  return m ? Number(m[1]) : null;
}

export type LinkError = "waErrBusy" | "waErrPhone" | "waErrLimit" | "waErrGeneric";
export function linkError(e: unknown): LinkError {
  switch (httpStatus(e)) {
    case 409: return "waErrBusy"; // already linked
    case 400: return "waErrPhone";
    case 429: return "waErrLimit";
    default: return "waErrGeneric";
  }
}
