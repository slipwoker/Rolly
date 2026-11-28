/**
 * Is the voice pipeline (the GPU worker) able to take a conversation right now? The app asks before it lets the user
 * start one, so nobody taps the mic and gets "pipeline host is loading or full" a second later.
 *
 * Read from the worker's unauthenticated `GET /healthz` (backend/gpu_worker.py): `ready` turns true when the models are
 * loaded, `load_error` is set when loading failed, `active_sessions` / `max_sessions` say whether there is room. An
 * unreachable worker (stopped pod, RunPod's proxy answering 404/502, a timeout) is "offline". Cached briefly, so many
 * phones polling do not each hit the pod.
 */

export type PipelineState = "ready" | "starting" | "busy" | "offline";
export interface PipelineStatus { state: PipelineState; retry_after_s: number }

interface Healthz { ready?: boolean; load_error?: string | null; active_sessions?: number | null; max_sessions?: number | null }

const RETRY: Record<PipelineState, number> = { ready: 30, starting: 8, busy: 15, offline: 30 };
const status = (state: PipelineState): PipelineStatus => ({ state, retry_after_s: RETRY[state] });

/** What one /healthz answer means for a new conversation. `null` = no usable answer. */
export function classify(h: Healthz | null): PipelineStatus {
  if (!h) return status("offline");
  if (h.load_error) return status("offline");
  if (!h.ready) return status("starting");
  if (typeof h.max_sessions === "number" && typeof h.active_sessions === "number" && h.active_sessions >= h.max_sessions) return status("busy");
  return status("ready");
}

/** `https://…/v1` (the worker's API base) → `https://…/healthz` (served at the root). */
export function healthzUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/healthz";
}

export function createPodStatus(o: { workerUrl: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }) {
  const get = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const url = healthzUrl(o.workerUrl);
  let cached: { at: number; value: PipelineStatus } | null = null;
  let inflight: Promise<PipelineStatus> | null = null;

  const probe = async (): Promise<PipelineStatus> => {
    try {
      const r = await get(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 4_000) });
      if (!r.ok) return classify(null);
      return classify(await r.json() as Healthz);
    } catch {
      return classify(null);
    }
  };

  /** A ready answer is reused for 10 s, anything else for 3 s (so the app sees "ready" soon after the pod is up). */
  return async function current(): Promise<PipelineStatus> {
    if (cached && now() - cached.at < (cached.value.state === "ready" ? 10_000 : 3_000)) return cached.value;
    inflight ??= probe().then((value) => { cached = { at: now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  };
}
