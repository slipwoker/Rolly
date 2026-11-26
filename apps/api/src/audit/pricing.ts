/**
 * Prices used by the audit (USD). Defaults come from docs/research/05-llm-and-frameworks.md (gpt-6-luna list price,
 * VERIFIED-official there) and COSTS.md (L40S on RunPod, measured; Render plans). Override any part without a deploy of
 * the code with ROLLY_PRICING (JSON, merged over the defaults), e.g.
 *   ROLLY_PRICING='{"models":{"gpt-6-luna":{"input":0.1,"cached":0.01,"output":0.5}},"gpu_usd_per_hour":1.09}'
 *
 * Every stored cost keeps the prices it was computed with, so a later price change does not rewrite history.
 */

export interface ModelPrice { input: number; cached: number; output: number } // per 1M tokens

export interface Pricing {
  models: Record<string, ModelPrice>;
  /** the conversation model on the GPU pod has no per-token price; its cost is GPU time */
  gpu_usd_per_hour: number;
  /** conversations one GPU serves at once, used to share the hour between them (1 = this session had the pod to itself) */
  gpu_sessions_share: number;
  /** fixed monthly infrastructure, shown next to the variable cost */
  fixed_monthly: Record<string, number>;
  /** price per 1M characters / per audio minute if speech moves to an API (0 = self-hosted on the pod) */
  tts_usd_per_m_chars: number;
  stt_usd_per_audio_min: number;
}

export const DEFAULT_PRICING: Pricing = {
  models: {
    "gpt-6-luna": { input: 0.10, cached: 0.01, output: 0.50 },
    "gpt-5.6-luna": { input: 0.20, cached: 0.02, output: 1.20 },
    "claude-haiku-5-5": { input: 0.10, cached: 0.01, output: 0.50 },
  },
  gpu_usd_per_hour: 1.09,
  gpu_sessions_share: 1,
  fixed_monthly: { "Render rolly-api (Starter)": 7, "Render PostgreSQL (Basic-256MB)": 6 },
  tts_usd_per_m_chars: 0,
  stt_usd_per_audio_min: 0,
};

export function loadPricing(raw = process.env.ROLLY_PRICING): Pricing {
  if (!raw) return structuredClone(DEFAULT_PRICING);
  try {
    const o = JSON.parse(raw) as Partial<Pricing>;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      models: { ...DEFAULT_PRICING.models, ...(o.models ?? {}) },
      gpu_usd_per_hour: num(o.gpu_usd_per_hour, DEFAULT_PRICING.gpu_usd_per_hour),
      gpu_sessions_share: Math.max(1, num(o.gpu_sessions_share, DEFAULT_PRICING.gpu_sessions_share)),
      fixed_monthly: o.fixed_monthly ?? { ...DEFAULT_PRICING.fixed_monthly },
      tts_usd_per_m_chars: num(o.tts_usd_per_m_chars, 0),
      stt_usd_per_audio_min: num(o.stt_usd_per_audio_min, 0),
    };
  } catch { return structuredClone(DEFAULT_PRICING); }
}

/** the price of a model by exact name, else by the longest known prefix ("gpt-6-luna-2026-10" -> "gpt-6-luna") */
export function priceOf(p: Pricing, model: string): ModelPrice | null {
  if (p.models[model]) return p.models[model]!;
  const k = Object.keys(p.models).filter((m) => model.startsWith(m)).sort((a, b) => b.length - a.length)[0];
  return k ? p.models[k]! : null;
}

export interface TokenUsage { prompt_tokens?: number | null; cached_tokens?: number | null; completion_tokens?: number | null }

/** null when the model has no known price (shown as "unpriced", never as zero) */
export function tokenCost(p: Pricing, model: string, u: TokenUsage): number | null {
  const price = priceOf(p, model);
  if (!price) return null;
  const prompt = u.prompt_tokens ?? 0, cached = Math.min(u.cached_tokens ?? 0, prompt), out = u.completion_tokens ?? 0;
  return ((prompt - cached) * price.input + cached * price.cached + out * price.output) / 1e6;
}

/** GPU time a conversation occupied, shared among the conversations a GPU serves at once */
export function gpuCost(p: Pricing, durationS: number): number {
  return (Math.max(0, durationS) / 3600) * p.gpu_usd_per_hour / p.gpu_sessions_share;
}

/** Normalises an OpenAI-compatible `usage` object (chat completions). */
export function parseUsage(u: unknown): TokenUsage & { reasoning_tokens?: number | null } {
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pd = (o.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cd = (o.completion_tokens_details ?? {}) as Record<string, unknown>;
  return { prompt_tokens: n(o.prompt_tokens), cached_tokens: n(pd.cached_tokens), completion_tokens: n(o.completion_tokens), reasoning_tokens: n(cd.reasoning_tokens) };
}

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
