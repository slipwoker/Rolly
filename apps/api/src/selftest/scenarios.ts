/**
 * Scripted conversations against the real pipeline. Each returns measured numbers and the transcript as the phone saw it.
 * Latency here: end of the user's utterance audio -> first agent audio frame received by the scripted phone. When run on
 * the server (POST /v1/admin/selftest) the phone is next to rolly-api, so the number includes rolly-api <-> pod but not the
 * real phone's network, audio buffers or Bluetooth.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerMessage } from "@rolly/contracts";
import { Phone, gainDb, userSpeech, wav, type Turn } from "./phone.ts";

export interface Step { say: string; gain_db?: number; barge_in_after_ms?: number; expect_reply?: boolean;
  /** stay silent this long before speaking (to let ride time pass in paced scenarios) */
  wait_ms?: number;
  /** after the reply, stay silent and wait for one more agent turn (the answer of an online lookup) */
  then_another_turn?: boolean }
export interface RunOpts {
  wsUrl: string; // full ws URL incl. ticket or dev_user
  lang: "he" | "en";
  pod: { url: string; apiKey: string };
  steps: Step[];
  outDir?: string;
  label?: string;
  /** expected length of the ride sent with session.start (default 20) */
  minutes?: number;
}

export interface TurnResult {
  label: string; seq: number; text: string; audio_s: number; interrupted: boolean; proactive: boolean;
  reply_latency_ms?: number; interrupt_received_ms_after_barge_start?: number | null; user_said?: string;
  /** for the answer of an online lookup: ms from the end of the "checking" reply's first audio to this turn's first audio */
  after_previous_ms?: number;
}

export interface RunResult {
  ok: boolean; error?: string; lang: string; turns: TurnResult[]; summary?: unknown; session_id?: string;
  transcripts: { text: string; language?: string | null }[]; events: { t: number; type: string }[];
}

export async function runConversation(o: RunOpts): Promise<RunResult> {
  const audio: Uint8Array[] = [];
  for (const s of o.steps) audio.push(await userSpeech(s.say, o.lang, o.pod));
  const phone = new Phone();
  const res: RunResult = { ok: false, lang: o.lang, turns: [], transcripts: [], events: [] };
  const save = (label: string, t: Turn, extra: Partial<TurnResult> = {}) => {
    if (o.outDir) {
      mkdirSync(o.outDir, { recursive: true });
      writeFileSync(resolve(o.outDir, `${o.label ?? "run"}_${label}_seq${t.seq}.wav`), wav(Buffer.concat(t.chunks.map((c) => Buffer.from(c))), 24000));
    }
    res.turns.push({ label, seq: t.seq, text: t.text, audio_s: +(t.bytes / 48000).toFixed(2), interrupted: t.interrupted, proactive: t.proactive, ...extra });
  };
  try {
    await phone.connect(o.wsUrl);
    phone.send({ type: "session.start", language: o.lang, language_explicit: true, proactive: true, journey: { duration_min: o.minutes ?? 20 }, client: { platform: "selftest" } });
    const created = await waitEvent(phone, "session.created", 40_000);
    res.session_id = (created as { session_id: string }).session_id;
    const opener = await phone.waitReply(0, 45_000);
    save("opener", opener);
    for (let i = 0; i < o.steps.length; i++) {
      const step = o.steps[i]!;
      if (step.wait_ms) await new Promise((r) => setTimeout(r, step.wait_ms));
      const pcm = step.gain_db ? gainDb(audio[i]!, step.gain_db) : audio[i]!;
      if (step.barge_in_after_ms !== undefined) {
        // speak while the previous reply is playing: wait for the next agent audio first
        const prev = res.turns[res.turns.length - 1];
        const target = [...phone.turns.values()].find((t) => t.seq === prev?.seq);
        if (target && !target.done) await new Promise((r) => setTimeout(r, step.barge_in_after_ms));
        const bargeStart = Date.now() + phone.queue.length * 20;
        const n = phone.events.length;
        const end = await phone.say(pcm);
        if (target) {
          await phone.waitFor(() => target.interrupted || target.done, 10_000, "interruption").catch(() => {});
          const ev = phone.events.slice(n).find((e) => e.msg.type === "agent.interrupted");
          const tr = res.turns.find((x) => x.seq === target.seq);
          if (tr) { tr.interrupted = target.interrupted; tr.interrupt_received_ms_after_barge_start = ev ? ev.t - bargeStart : null; tr.text = target.text; }
        }
        const r = await phone.waitReply(end - 1);
        save(`after_barge_in_${i + 1}`, r, { reply_latency_ms: r.firstAt! - end, user_said: step.say });
        continue;
      }
      const end = await phone.say(pcm);
      if (step.expect_reply === false) { await new Promise((r) => setTimeout(r, 2500)); continue; }
      const next = o.steps[i + 1];
      if (next?.barge_in_after_ms !== undefined) {
        // the following step interrupts this reply: only wait for its first audio
        let r: Turn | undefined;
        await phone.waitFor(() => { r = [...phone.turns.values()].find((t) => t.firstAt !== null && t.firstAt > end - 1); return !!r; }, 30_000, "reply audio");
        save(`reply${i + 1}`, r!, { reply_latency_ms: r!.firstAt! - end, user_said: step.say });
        continue;
      }
      const r = await phone.waitReply(end - 1);
      save(`reply${i + 1}`, r, { reply_latency_ms: r.firstAt! - end, user_said: step.say });
      if (step.then_another_turn) {
        // "checking…" was said; the answer arrives as a turn of its own, with nothing said in between
        const more = await phone.waitReply(r.firstAt!, 40_000);
        save(`answer${i + 1}`, more, { after_previous_ms: more.firstAt! - r.firstAt! });
      }
    }
    phone.send({ type: "session.end" });
    await phone.waitFor(() => phone.closed, 120_000, "session.closed");
    res.summary = phone.events.find((e) => e.msg.type === "session.summary")?.msg;
    res.ok = true;
  } catch (e) {
    res.error = String((e as Error).message ?? e).slice(0, 300);
  } finally {
    phone.stop();
    try { phone.ws?.close(); } catch { /* ignore */ }
  }
  for (const e of phone.events) {
    if (e.msg.type === "user.transcript" && e.msg.final) res.transcripts.push({ text: e.msg.text, language: e.msg.language });
    if (e.msg.type !== "agent.text") res.events.push({ t: e.t - phone.t0, type: e.msg.type });
    if (e.msg.type === "error") res.error = res.error ?? (e.msg as { message: string }).message;
  }
  return res;
}

async function waitEvent(phone: Phone, type: ServerMessage["type"], ms: number): Promise<ServerMessage> {
  let found: ServerMessage | undefined;
  await phone.waitFor(() => {
    found = phone.events.find((e) => e.msg.type === type)?.msg;
    const err = phone.events.find((e) => e.msg.type === "error" && (e.msg as { fatal: boolean }).fatal)?.msg;
    if (err) throw new Error((err as { message: string }).message);
    return !!found;
  }, ms, type);
  return found!;
}

export const LINES = {
  he: {
    relay: [
      { say: "היי, אני בדרך לעבודה, יש לי פגישה חשובה עם לקוח חדש היום." },
      { say: "אני קצת לחוץ, תן לי טיפ אחד קצר לפגישה." },
      { say: "רגע, רגע, בעצם בוא נדבר על משהו אחר.", barge_in_after_ms: 700 },
    ] as Step[],
  },
  en: {
    relay: [
      { say: "Hey, I'm driving to work, I have an important meeting with a new client today." },
      { say: "I'm a bit stressed, give me one short tip for the meeting." },
      { say: "Wait, wait, actually let's talk about something else.", barge_in_after_ms: 700 },
    ] as Step[],
  },
};
