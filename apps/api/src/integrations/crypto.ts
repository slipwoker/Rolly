/**
 * Sealing of stored third-party tokens, and the signed `state` of the OAuth round trip.
 *
 * Tokens (Google refresh tokens) are sealed with AES-256-GCM under a key that exists only in the environment
 * (ROLLY_INTEGRATIONS_KEY, decision P1-D40). The database never holds it, so a dump or a backup alone cannot open them.
 * Sealed text: `v2.<iv>.<tag>.<ciphertext>` (base64url).
 *
 * Before P1-D40 the key was derived from the auth HMAC secret, which (without ROLLY_AUTH_SECRET) is stored in the same
 * database. Rows in that format (`<iv>.<tag>.<ciphertext>`, no prefix) are still read with the old key and re-sealed
 * under the new one (TokenVault + resealLegacyTokens).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const V2 = "v2.";
/** a key shorter than this is refused (generate one with `openssl rand -base64 32`) */
export const MIN_KEY_CHARS = 32;

const legacyKey = (secret: string) => createHash("sha256").update("integrations.v1." + secret).digest();
const v2Key = (raw: string) => Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), "rolly.integrations.v2", 32));

function gcmSeal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

function gcmUnseal(sealed: string, key: Buffer): string | null {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 3) return null;
    const [iv, tag, enc] = parts.map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
  } catch { return null; }
}

/** The pre-P1-D40 format, keyed by the auth secret. Kept to read (and re-seal) old rows; nothing new is written with it. */
export function legacySeal(plain: string, secret: string): string { return gcmSeal(plain, legacyKey(secret)); }
export function legacyUnseal(sealed: string, secret: string): string | null { return gcmUnseal(sealed, legacyKey(secret)); }

export class TokenVault {
  private readonly key: Buffer;
  private readonly legacy: Buffer | null;
  /**
   * @param key the dedicated sealing key (ROLLY_INTEGRATIONS_KEY), never stored in the database
   * @param legacySecret the auth secret that sealed rows written before P1-D40, or null to read only the new format
   */
  constructor(key: string, legacySecret: string | null) {
    if (key.length < MIN_KEY_CHARS) throw new Error(`the integrations key must be at least ${MIN_KEY_CHARS} characters`);
    this.key = v2Key(key);
    this.legacy = legacySecret ? legacyKey(legacySecret) : null;
  }
  seal(plain: string): string { return V2 + gcmSeal(plain, this.key); }
  unseal(sealed: string): string | null {
    if (sealed.startsWith(V2)) return gcmUnseal(sealed.slice(V2.length), this.key);
    return this.legacy ? gcmUnseal(sealed, this.legacy) : null;
  }
  /** sealed under the current key (no re-sealing needed) */
  static isCurrent(sealed: string): boolean { return sealed.startsWith(V2); }
}

/** what resealLegacyTokens needs from the database (pg.Pool fits) */
export interface SealedRows {
  query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/**
 * Re-seals every stored token still in the old format under the vault's current key. Runs at start-up; reading a token
 * (`googleRefresh`) also re-seals one lazily, in case an older instance wrote one during a deploy. Each row is updated
 * only if it has not changed since it was read. A row that cannot be opened with the old key is left alone and counted.
 */
export async function resealLegacyTokens(db: SealedRows, vault: TokenVault): Promise<{ resealed: number; unreadable: number }> {
  const rows = (await db.query<{ user_id: string; provider: string; refresh_enc: string }>(
    "SELECT user_id, provider, refresh_enc FROM integrations WHERE refresh_enc NOT LIKE 'v2.%'")).rows;
  let resealed = 0, unreadable = 0;
  for (const r of rows) {
    const plain = vault.unseal(r.refresh_enc);
    if (plain === null) { unreadable++; continue; }
    const u = await db.query("UPDATE integrations SET refresh_enc=$1 WHERE user_id=$2 AND provider=$3 AND refresh_enc=$4",
      [vault.seal(plain), r.user_id, r.provider, r.refresh_enc]);
    if (u.rowCount) resealed++;
  }
  return { resealed, unreadable };
}

/**
 * Reads one stored token. A row still in the old format (an older instance wrote it during a deploy) is re-sealed under
 * the current key on the way, if nothing changed it meanwhile.
 */
export async function readSealedToken(db: SealedRows, vault: TokenVault, userId: string, provider: string): Promise<string | null> {
  const sealed = (await db.query<{ refresh_enc: string }>("SELECT refresh_enc FROM integrations WHERE user_id=$1 AND provider=$2", [userId, provider])).rows[0]?.refresh_enc;
  if (!sealed) return null;
  const plain = vault.unseal(sealed);
  if (plain !== null && !TokenVault.isCurrent(sealed)) {
    await db.query("UPDATE integrations SET refresh_enc=$1 WHERE user_id=$2 AND provider=$3 AND refresh_enc=$4", [vault.seal(plain), userId, provider, sealed]).catch(() => {});
  }
  return plain;
}

/** `state` for the OAuth redirect: binds the callback to the user who started it, valid for 10 minutes. */
export function signState(userId: string, secret: string, now = Date.now(), purpose = "google"): string {
  const p = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(now / 1000) + 600, p: purpose })).toString("base64url");
  return `${p}.${createHmac("sha256", secret).update("oauth-state." + p).digest("base64url")}`;
}

export function verifyState(state: string | undefined, secret: string, now = Date.now(), purpose = "google"): string | null {
  const [p, sig] = (state ?? "").split(".");
  if (!p || !sig) return null;
  const want = createHmac("sha256", secret).update("oauth-state." + p).digest(), got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try { const j = JSON.parse(Buffer.from(p, "base64url").toString()) as { u: string; e: number; p?: string }; return j.e * 1000 > now && j.p === purpose ? j.u : null; } catch { return null; }
}
