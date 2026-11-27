/**
 * TEMPORARY owner-only diagnostics for WhatsApp (added 2026-11-27): how a contact is actually stored, when a name search finds
 * nothing. The owner's admin token only. The answer has the stored name and its bytes (to spot hidden characters), whether it is a
 * group, the kind of address the chat is keyed by, and the names WhatsApp knows for a number; never message text, never a phone
 * number or a chat address. The number travels in the POST body, so Render's request log of this service (path and query) never has it. REMOVE this file, its registration in app.ts and
 * apps/wa-gateway/debug.go once the question is answered.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Gateway } from "./gateway.ts";

export interface WhatsappAdminDeps {
  gateway: Gateway | null;
  admin(req: FastifyRequest, reply: FastifyReply): boolean;
}

const Query = z.object({
  user_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  q: z.string().trim().max(80).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 \-]{8,20}$/).optional(),
  /** list the newest one-to-one chats that have no name stored (what WhatsApp knows about each, never a number) */
  unnamed: z.boolean().optional(),
}).refine((v) => Boolean(v.q) || Boolean(v.phone) || v.unnamed === true, { message: "q, phone or unnamed is required" });

export async function whatsappAdminRoutes(app: FastifyInstance, d: WhatsappAdminDeps) {
  app.post("/v1/admin/whatsapp/lookup", async (req, reply) => {
    if (!d.admin(req, reply)) return;
    if (!d.gateway) return reply.code(404).send({ error: "whatsapp is not available" });
    const b = Query.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "user_id and (q, phone or unnamed) are required" });
    try {
      return await d.gateway.debugLookup(b.data.user_id, { q: b.data.q, phone: b.data.phone, unnamed: b.data.unnamed });
    } catch {
      return reply.code(502).send({ error: "gateway unreachable" });
    }
  });
}
