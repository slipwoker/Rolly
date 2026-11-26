/** Minimal OpenAI-compatible chat client for the utility LLM (summaries, memory commands). */
import { fetch, ProxyAgent, type Dispatcher } from "undici";

export type LlmPurpose = "summary" | "live_command" | "capture" | "plan" | "scrub" | "consolidate" | "judge" | "other";

export interface UtilityLlm {
  name: string;
  /** `purpose` labels the call in the audit (src/audit/recorder.ts); it is not sent to the model */
  json(prompt: string, opts?: { maxTokens?: number; purpose?: LlmPurpose }): Promise<{ obj: Record<string, unknown>; ms: number; usage?: unknown }>;
}

let dispatcher: Dispatcher | undefined;
function proxyDispatcher(): Dispatcher | undefined {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) return undefined;
  return (dispatcher ??= new ProxyAgent(p));
}

export function extractJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function openAiLlm(cfg: { baseUrl: string; apiKey: string; model: string; reasoning: string | null }): UtilityLlm {
  return {
    name: cfg.model,
    async json(prompt, opts = {}) {
      const t0 = Date.now();
      const body: Record<string, unknown> = {
        model: cfg.model, messages: [{ role: "user", content: prompt }],
        max_completion_tokens: opts.maxTokens ?? 1500, response_format: { type: "json_object" },
      };
      if (cfg.reasoning) body.reasoning_effort = cfg.reasoning;
      const d = proxyDispatcher();
      const r = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), ...(d ? { dispatcher: d } : {}), signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`utility LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as { choices: { message: { content: string } }[]; usage?: unknown };
      const obj = extractJson(j.choices?.[0]?.message?.content ?? "");
      if (!obj) throw new Error("utility LLM returned no JSON");
      return { obj, ms: Date.now() - t0, usage: j.usage };
    },
  };
}
