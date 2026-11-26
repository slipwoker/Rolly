import { describe, expect, it } from "vitest";
import { packClientAudio, type ClientMessage } from "@rolly/contracts";
import { VoiceController, type NativeAudio, type SocketLike } from "../src/voice/controller.ts";

const b64 = {
  encode: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};

function harness() {
  let now = 1_000_000;
  const sent: (ClientMessage | { binary: number })[] = [];
  const enqueued: { seq: number; bytes: number }[] = [];
  const flushed: number[] = [];
  const cbs: Record<string, (e: never) => void> = {};
  const audio: NativeAudio = {
    start: async () => ({ route: "speaker", bluetooth_hfp: false }),
    stop: async () => {},
    enqueue: (seq, data) => enqueued.push({ seq, bytes: b64.decode(data).length }),
    flush: (seq) => { flushed.push(seq); return 1; },
    onMicFrame: (cb) => { cbs.mic = cb as never; return () => {}; },
    onPlayback: (cb) => { cbs.play = cb as never; return () => {}; },
    onAudioSession: (cb) => { cbs.session = cb as never; return () => {}; },
  };
  const sockets: SocketLike[] = [];
  const openSocket = (_url: string): SocketLike => {
    const s: SocketLike = {
      binaryType: "", readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null,
      send: (d) => sent.push(typeof d === "string" ? JSON.parse(d) : { binary: (d as ArrayBuffer).byteLength }),
      close: () => { s.readyState = 3; },
    };
    sockets.push(s);
    queueMicrotask(() => s.onopen?.());
    return s;
  };
  const ctl = new VoiceController({ audio, openSocket, getTicket: async () => "tkt", wsBase: "ws://x", b64, now: () => now, maxReconnects: 1 });
  const server = (m: unknown) => sockets.at(-1)!.onmessage!({ data: JSON.stringify(m) });
  const serverAudio = (seq: number, n: number) => { const f = packClientAudio(seq, new Uint8Array(n)); sockets.at(-1)!.onmessage!({ data: f.buffer as ArrayBuffer }); };
  const mic = (t: number) => (cbs.mic as unknown as (f: { data: string; t: number }) => void)({ data: b64.encode(new Uint8Array(640)), t });
  const play = (e: object) => (cbs.play as unknown as (e: object) => void)(e);
  return { ctl, sent, enqueued, flushed, sockets, server, serverAudio, mic, play, cbs, setNow: (n: number) => { now = n; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("VoiceController", () => {
  it("starts a session, streams the mic only after session.created, plays audio and measures reply time on the phone", async () => {
    const h = harness();
    await h.ctl.start({ language: "he" });
    await tick();
    // a default language is not marked as the user's choice (the server then uses the profile's language)
    expect(h.sent[0]).toMatchObject({ type: "session.start", language: "he", language_explicit: false });
    h.mic(5000); // before session.created: not sent
    expect(h.sent.filter((m) => "binary" in m)).toHaveLength(0);
    h.server({ type: "session.created", session_id: "s1", input_sample_rate: 16000, output_sample_rate: 24000, language: "he", proactive: true, onboarding: true });
    expect(h.ctl.state).toBe("listening");
    // 50 frames = 1 s of microphone audio captured from t=10_000
    for (let i = 0; i < 50; i++) h.mic(10_000 + i * 20);
    expect(h.sent.filter((m) => "binary" in m)).toHaveLength(50);
    // proactive opener: no reply-time measurement
    h.server({ type: "agent.turn_started", seq: 1, proactive: true });
    h.serverAudio(1, 4800);
    expect(h.enqueued).toEqual([{ seq: 1, bytes: 4800 }]);
    h.play({ event: "first_audio", seq: 1, t: 10_500 });
    expect(h.sent.at(-1)).toMatchObject({ type: "client.playback", event: "first_audio", seq: 1 });
    expect(h.sent.at(-1)).not.toHaveProperty("since_speech_stopped_ms");
    // user speech ends at stream time 900 ms -> captured at 10_900; first audible reply at 11_750 -> 850 ms
    h.server({ type: "user.speech_stopped", audio_end_ms: 900 });
    h.server({ type: "agent.turn_started", seq: 2, proactive: false });
    h.serverAudio(2, 4800);
    h.play({ event: "first_audio", seq: 2, t: 11_750 });
    expect(h.ctl.measures.reply_ms).toEqual([850]);
    expect(h.sent.at(-1)).toMatchObject({ event: "first_audio", seq: 2, since_speech_stopped_ms: 850 });
  });

  it("flushes on agent.interrupted and drops late audio of that turn", async () => {
    const h = harness();
    await h.ctl.start({ language: "he" });
    await tick();
    h.server({ type: "session.created", session_id: "s1", input_sample_rate: 16000, output_sample_rate: 24000, language: "he", proactive: true, onboarding: false });
    h.serverAudio(3, 960);
    h.server({ type: "agent.interrupted", seq: 3 });
    expect(h.flushed).toEqual([3]);
    expect(h.sent.at(-1)).toMatchObject({ type: "client.playback", event: "flushed", seq: 3 });
    h.serverAudio(3, 960); // late chunk of the interrupted turn
    expect(h.enqueued.filter((e) => e.seq === 3)).toHaveLength(1);
    h.serverAudio(4, 960); // next turn plays
    expect(h.enqueued.at(-1)).toEqual({ seq: 4, bytes: 960 });
  });

  it("reports audio-session interruptions and route changes, pauses and resumes", async () => {
    const h = harness();
    await h.ctl.start({ language: "he" });
    await tick();
    h.server({ type: "session.created", session_id: "s1", input_sample_rate: 16000, output_sample_rate: 24000, language: "he", proactive: true, onboarding: false });
    const ev = h.cbs.session as unknown as (e: object) => void;
    ev({ event: "interruption_began", t: 1 });
    expect(h.ctl.state).toBe("paused");
    h.mic(1); // no audio while paused
    expect(h.sent.filter((m) => "binary" in m)).toHaveLength(0);
    ev({ event: "interruption_ended", t: 2 });
    expect(h.ctl.state).toBe("listening");
    ev({ event: "route_changed", reason: "old_device_unavailable", route: "in=[MicrophoneBuiltIn] out=[Speaker]", t: 3 });
    expect(h.sent.filter((m) => (m as ClientMessage).type === "client.audio").map((m) => (m as { event: string }).event))
      .toEqual(["interruption_began", "interruption_ended", "route_changed"]);
  });

  it("reconnects after an unexpected drop with resume_of, and gives up after the limit", async () => {
    const h = harness();
    await h.ctl.start({ language: "he" });
    await tick();
    h.server({ type: "session.created", session_id: "s1", input_sample_rate: 16000, output_sample_rate: 24000, language: "he", proactive: true, onboarding: false });
    h.sockets[0]!.onclose!({ code: 1006, reason: "" });
    expect(h.ctl.state).toBe("reconnecting");
    await new Promise((r) => setTimeout(r, 600));
    await tick();
    expect(h.sockets).toHaveLength(2);
    expect(h.sent.filter((m) => (m as ClientMessage).type === "session.start").at(-1)).toMatchObject({ resume_of: "s1" });
    h.sockets[1]!.onclose!({ code: 1006, reason: "" }); // no session.created in between: counts against the limit
    expect(h.ctl.state).toBe("error");
  });

  it("does not reconnect when the server closed the session", async () => {
    const h = harness();
    await h.ctl.start({ language: "he" });
    await tick();
    h.server({ type: "session.created", session_id: "s1", input_sample_rate: 16000, output_sample_rate: 24000, language: "he", proactive: true, onboarding: false });
    h.server({ type: "session.closed", reason: "agent_ended" });
    expect(h.ctl.state).toBe("ended");
  });
});
