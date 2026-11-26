import { fetch as undiciFetch } from "undici";
import { proxyDispatcher } from "../memory/llm.ts";

export interface HttpInit { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }
export interface HttpResult { ok: boolean; status: number; json: unknown }
/** Injectable for tests. */
export type Http = (url: string, init?: HttpInit) => Promise<HttpResult>;

export const realHttp: Http = async (url, init = {}) => {
  const d = proxyDispatcher();
  const r = await undiciFetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, ...(d ? { dispatcher: d } : {}), signal: AbortSignal.timeout(init.timeoutMs ?? 8_000) });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: r.ok, status: r.status, json };
};

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
