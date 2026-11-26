/** React binding of the VoiceController to the native module and the API. */
import { useEffect, useRef, useState } from "react";
import { RollyAudio } from "../../modules/rolly-audio/src";
import { WS_URL, voiceTicket } from "../api";
import { VoiceController, type NativeAudio, type VoiceState } from "./controller";

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const native: NativeAudio = {
  start: () => RollyAudio.start(),
  stop: () => RollyAudio.stop(),
  enqueue: (seq, data) => RollyAudio.enqueue(seq, data),
  flush: (seq) => RollyAudio.flush(seq),
  onMicFrame: (cb) => { const s = RollyAudio.addListener("onMicFrame", cb); return () => s.remove(); },
  onPlayback: (cb) => { const s = RollyAudio.addListener("onPlayback", cb); return () => s.remove(); },
  onAudioSession: (cb) => { const s = RollyAudio.addListener("onAudioSession", cb); return () => s.remove(); },
};

export interface Caption { role: "user" | "agent"; text: string; seq?: number }

export function useVoice() {
  const [state, setState] = useState<VoiceState>("idle");
  const [detail, setDetail] = useState<string | undefined>();
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [lastReplyMs, setLastReplyMs] = useState<number | null>(null);
  const ctl = useRef<VoiceController | null>(null);

  useEffect(() => () => { void ctl.current?.stop(); }, []);

  /** Transcripts always arrive from the server; `withCaptions` only marks the session as a debug-captions session. */
  const start = async (language: "he" | "en" | "auto", withCaptions = false, journey?: { duration_min?: number }, languageExplicit = false) => {
    setCaptions([]);
    setLastReplyMs(null);
    const c = new VoiceController({
      audio: native, openSocket: (url) => new WebSocket(url) as never, getTicket: voiceTicket, wsBase: WS_URL, b64,
      onState: (s, d) => { setState(s); setDetail(d); },
      onMeasure: (m) => { if (m.kind === "reply_ms") setLastReplyMs(m.value); },
      onCaption: (cap) => setCaptions((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (cap.role === "agent" && last?.role === "agent" && last.seq === cap.seq) {
          next[next.length - 1] = { ...last, text: cap.final ? cap.text : last.text + cap.text };
        } else if (cap.role === "user" && !cap.final) {
          return prev;
        } else {
          next.push({ role: cap.role, text: cap.text, seq: cap.seq });
        }
        return next.slice(-60);
      }),
    });
    ctl.current = c;
    await c.start({ language, languageExplicit, captions: withCaptions, journey });
  };

  const stop = async () => { await ctl.current?.stop(); };
  return { state, detail, captions, lastReplyMs, start, stop, active: !["idle", "ended", "error"].includes(state) };
}
