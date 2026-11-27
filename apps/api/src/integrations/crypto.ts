/** Sealing of stored third-party tokens, and the signed `state` of the OAuth round trip. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const key = (secret: string) => createHash("sha256").update("integrations.v1." + secret).digest();

export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function unseal(sealed: string, secret: string): string | null {
  try {
    const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key(secret), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
  } catch { return null; }
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
