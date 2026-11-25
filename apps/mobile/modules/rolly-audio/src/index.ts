/** JS side of the ROLLY native audio module (iOS). See ios/RollyAudioModule.swift. */
import { requireNativeModule, type EventSubscription } from "expo-modules-core";

export interface RouteInfo {
  route: string;
  sample_rate: number;
  input_latency_ms: number;
  output_latency_ms: number;
  io_buffer_ms: number;
  bluetooth_hfp: boolean;
}
export interface MicFrame { data: string; t: number } // base64 PCM16 16 kHz mono 20 ms; t = wall ms of the first sample
export type PlaybackEvent =
  | { event: "first_audio"; seq: number; t: number; output_latency_ms: number; queued_before: boolean }
  | { event: "flushed"; seq: number; flush_ms: number; t: number }
  | { event: "idle"; seq: number; t: number };
export interface AudioSessionEvent { event: string; reason?: string; route?: string; should_resume?: boolean; t: number }

interface Native {
  start(): Promise<RouteInfo>;
  stop(): Promise<void>;
  enqueue(seq: number, base64: string): void;
  flush(seq: number): number;
  currentRoute(): RouteInfo;
  addListener(name: "onMicFrame", cb: (e: MicFrame) => void): EventSubscription;
  addListener(name: "onPlayback", cb: (e: PlaybackEvent) => void): EventSubscription;
  addListener(name: "onAudioSession", cb: (e: AudioSessionEvent) => void): EventSubscription;
}

export const RollyAudio = requireNativeModule<Native>("RollyAudio");
