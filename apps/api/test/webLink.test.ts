/**
 * Linking WhatsApp from a computer (src/whatsapp/webLink.ts) and the email that carries the link (src/email/elastic.ts).
 * The routes run on their own Fastify instance with a fake gateway and a fake mailer: no database, no network.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ELASTIC_URL, MailError, elasticMailer, type Mail, type Mailer } from "../src/email/elastic.ts";
import type { Http } from "../src/integrations/http.ts";
import { GatewayError, type Gateway } from "../src/whatsapp/gateway.ts";
import { TOKEN_TTL_MS, WebLinkTokens, linkEmail, renderLinkPage, whatsappLinkRoutes } from "../src/whatsapp/webLink.ts";

class FakeGateway implements Gateway {
  calls: string[] = [];
  state: "unlinked" | "pairing" | "connected" = "pairing";
  qr: string | undefined = "2@fakepayload,aaa,bbb,ccc,9";
  linkError: GatewayError | null = null;
  async status() { return { state: this.state, ...(this.qr && this.state === "pairing" ? { link: { qr: this.qr } } : {}) }; }
  async link(userId: string, mode: string, _phone: string | undefined, consent: boolean) { this.calls.push(`link:${userId}:${mode}:${consent}`); if (this.linkError) throw this.linkError; return {}; }
  async chats() { return []; } async messages() { return { chat: { ref: "", name: "" }, messages: [] }; }
  async draft(): Promise<never> { throw new Error("no"); } async confirm(): Promise<never> { throw new Error("no"); }
  async cancel() {} async unlink() {} async stats() { return {}; } async debugLookup() { return {}; }
}
class FakeMailer implements Mailer { sent: Mail[] = []; fail = false; async send(m: Mail) { if (this.fail) throw new MailError(500); this.sent.push(m); } }

async function build(over: { gateway?: Gateway | null; mailer?: Mailer | null } = {}) {
  const app = Fastify();
  const gw = (over.gateway === undefined ? new FakeGateway() : over.gateway);
  const mailer = over.mailer === undefined ? new FakeMailer() : over.mailer;
  const forgotten: string[] = [];
  await whatsappLinkRoutes(app, {
    gateway: gw, mailer, publicUrl: "https://api.example.test", forget: (id) => forgotten.push(id),
    user: (req, reply) => { const u = req.headers["x-user"]; if (typeof u !== "string") { void reply.code(401).send({ error: "unauthorized" }); return null; } return u; },
  });
  return { app, gw: gw as FakeGateway, mailer: mailer as FakeMailer, forgotten };
}
const asUser = (u: string) => ({ "x-user": u, "content-type": "application/json" });
const tokenOf = (url: string) => url.split("#")[1]!;
const post = (app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers });

let app: FastifyInstance;
afterEach(async () => { vi.useRealTimers(); await app?.close(); });

describe("creating the link", () => {
  it("needs the user's sign-in and a yes to the terms", async () => {
    const b = await build(); app = b.app;
    expect((await post(app, "/v1/whatsapp/web-link", { consent: true })).statusCode).toBe(401);
    expect((await post(app, "/v1/whatsapp/web-link", {}, asUser("u1"))).statusCode).toBe(400);
    expect((await post(app, "/v1/whatsapp/web-link", { consent: false }, asUser("u1"))).statusCode).toBe(400);
  });
  it("returns a one-time address whose token is in the fragment, never in the path or query", async () => {
    const b = await build(); app = b.app;
    const r = await post(app, "/v1/whatsapp/web-link", { consent: true }, asUser("u1"));
    expect(r.statusCode).toBe(201);
    const { url } = r.json() as { url: string };
    expect(url).toMatch(/^https:\/\/api\.example\.test\/link\/wa#[A-Za-z0-9_-]{30,}$/);
    expect(url.split("#")[0]).not.toContain("?");
    expect(b.forgotten).toEqual(["u1"]);
  });
  it("is not available without a gateway", async () => {
    const b = await build({ gateway: null }); app = b.app;
    expect((await post(app, "/v1/whatsapp/web-link", { consent: true }, asUser("u1"))).statusCode).toBe(404);
  });
});

describe("the email", () => {
  it("sends the link to the given address and does not return it", async () => {
    const b = await build(); app = b.app;
    const r = await post(app, "/v1/whatsapp/web-link", { consent: true, email: "Me@Example.com", lang: "en" }, asUser("u1"));
    expect(r.statusCode).toBe(202);
    expect(r.body).not.toContain("/link/wa");
    expect(b.mailer.sent).toHaveLength(1);
    const m = b.mailer.sent[0]!;
    expect(m.to).toBe("me@example.com");
    expect(m.subject).toContain("connect WhatsApp");
    expect(m.text).toMatch(/https:\/\/api\.example\.test\/link\/wa#[A-Za-z0-9_-]+/);
    expect(m.html).toContain('dir="ltr"');
  });
  it("is in Hebrew by default", async () => {
    const b = await build(); app = b.app;
    await post(app, "/v1/whatsapp/web-link", { consent: true, email: "me@example.com" }, asUser("u1"));
    expect(b.mailer.sent[0]!.html).toContain('dir="rtl"');
    expect(b.mailer.sent[0]!.text).toContain("מכשירים מקושרים");
  });
  it("refuses a bad address and, when email is not configured, says so", async () => {
    const b = await build(); app = b.app;
    expect((await post(app, "/v1/whatsapp/web-link", { consent: true, email: "not-an-email" }, asUser("u1"))).statusCode).toBe(400);
    const none = await build({ mailer: null });
    expect((await post(none.app, "/v1/whatsapp/web-link", { consent: true, email: "me@example.com" }, asUser("u1"))).statusCode).toBe(501);
    await none.app.close();
  });
  it("limits how many emails one user can ask for", async () => {
    const b = await build(); app = b.app;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(app, "/v1/whatsapp/web-link", { consent: true, email: "me@example.com" }, asUser("u1"))).statusCode);
    expect(codes).toEqual([202, 202, 202, 429, 429]);
    expect(b.mailer.sent).toHaveLength(3);
  });
  it("a provider failure is a 502 and the token it made is dead", async () => {
    const b = await build(); app = b.app;
    b.mailer.fail = true;
    const r = await post(app, "/v1/whatsapp/web-link", { consent: true, email: "me@example.com" }, asUser("u1"));
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain("500");
  });
});

describe("the page", () => {
  it("is self-contained and locked down: nonce scripts only, nothing external, no framing", async () => {
    const b = await build(); app = b.app;
    const r = await app.inject({ method: "GET", url: "/link/wa", headers: { "accept-language": "he-IL,he;q=0.9" } });
    expect(r.statusCode).toBe(200);
    const csp = String(r.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).toContain(`<style nonce="${nonce}">`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.body).not.toMatch(/(src|href)="https?:/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.body).toContain('dir="rtl"');
    expect(r.body).toContain("location.hash");
  });
  it("a new nonce on every load, and English for other browsers", async () => {
    const b = await build(); app = b.app;
    const a = await app.inject({ method: "GET", url: "/link/wa" });
    const c = await app.inject({ method: "GET", url: "/link/wa" });
    expect(/nonce-([^']+)'/.exec(String(a.headers["content-security-policy"]))![1]).not.toBe(/nonce-([^']+)'/.exec(String(c.headers["content-security-policy"]))![1]);
    expect(a.body).toContain('lang="en"');
  });
  it("renders for both languages", () => {
    expect(renderLinkPage("n", "he")).toContain("מכשירים מקושרים");
    expect(renderLinkPage("n", "en")).toContain("Linked devices");
  });
});

describe("the live QR", () => {
  const link = async (b: Awaited<ReturnType<typeof build>>, user = "u1") =>
    tokenOf(((await post(b.app, "/v1/whatsapp/web-link", { consent: true }, asUser(user))).json() as { url: string }).url);

  it("starts a QR link for the token's user, with the consent given when the link was made", async () => {
    const b = await build(); app = b.app;
    const token = await link(b, "user-7");
    const r = await post(app, "/link/wa/start", { token });
    expect(r.statusCode).toBe(202);
    expect(b.gw.calls).toEqual(["link:user-7:qr:true"]);
  });
  it("an unknown, malformed or missing token is a 404 and never reaches the gateway", async () => {
    const b = await build(); app = b.app;
    for (const bad of [{ token: "x".repeat(32) }, { token: "short" }, {}, { token: 5 }]) expect((await post(app, "/link/wa/start", bad)).statusCode).toBe(404);
    expect((await post(app, "/link/wa/state", { token: "y".repeat(32) })).statusCode).toBe(404);
    expect(b.gw.calls).toHaveLength(0);
  });
  it("shows the QR as an SVG while pairing", async () => {
    const b = await build(); app = b.app;
    const token = await link(b);
    const s = (await post(app, "/link/wa/state", { token })).json() as { state: string; qr_svg: string };
    expect(s.state).toBe("pairing");
    expect(s.qr_svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(s.qr_svg).not.toContain("<script");
  });
  it("when connected the page is told so and the token is dead afterwards", async () => {
    const b = await build(); app = b.app;
    const token = await link(b);
    b.gw.state = "connected";
    expect((await post(app, "/link/wa/state", { token })).json()).toEqual({ state: "connected" });
    expect(b.forgotten).toContain("u1");
    expect((await post(app, "/link/wa/state", { token })).statusCode).toBe(404);
    expect((await post(app, "/link/wa/start", { token })).statusCode).toBe(404);
  });
  it("an account that is already linked is reported as connected, not as an error", async () => {
    const b = await build(); app = b.app;
    const token = await link(b);
    b.gw.linkError = new GatewayError(409, "already linked");
    expect((await post(app, "/link/wa/start", { token })).json()).toEqual({ state: "connected" });
  });
  it("a gateway failure is a 502, not a crash", async () => {
    const b = await build(); app = b.app;
    const token = await link(b);
    b.gw.linkError = new GatewayError(0, "down");
    expect((await post(app, "/link/wa/start", { token })).statusCode).toBe(502);
  });
  it("the link dies after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const b = await build(); app = b.app;
    const token = await link(b);
    expect((await post(app, "/link/wa/state", { token })).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + TOKEN_TTL_MS + 1000);
    expect((await post(app, "/link/wa/state", { token })).statusCode).toBe(404);
  });
  it("a newer link replaces the older one of the same user, and tokens do not cross users", async () => {
    const b = await build(); app = b.app;
    const first = await link(b, "u1");
    const second = await link(b, "u1");
    const other = await link(b, "u2");
    expect((await post(app, "/link/wa/state", { token: first })).statusCode).toBe(404);
    expect((await post(app, "/link/wa/state", { token: second })).statusCode).toBe(200);
    await post(app, "/link/wa/start", { token: other });
    expect(b.gw.calls).toEqual(["link:u2:qr:true"]);
  });
});

describe("WebLinkTokens", () => {
  it("expires and revokes", () => {
    const t = new WebLinkTokens();
    const tok = t.create("u", 1000);
    expect(t.userOf(tok, 1000 + TOKEN_TTL_MS - 1)).toBe("u");
    expect(t.userOf(tok, 1000 + TOKEN_TTL_MS)).toBeNull();
    const t2 = t.create("u", 5000); t.revoke(t2);
    expect(t.userOf(t2, 5001)).toBeNull();
  });
});

describe("Elastic Email", () => {
  const mail: Mail = { to: "me@example.com", subject: "Hi", html: "<p>x</p>", text: "x" };
  it("sends one transactional call with the key in a header and both bodies", async () => {
    const seen: { url: string; init: Parameters<Http>[1] }[] = [];
    const http: Http = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: {} }; };
    await elasticMailer({ apiKey: "KEY", from: "ROLLY <no-reply@example.com>", http }).send(mail);
    expect(seen[0]!.url).toBe(ELASTIC_URL);
    expect(seen[0]!.init!.headers).toMatchObject({ "X-ElasticEmail-ApiKey": "KEY" });
    const body = JSON.parse(seen[0]!.init!.body!);
    expect(body.Recipients.To).toEqual(["me@example.com"]);
    expect(body.Content).toMatchObject({ From: "ROLLY <no-reply@example.com>", Subject: "Hi" });
    expect(body.Content.Body.map((b: { ContentType: string }) => b.ContentType)).toEqual(["HTML", "PlainText"]);
    expect(seen[0]!.init!.body).not.toContain("KEY");
  });
  it("a failure carries only the status", async () => {
    const bad: Http = async () => ({ ok: false, status: 401, json: { Error: "secret detail me@example.com" } });
    await expect(elasticMailer({ apiKey: "k", from: "f", http: bad }).send(mail)).rejects.toMatchObject({ status: 401, message: "email provider HTTP 401" });
    const down: Http = async () => { throw new Error("network down"); };
    await expect(elasticMailer({ apiKey: "k", from: "f", http: down }).send(mail)).rejects.toMatchObject({ status: 0 });
  });
});

describe("linkEmail", () => {
  it("carries the address and the instructions in both languages", () => {
    const he = linkEmail("https://x.test/link/wa#abc", "he"), en = linkEmail("https://x.test/link/wa#abc", "en");
    expect(he.html).toContain("https://x.test/link/wa#abc");
    expect(en.text).toContain("Linked devices");
    expect(he.text).toContain("10 דקות");
  });
});
