/**
 * The phone side of a ROLLY conversation, independent of React and of the native module (both injected), so it can be
 * tested without a device (test/controller.test.ts).
 *
 *  - opens WS /v1/voice with a single-use ticket, sends session.start, streams the microphone (20 ms PCM16 16 kHz frames)
 *  - plays agent audio by sequence number; on agent.interrupted flushes playback at once and drops late chunks of that turn
 *  - measures, on the phone: end of the user's speech (capture time of audio_end_ms) -> first audible agent audio,
 *    and interrupted -> playback stopped; reports both to the server (client.playback)
 *  - forwards audio-session events (interruptions, Bluetooth route changes) to the server (client.audio)
 *  - if the connection drops unexpectedly, reconnects with a new session that resumes the conversation (resume_of)
 */
import { unpackClientAudio, type ClientMessage, type ServerMessage } from "@rolly/contracts";

export type VoiceState = "idle" | "connecting" | "listening" | "user_speaking" | "agent_speaking" | "reconnecting" | "paused" | "ended" | "error";

export interface NativeAudio {
  start(): Promise<{ route: string; bluetooth_hfp: boolean }>;
  stop(): Promise<void>;
  enqueue(seq: number, base64: string): void;
  flush(seq: number): number;
  onMicFrame(cb: (f: { data: string; t: number }) => void): () => void;
  onPlayback(cb: (e: { event: string; seq: number; t: number; flush_ms?: number }) => void): () => void;
  onAudioSession(cb: (e: { event: string; reason?: string; route?: string; t: number }) => void): () => void;
}

export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface ControllerDeps {
  audio: NativeAudio;
  openSocket(url: string): SocketLike;
  getTicket(): Promise<string>;
  wsBase: string; // wss://rolly-api.onrender.com
  now?: () => number;
  b64: { encode(bytes: Uint8Array): string; decode(s: string): Uint8Array };
  onState?(s: VoiceState, detail?: string): void;
  onCaption?(c: { role: "user" | "agent"; text: string; final: boolean; seq?: number }): void;
  onMeasure?(m: { kind: "reply_ms" | "flush_ms"; value: number }): void;
  maxReconnects?: number;
}

export interface StartOptions { language: "he" | "en" | "auto"; captions?: boolean; journey?: { duration_min?: number } }

const OPEN = 1;

export class VoiceController {
  state: VoiceState = "idle";
  sessionId: string | null = null;
  private ws: SocketLike | null = null;
  private unsub: (() => void)[] = [];
  private flushed = new Set<number>();
  private proactive = new Set<number>();
  private currentSeq = -1;
  private ready = false;
  private ending = false;
  private reconnects = 0;
  private opts: StartOptions = { language: "he" };
  // capture times: wall-clock ms of the first sample of each 20 ms frame sent in this session, by stream position
  private streamFrames = 0;
  private frameTimes: number[] = [];
  private lastSpeechEndWall: number | null = null;
  private interruptedAt = new Map<number, number>();
  readonly measures = { reply_ms: [] as number[], flush_ms: [] as number[] };

  constructor(private readonly d: ControllerDeps) {}

  private now() { return (this.d.now ?? Date.now)(); }
  private set(s: VoiceState, detail?: string) { this.state = s; this.d.onState?.(s, detail); }
  private send(m: ClientMessage) { if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(m)); }

  async start(opts: StartOptions): Promise<void> {
    this.opts = opts;
    this.ending = false;
    this.reconnects = 0;
    this.set("connecting");
    try {
      await this.d.audio.start();
    } catch (e) {
      this.set("error", `microphone: ${String(e)}`);
      return;
    }
    this.unsub.push(this.d.audio.onMicFrame((f) => this.onMic(f)));
    this.unsub.push(this.d.audio.onPlayback((e) => this.onPlayback(e)));
    this.unsub.push(this.d.audio.onAudioSession((e) => this.onAudioSession(e)));
    await this.connect(null);
  }

  private async connect(resumeOf: string | null): Promise<void> {
    let ticket: string;
    try {
      ticket = await this.d.getTicket();
    } catch (e) {
      return this.onDrop(`ticket: ${String(e)}`);
    }
    const ws = this.d.openSocket(`${this.d.wsBase}/v1/voice?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.ready = false;
    this.flushed.clear();
    this.proactive.clear();
    this.streamFrames = 0;
    this.frameTimes = [];
    this.lastSpeechEndWall = null;
    ws.onopen = () => {
      this.send({ type: "session.start", language: this.opts.language, proactive: true, captions: this.opts.captions,
        journey: this.opts.journey, client: { platform: "ios" }, ...(resumeOf ? { resume_of: resumeOf } : {}) });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.onServer(JSON.parse(e.data) as ServerMessage);
      else this.onServerAudio(new Uint8Array(e.data));
    };
    ws.onclose = (e) => { if (this.ws === ws) this.onDrop(`closed ${e.code} ${e.reason}`); };
    ws.onerror = () => { /* followed by onclose */ };
  }

  private onDrop(why: string) {
    this.ws = null;
    this.ready = false;
    if (this.ending || this.state === "ended") return;
    const max = this.d.maxReconnects ?? 3;
    if (this.reconnects >= max) { this.set("error", `connection lost: ${why}`); void this.teardownAudio(); return; }
    this.reconnects++;
    this.set("reconnecting", why);
    const prev = this.sessionId;
    setTimeout(() => { if (!this.ending) void this.connect(prev); }, Math.min(8000, 500 * 2 ** (this.reconnects - 1)));
  }

  // ---------------------------------------------------------------- microphone
  private onMic(f: { data: string; t: number }) {
    if (!this.ready || !this.ws || this.ws.readyState !== OPEN || this.state === "paused") return;
    const bytes = this.d.b64.decode(f.data);
    this.frameTimes.push(f.t);
    if (this.frameTimes.length > 30_000) this.frameTimes.splice(0, 15_000); // bounded memory; captureTimeAt accounts for it
    this.streamFrames++;
    this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  /** wall time at which the sample at `ms` of microphone-stream time was captured */
  captureTimeAt(ms: number): number | null {
    const frame = Math.floor(ms / 20);
    const dropped = this.streamFrames - this.frameTimes.length;
    const t = this.frameTimes[frame - dropped];
    return t === undefined ? null : t + (ms - frame * 20);
  }

  // ---------------------------------------------------------------- server
  private onServer(m: ServerMessage) {
    switch (m.type) {
      case "session.created":
        this.sessionId = m.session_id;
        this.ready = true;
        this.reconnects = 0;
        this.set("listening");
        break;
      case "user.speech_started":
        this.set("user_speaking");
        break;
      case "user.speech_stopped":
        this.lastSpeechEndWall = typeof m.audio_end_ms === "number" ? this.captureTimeAt(m.audio_end_ms) : this.now();
        if (this.state === "user_speaking") this.set("listening");
        break;
      case "user.transcript":
        if (m.text) this.d.onCaption?.({ role: "user", text: m.text, final: m.final });
        break;
      case "agent.turn_started":
        if (m.proactive) this.proactive.add(m.seq);
        break;
      case "agent.text":
        this.d.onCaption?.({ role: "agent", text: m.delta, final: false, seq: m.seq });
        break;
      case "agent.turn_done":
        this.d.onCaption?.({ role: "agent", text: m.text, final: true, seq: m.seq });
        break;
      case "agent.interrupted": {
        const t0 = this.now();
        this.flushed.add(m.seq);
        this.d.audio.flush(m.seq);
        const flushMs = this.now() - t0; // interrupted received -> scheduled playback dropped
        this.measures.flush_ms.push(flushMs);
        this.d.onMeasure?.({ kind: "flush_ms", value: flushMs });
        this.send({ type: "client.playback", event: "flushed", seq: m.seq, t: this.now(), flush_ms: flushMs });
        if (this.state === "agent_speaking") this.set("user_speaking");
        break;
      }
      case "error":
        if (m.fatal) this.set("error", m.message);
        break;
      case "session.closed":
        // the server ended the session (agent said goodbye, max duration, pipeline error): no reconnect
        this.ending = true;
        if (this.state !== "error") this.set("ended", m.reason);
        void this.teardownAudio();
        this.ws?.close();
        this.ws = null;
        break;
      default:
        break;
    }
  }

  private onServerAudio(frame: Uint8Array) {
    const { seq, pcm } = unpackClientAudio(frame);
    if (this.flushed.has(seq)) return; // late audio of an interrupted turn
    this.currentSeq = seq;
    this.d.audio.enqueue(seq, this.d.b64.encode(pcm));
    if (this.state !== "user_speaking") this.set("agent_speaking");
  }

  private onPlayback(e: { event: string; seq: number; t: number }) {
    if (e.event === "first_audio") {
      const proactive = this.proactive.has(e.seq);
      const since = !proactive && this.lastSpeechEndWall !== null ? Math.round(e.t - this.lastSpeechEndWall) : undefined;
      if (since !== undefined) { this.measures.reply_ms.push(since); this.d.onMeasure?.({ kind: "reply_ms", value: since }); }
      this.send({ type: "client.playback", event: "first_audio", seq: e.seq, t: e.t, since_speech_stopped_ms: since });
    } else if (e.event === "idle") {
      this.send({ type: "client.playback", event: "idle", seq: e.seq, t: e.t });
      if (this.state === "agent_speaking" && e.seq === this.currentSeq) this.set("listening");
    }
  }

  private onAudioSession(e: { event: string; reason?: string; route?: string; t: number }) {
    const map: Record<string, string> = { interruption_began: "interruption_began", interruption_ended: "interruption_ended",
      route_changed: "route_changed", media_services_reset: "media_services_reset", restarted: "route_changed" };
    const ev = map[e.event];
    if (ev) this.send({ type: "client.audio", event: ev as never, route: e.route, reason: e.reason ?? e.event, t: e.t });
    if (e.event === "interruption_began") this.set("paused", "audio interrupted (call or another app)");
    if ((e.event === "restarted" || e.event === "interruption_ended") && this.state === "paused") this.set("listening");
  }

  // ---------------------------------------------------------------- stop
  async stop(): Promise<void> {
    this.ending = true;
    this.send({ type: "session.end" });
    // the server answers with session.summary + session.closed; do not wait for it to release the microphone
    await this.teardownAudio();
    this.set("ended", "user");
    setTimeout(() => { try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; }, 15_000);
  }

  private async teardownAudio() {
    for (const u of this.unsub.splice(0)) u();
    try { await this.d.audio.stop(); } catch { /* ignore */ }
  }
}
