/**
 * Landing-page waiting list against a real PostgreSQL (own database, TEST_WAITLIST_DATABASE_URL, default
 * postgres://rolly:rolly@127.0.0.1/rolly_waitlist_test, created and reset here).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { createPool, migrate, type Db } from "../src/db/index.ts";
import { waitlistRoutes } from "../src/waitlist.ts";

const URL = process.env.TEST_WAITLIST_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_waitlist_test";
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  const u = new globalThis.URL(URL);
  const name = u.pathname.slice(1);
  const admin = new pg.Client({ connectionString: URL.replace(`/${name}`, "/postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  db = createPool(URL);
  await migrate(db);
  app = Fastify({ trustProxy: true });
  await waitlistRoutes(app, { db, isAdmin: (req) => req.headers.authorization === "Bearer admin" });
  await app.ready();
});
afterAll(async () => { await app?.close(); await db?.end(); });

const signUp = (body: unknown, ip = "10.0.0.1") =>
  app.inject({ method: "POST", url: "/v1/waitlist", payload: body as object, headers: { "x-forwarded-for": ip } });

describe("waitlist", () => {
  it("answers the CORS preflight", async () => {
    const r = await app.inject({ method: "OPTIONS", url: "/v1/waitlist" });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
  });

  it("signs up, numbers people in order and is idempotent per address (case-insensitive)", async () => {
    const a = await signUp({ email: "Dana@Example.com", lang: "he", source: "utm:instagram" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ ok: true, position: 1, already: false });
    expect(a.headers["access-control-allow-origin"]).toBe("*");
    const b = await signUp({ email: "omer@example.com" });
    expect(b.json()).toMatchObject({ position: 2 });
    const again = await signUp({ email: " dana@example.COM " });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, position: 1, already: true });
  });

  it("rejects bad input and swallows honeypot sign-ups", async () => {
    expect((await signUp({ email: "not-an-email" })).statusCode).toBe(400);
    expect((await signUp({ email: "x@example.com", lang: "fr" })).statusCode).toBe(400);
    const bot = await signUp({ email: "bot@example.com", website: "http://spam" });
    expect(bot.statusCode).toBe(201);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM waitlist WHERE email = 'bot@example.com'");
    expect(rows[0].n).toBe(0);
  });

  it("rate-limits one address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await signUp({ email: `p${i}@example.com` }, "10.9.9.9")).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("lists sign-ups for the owner only, also as CSV", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/admin/waitlist" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/v1/admin/waitlist", headers: { authorization: "Bearer admin" } });
    expect(r.json().items[0]).toMatchObject({ email: "dana@example.com", lang: "he", source: "utm:instagram" });
    const csv = await app.inject({ method: "GET", url: "/v1/admin/waitlist?format=csv", headers: { authorization: "Bearer admin" } });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[1]).toContain('"dana@example.com"');
  });
});
