/** Configuration from environment variables. Secrets are only ever read from the environment, never logged. */
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
  /** admin token for creating pairing codes (owner only) */
  adminToken: string | null;
  transcriptRetentionDays: number;
  candidateTtlDays: number;
  maxSessionMinutes: number;
  /** development only: accept `?dev_user=<id>` on the voice socket without a ticket. Refused when NODE_ENV=production. */
  devAuth: boolean;
  timezone: string;
}

function req(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name}`);
  return v;
}

/** names of required settings that are missing (the service starts anyway and reports them on /healthz) */
export function missingSettings(c: Config): string[] {
  const m: string[] = [];
  if (!c.gpuApiKey) m.push("ROLLY_GPU_API_KEY");
  if (!c.databaseUrl && process.env.NODE_ENV === "production") m.push("DATABASE_URL");
  if (!c.openaiApiKey) m.push("OPENAI_API_KEY");
  if (!c.adminToken) m.push("ROLLY_ADMIN_TOKEN");
  return m;
}

export function loadConfig(env = process.env): Config {
  const production = env.NODE_ENV === "production";
  const devAuth = env.ROLLY_DEV_AUTH === "1";
  if (production && devAuth) throw new Error("ROLLY_DEV_AUTH must not be enabled in production");
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL || null,
    gpuWorkerUrl: req(env, "ROLLY_GPU_WORKER_URL", "https://gn48mxl9lsf1nv-8000.proxy.runpod.net/v1"),
    gpuApiKey: env.ROLLY_GPU_API_KEY ?? "",
    openaiApiKey: env.OPENAI_API_KEY || null,
    utilityModel: env.ROLLY_UTILITY_LLM_MODEL ?? "gpt-6-luna",
    utilityBaseUrl: env.ROLLY_UTILITY_LLM_BASE_URL ?? "https://api.openai.com/v1",
    utilityReasoning: env.ROLLY_UTILITY_LLM_REASONING ?? "none",
    authSecret: env.ROLLY_AUTH_SECRET ?? "", // empty: generated once and kept in the database (app_secrets)
    adminToken: env.ROLLY_ADMIN_TOKEN || null,
    transcriptRetentionDays: Number(env.ROLLY_TRANSCRIPT_RETENTION_DAYS ?? 30),
    candidateTtlDays: Number(env.ROLLY_CANDIDATE_TTL_DAYS ?? 14),
    maxSessionMinutes: Number(env.ROLLY_MAX_SESSION_MINUTES ?? 90),
    devAuth,
    timezone: env.ROLLY_TIMEZONE ?? "Asia/Jerusalem",
  };
}
