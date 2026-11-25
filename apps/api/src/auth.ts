/**
 * Accounts for a handful of testers (decision P1-D3 in docs/PHASE1_DECISIONS.md):
 *  - the owner creates a user and a one-time PAIRING CODE with the admin token (10 minutes, single use, stored hashed);
 *  - the app exchanges the code for a long-lived, revocable DEVICE REFRESH TOKEN (stored hashed, kept in the iOS Keychain);
 *  - the refresh token buys short ACCESS TOKENS (HMAC-signed, 15 minutes) for the HTTP API;
 *  - an access token buys a single-use VOICE TICKET (60 s) to open the voice WebSocket.
 * No third-party identity service, no Apple capability, no email delivery. Pipeline and OpenAI keys never leave the server.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db/index.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export const ACCESS_TTL_S = 15 * 60;
export const TICKET_TTL_S = 60;
export const PAIRING_TTL_S = 10 * 60;

/** human-friendly code: 10 characters from an unambiguous alphabet (~50 bits), shown as XXXXX-XXXXX */
export function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export class Auth {
  constructor(private readonly db: Db, private readonly secret: string) {}

  static async loadSecret(db: Db, fromEnv: string | null): Promise<string> {
    if (fromEnv && fromEnv !== "dev-only-secret-not-for-production") return fromEnv;
    const r = await db.query<{ value: string }>("SELECT value FROM app_secrets WHERE name='auth_hmac'");
    if (r.rows[0]) return r.rows[0].value;
    const v = randomBytes(32).toString("base64url");
    await db.query("INSERT INTO app_secrets(name, value) VALUES ('auth_hmac', $1) ON CONFLICT (name) DO NOTHING", [v]);
    return (await db.query<{ value: string }>("SELECT value FROM app_secrets WHERE name='auth_hmac'")).rows[0]!.value;
  }

  /** ttlS: default 10 minutes, at most 24 hours (the owner may hand a code over before the app is installed) */
  async createPairingCode(userId: string, ttlS = PAIRING_TTL_S): Promise<{ code: string; expires_at: string }> {
    const code = newPairingCode();
    const exp = new Date(Date.now() + Math.min(Math.max(60, ttlS), 86_400) * 1000);
    await this.db.query("INSERT INTO pairing_codes(code_hash, user_id, expires_at) VALUES ($1,$2,$3)", [sha256(normCode(code)), userId, exp]);
    return { code, expires_at: exp.toISOString() };
  }

  async pair(code: string, deviceName: string | null): Promise<{ user_id: string; refresh_token: string } | null> {
    const r = await this.db.query<{ user_id: string }>(
      `UPDATE pairing_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(normCode(code))]);
    if (!r.rows[0]) return null;
    const refresh = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO devices(user_id, name, refresh_hash) VALUES ($1,$2,$3)", [r.rows[0].user_id, deviceName?.slice(0, 80) ?? null, sha256(refresh)]);
    return { user_id: r.rows[0].user_id, refresh_token: refresh };
  }

  /** Rotates the refresh token on every use. */
  async refresh(refreshToken: string): Promise<{ user_id: string; refresh_token: string; access_token: string; expires_in: number } | null> {
    const next = randomBytes(32).toString("base64url");
    const r = await this.db.query<{ user_id: string }>(
      `UPDATE devices d SET refresh_hash=$2, last_seen_at=now() FROM users u
       WHERE d.refresh_hash=$1 AND d.revoked_at IS NULL AND u.id=d.user_id AND u.deleted_at IS NULL RETURNING d.user_id`,
      [sha256(refreshToken), sha256(next)]);
    if (!r.rows[0]) return null;
    return { user_id: r.rows[0].user_id, refresh_token: next, access_token: this.accessToken(r.rows[0].user_id), expires_in: ACCESS_TTL_S };
  }

  accessToken(userId: string, now = Date.now()): string {
    const payload = b64u(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + ACCESS_TTL_S }));
    const sig = b64u(createHmac("sha256", this.secret).update("access." + payload).digest());
    return `${payload}.${sig}`;
  }

  verifyAccess(token: string | undefined, now = Date.now()): string | null {
    if (!token) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const want = createHmac("sha256", this.secret).update("access." + payload).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; exp: number };
      return p.exp * 1000 > now ? p.sub : null;
    } catch { return null; }
  }

  async createTicket(userId: string): Promise<{ ticket: string; expires_in: number }> {
    const t = randomBytes(24).toString("base64url");
    await this.db.query("INSERT INTO voice_tickets(ticket_hash, user_id, expires_at) VALUES ($1,$2,$3)", [sha256(t), userId, new Date(Date.now() + TICKET_TTL_S * 1000)]);
    await this.db.query("DELETE FROM voice_tickets WHERE expires_at < now() - interval '1 hour'");
    return { ticket: t, expires_in: TICKET_TTL_S };
  }

  async consumeTicket(ticket: string): Promise<string | null> {
    const r = await this.db.query<{ user_id: string }>(
      "UPDATE voice_tickets SET used_at=now() WHERE ticket_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id", [sha256(ticket)]);
    return r.rows[0]?.user_id ?? null;
  }

  async revokeDevices(userId: string): Promise<void> {
    await this.db.query("UPDATE devices SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  }
}

export function adminOk(header: string | undefined, adminToken: string | null): boolean {
  if (!adminToken || !header) return false;
  const a = Buffer.from(header), b = Buffer.from(`Bearer ${adminToken}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
