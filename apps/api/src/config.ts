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
  /** gate for silent device enrollment (the same value is built into the app); null = enrollment closed */
  enrollmentKey: string | null;
  /** at most this many (non-deleted) users can exist; enrollment stops there */
  maxUsers: number;
  /** sampling for the conversation model, sent to the pod per session (`ctx.options.llm`); chosen with scripts/style-eval.ts */
  llmSampling: Record<string, number>;
  /** development only: accept `?dev_user=<id>` on the voice socket without a ticket. Refused when NODE_ENV=production. */
  devAuth: boolean;
  timezone: string;
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
    enrollmentKey: env.ROLLY_ENROLLMENT_KEY || null,
    maxUsers: Number(env.ROLLY_MAX_USERS ?? 5),
    llmSampling: parseSampling(env.ROLLY_LLM_SAMPLING),
    transcriptRetentionDays: Number(env.ROLLY_TRANSCRIPT_RETENTION_DAYS ?? 30),
    candidateTtlDays: Number(env.ROLLY_CANDIDATE_TTL_DAYS ?? 14),
    maxSessionMinutes: Number(env.ROLLY_MAX_SESSION_MINUTES ?? 90),
    devAuth,
    timezone: env.ROLLY_TIMEZONE ?? "Asia/Jerusalem",
  };
}
