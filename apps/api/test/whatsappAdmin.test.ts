import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { adminOk } from "../src/auth.ts";
import { GatewayError, type Gateway } from "../src/whatsapp/gateway.ts";
import { whatsappAdminRoutes } from "../src/whatsapp/adminRoutes.ts";

const TOKEN = "admin-test-token";
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

async function build(gw: Partial<Gateway> | null) {
  app = Fastify();
  await whatsappAdminRoutes(app, {
    gateway: gw as Gateway | null,
    admin: (req, reply) => { if (!adminOk(req.headers.authorization, TOKEN)) { void reply.code(401).send({ error: "unauthorized" }); return false; } return true; },
  });
}
const post = (body: unknown, auth = `Bearer ${TOKEN}`) => app.inject({ method: "POST", url: "/v1/admin/whatsapp/lookup", payload: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } });

describe("the temporary owner-only lookup", () => {
  it("needs the admin token", async () => {
    await build({ debugLookup: async () => ({}) });
    expect((await post({ user_id: "u1", q: "alex" }, "")).statusCode).toBe(401);
    expect((await post({ user_id: "u1", q: "alex" }, "Bearer wrong")).statusCode).toBe(401);
  });
  it("passes the name and the number to the gateway, and returns what it says", async () => {
    const seen: unknown[] = [];
    await build({ debugLookup: async (u, o) => { seen.push([u, o]); return { chats: [{ name: "Alex Dumsky", name_hex: "416c6578" }] }; } });
    const r = await post({ user_id: "u1", q: "אלכס", phone: "+972 50-643-0688" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ chats: [{ name: "Alex Dumsky", name_hex: "416c6578" }] });
    expect(seen).toEqual([["u1", { q: "אלכס", phone: "+972 50-643-0688" }]]);
  });
  it("can list the unnamed chats", async () => {
    const seen: unknown[] = [];
    await build({ debugLookup: async (u, o) => { seen.push([u, o]); return { chats: [] }; } });
    expect((await post({ user_id: "u1", unnamed: true })).statusCode).toBe(200);
    expect(seen).toEqual([["u1", { q: undefined, phone: undefined, unnamed: true }]]);
    expect((await post({ user_id: "u1", unnamed: false })).statusCode).toBe(400);
  });
  it("needs a user and a name or a number, and refuses odd input", async () => {
    await build({ debugLookup: async () => ({}) });
    for (const bad of [{}, { user_id: "u1" }, { q: "alex" }, { user_id: "u/../x", q: "a" }, { user_id: "u1", phone: "abc" }, { user_id: "u1", q: "x".repeat(200) }]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
  });
  it("is 404 without a gateway and 502 when it is down", async () => {
    await build(null);
    expect((await post({ user_id: "u1", q: "alex" })).statusCode).toBe(404);
    await app.close();
    await build({ debugLookup: async () => { throw new GatewayError(0, "down"); } });
    expect((await post({ user_id: "u1", q: "alex" })).statusCode).toBe(502);
  });
});
