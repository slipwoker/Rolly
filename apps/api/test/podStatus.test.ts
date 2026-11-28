import { describe, expect, it, vi } from "vitest";
import { classify, createPodStatus, healthzUrl } from "../src/voice/podStatus.ts";

const res = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

describe("voice pipeline status", () => {
  it("classifies the worker's /healthz", () => {
    expect(classify({ ready: true, active_sessions: 1, max_sessions: 60 }).state).toBe("ready");
    expect(classify({ ready: false }).state).toBe("starting");
    expect(classify({ ready: false, load_error: "CUDA out of memory" }).state).toBe("offline");
    expect(classify({ ready: true, active_sessions: 60, max_sessions: 60 }).state).toBe("busy");
    expect(classify({ ready: true, active_sessions: 3 }).state).toBe("ready"); // an older worker without max_sessions
    expect(classify(null).state).toBe("offline");
    expect(classify({ ready: false }).retry_after_s).toBeLessThan(classify({ ready: true }).retry_after_s);
  });

  it("finds /healthz at the worker's root", () => {
    expect(healthzUrl("https://abc-8000.proxy.runpod.net/v1")).toBe("https://abc-8000.proxy.runpod.net/healthz");
    expect(healthzUrl("https://abc-8000.proxy.runpod.net/v1/")).toBe("https://abc-8000.proxy.runpod.net/healthz");
    expect(healthzUrl("http://localhost:8000")).toBe("http://localhost:8000/healthz");
  });

  it("treats a stopped pod (proxy 404/502) or a timeout as offline", async () => {
    expect((await createPodStatus({ workerUrl: "https://x/v1", fetch: async () => res({}, false) })()).state).toBe("offline");
    expect((await createPodStatus({ workerUrl: "https://x/v1", fetch: async () => { throw new Error("timeout"); } })()).state).toBe("offline");
  });

  it("caches: ready for 10 s, anything else for 3 s, and one request at a time", async () => {
    let t = 0;
    let body: unknown = { ready: false };
    const fetch = vi.fn(async () => res(body));
    const current = createPodStatus({ workerUrl: "https://x/v1", fetch, now: () => t });
    await Promise.all([current(), current(), current()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    t = 2_000; expect((await current()).state).toBe("starting"); expect(fetch).toHaveBeenCalledTimes(1);
    body = { ready: true, active_sessions: 0, max_sessions: 60 };
    t = 3_500; expect((await current()).state).toBe("ready"); expect(fetch).toHaveBeenCalledTimes(2);
    t = 12_000; await current(); expect(fetch).toHaveBeenCalledTimes(2);
    t = 14_000; await current(); expect(fetch).toHaveBeenCalledTimes(3);
  });
});
