/**
 * One live conversation: phone WebSocket <-> GPU worker, with memory hooks and telemetry.
 * TypeScript counterpart of backend/app/session.py (the tester) using the remote pipeline only.
 *
 * Responsibilities here: context in (from the memory layer), audio and events relayed, agent audio resampled to one
 * client rate with a sequence number per agent turn, interruption flush signalled to the phone, turns collected with
 * attribution hints, summary and memory update at the end (through the hooks).
 */
import { randomUUID } from "node:crypto";
import {
  OUTPUT_SAMPLE_RATE, INPUT_SAMPLE_RATE, PodEvent, packClientAudio,
  type ClientMessage, type ClientSessionStart, type PodSessionContext, type ServerMessage,
} from "@rolly/contracts";
import { PodSession, type PodAudio } from "./podClient.ts";
import { StreamResampler } from "./resampler.ts";

export const END_MARKER = "<end_session/>";

/** What the relay needs from the phone connection (a ws.WebSocket satisfies it; tests use a fake). */
export interface ClientSocket {
  sendJson(msg: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface SessionTurn {
  idx: number;
  role: "user" | "agent";
  text: string;
  language?: string | null;
  startedAt: number;
  /** user turns: "uncertain" when weak hints suggest another voice; "primary" means only "nothing suggests otherwise"
   * (this is NOT speaker identification). Agent turns are always "primary". */
  attribution: "primary" | "uncertain";
  meta: Record<string, unknown>;
}

export interface PreparedSession {
  ctx: PodSessionContext;
  onboarding: boolean;
}

/** The memory layer. A fixed-user implementation exists for the first slice and tests. */
export interface SessionHooks {
  prepare(userId: string, sessionId: string, start: ClientSessionStart): Promise<PreparedSession>;
  /** called for every final user turn while the session runs (live corrections, explicit addressing requests) */
  onUserTurn?(args: { userId: string; sessionId: string; turn: SessionTurn; recent: SessionTurn[] }): Promise<void>;
  /** called at the end; returns the summary that is sent to the phone */
  finalize(args: { userId: string; sessionId: string; turns: SessionTurn[]; stats: Record<string, unknown>; endReason: string;
    describe: Record<string, unknown>; language: string; startedAt: Date }): Promise<unknown>;
}

export interface PodConfig {
  url: string; // e.g. https://<pod>-8000.proxy.runpod.net/v1
  apiKey: string;
}

/** Weak hint only: a final utterance much quieter than the session's reference level is less likely to be the phone's
 * owner speaking into the phone. Used to mark a turn "uncertain" (never to mark it as the user). */
export const QUIET_MARGIN_DB = 10;

export function attributionFor(d: Record<string, unknown>): { attribution: "primary" | "uncertain"; why?: string } {
  const level = typeof d.level_db === "number" ? d.level_db : null;
  const ref = typeof d.ref_level_db === "number" ? d.ref_level_db : null;
  if (level !== null && ref !== null && level < ref - QUIET_MARGIN_DB) return { attribution: "uncertain", why: "much_quieter_than_reference" };
  if (level !== null && ref !== null && level > ref + QUIET_MARGIN_DB) return { attribution: "uncertain", why: "much_louder_than_reference" };
  return { attribution: "primary" };
}

export class VoiceSession {
  readonly sessionId: string;
  private pod: PodSession | null = null;
  private seqByRid = new Map<string, number>();
  private nextSeq = 1;
  private proactiveRids = new Set<string>();
  private resamplers = new Map<string, StreamResampler>();
  private agentPartial = new Map<string, string>();
  private turns: SessionTurn[] = [];
  private turnIdx = 0;
  private closing = false;
  private endReason = "client_disconnect";
  private startedAt = new Date();
  private lastSpeechStoppedT: number | null = null;
  private firstAudioSent = new Set<number>();
  /** wall-clock ms at which the audio sent so far will have finished playing on the phone (estimate) */
  private playbackUntil = 0;
  private endTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private language: string = "auto";
  private describe: Record<string, unknown> = {};
  private done: Promise<void>;
  private resolveDone!: () => void;

  readonly stats = {
    audio_in_bytes: 0, audio_out_bytes: 0, turns_user: 0, turns_agent: 0, interruptions: 0, errors: 0,
    reply_ms: [] as number[], interrupt_detect_ms: [] as number[], client_first_audio_ms: [] as number[],
    client_flush_ms: [] as number[], audio_events: [] as Record<string, unknown>[], pod_metrics: {} as Record<string, number[]>,
    pong_rtt_ms: [] as number[],
  };

  constructor(
    private readonly client: ClientSocket,
    private readonly userId: string,
    private readonly hooks: SessionHooks,
    private readonly podCfg: PodConfig,
    private readonly opts: { maxMinutes?: number; log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
  ) {
    this.sessionId = randomUUID();
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get finished(): Promise<void> { return this.done; }
  get transcript(): readonly SessionTurn[] { return this.turns; }

  private log(msg: string, extra?: Record<string, unknown>) { this.opts.log?.(msg, { session_id: this.sessionId, ...extra }); }

  private seqFor(rid: string): number {
    let s = this.seqByRid.get(rid);
    if (s === undefined) { s = this.nextSeq++; this.seqByRid.set(rid, s); }
    return s;
  }

  private send(msg: ServerMessage) { try { this.client.sendJson(msg); } catch { this.close("client_disconnect"); } }

  // ------------------------------------------------------------ start
  async start(start: ClientSessionStart): Promise<void> {
    let prepared: PreparedSession;
    try {
      prepared = await this.hooks.prepare(this.userId, this.sessionId, start);
    } catch (e) {
      this.send({ type: "error", message: `could not prepare the session: ${String(e).slice(0, 200)}`, fatal: true });
      return this.close("error");
    }
    this.language = prepared.ctx.language;
    this.pod = new PodSession(this.podCfg.url, this.podCfg.apiKey, {
      onEvent: (ev, d) => this.onPodEvent(ev, d),
      onAudio: (a) => this.onPodAudio(a),
      onLost: (reason) => {
        if (this.closing) return;
        this.stats.errors++;
        this.send({ type: "error", message: reason, fatal: true });
        this.close("provider_error");
      },
    });
    try {
      await this.pod.start(prepared.ctx);
    } catch (e) {
      this.stats.errors++;
      this.send({ type: "error", message: `voice pipeline unavailable: ${String((e as Error).message ?? e).slice(0, 200)}`, fatal: true });
      return this.close("provider_unavailable");
    }
    this.describe = this.pod.describe;
    this.send({
      type: "session.created", session_id: this.sessionId, input_sample_rate: INPUT_SAMPLE_RATE, output_sample_rate: OUTPUT_SAMPLE_RATE,
      language: prepared.ctx.language, proactive: prepared.ctx.proactive, onboarding: prepared.onboarding,
    });
    const maxMs = (this.opts.maxMinutes ?? 90) * 60_000;
    this.maxTimer = setTimeout(() => this.close("max_duration"), maxMs);
    this.log("session started", { onboarding: prepared.onboarding, language: prepared.ctx.language });
  }

  // ------------------------------------------------------------ phone -> pod
  onClientAudio(pcm: Uint8Array) {
    if (this.closing) return;
    this.stats.audio_in_bytes += pcm.byteLength;
    this.pod?.pushAudio(pcm);
  }

  onClientMessage(m: ClientMessage) {
    switch (m.type) {
      case "client.playback":
        if (m.event === "first_audio" && typeof m.since_speech_stopped_ms === "number") this.stats.client_first_audio_ms.push(m.since_speech_stopped_ms);
        if (m.event === "flushed" && typeof m.flush_ms === "number") this.stats.client_flush_ms.push(m.flush_ms);
        if (m.event === "idle") this.playbackUntil = Math.min(this.playbackUntil, Date.now());
        break;
      case "client.audio":
        this.stats.audio_events.push({ ...m, t_server: Date.now() });
        break;
      case "ping":
        this.send({ type: "pong", t: m.t, t_server: Date.now() });
        break;
      case "interrupt":
        this.pod?.interrupt();
        break;
      case "session.end":
        this.close("client_end");
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ pod -> phone
  private onPodAudio(a: PodAudio) {
    if (this.closing) return;
    const rid = String(a.data.response_id ?? "?");
    const seq = this.seqFor(rid);
    let rs = this.resamplers.get(rid);
    if (!rs || rs.inRate !== a.sampleRate) {
      rs = new StreamResampler(a.sampleRate, OUTPUT_SAMPLE_RATE);
      this.resamplers.clear(); // only the current turn's stream is kept
      this.resamplers.set(rid, rs);
    }
    const pcm = rs.push(a.pcm);
    if (!pcm.byteLength) return;
    this.sendAudio(seq, pcm, rid);
  }

  private sendAudio(seq: number, pcm: Uint8Array, rid: string) {
    if (!this.firstAudioSent.has(seq)) {
      this.firstAudioSent.add(seq);
      const proactive = this.proactiveRids.has(rid);
      const replyMs = !proactive && this.lastSpeechStoppedT !== null ? Date.now() - this.lastSpeechStoppedT : null;
      if (replyMs !== null) this.stats.reply_ms.push(replyMs);
      this.send({ type: "turn.latency", seq, server_reply_ms: replyMs, proactive });
    }
    this.stats.audio_out_bytes += pcm.byteLength;
    const now = Date.now();
    this.playbackUntil = Math.max(this.playbackUntil, now) + (pcm.byteLength / 2 / OUTPUT_SAMPLE_RATE) * 1000;
    try { this.client.sendBinary(packClientAudio(seq, pcm)); } catch { this.close("client_disconnect"); }
  }

  private onPodEvent(ev: string, d: Record<string, unknown>) {
    if (this.closing && ev !== PodEvent.AGENT_TURN_DONE) return;
    switch (ev) {
      case PodEvent.USER_SPEECH_STARTED:
        this.send({ type: "user.speech_started" });
        break;
      case PodEvent.USER_SPEECH_STOPPED:
        this.lastSpeechStoppedT = Date.now();
        this.send({ type: "user.speech_stopped", audio_end_ms: typeof d.audio_end_ms === "number" ? d.audio_end_ms : null });
        break;
      case PodEvent.USER_TRANSCRIPT: {
        const text = String(d.text ?? "").trim();
        const final = Boolean(d.final);
        if (final && text && !d.discarded) {
          this.stats.turns_user++;
          const a = attributionFor(d);
          this.addTurn("user", text, (d.language as string) ?? null, a.attribution, {
            level_db: d.level_db, ref_level_db: d.ref_level_db, barge_in: d.barge_in, near_agent: d.near_agent,
            ...(a.why ? { uncertain_because: a.why } : {}),
          });
          const turn = this.turns[this.turns.length - 1]!;
          this.hooks.onUserTurn?.({ userId: this.userId, sessionId: this.sessionId, turn, recent: this.turns.slice(-8) })
            .catch((e) => this.log("onUserTurn failed", { error: String(e).slice(0, 200) }));
        }
        this.send({ type: "user.transcript", text: String(d.text ?? ""), final, language: (d.language as string) ?? null });
        break;
      }
      case PodEvent.AGENT_TURN_STARTED: {
        const rid = String(d.response_id);
        if (d.proactive) this.proactiveRids.add(rid);
        this.send({ type: "agent.turn_started", seq: this.seqFor(rid), proactive: Boolean(d.proactive) });
        break;
      }
      case PodEvent.AGENT_TEXT: {
        const rid = String(d.response_id);
        this.agentPartial.set(rid, (this.agentPartial.get(rid) ?? "") + String(d.delta ?? ""));
        this.send({ type: "agent.text", seq: this.seqFor(rid), delta: String(d.delta ?? "").replace(END_MARKER, "") });
        break;
      }
      case PodEvent.AGENT_TURN_DONE: {
        const rid = String(d.response_id);
        const seq = this.seqFor(rid);
        const rs = this.resamplers.get(rid);
        if (rs && !this.closing) {
          const tail = rs.flush();
          if (tail.byteLength) this.sendAudio(seq, tail, rid);
        }
        const text = String(d.text ?? this.agentPartial.get(rid) ?? "").replace(END_MARKER, "").trim();
        this.stats.turns_agent++;
        if (text) this.addTurn("agent", text, null, "primary", { proactive: this.proactiveRids.has(rid), rid });
        this.agentPartial.delete(rid);
        if (!this.closing) this.send({ type: "agent.turn_done", seq, text });
        break;
      }
      case PodEvent.AGENT_INTERRUPTED: {
        const rid = String(d.response_id ?? "?");
        const seq = this.seqFor(rid);
        this.stats.interruptions++;
        this.resamplers.delete(rid);
        this.playbackUntil = Date.now();
        const heard = typeof d.heard_text === "string" ? d.heard_text : (this.agentPartial.get(rid) ?? "");
        this.agentPartial.delete(rid);
        const last = this.turns[this.turns.length - 1];
        if (last && last.role === "agent" && last.meta.rid === rid) {
          last.text = heard || last.text;
          last.meta.interrupted = true;
        } else if (heard) {
          this.addTurn("agent", heard, null, "primary", { interrupted: true, rid });
        }
        const det = typeof d.detect_audio_ms === "number" ? d.detect_audio_ms : null;
        this.send({ type: "agent.interrupted", seq, interrupt_detect_ms: det });
        break;
      }
      case PodEvent.METRIC: {
        const name = String(d.name);
        (this.stats.pod_metrics[name] ??= []).push(Number(d.value_ms));
        break;
      }
      case PodEvent.END_REQUESTED: {
        if (this.endTimer) break;
        const wait = Math.min(20_000, Math.max(0, this.playbackUntil - Date.now()) + 600);
        this.endTimer = setTimeout(() => this.close(String(d.reason ?? "agent_ended")), wait);
        break;
      }
      case PodEvent.ERROR:
        this.stats.errors++;
        this.send({ type: "error", message: String(d.message ?? ""), fatal: Boolean(d.fatal) });
        if (d.fatal) this.close("provider_error");
        break;
      default:
        break;
    }
  }

  private addTurn(role: "user" | "agent", text: string, language: string | null, attribution: "primary" | "uncertain", meta: Record<string, unknown>) {
    this.turns.push({ idx: this.turnIdx++, role, text, language, startedAt: Date.now(), attribution, meta });
  }

  // ------------------------------------------------------------ end
  async close(reason: string): Promise<void> {
    if (this.closing) return this.done;
    this.closing = true;
    this.endReason = reason;
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.pod?.close();
    let summary: unknown = null;
    const stats = this.summaryStats();
    try {
      summary = await this.hooks.finalize({
        userId: this.userId, sessionId: this.sessionId, turns: this.turns, stats, endReason: reason, describe: this.describe,
        language: this.language, startedAt: this.startedAt,
      });
    } catch (e) {
      this.log("finalize failed", { error: String(e).slice(0, 300) });
    }
    try {
      this.client.sendJson({ type: "session.summary", session_id: this.sessionId, summary, stats });
      this.client.sendJson({ type: "session.closed", reason });
      this.client.close(1000, reason);
    } catch { /* phone already gone */ }
    this.log("session ended", { reason, turns: this.turns.length });
    this.resolveDone();
  }

  summaryStats(): Record<string, unknown> {
    const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
    const s = this.stats;
    return {
      end_reason: this.endReason, duration_s: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      turns_user: s.turns_user, turns_agent: s.turns_agent, interruptions: s.interruptions, errors: s.errors,
      audio_in_s: +(s.audio_in_bytes / 2 / INPUT_SAMPLE_RATE).toFixed(1), audio_out_s: +(s.audio_out_bytes / 2 / OUTPUT_SAMPLE_RATE).toFixed(1),
      server_reply_ms: s.reply_ms, server_reply_ms_median: med(s.reply_ms),
      client_first_audio_ms: s.client_first_audio_ms, client_first_audio_ms_median: med(s.client_first_audio_ms),
      client_flush_ms: s.client_flush_ms, audio_events: s.audio_events,
      pod_metrics_median: Object.fromEntries(Object.entries(s.pod_metrics).map(([k, v]) => [k, med(v)])),
    };
  }
}
