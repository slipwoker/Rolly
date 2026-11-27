/**
 * Sending an email through Elastic Email (https://elasticemail.com), the owner's provider (2026-11-26).
 * One call, no SDK. The API key and the verified sender address are settings of the service (ROLLY_EMAIL_API_KEY,
 * ROLLY_EMAIL_FROM), never in the repository. UNVERIFIED against the live API from this environment (no key was
 * available here): the request shape follows the v4 "transactional" endpoint of the official SDK; check it with one real
 * send after the key is set. A failure carries only the HTTP status, never the response body.
 */
import type { Http } from "../integrations/http.ts";

export interface Mail { to: string; subject: string; html: string; text: string }
export interface Mailer { send(m: Mail): Promise<void> }

export class MailError extends Error {
  constructor(readonly status: number) { super(`email provider HTTP ${status}`); }
}

export const ELASTIC_URL = "https://api.elasticemail.com/v4/emails/transactional";

export function elasticMailer(cfg: { apiKey: string; from: string; http: Http }): Mailer {
  return {
    async send(m) {
      const r = await cfg.http(ELASTIC_URL, {
        method: "POST", timeoutMs: 10_000,
        headers: { "X-ElasticEmail-ApiKey": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          Recipients: { To: [m.to] },
          Content: {
            From: cfg.from, Subject: m.subject,
            Body: [{ ContentType: "HTML", Charset: "utf-8", Content: m.html }, { ContentType: "PlainText", Charset: "utf-8", Content: m.text }],
          },
        }),
      }).catch(() => ({ ok: false, status: 0, json: null }));
      if (!r.ok) throw new MailError(r.status);
    },
  };
}
