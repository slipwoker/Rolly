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
import { Pacer, parseRemainingMinutes } from "./pacing.ts";
import { PlanFeeder, type PlanItem } from "./planFeeder.ts";
import { styleGuardNote } from "../persona/style.ts";
import { NOTE, LOOKUP_MARKER } from "../persona/core.ts";
import { StreamResampler } from "./resampler.ts";

export const END_MARKER = "<end_session/>";
const stripMarkers = (t: string) => t.replace(END_MARKER, "").replace(LOOKUP_MARKER, "");
const LOOKUP_TIMEOUT_MESSAGE = "[lookup_failed - not said by the user] The online check did not work just now. Say so in a few words, do not guess the answer, and go on with the conversation.";

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
  /** compress pacing time (server-side self-tests only); 1 or absent = real time */
  pacingScale?: number;
  /** the plan for this ride; item 0 is already in the opener, the rest are fed by notes when the conversation runs dry */
  plan?: PlanItem[];
  /** something unconfirmed to ask about once, when a quiet moment comes */
  confirm?: string | null;
}

/** Something to tell the conversation model on its next turn(s) through the pod's note channel. */
export interface TurnNote { text: string; turns: number;
  /** holds for the rest of the conversation (e.g. how to address the user): sent again when its turns run out */
  standing?: boolean }

/** A note as sent, for the audit: what, when (seconds into the session) and for how many turns. */
export interface NoteRecord { kind: string; text: string; turns: number; at_s: number }

/** The memory layer. A fixed-user implementation exists for the first slice and tests. */
export interface SessionHooks {
  prepare(userId: string, sessionId: string, start: ClientSessionStart): Promise<PreparedSession>;
  /** called for every final user turn while the session runs (live corrections, explicit addressing requests) */
  onUserTurn?(args: { userId: string; sessionId: string; turn: SessionTurn; recent: SessionTurn[] }): Promise<TurnNote | void>;
  /**
   * The model said it is checking something online: find the answer. Resolves with the marked message the model is
   * given next (lookup/web.ts: the facts, or that the check did not work). Never rejects in normal operation.
   */
  lookup?(args: { userId: string; sessionId: string; question: string; recent: { role: "user" | "agent"; text: string }[]; language: string }): Promise<{ message: string; ok: boolean; reason?: string }>;
  /** called at the end; returns the summary that is sent to the phone */
  finalize(args: { userId: string; sessionId: string; turns: SessionTurn[]; stats: Record<string, unknown>; endReason: string;
    describe: Record<string, unknown>; language: string; startedAt: Date;
    /** the notes sent to the model, with their text (for the audit; personal text, kept apart from `stats`) */
    notes?: NoteRecord[] }): Promise<unknown>;
}

export interface PodConfig {
  url: string; // e.g. https://<pod>-8000.proxy.runpod.net/v1
  apiKey: string;
}

/** Weak hint only: a final utterance much quieter than the session's reference level is less likely to be the phone's
 * owner speaking into the phone. Used to mark a turn "uncertain" (never to mark it as the user).
 * A much LOUDER utterance is no longer a hint (P1-D33): someone else in the car is farther from the microphone, so
 * quieter; louder is the owner speaking up. On 2026-11-26 a tester's "אני בת" was dropped for being loud. */
export const QUIET_MARGIN_DB = 10;

export function attributionFor(d: Record<string, unknown>): { attribution: "primary" | "uncertain"; why?: string } {
  const level = typeof d.level_db === "number" ? d.level_db : null;
  const ref = typeof d.ref_level_db === "number" ? d.ref_level_db : null;
  if (level !== null && ref !== null && level < ref - QUIET_MARGIN_DB) return { attribution: "uncertain", why: "much_quieter_than_reference" };
  return { attribution: "primary" };
}

/**
 * Every conversation numbers its agent turns from a range of its own.
 *
 * They used to start at 1 in every conversation. The phone's audio player remembers which turn numbers were cut off
 * (to drop their late audio) and, in the builds installed in November 2026, keeps that list for as long as the app is
 * open. So a reply whose number had been interrupted in an EARLIER conversation was shown as text and never spoken
 * (owner's phone, 2026-11-26 11:27: replies 4 and 7 were silent; 4 had been cut off at 11:18 and 7 at 11:14).
 * With a range per conversation no number is ever seen twice by one app. The value fits the 4 bytes it has in an
 * audio frame and a signed 32-bit integer.
 */
let lastSeqBase = 0;
export function seqBase(now = Date.now()): number {
  // Below 2^31: the Android audio module takes the number as a 32-bit signed integer.
  const byClock = (Math.floor(now / 1000) % 2_000_000) * 1000 + 1; // unique across server restarts (repeats after 23 days)
  lastSeqBase = byClock > lastSeqBase ? byClock : lastSeqBase + 1000; // and for two conversations in the same second
  if (lastSeqBase > 2_000_000_000) lastSeqBase = 1;
  return lastSeqBase;
}

export class VoiceSession {
  readonly sessionId: string;
  private pod: PodSession | null = null;
  private seqByRid = new Map<string, number>();
  private nextSeq = seqBase();
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
  private pacer: Pacer | null = null;
  private paceTimer: NodeJS.Timeout | null = null;
  private feeder: PlanFeeder | null = null;
  private confirm: string | null = null;
  /** Rolly's completed replies, for the style guard */
  private replies: string[] = [];
  private lastUserWords: number | null = null;
  private standing: { text: string; turns: number; left: number } | null = null;
  // ---- online lookups: the result is handed to the model at a quiet moment (sending text cuts a turn in progress)
  private agentBusy = false; // a reply is being generated or synthesised
  private userBusy = false; // the user is speaking, or has spoken and the reply has not started yet
  private userBusySince = 0;
  private lookupRunning = false;
  private inject: { message: string; readyAt: number } | null = null;
  private injectTimer: NodeJS.Timeout | null = null;
  /** the next agent turn answers an injected message, not the user: no reply-latency measurement for it */
  private injectedNext = false;
  private language: string = "auto";
  private describe: Record<string, unknown> = {};
  private done: Promise<void>;
  private resolveDone!: () => void;

  readonly stats = {
    audio_in_bytes: 0, audio_out_bytes: 0, turns_user: 0, turns_agent: 0, interruptions: 0, errors: 0,
    reply_ms: [] as number[], interrupt_detect_ms: [] as number[], client_first_audio_ms: [] as number[],
    client_flush_ms: [] as number[], audio_events: [] as Record<string, unknown>[], pod_metrics: {} as Record<string, number[]>,
    pong_rtt_ms: [] as number[],
    /** notes sent to the conversation model: pacing nudges and memory hints (what, and when in the session) */
    notes: [] as { kind: string; at_s: number }[],
    /**
     * Bytes of voice received from the pod, by the sample rate it arrived at. Each voice engine has its own rate (the
     * Hebrew voice BlueV3 44,100 Hz; the Piper voices 22,050 Hz), so this shows which voice really spoke in a session,
     * including a silent switch to the pod's backup Hebrew voice.
     */
    voice_bytes_by_rate: {} as Record<string, number>,
    /** online lookups: when asked (seconds into the session), how long the search took, how long until it was said */
    lookups: [] as { at_s: number; ok: boolean; reason?: string; search_ms: number; delivered_after_ms: number | null }[],
    /** raw units reported by the pod (`usage` events): conversation-model tokens, synthesised characters, transcribed audio */
    usage: {
      llm: { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, max_prompt_tokens: 0, model: null as string | null },
      tts: { chars: 0, audio_s: 0, engine: null as string | null },
      stt: { audio_s: 0, engine: null as string | null },
    },
  };
  /** the same notes with their text, handed to finalize for the audit only */
  private noteLog: NoteRecord[] = [];
  /** per agent reply (response id): server reply latency and the pod's stage timings, put on the agent turn */
  private turnMetrics = new Map<string, Record<string, number>>();

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
    // pacing: nudges for the model when the ride has an expected length (or the user says how long is left)
    const minutes = Number((prepared.ctx.journey as { duration_min?: unknown }).duration_min) || null;
    this.pacer = new Pacer(Date.now(), minutes, prepared.pacingScale ?? 1);
    if (prepared.plan?.length) this.feeder = new PlanFeeder(prepared.plan, prepared.ctx.proactive && !!prepared.ctx.opener_instruction);
    this.confirm = prepared.confirm ?? null;
    this.paceTimer = setInterval(() => this.pace(), 1000);
    this.log("session started", { onboarding: prepared.onboarding, language: prepared.ctx.language, minutes });
  }

  private pace() {
    if (this.closing || !this.pacer) return;
    for (const n of this.pacer.due(Date.now())) {
      // halfway: the next item of the plan, if one is left, instead of a general nudge
      const item = n.event === "half" ? this.feeder?.afterReply(null, true) : null;
      if (item) this.note("plan_halfway", item.text, item.turns);
      else this.note(`pacing_${n.event}`, n.text, n.turns);
    }
  }

  /**
   * After each completed reply of Rolly: what should the model be told before its next turn?
   *  - style guard: it fell back on bot-speak (agreeing openers, general wisdom, promises);
   *  - the next item of the plan, held on the pod until the user gives a one-word answer twice in a row;
   *  - once per ride, on a quiet turn: whether to remember something unconfirmed.
   */
  private afterReply(text: string, proactive: boolean) {
    this.replies.push(text);
    // the system prompt cannot change mid-conversation, so a standing note is repeated when the pod has used it up
    if (this.standing && --this.standing.left <= 0) { this.standing.left = this.standing.turns; this.note("standing", this.standing.text, this.standing.turns); }
    const guard = styleGuardNote(this.replies.slice(-2));
    if (guard) this.note("style", guard, 1);
    const item = this.feeder?.afterReply(proactive ? null : this.lastUserWords);
    if (item) this.note("plan", item.text, item.turns, item.maxUserWords !== undefined ? { maxUserWords: item.maxUserWords, minStreak: 2 } : undefined);
    if (this.confirm && this.replies.length === 3) {
      this.note("confirm", NOTE.confirm(this.confirm), 1, { maxUserWords: 2, minStreak: 1 });
      this.confirm = null;
    }
  }

  /** A note for the model's next turn(s). It does not interrupt speech and is not part of the transcript. */
  private note(kind: string, text: string, turns: number, when?: { maxUserWords: number; minStreak?: number }) {
    if (this.closing || !this.pod) return;
    this.pod.note(text, turns, when);
    const at_s = Math.round((Date.now() - this.startedAt.getTime()) / 1000);
    this.stats.notes.push({ kind, at_s });
    this.noteLog.push({ kind, text: text.slice(0, 600), turns, at_s });
  }

  // ------------------------------------------------------------ online lookups
  /** The model said "checking" (its reply carried the lookup marker): search, then tell it the answer at a quiet moment. */
  private startLookup() {
    if (this.closing || this.lookupRunning || !this.hooks.lookup) return;
    const users = this.turns.filter((t) => t.role === "user");
    const question = users.at(-1)?.text;
    if (!question) return;
    this.lookupRunning = true;
    const t0 = Date.now();
    const at_s = Math.round((t0 - this.startedAt.getTime()) / 1000);
    const recent = this.turns.slice(-6).map((t) => ({ role: t.role, text: t.text }));
    const guard = new Promise<{ message: string; ok: boolean; reason?: string }>((r) => setTimeout(() => r({ message: LOOKUP_TIMEOUT_MESSAGE, ok: false, reason: "timeout" }), 16_000));
    Promise.race([this.hooks.lookup({ userId: this.userId, sessionId: this.sessionId, question, recent, language: this.language }), guard])
      .catch((e) => ({ message: LOOKUP_TIMEOUT_MESSAGE, ok: false, reason: String(e).slice(0, 80) }))
      .then((r) => {
        const rec = { at_s, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), search_ms: Date.now() - t0, delivered_after_ms: null as number | null };
        this.stats.lookups.push(rec);
        if (this.closing) { this.lookupRunning = false; return; }
        this.inject = { message: r.message, readyAt: Date.now() };
        const tryNow = () => {
          if (this.closing || !this.inject) { this.stopInject(); return; }
          const waited = Date.now() - this.inject.readyAt;
          // a user who started speaking and got no reply within 4 s was not answered (noise, a discarded utterance)
          if (this.userBusy && Date.now() - this.userBusySince > 4_000) this.userBusy = false;
          const quiet = !this.agentBusy && !this.userBusy && Date.now() >= this.playbackUntil + 300;
          if (!quiet && waited < 20_000) return;
          this.injectedNext = true;
          this.pod?.sendText(this.inject.message);
          rec.delivered_after_ms = Date.now() - t0;
          this.stats.notes.push({ kind: r.ok ? "lookup_result" : "lookup_failed", at_s: Math.round((Date.now() - this.startedAt.getTime()) / 1000) });
          this.stopInject();
        };
        this.injectTimer = setInterval(tryNow, 250);
        tryNow();
      });
  }

  private stopInject() {
    if (this.injectTimer) clearInterval(this.injectTimer);
    this.injectTimer = null; this.inject = null; this.lookupRunning = false;
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
    this.stats.voice_bytes_by_rate[a.sampleRate] = (this.stats.voice_bytes_by_rate[a.sampleRate] ?? 0) + a.pcm.byteLength;
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
      if (replyMs !== null) { this.stats.reply_ms.push(replyMs); this.metricsFor(rid).reply_ms = replyMs; }
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
        this.userBusy = true; this.userBusySince = Date.now();
        this.send({ type: "user.speech_started" });
        break;
      case PodEvent.LOOKUP_REQUESTED:
        this.startLookup();
        break;
      case PodEvent.USER_SPEECH_STOPPED:
        this.lastSpeechStoppedT = Date.now();
        this.send({ type: "user.speech_stopped", audio_end_ms: typeof d.audio_end_ms === "number" ? d.audio_end_ms : null });
        break;
      case PodEvent.USER_TRANSCRIPT: {
        const text = String(d.text ?? "").trim();
        const final = Boolean(d.final);
        // our own marked message coming back as "typed text" (a lookup result): not the user's words, not shown, not stored
        if (d.typed && text.startsWith("[")) break;
        if (final && d.discarded) this.userBusy = false; // nothing will be answered
        if (final && text && !d.discarded) {
          this.stats.turns_user++;
          const a = attributionFor(d);
          this.addTurn("user", text, (d.language as string) ?? null, a.attribution, {
            level_db: d.level_db, ref_level_db: d.ref_level_db, barge_in: d.barge_in, near_agent: d.near_agent,
            ...(a.why ? { uncertain_because: a.why } : {}),
          });
          const turn = this.turns[this.turns.length - 1]!;
          this.lastUserWords = text.split(/\s+/).filter(Boolean).length;
          // "עוד רבע שעה אני מגיע": the user's own statement resets the clock (only from a turn with no hint of another speaker)
          if (a.attribution === "primary" && this.pacer) {
            const left = parseRemainingMinutes(text);
            if (left !== null) { this.pacer.setRemaining(left, Date.now()); this.stats.notes.push({ kind: `time_left_${left}`, at_s: Math.round((Date.now() - this.startedAt.getTime()) / 1000) }); }
          }
          this.hooks.onUserTurn?.({ userId: this.userId, sessionId: this.sessionId, turn, recent: this.turns.slice(-8) })
            .then((n) => {
              if (!n) return;
              if (n.standing) { this.standing = { text: n.text, turns: n.turns, left: n.turns }; this.note("standing", n.text, n.turns); }
              else this.note("memory", n.text, n.turns);
            })
            .catch((e) => this.log("onUserTurn failed", { error: String(e).slice(0, 200) }));
        }
        this.send({ type: "user.transcript", text: String(d.text ?? ""), final, language: (d.language as string) ?? null });
        break;
      }
      case PodEvent.AGENT_TURN_STARTED: {
        const rid = String(d.response_id);
        this.agentBusy = true; this.userBusy = false;
        if (d.proactive || this.injectedNext) this.proactiveRids.add(rid);
        this.injectedNext = false;
        this.send({ type: "agent.turn_started", seq: this.seqFor(rid), proactive: Boolean(d.proactive) });
        break;
      }
      case PodEvent.AGENT_TEXT: {
        const rid = String(d.response_id);
        this.agentPartial.set(rid, (this.agentPartial.get(rid) ?? "") + String(d.delta ?? ""));
        this.send({ type: "agent.text", seq: this.seqFor(rid), delta: stripMarkers(String(d.delta ?? "")) });
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
        const text = stripMarkers(String(d.text ?? this.agentPartial.get(rid) ?? "")).trim();
        this.stats.turns_agent++;
        this.agentBusy = false;
        const usage = d.usage && typeof d.usage === "object" ? d.usage as Record<string, unknown> : null;
        if (text) this.addTurn("agent", text, null, "primary", { proactive: this.proactiveRids.has(rid), rid, ...this.turnMetrics.get(rid),
          ...(usage && typeof usage.prompt_tokens === "number" ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens ?? null } : {}) });
        this.turnMetrics.delete(rid);
        if (text && !this.closing) this.afterReply(text, this.proactiveRids.has(rid));
        this.agentPartial.delete(rid);
        if (!this.closing) this.send({ type: "agent.turn_done", seq, text });
        break;
      }
      case PodEvent.AGENT_INTERRUPTED: {
        this.agentBusy = false;
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
          this.addTurn("agent", heard, null, "primary", { interrupted: true, rid, ...this.turnMetrics.get(rid) });
        }
        const det = typeof d.detect_audio_ms === "number" ? d.detect_audio_ms : null;
        this.send({ type: "agent.interrupted", seq, interrupt_detect_ms: det });
        break;
      }
      case PodEvent.METRIC: {
        const name = String(d.name);
        (this.stats.pod_metrics[name] ??= []).push(Number(d.value_ms));
        if (d.response_id !== undefined && /^(stt_ms|llm_ttft_ms|llm_total_ms|tts_ttfa_ms|pipeline_ms)$/.test(name) && Number.isFinite(Number(d.value_ms))) {
          this.metricsFor(String(d.response_id))[name] = Math.round(Number(d.value_ms));
        }
        break;
      }
      case PodEvent.USAGE: this.addUsage(d); break;
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

  private metricsFor(rid: string): Record<string, number> {
    let m = this.turnMetrics.get(rid);
    if (!m) { m = {}; this.turnMetrics.set(rid, m); if (this.turnMetrics.size > 50) this.turnMetrics.delete(this.turnMetrics.keys().next().value!); }
    return m;
  }

  private addUsage(d: Record<string, unknown>) {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const u = this.stats.usage;
    if (d.kind === "llm") {
      u.llm.calls++;
      u.llm.prompt_tokens += n(d.prompt_tokens); u.llm.completion_tokens += n(d.completion_tokens); u.llm.cached_tokens += n(d.cached_tokens);
      u.llm.max_prompt_tokens = Math.max(u.llm.max_prompt_tokens, n(d.prompt_tokens));
      if (typeof d.model === "string") u.llm.model = d.model;
    } else if (d.kind === "tts") {
      u.tts.chars += n(d.chars); u.tts.audio_s = +(u.tts.audio_s + n(d.audio_s)).toFixed(2);
      if (typeof d.engine === "string") u.tts.engine = d.engine;
    } else if (d.kind === "stt") {
      u.stt.audio_s = +(u.stt.audio_s + n(d.audio_s)).toFixed(2);
      if (typeof d.engine === "string") u.stt.engine = d.engine;
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
    if (this.paceTimer) clearInterval(this.paceTimer);
    if (this.injectTimer) clearInterval(this.injectTimer);
    this.pod?.close();
    let summary: unknown = null;
    const stats = this.summaryStats();
    try {
      summary = await this.hooks.finalize({
        userId: this.userId, sessionId: this.sessionId, turns: this.turns, stats, endReason: reason, describe: this.describe,
        language: this.language, startedAt: this.startedAt, notes: this.noteLog,
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
      voice_s_by_rate: Object.fromEntries(Object.entries(s.voice_bytes_by_rate).map(([rate, bytes]) => [rate, +(bytes / 2 / Number(rate)).toFixed(1)])),
      server_reply_ms: s.reply_ms, server_reply_ms_median: med(s.reply_ms),
      client_first_audio_ms: s.client_first_audio_ms, client_first_audio_ms_median: med(s.client_first_audio_ms),
      client_flush_ms: s.client_flush_ms, audio_events: s.audio_events, notes: s.notes, lookups: s.lookups,
      pod_metrics_median: Object.fromEntries(Object.entries(s.pod_metrics).map(([k, v]) => [k, med(v)])),
      pod_metrics_count: Object.fromEntries(Object.entries(s.pod_metrics).map(([k, v]) => [k, v.length])),
      usage: s.usage,
    };
  }
}
