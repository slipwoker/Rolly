/** OpenAI-compatible chat client for evaluation runs (target model and judge). Honours HTTPS_PROXY like src/memory/llm.ts. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { Msg } from "./assemble.ts";

let dispatcher: Dispatcher | undefined;
function proxy(): Dispatcher | undefined {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  return p ? (dispatcher ??= new ProxyAgent(p)) : undefined;
}

export interface ChatConfig {
  baseUrl: string;
  model: string;
  /** environment variable holding the key; behind a credential-injecting proxy any placeholder works */
  apiKeyEnv?: string;
  maxTokens: number;
  temperature: number | null; // null = do not send (some hosted reasoning models reject it)
  tokenParam: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string | null;
}

export interface ChatResult { text: string; ms: number; finishReason?: string; usage?: unknown }

export async function chat(cfg: ChatConfig, messages: Msg[], extra: Record<string, unknown> = {}): Promise<ChatResult> {
  const t0 = Date.now();
  const body: Record<string, unknown> = { model: cfg.model, messages, [cfg.tokenParam]: cfg.maxTokens, ...extra };
  if (cfg.temperature !== null) body.temperature = cfg.temperature;
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  const key = (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) || "not-needed";
  const d = proxy();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), ...(d ? { dispatcher: d } : {}), signal: AbortSignal.timeout(120_000),
    });
    if (r.ok) {
      const j = (await r.json()) as { choices: { message: { content: string | null }; finish_reason?: string }[]; usage?: unknown };
      return { text: j.choices?.[0]?.message?.content ?? "", ms: Date.now() - t0, finishReason: j.choices?.[0]?.finish_reason, usage: j.usage };
    }
    const detail = (await r.text()).slice(0, 300);
    if (attempt < 3 && (r.status === 429 || r.status >= 500)) { await new Promise((s) => setTimeout(s, 1500 * 2 ** attempt)); continue; }
    throw new Error(`${cfg.model} HTTP ${r.status}: ${detail}`);
  }
}

/**
 * The conversation model's sampling settings as the pod uses them: the `llm` block of `modular-selfhosted` in
 * config/providers.yaml (max_tokens, temperature). Read at run time so the eval follows config changes.
 */
export function podLlmSettings(root: string): { maxTokens: number; temperature: number; source: string } {
  const fallback = { maxTokens: 120, temperature: 0.6, source: "fallback (config/providers.yaml not parsed)" };
  try {
    const y = readFileSync(resolve(root, "config/providers.yaml"), "utf8");
    const block = y.split(/\n  modular-selfhosted:\n/)[1]?.split(/\n  [a-z][\w-]*:\n/)[0] ?? "";
    const llm = block.split(/\n    llm:\n/)[1]?.split(/\n    [a-z_]+:/)[0] ?? "";
    const mt = llm.match(/max_tokens:\s*(\d+)/)?.[1];
    const tp = llm.match(/temperature:\s*([\d.]+)/)?.[1];
    if (!mt || !tp) return fallback;
    return { maxTokens: Number(mt), temperature: Number(tp), source: "config/providers.yaml modular-selfhosted.llm" };
  } catch {
    return fallback;
  }
}
