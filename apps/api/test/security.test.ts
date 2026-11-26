/**
 * Security fixes of P1-D40: tokens sealed under a key that only the environment holds (and old rows re-sealed), the
 * production refusal without that key, URLs without query values in the request log, `store: false` on OpenAI calls,
 * and the rate limit on failed admin attempts. The re-sealing test uses its own database
 * (TEST_SECURITY_DATABASE_URL, default postgres://rolly:rolly@127.0.0.1/rolly_security_test), created if missing.
 */
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import pg from "pg";
import { TokenVault, legacySeal, legacyUnseal, readSealedToken, resealLegacyTokens } from "../src/integrations/crypto.ts";
import { loadConfig } from "../src/config.ts";
import { loggerOptions, quietNotFound, redactUrl } from "../src/server.ts";
import { openAiLlm } from "../src/memory/llm.ts";
import { AdminGate } from "../src/auth.ts";

const KEY = "an-integrations-key-of-32+-characters";
const AUTH = "the-auth-hmac-secret-kept-in-the-database";

describe("sealed tokens", () => {
  it("are sealed under the integrations key, never the auth secret", () => {
    const v = new TokenVault(KEY, AUTH);
    const s = v.seal("1//refresh");
    expect(s.startsWith("v2.")).toBe(true);
    expect(TokenVault.isCurrent(s)).toBe(true);
    expect(v.unseal(s)).toBe("1//refresh");
    // what a copy of the database (auth secret included) can open: nothing sealed now
    expect(legacyUnseal(s.slice(3), AUTH)).toBeNull();
    expect(new TokenVault("x".repeat(32), AUTH).unseal(s)).toBeNull();
  });
  it("still open rows written before P1-D40, with the old key", () => {
    const old = legacySeal("1//old", AUTH);
    expect(TokenVault.isCurrent(old)).toBe(false);
    expect(new TokenVault(KEY, AUTH).unseal(old)).toBe("1//old");
    expect(new TokenVault(KEY, null).unseal(old)).toBeNull();
  });
  it("refuse a short key", () => {
    expect(() => new TokenVault("short", null)).toThrow(/at least 32/);
  });
});

describe("configuration", () => {
  const base = { NODE_ENV: "production", ROLLY_GPU_API_KEY: "k" } as NodeJS.ProcessEnv;
  it("refuses to start in production without ROLLY_INTEGRATIONS_KEY", () => {
    expect(() => loadConfig(base)).toThrow(/ROLLY_INTEGRATIONS_KEY must be set in production/);
    expect(() => loadConfig({ ...base, ROLLY_INTEGRATIONS_KEY: "too-short" })).toThrow(/at least 32/);
    expect(loadConfig({ ...base, ROLLY_INTEGRATIONS_KEY: KEY }).integrationsKey).toBe(KEY);
  });
  it("does not need it in development", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).integrationsKey).toBeNull();
  });
});

// ------------------------------------------------------------------ re-sealing on a real database
const URL = process.env.TEST_SECURITY_DATABASE_URL ?? "postgres://rolly:rolly@127.0.0.1/rolly_security_test";
let available = true, db: pg.Pool;
async function ensureDb(url: string) {
  try { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await c.end(); return true; }
  catch (e) {
    if (!/does not exist/.test(String(e))) return false;
    const u = new globalThis.URL(url), name = u.pathname.slice(1);
    u.pathname = "/postgres";
    try { const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); await c.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`); await c.end(); return true; }
    catch { return false; }
  }
}
beforeAll(async () => {
  if (!(await ensureDb(URL))) { available = false; return; }
  db = new pg.Pool({ connectionString: URL });
}, 30_000);
afterAll(async () => { await db?.end(); });

describe("re-sealing stored tokens", () => {
  const cfg = (key?: string) => ({ ...loadConfig({ DATABASE_URL: URL, ROLLY_GPU_API_KEY: "pod-key", ROLLY_AUTH_SECRET: AUTH,
    ...(key ? { ROLLY_INTEGRATIONS_KEY: key } : {}) } as NodeJS.ProcessEnv), port: 0 });
  const stored = async (uid: string) => (await db.query<{ refresh_enc: string }>("SELECT refresh_enc FROM integrations WHERE user_id=$1", [uid])).rows[0]!.refresh_enc;

  it("at start-up, old rows are re-sealed under the integrations key; one written later is re-sealed when read", async () => {
    if (!available) return; // like the other database tests: skipped without PostgreSQL
    const { createApp } = await import("../src/app.ts");
    await createApp(cfg(), { llm: null }); // creates the schema
    const user = async (label: string) => (await db.query<{ id: string }>("INSERT INTO users(display_label) VALUES ($1) RETURNING id", [label])).rows[0]!.id;
    const uid = await user("sec"), broken = await user("sec-broken");
    // rows from before P1-D40: sealed with the auth secret, which a copy of the database contains
    await db.query("INSERT INTO integrations(user_id, provider, refresh_enc) VALUES ($1,'google',$2), ($3,'google','not.a.token')",
      [uid, legacySeal("1//google-refresh", AUTH), broken]);

    await createApp(cfg(KEY), { llm: null });
    const now = await stored(uid);
    expect(now.startsWith("v2.")).toBe(true);
    expect(new TokenVault(KEY, null).unseal(now)).toBe("1//google-refresh");
    expect(legacyUnseal(now, AUTH)).toBeNull();
    expect(legacyUnseal(now.slice(3), AUTH)).toBeNull();
    expect(await stored(broken)).toBe("not.a.token"); // unreadable: left alone
    expect(await resealLegacyTokens(db, new TokenVault(KEY, AUTH))).toEqual({ resealed: 0, unreadable: 1 });

    // an older instance still running during the deploy writes the old format: the first read re-seals it
    await db.query("UPDATE integrations SET refresh_enc=$1 WHERE user_id=$2", [legacySeal("1//written-late", AUTH), uid]);
    expect(await readSealedToken(db, new TokenVault(KEY, AUTH), uid, "google")).toBe("1//written-late");
    expect(new TokenVault(KEY, null).unseal(await stored(uid))).toBe("1//written-late");
    expect(await readSealedToken(db, new TokenVault(KEY, AUTH), broken, "google")).toBeNull();
  }, 30_000);

  it("refuses an integrations key equal to the auth secret", async () => {
    if (!available) return;
    const { createApp } = await import("../src/app.ts");
    await expect(createApp({ ...cfg(AUTH) }, { llm: null })).rejects.toThrow(/must differ from the auth secret/);
  });
});

describe("request logs", () => {
  it("keep the path and parameter names but no query values", () => {
    expect(redactUrl("/v1/integrations/google/callback?code=4/0Ab-secret&state=eyJ1Ijoi.sig")).toBe("/v1/integrations/google/callback?code=~&state=~");
    expect(redactUrl("/healthz")).toBe("/healthz");
    expect(redactUrl("/x?flag")).toBe("/x?flag=~");
  });
  it("never write the OAuth code or state, on a known route or an unknown one", async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: loggerOptions({ write: (l) => { lines.push(l); } }), trustProxy: true });
    quietNotFound(app);
    app.get("/v1/integrations/google/callback", async () => "ok");
    await app.inject({ url: "/v1/integrations/google/callback?code=SECRET-CODE&state=SECRET-STATE", headers: { "x-forwarded-for": "203.0.113.9" } });
    const nf = await app.inject({ url: "/v1/integrations/google/callbak?code=SECRET-CODE&ticket=SECRET-TICKET" });
    await app.close();
    expect(nf.statusCode).toBe(404);
    const log = lines.join("");
    expect(log).toContain("/v1/integrations/google/callback?code=~&state=~");
    expect(log).not.toMatch(/SECRET-(CODE|STATE|TICKET)/);
    expect(nf.body).not.toMatch(/SECRET/);
    // the client address stays (operation and security), the client port does not
    expect(log).toContain("203.0.113.9");
    expect(log).not.toContain("remotePort");
  });
});

describe("OpenAI calls", () => {
  let server: Server, url = "";
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        bodies.push({ path: req.url ?? "", body: JSON.parse(raw) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url?.endsWith("/responses")
          ? { output: [{ type: "message", content: [{ type: "output_text", text: "found it" }] }] }
          : { choices: [{ message: { content: "{\"ok\":true}" } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("send store: false on chat completions and on the web search (Responses API)", async () => {
    vi.stubEnv("HTTPS_PROXY", ""); vi.stubEnv("https_proxy", "");
    const llm = openAiLlm({ baseUrl: url, apiKey: "test", model: "m", reasoning: null });
    await llm.json("say ok");
    await llm.search!("look it up");
    expect(bodies.map((b) => b.path)).toEqual(["/v1/chat/completions", "/v1/responses"]);
    expect(bodies.every((b) => b.body.store === false)).toBe(true);
  });
});

describe("admin token", () => {
  it("refuses an address after 10 failed attempts, even with the right token, until the window passes", () => {
    const g = new AdminGate("admin-token", { perIp: 10, total: 100, windowMs: 60_000 });
    const t = 1_000_000;
    expect(g.check("Bearer admin-token", "1.1.1.1", t)).toBe("ok");
    for (let i = 0; i < 10; i++) expect(g.check("Bearer wrong", "1.1.1.1", t + i)).toBe("unauthorized");
    expect(g.check("Bearer admin-token", "1.1.1.1", t + 20)).toBe("limited");
    expect(g.check("Bearer admin-token", "2.2.2.2", t + 20)).toBe("ok");
    expect(g.check("Bearer admin-token", "1.1.1.1", t + 61_000)).toBe("ok");
  });
  it("caps failures overall, so changing the forwarded address does not help", () => {
    const g = new AdminGate("admin-token", { perIp: 10, total: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) expect(g.check(undefined, `10.0.0.${i}`, 1000)).toBe("unauthorized");
    expect(g.check("Bearer admin-token", "10.0.0.99", 1001)).toBe("limited");
  });
  it("never accepts anything when no admin token is configured", () => {
    expect(new AdminGate(null).check("Bearer ", "1.1.1.1")).toBe("unauthorized");
  });
});
