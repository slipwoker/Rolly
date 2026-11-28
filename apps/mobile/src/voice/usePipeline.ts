/**
 * Can the voice pipeline take a conversation right now? Asked on the home screen before the user may start one, so a
 * cold GPU pod reads "Rolly is waking up" instead of a mic tap that fails a second later (GET /v1/voice/status).
 *
 * Checks when the screen gets focus and when the app comes back to the foreground, then again after the server's
 * `retry_after_s` (seconds while waking up, half a minute once ready). Paused during a conversation. If the status
 * cannot be read (no network, an older server without the endpoint) the state is "unknown" and starting stays allowed:
 * the conversation's own error handling then applies.
 */
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { api } from "../api";

export type PipelineState = "ready" | "starting" | "busy" | "offline" | "unknown";

export function usePipeline(paused: boolean) {
  const [state, setState] = useState<PipelineState>("unknown");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(false);

  const check = useCallback(async () => {
    clearTimeout(timer.current);
    let next: PipelineState = "unknown";
    let retry = 15;
    try {
      const r = await api<{ state: PipelineState; retry_after_s: number }>("/v1/voice/status");
      next = r.state;
      retry = Math.max(3, Math.min(60, r.retry_after_s || 15));
    } catch { /* unknown: let the user try */ }
    if (!alive.current) return;
    setState(next);
    timer.current = setTimeout(() => void check(), retry * 1000);
  }, []);

  useFocusEffect(useCallback(() => {
    if (paused) return;
    alive.current = true;
    void check();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void check(); });
    return () => { alive.current = false; clearTimeout(timer.current); sub.remove(); };
  }, [paused, check]));

  /** starting a conversation now would fail: the pod is loading, full or down */
  const blocked = state === "starting" || state === "busy" || state === "offline";
  return { state, blocked, check };
}
