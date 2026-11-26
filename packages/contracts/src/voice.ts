/**
 * Voice protocols.
 *
 * 1. Phone <-> rolly-api  (WS /v1/voice?ticket=<single-use ticket>)
 *    Deliberately close to the research tester's browser protocol (backend/app/session.py), which is proven end to end.
 *
 *    phone -> api
 *      text   ClientMessage (JSON)
 *      binary PCM16 little-endian, mono, 16 kHz microphone audio (20 ms frames recommended)
 *    api -> phone
 *      text   ServerMessage (JSON)
 *      binary [4-byte little-endian agent-turn sequence number][PCM16 LE mono, OUTPUT_SAMPLE_RATE]
 *
 * 2. rolly-api <-> GPU worker  (WS /v1/session, Authorization: Bearer ROLLY_GPU_API_KEY) — unchanged research protocol,
 *    see providers/remote.py and backend/gpu_worker.py.
 *    api -> pod   text {"type":"start","ctx":PodSessionContext}, binary PCM16 16 kHz, text {"type":"text"|"interrupt"|"close"}
 *    pod -> api   text {"type":"ready","describe":{...}} | {"type":"event","event":name,"data":{...}} | {"type":"error",...}
 *                 binary [4-byte BIG-endian header length][JSON {"event","data","sample_rate"}][PCM16 at the voice's own rate]
 */

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

export type Language = "he" | "en" | "auto";

// ---------------------------------------------------------------- phone -> api
export interface ClientSessionStart {
  type: "session.start";
  language?: Language;
  /**
   * true when the user picked this language themselves (the language button). Without it the server uses the language
   * of the user's profile (Hebrew when none is known): an app default, such as the phone's system language, must not
   * decide which speech recogniser listens.
   */
  language_explicit?: boolean;
  proactive?: boolean;
  journey?: { duration_min?: number; mode?: string };
  /** Debug captions in the app; the server always sends transcripts, this only marks the session. */
  captions?: boolean;
  client?: { platform?: string; app_version?: string; audio_route?: string };
  /** reconnect after a dropped connection: id of the session that was cut off; ROLLY picks the conversation up */
  resume_of?: string;
}

export interface ClientPlayback {
  type: "client.playback";
  event: "first_audio" | "flushed" | "idle";
  seq: number;
  /** client wall clock ms when the event happened (Date.now()) */
  t?: number;
  /** for first_audio: ms between the true end of the user's speech (capture time of audio_end_ms) and the first audible
   *  agent audio, measured on the phone. Absent for proactive turns. */
  since_speech_stopped_ms?: number;
  /** for flushed: ms between agent.interrupted received and playback stopped */
  flush_ms?: number;
}

/** Audio-session lifecycle on the phone: interruptions (calls, Siri), route changes (Bluetooth on/off). */
export interface ClientAudioEvent {
  type: "client.audio";
  event: "interruption_began" | "interruption_ended" | "route_changed" | "media_services_reset" | "background" | "foreground";
  route?: string;
  reason?: string;
  t?: number;
}

export type ClientMessage =
  | ClientSessionStart
  | ClientPlayback
  | ClientAudioEvent
  | { type: "interrupt" }
  | { type: "ping"; t: number }
  | { type: "session.end" };

// ---------------------------------------------------------------- api -> phone
export interface SessionCreated {
  type: "session.created";
  session_id: string;
  input_sample_rate: number;
  output_sample_rate: number;
  language: Language;
  proactive: boolean;
  onboarding: boolean;
}

export type ServerMessage =
  | SessionCreated
  | { type: "user.speech_started" }
  /** audio_end_ms: true end of speech in microphone-stream time (ms of audio since the session's first frame). The phone
   *  maps it to the wall-clock capture time of that sample to measure end-of-speech -> first audible reply. */
  | { type: "user.speech_stopped"; audio_end_ms?: number | null }
  | { type: "user.transcript"; text: string; final: boolean; language?: string | null }
  | { type: "agent.turn_started"; seq: number; proactive: boolean }
  | { type: "agent.text"; seq: number; delta: string }
  | { type: "agent.turn_done"; seq: number; text: string }
  | { type: "agent.interrupted"; seq: number; interrupt_detect_ms?: number | null }
  | { type: "turn.latency"; seq: number; server_reply_ms?: number | null; proactive?: boolean }
  | { type: "pong"; t: number; t_server: number }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "session.summary"; session_id: string; summary: unknown; stats: Record<string, unknown> }
  | { type: "session.closed"; reason: string };

// ---------------------------------------------------------------- api <-> pod
export interface PodSessionContext {
  session_id: string;
  user_id: string;
  language: Language;
  system_prompt: string;
  opener_instruction: string | null;
  proactive: boolean;
  journey: Record<string, unknown>;
  profile: Record<string, unknown>;
  options: Record<string, unknown>;
}

/** Event names emitted by the pod (providers/base.py). */
export const PodEvent = {
  USER_SPEECH_STARTED: "user.speech_started",
  USER_SPEECH_STOPPED: "user.speech_stopped",
  USER_TRANSCRIPT: "user.transcript",
  AGENT_TURN_STARTED: "agent.turn_started",
  AGENT_TEXT: "agent.text",
  AGENT_AUDIO: "agent.audio",
  AGENT_TURN_DONE: "agent.turn_done",
  AGENT_INTERRUPTED: "agent.interrupted",
  METRIC: "metric",
  USAGE: "usage",
  END_REQUESTED: "session.end_requested",
  /** the model said it is checking something online (its reply carried the lookup marker) */
  LOOKUP_REQUESTED: "session.lookup_requested",
  ERROR: "error",
} as const;

/** Data of a final user.transcript from the pod. level_db/ref_level_db/barge_in are weak hints only, never identification. */
export interface PodTranscript {
  text: string;
  final: boolean;
  language?: string | null;
  level_db?: number | null;
  ref_level_db?: number | null;
  barge_in?: boolean;
  near_agent?: boolean;
  discarded?: boolean;
}

/** Append an agent-turn sequence number to a PCM16 chunk (phone protocol). */
export function packClientAudio(seq: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + pcm.byteLength);
  new DataView(out.buffer).setUint32(0, seq >>> 0, true);
  out.set(pcm, 4);
  return out;
}

export function unpackClientAudio(frame: Uint8Array): { seq: number; pcm: Uint8Array } {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { seq: dv.getUint32(0, true), pcm: frame.subarray(4) };
}
