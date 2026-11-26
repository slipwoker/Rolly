/** Minimal OpenAI-compatible chat client for the utility LLM (summaries, memory commands). */
import { fetch, ProxyAgent, type Dispatcher } from "undici";

export type LlmPurpose = "summary" | "live_command" | "capture" | "plan" | "scrub" | "consolidate" | "judge" | "lookup" | "name_pron" | "other";

export interface UtilityLlm {
  name: string;
  /** `purpose` labels the call in the audit (src/audit/recorder.ts); it is not sent to the model */
  json(prompt: string, opts?: { maxTokens?: number; purpose?: LlmPurpose }): Promise<{ obj: Record<string, unknown>; ms: number; usage?: unknown }>;
  /**
   * An answer written after searching the web (the provider's own search tool). `searches` = search calls made, each
   * billed separately from tokens. Absent when the provider has no such tool.
   */
  search?(prompt: string, opts?: { maxTokens?: number; timeoutMs?: number; country?: string; timezone?: string }): Promise<{ text: string; ms: number; usage?: unknown; searches: number }>;
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
    // OpenAI Responses API with the web search tool. Shape checked against the live API on 2026-11-26 with gpt-6-luna:
    // output = [web_search_call…, reasoning?, message{content:[{type:"output_text", text}]}], usage.input_tokens/output_tokens.
    async search(prompt, opts = {}) {
      const t0 = Date.now();
      const body: Record<string, unknown> = {
        model: cfg.model, input: prompt, max_output_tokens: opts.maxTokens ?? 500,
        tools: [{ type: "web_search", search_context_size: "low",
          user_location: { type: "approximate", country: opts.country ?? "IL", ...(opts.timezone ? { timezone: opts.timezone } : {}) } }],
      };
      const d = proxyDispatcher();
      const r = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/responses", {
        method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), ...(d ? { dispatcher: d } : {}), signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      });
      if (!r.ok) throw new Error(`web search HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as { output?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } };
      const out = j.output ?? [];
      const text = out.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join(" ").replace(/\s+/g, " ").trim();
      if (!text) throw new Error("web search returned no text");
      // the audit reads usage in the chat-completions shape
      const usage = j.usage ? { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens,
        prompt_tokens_details: { cached_tokens: j.usage.input_tokens_details?.cached_tokens }, completion_tokens_details: { reasoning_tokens: j.usage.output_tokens_details?.reasoning_tokens } } : undefined;
      return { text, ms: Date.now() - t0, usage, searches: out.filter((o) => o.type === "web_search_call").length };
    },
  };
}
