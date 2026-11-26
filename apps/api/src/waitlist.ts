/**
 * Waiting list for the landing page (apps/site, a separate static site): a public, CORS-open sign-up and an owner-only
 * listing. Signing up twice with the same address is not an error: it returns the original place in line.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db/index.ts";
import { RateLimiter } from "./auth.ts";

export interface WaitlistDeps {
  db: Db;
  isAdmin(req: FastifyRequest): boolean;
}

export const SignUp = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  lang: z.enum(["he", "en"]).optional(),
  source: z.string().trim().max(120).optional(),
  /** honeypot: a hidden field people never fill */
  website: z.string().max(200).optional(),
});

const cors = (reply: FastifyReply) => reply
  .header("access-control-allow-origin", "*")
  .header("access-control-allow-methods", "POST, OPTIONS")
  .header("access-control-allow-headers", "content-type")
  .header("access-control-max-age", "86400");

export async function waitlistRoutes(app: FastifyInstance, d: WaitlistDeps) {
  const limit = new RateLimiter(10, 3600_000);

  app.options("/v1/waitlist", async (_req, reply) => cors(reply).code(204).send());

  app.post("/v1/waitlist", async (req, reply) => {
    cors(reply);
    const r = SignUp.safeParse(req.body ?? {});
    if (!r.success) return reply.code(400).send({ error: "invalid email" });
    if (!limit.allow(req.ip)) return reply.code(429).send({ error: "too many attempts" });
    const b = r.data;
    // bots that fill every field get a polite answer and no row
    if (b.website) return reply.code(201).send({ ok: true, position: null });
    const row = await d.db.query<{ id: string; created: boolean }>(
      `INSERT INTO waitlist (email, lang, source) VALUES ($1, $2, $3)
       ON CONFLICT ((lower(email))) DO UPDATE SET email = waitlist.email
       RETURNING id, (xmax = 0) AS created`,
      [b.email, b.lang ?? null, b.source || null]);
    const { id, created } = row.rows[0]!;
    const pos = await d.db.query<{ n: string }>("SELECT count(*) AS n FROM waitlist WHERE id <= $1", [id]);
    if (created) app.log.info({ waitlist_id: id }, "waitlist sign-up");
    return reply.code(created ? 201 : 200).send({ ok: true, position: Number(pos.rows[0]!.n), already: !created });
  });

  app.get("/v1/admin/waitlist", async (req, reply) => {
    if (!d.isAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    const rows = await d.db.query("SELECT id, email, lang, source, created_at FROM waitlist ORDER BY id");
    if ((req.query as { format?: string }).format === "csv") {
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = ["id,email,lang,source,created_at",
        ...rows.rows.map((r) => [r.id, r.email, r.lang, r.source, new Date(r.created_at).toISOString()].map(esc).join(","))].join("\n");
      return reply.header("content-type", "text/csv; charset=utf-8").header("cache-control", "no-store").send(csv);
    }
    return { count: rows.rowCount, items: rows.rows };
  });
}
