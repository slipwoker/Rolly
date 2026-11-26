/**
 * Link WhatsApp from a COMPUTER: the pairing code of the phone-only flow does not always work (docs/WHATSAPP_GATEWAY.md),
 * the QR does, and a QR cannot be scanned from the screen of the same phone. So the app asks for a one-time link (shared or
 * emailed), the user opens it on a computer, the page shows a live QR, and the phone scans it.
 *
 * The token travels in the URL FRAGMENT (#...), which browsers never send to a server: it is not in request logs or in a
 * Referer. The page passes it in a POST body. A token lives 10 minutes, belongs to one user, is replaced by the next one,
 * and is dropped when the link succeeds. Whoever holds the link can show the QR; whoever scans it links THEIR WhatsApp to
 * this Rolly account, which is why the lifetime is short.
 * Creating a link needs `consent: true` (the app showed the terms); the page does not ask again.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { RateLimiter } from "../auth.ts";
import type { Mailer } from "../email/elastic.ts";
import { GatewayError, type Gateway } from "./gateway.ts";

export const TOKEN_TTL_MS = 10 * 60_000;

export class WebLinkTokens {
  private m = new Map<string, { userId: string; exp: number }>();
  /** a new token replaces the user's previous one */
  create(userId: string, now = Date.now()): string {
    for (const [k, v] of this.m) if (v.exp <= now || v.userId === userId) this.m.delete(k);
    const token = randomBytes(24).toString("base64url");
    this.m.set(token, { userId, exp: now + TOKEN_TTL_MS });
    return token;
  }
  userOf(token: unknown, now = Date.now()): string | null {
    if (typeof token !== "string" || token.length < 20 || token.length > 64) return null;
    const v = this.m.get(token);
    if (!v) return null;
    if (v.exp <= now) { this.m.delete(token); return null; }
    return v.userId;
  }
  secondsLeft(token: string, now = Date.now()): number { return Math.max(0, Math.floor(((this.m.get(token)?.exp ?? 0) - now) / 1000)); }
  revoke(token: string) { this.m.delete(token); }
}

// ------------------------------------------------------------------ the email
export function linkEmail(url: string, lang: "he" | "en"): { subject: string; html: string; text: string } {
  const he = lang === "he";
  const subject = he ? "קישור לחיבור WhatsApp ל-ROLLY" : "Your link to connect WhatsApp to ROLLY";
  const lines = he
    ? ["ביקשת לחבר את WhatsApp ל-ROLLY.", "פתח את הקישור הזה במחשב (הוא תקף 10 דקות):", url,
       "הדף מציג קוד QR. בטלפון: WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסרוק את הקוד מהמסך.",
       "לא ביקשת? התעלם מהמייל. אף אחד לא יכול לחבר בלי שיסרוק את הקוד."]
    : ["You asked to connect WhatsApp to ROLLY.", "Open this link on a computer (valid for 10 minutes):", url,
       "The page shows a QR code. On your phone: WhatsApp → Settings → Linked devices → Link a device, and scan the code on the screen.",
       "Did not ask for this? Ignore the email. Nobody can connect without scanning the code."];
  const dir = he ? "rtl" : "ltr";
  const html = `<div dir="${dir}" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111">` +
    `<p>${lines[0]}</p><p>${lines[1]}</p><p><a href="${url}" style="font-weight:bold">${url}</a></p><p>${lines[3]}</p><p style="color:#666">${lines[4]}</p></div>`;
  return { subject, html, text: lines.join("\n\n") };
}

// ------------------------------------------------------------------ the page
const STR = {
  he: { title: "חיבור WhatsApp ל-ROLLY", s1: "פתח את WhatsApp בטלפון", s2: "הגדרות ← מכשירים מקושרים ← קישור מכשיר", s3: "סרוק את הקוד שעל המסך", wait: "מכין קוד…",
        ok: "מחובר! אפשר לסגור את הדף וחזור לאפליקציה.", gone: "הקישור פג. חזור לאפליקציה וקבל קישור חדש.", err: "משהו השתבש. נסה שוב או בקש קישור חדש." },
  en: { title: "Connect WhatsApp to ROLLY", s1: "Open WhatsApp on your phone", s2: "Settings → Linked devices → Link a device", s3: "Scan the code on this screen", wait: "Preparing the code…",
        ok: "Connected! You can close this page and go back to the app.", gone: "This link expired. Go back to the app and get a new one.", err: "Something went wrong. Try again or ask for a new link." },
} as const;

export function renderLinkPage(nonce: string, lang: "he" | "en"): string {
  const t = STR[lang];
  const dir = lang === "he" ? "rtl" : "ltr";
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${t.title}</title>
<style nonce="${nonce}">body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f7f6fa;color:#111;display:flex;justify-content:center}
main{max-width:420px;width:100%;padding:32px 20px;text-align:center}h1{font-size:22px;margin:0 0 20px}
#qr{background:#fff;border-radius:16px;padding:12px;min-height:288px;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(76,29,149,.08)}
#qr svg{width:100%;height:auto}ol{text-align:start;padding-inline-start:22px;line-height:1.7}#msg{margin-top:16px;font-weight:600}.bad{color:#d92d20}.good{color:#12b76a}</style></head>
<body><main><h1>${t.title}</h1><div id="qr">${t.wait}</div>
<ol><li>${t.s1}</li><li>${t.s2}</li><li>${t.s3}</li></ol><div id="msg"></div></main>
<script nonce="${nonce}">
(function(){
  var T = decodeURIComponent((location.hash || '').slice(1));
  var S = ${JSON.stringify(t)};
  var qr = document.getElementById('qr'), msg = document.getElementById('msg'), starting = false, lastStart = 0, done = false;
  function post(path){ return fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token:T}), cache:'no-store'}).then(function(r){ return r.json().then(function(j){ j._status = r.status; return j; }); }); }
  function stop(text, cls){ done = true; msg.textContent = text; msg.className = cls || ''; }
  function start(){ if (starting || done) return; starting = true; lastStart = Date.now(); post('/link/wa/start').then(function(j){ if (j._status === 404) stop(S.gone,'bad'); }).catch(function(){}).then(function(){ starting = false; }); }
  function tick(){
    if (done) return;
    post('/link/wa/state').then(function(s){
      if (s._status === 404) return stop(S.gone,'bad');
      if (s.state === 'connected') { qr.textContent = ''; return stop(S.ok,'good'); }
      if (s.state === 'pairing' && s.qr_svg) { qr.innerHTML = s.qr_svg; msg.textContent = ''; }
      else if (Date.now() - lastStart > 4000) start();
    }).catch(function(){ msg.textContent = S.err; msg.className = 'bad'; });
  }
  if (!T) return stop(S.gone,'bad');
  start(); setInterval(tick, 2000);
})();
</script></body></html>`;
}

// ------------------------------------------------------------------ the routes
export interface WebLinkDeps {
  gateway: Gateway | null;
  /** the user of a request, or null after answering 401 (app.ts `user`) */
  user(req: FastifyRequest, reply: FastifyReply): string | null;
  mailer: Mailer | null;
  publicUrl: string;
  /** the link state changed: forget what was cached about it (WhatsAppFlow.forget) */
  forget?(userId: string): void;
  tokens?: WebLinkTokens;
}

const Body = z.object({
  consent: z.literal(true),
  email: z.string().trim().toLowerCase().max(254).email().optional(),
  lang: z.enum(["he", "en"]).optional(),
});
const TokenBody = z.object({ token: z.string().min(20).max(64) });

const secure = (reply: FastifyReply) => reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff");

export async function whatsappLinkRoutes(app: FastifyInstance, d: WebLinkDeps) {
  const tokens = d.tokens ?? new WebLinkTokens();
  const perUserHour = new RateLimiter(3, 3_600_000), perUserDay = new RateLimiter(8, 86_400_000), perIpHour = new RateLimiter(10, 3_600_000);

  // the app asks for a link: returned (to share) or emailed
  app.post("/v1/whatsapp/web-link", async (req, reply) => {
    const userId = d.user(req, reply); if (!userId) return;
    if (!d.gateway) return reply.code(404).send({ error: "whatsapp is not available" });
    const b = Body.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "consent is required, and the email must be valid" });
    if (b.data.email && !d.mailer) return reply.code(501).send({ error: "email is not configured" });
    if (b.data.email && !(perUserHour.allow(userId) && perUserDay.allow(userId) && perIpHour.allow(req.ip))) return reply.code(429).send({ error: "too many emails, try later" });
    const token = tokens.create(userId);
    const url = `${d.publicUrl}/link/wa#${token}`;
    d.forget?.(userId);
    if (b.data.email) {
      try { await d.mailer!.send({ to: b.data.email, ...linkEmail(url, b.data.lang ?? "he") }); }
      catch { tokens.revoke(token); return reply.code(502).send({ error: "the email could not be sent" }); }
      return reply.code(202).send({ sent: true, expires_in_s: TOKEN_TTL_MS / 1000 });
    }
    return reply.code(201).send({ url, expires_in_s: TOKEN_TTL_MS / 1000 });
  });

  // the page (no token in its address that the server sees)
  app.get("/link/wa", async (req, reply) => {
    const nonce = randomBytes(16).toString("base64");
    const lang = String(req.headers["accept-language"] ?? "").toLowerCase().startsWith("he") ? "he" : "en";
    return secure(reply).header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
      .header("x-frame-options", "DENY").send(renderLinkPage(nonce, lang));
  });

  const userOf = (req: FastifyRequest, reply: FastifyReply): { userId: string; token: string } | null => {
    const b = TokenBody.safeParse(req.body ?? {});
    const userId = b.success ? tokens.userOf(b.data.token) : null;
    if (!b.success || !userId) { void secure(reply).code(404).send({ error: "expired" }); return null; }
    return { userId, token: b.data.token };
  };

  app.post("/link/wa/start", async (req, reply) => {
    const t = userOf(req, reply); if (!t) return;
    if (!d.gateway) return secure(reply).code(404).send({ error: "not available" });
    try { await d.gateway.link(t.userId, "qr", undefined, true); }
    catch (e) {
      if (e instanceof GatewayError && e.status === 409) return secure(reply).send({ state: "connected" }); // already linked
      return secure(reply).code(502).send({ error: "link failed" });
    }
    return secure(reply).code(202).send({ state: "pairing" });
  });

  app.post("/link/wa/state", async (req, reply) => {
    const t = userOf(req, reply); if (!t) return;
    if (!d.gateway) return secure(reply).code(404).send({ error: "not available" });
    const s = await d.gateway.status(t.userId).catch(() => null);
    if (!s) return secure(reply).code(502).send({ error: "unavailable" });
    if (s.state === "connected") { tokens.revoke(t.token); d.forget?.(t.userId); return secure(reply).send({ state: "connected" }); }
    if (s.state === "pairing" && s.link?.qr) {
      const qr_svg = await QRCode.toString(s.link.qr, { type: "svg", margin: 2, errorCorrectionLevel: "L" });
      return secure(reply).send({ state: "pairing", qr_svg });
    }
    return secure(reply).send({ state: s.state });
  });
}
