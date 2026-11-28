/** Configuration from environment variables. Secrets are only ever read from the environment, never logged. */
import { MIN_KEY_CHARS } from "./integrations/crypto.ts";

export interface Config {
  port: number;
  host: string;
  databaseUrl: string | null;
  gpuWorkerUrl: string;
  gpuApiKey: string;
  openaiApiKey: string | null;
  utilityModel: string;
  utilityBaseUrl: string;
  utilityReasoning: string | null;
  /** HMAC key for access tokens; when unset, a random key is generated once and stored in PostgreSQL */
  authSecret: string;
  /**
   * Key that seals stored third-party tokens (ROLLY_INTEGRATIONS_KEY, P1-D40). Only ever in the environment, never in the
   * database. Required in production; null elsewhere = a development key derived from the auth secret (with a warning).
   */
  integrationsKey: string | null;
  /** admin token for creating pairing codes (owner only) */
  adminToken: string | null;
  transcriptRetentionDays: number;
  candidateTtlDays: number;
  maxSessionMinutes: number;
  /**
   * On shutdown, how long running conversations may keep going before the rest are handed over. Must be shorter than the
   * shutdown delay Render allows after SIGTERM: 30 s unless `maxShutdownDelaySeconds` was raised through the API or the
   * blueprint (a dashboard field does not exist), so the default is 20 s. Render also waits 60 s after moving traffic to the
   * new instance before it sends SIGTERM, and that time is on top of this.
   */
  drainMaxS: number;
  /** the model may look things up online during a conversation (needs the utility LLM key); ROLLY_WEB_LOOKUP=0 turns it off */
  webLookup: boolean;
  /** WhatsApp through the private gateway (apps/wa-gateway); null = not connected. Needs the utility LLM key too. */
  whatsapp: { url: string; token: string } | null;
  /** Elastic Email (src/email/elastic.ts): the API key and a sender address verified in the provider; null = no email */
  email: { apiKey: string; from: string } | null;
  /** at most this many lookups per user in 24 hours (each costs a search fee) */
  lookupsPerDay: number;
  /** gate for silent device enrollment (the same value is built into the app); null = enrollment closed */
  enrollmentKey: string | null;
  /** at most this many (non-deleted) users can exist; enrollment stops there */
  maxUsers: number;
  /** sampling for the conversation model, sent to the pod per session (`ctx.options.llm`); chosen with scripts/style-eval.ts */
  llmSampling: Record<string, number>;
  /** development only: accept `?dev_user=<id>` on the voice socket without a ticket. Refused when NODE_ENV=production. */
  devAuth: boolean;
  timezone: string;
  /** deploy commit, recorded with each prompt version in the audit (Render sets RENDER_GIT_COMMIT) */
  build: string | null;
  /** Google sign-in for calendar + mail (read only); all three set = enabled. Redirect URI = `${publicUrl}/v1/integrations/google/callback` */
  google: { clientId: string; clientSecret: string } | null;
  spotify: { clientId: string; clientSecret: string; market: string } | null;
  /** public base URL of this API (OAuth redirects, app return page) */
  publicUrl: string;
  /** run the LLM judge after every conversation with at least two user turns (ROLLY_AUDIT_JUDGE=off disables it) */
  auditJudge: boolean;
}

function req(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name}`);
  return v;
}

/**
   * No override by default: the pod's own settings (temperature 0.6) stay. Measured on 111 replies per setting
   * (benchmarks/results/style_eval_20261126.json): temperature 0.7 with repetition penalty 1.05 was not better than the
   * default within the noise, and a hard word ban produced broken Hebrew words. The channel stays for later tuning
   * (ROLLY_LLM_SAMPLING, a JSON object) without redeploying the pod.
   */
export const DEFAULT_SAMPLING: Record<string, number> = {};

function parseSampling(raw: string | undefined): Record<string, number> {
  if (!raw) return { ...DEFAULT_SAMPLING };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
  } catch { return { ...DEFAULT_SAMPLING }; }
}

/** names of required settings that are missing (the service starts anyway and reports them on /healthz) */
export function missingSettings(c: Config): string[] {
  const m: string[] = [];
  if (!c.gpuApiKey) m.push("ROLLY_GPU_API_KEY");
  if (!c.databaseUrl && process.env.NODE_ENV === "production") m.push("DATABASE_URL");
  if (!c.openaiApiKey) m.push("OPENAI_API_KEY");
  if (!c.adminToken) m.push("ROLLY_ADMIN_TOKEN");
  if (!c.enrollmentKey) m.push("ROLLY_ENROLLMENT_KEY");
  return m;
}

export function loadConfig(env = process.env): Config {
  const production = env.NODE_ENV === "production";
  const devAuth = env.ROLLY_DEV_AUTH === "1";
  if (production && devAuth) throw new Error("ROLLY_DEV_AUTH must not be enabled in production");
  const integrationsKey = env.ROLLY_INTEGRATIONS_KEY || null;
  // fail closed: without its own key, stored tokens would be sealed with a secret kept in the same database (P1-D40)
  if (production && !integrationsKey) throw new Error("ROLLY_INTEGRATIONS_KEY must be set in production (generate one with: openssl rand -base64 32)");
  if (integrationsKey && integrationsKey.length < MIN_KEY_CHARS) throw new Error(`ROLLY_INTEGRATIONS_KEY must be at least ${MIN_KEY_CHARS} characters`);
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL || null,
    gpuWorkerUrl: req(env, "ROLLY_GPU_WORKER_URL", "https://c9yxo4cxgae2u8-8000.proxy.runpod.net/v1"),
    gpuApiKey: env.ROLLY_GPU_API_KEY ?? "",
    openaiApiKey: env.OPENAI_API_KEY || null,
    utilityModel: env.ROLLY_UTILITY_LLM_MODEL ?? "gpt-6-luna",
    utilityBaseUrl: env.ROLLY_UTILITY_LLM_BASE_URL ?? "https://api.openai.com/v1",
    utilityReasoning: env.ROLLY_UTILITY_LLM_REASONING ?? "none",
    authSecret: env.ROLLY_AUTH_SECRET ?? "", // empty: generated once and kept in the database (app_secrets)
    integrationsKey,
    adminToken: env.ROLLY_ADMIN_TOKEN || null,
    enrollmentKey: env.ROLLY_ENROLLMENT_KEY || null,
    maxUsers: Number(env.ROLLY_MAX_USERS ?? 5),
    llmSampling: parseSampling(env.ROLLY_LLM_SAMPLING),
    transcriptRetentionDays: Number(env.ROLLY_TRANSCRIPT_RETENTION_DAYS ?? 30),
    candidateTtlDays: Number(env.ROLLY_CANDIDATE_TTL_DAYS ?? 14),
    maxSessionMinutes: Number(env.ROLLY_MAX_SESSION_MINUTES ?? 90),
    drainMaxS: Number(env.ROLLY_DRAIN_MAX_S ?? 20),
    webLookup: (env.ROLLY_WEB_LOOKUP ?? "1") !== "0" && Boolean(env.OPENAI_API_KEY),
    lookupsPerDay: Number(env.ROLLY_LOOKUPS_PER_DAY ?? 30),
    email: env.ROLLY_EMAIL_API_KEY && env.ROLLY_EMAIL_FROM ? { apiKey: env.ROLLY_EMAIL_API_KEY, from: env.ROLLY_EMAIL_FROM } : null,
    whatsapp: env.ROLLY_WA_GATEWAY_URL && env.ROLLY_WA_GATEWAY_TOKEN && env.OPENAI_API_KEY && (env.ROLLY_WHATSAPP ?? "1") !== "0"
      ? { url: env.ROLLY_WA_GATEWAY_URL.replace(/\/+$/, ""), token: env.ROLLY_WA_GATEWAY_TOKEN } : null,
    devAuth,
    timezone: env.ROLLY_TIMEZONE ?? "Asia/Jerusalem",
    build: (env.RENDER_GIT_COMMIT || env.ROLLY_BUILD || "").slice(0, 12) || null,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,
    spotify: env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET ? { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, market: env.SPOTIFY_MARKET ?? "IL" } : null,
    publicUrl: (env.ROLLY_PUBLIC_URL ?? "https://rolly-api.onrender.com").replace(/\/+$/, ""),
    auditJudge: !/^(off|0|false|no)$/i.test(env.ROLLY_AUDIT_JUDGE ?? "on"),
  };
}
