/**
 * Memory protection policy (one primary user, other voices possible, no speaker identification).
 *
 * A statement about the user becomes an ACTIVE memory only when it is reliably the user's:
 *   - the user confirmed it (answered "yes" when ROLLY asked, or set it in the app), or
 *   - it is a correction the user made, or
 *   - all of: stated in clear first person, confidence >= ACTIVE_MIN_CONFIDENCE, the quote is found in a user turn,
 *     that turn has no hint of another speaker ("primary"), and nothing in the session suggests other speakers
 *     (a one-to-one context).
 * Otherwise it is stored as a CANDIDATE: not presented to the model as a fact, expires after the TTL, and ROLLY may ask
 * to confirm it. Nothing here identifies a speaker; acoustic hints can only make attribution MORE uncertain.
 */
import type { SessionTurn } from "../voice/session.ts";
import type { Item } from "./summarizer.ts";

export const ACTIVE_MIN_CONFIDENCE = 0.75;

export type Decision = { status: "active" | "candidate"; reason: string; turn: number | null; attribution: "primary" | "uncertain" | "not_found" };

const norm = (s: string) => s.toLowerCase().replace(/[֑-ׇ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** The user turn an item comes from: the turn whose text contains the quote (the turn number alone is not trusted). */
export function sourceTurn(item: Pick<Item, "quote" | "turn">, turns: SessionTurn[]): SessionTurn | null {
  const users = turns.filter((t) => t.role === "user");
  const q = norm(item.quote ?? "");
  if (q.length >= 2) {
    const byIdx = users.find((t) => t.idx === item.turn && norm(t.text).includes(q));
    if (byIdx) return byIdx;
    const any = users.find((t) => norm(t.text).includes(q));
    if (any) return any;
    return null;
  }
  return null;
}

export function decide(item: Item, turns: SessionTurn[], session: { otherSpeakersSuspected: boolean }): Decision {
  const src = sourceTurn(item, turns);
  if (!src) return { status: "candidate", reason: "quote_not_found_in_user_turns", turn: item.turn, attribution: "not_found" };
  if (src.attribution === "uncertain") return { status: "candidate", reason: "uncertain_speaker", turn: src.idx, attribution: "uncertain" };
  // Rolly said it back and the owner agreed: their own yes, in a turn with no hint of another speaker, in reply to an AGENT turn
  if (item.confirmed && turns.find((t) => t.idx === src.idx - 1)?.role === "agent") return { status: "active", reason: "user_confirmed_phrasing", turn: src.idx, attribution: "primary" };
  if (session.otherSpeakersSuspected) return { status: "candidate", reason: "other_speakers_suspected", turn: src.idx, attribution: "primary" };
  if (!item.first_person) return { status: "candidate", reason: "not_first_person", turn: src.idx, attribution: "primary" };
  if (item.confidence < ACTIVE_MIN_CONFIDENCE) return { status: "candidate", reason: "low_confidence", turn: src.idx, attribution: "primary" };
  return { status: "active", reason: "first_person_one_to_one", turn: src.idx, attribution: "primary" };
}

/** A confirmation, correction or deletion counts only if it is in a user turn without hints of another speaker. */
export function userActionAccepted(turnIdx: number | null, quote: string, turns: SessionTurn[]): { ok: boolean; reason: string } {
  const src = sourceTurn({ quote, turn: turnIdx }, turns) ?? turns.find((t) => t.role === "user" && t.idx === turnIdx) ?? null;
  if (!src || src.role !== "user") return { ok: false, reason: "turn_not_found" };
  if (src.attribution === "uncertain") return { ok: false, reason: "uncertain_speaker" };
  return { ok: true, reason: "primary_turn" };
}

/** Session-level "other speakers" flag: the summariser's judgement OR any user turn flagged uncertain by hints. */
export function otherSpeakersSuspected(summarizerFlag: boolean, turns: SessionTurn[]): boolean {
  return summarizerFlag || turns.some((t) => t.role === "user" && t.attribution === "uncertain");
}
