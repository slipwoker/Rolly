/**
 * Deterministic checks on a conversation transcript.
 *
 * Severity:
 *  - "hard": a clear-cut violation of a product boundary (format, end marker, assistant voice, wrong grammatical
 *    gender, a forgotten memory brought back). A hard failure means the scenario failed.
 *  - "signal": a heuristic indicator of a quality problem (interviewing, menus, formulaic empathy, formal register).
 *    Reported and compared across runs, never treated as proof on its own: read the transcript.
 *
 * Checks measure behaviour, not prompt wording. Do not add a check that only asserts a phrase is present in the prompt.
 */
import { END_MARKER } from "../src/persona/research.ts";
import type { AddressingValue } from "../src/persona/phase1Sections.ts";
import { observe } from "../src/memory/addressing.ts";
import { endsWithQuestion } from "./assemble.ts";

export type Severity = "hard" | "signal";

export interface AgentTurn {
  /** 0 = the proactive opener */
  idx: number;
  text: string;
  /** what the user said before this reply (null for the opener) */
  userSaid: string | null;
  guardApplied: boolean;
  /** the reply was cut by a simulated barge-in on the next step */
  interrupted?: boolean;
}

export interface CheckResult { id: string; severity: Severity; pass: boolean; detail?: string; turns?: number[] }

/** Which agent turns a scenario check applies to. */
export type TurnSel = "opener" | "all" | "any" | { from: number } | number[];

export type CheckSpec =
  | { kind: "expect_any"; id: string; turns: TurnSel; keywords: string[]; severity?: Severity }
  | { kind: "expect_none"; id: string; turns: TurnSel; keywords: string[]; severity?: Severity }
  | { kind: "max_question_turns"; id: string; turns: TurnSel; max: number; severity?: Severity }
  | { kind: "expect_end_marker"; id: string; turn: number }
  | { kind: "statement_not_question"; id: string; turns: TurnSel; severity?: Severity };

// ------------------------------------------------------------------ text helpers
const HEB_LETTER = /[א-ת]/;
const NIQQUD = /[֑-ׇ]/g;

export function words(text: string): string[] {
  return text.split(END_MARKER).join(" ").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** lower-cased word tokens without punctuation or niqqud */
export function tokens(text: string): string[] {
  return (text.replace(NIQQUD, "").toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
}

/** the token, and without a leading conjunction ו ("ולך", "ובוא"); other prefixes are not stripped (הלך, מלך are not לך) */
function heBase(tok: string): string[] {
  return tok.length > 2 && tok.startsWith("ו") ? [tok, tok.slice(1)] : [tok];
}

export function dominantLanguage(text: string): "he" | "en" | "none" {
  const h = (text.match(/[א-ת]/g) ?? []).length;
  const l = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!h && !l) return "none";
  return h > 0 && h >= l * 0.5 ? "he" : "en";
}

function contains(text: string, kw: string): boolean {
  return text.replace(NIQQUD, "").toLowerCase().includes(kw.toLowerCase());
}

function select(turns: AgentTurn[], sel: TurnSel): AgentTurn[] {
  if (sel === "opener") return turns.filter((t) => t.idx === 0);
  if (sel === "all" || sel === "any") return turns;
  if (Array.isArray(sel)) return turns.filter((t) => sel.includes(t.idx));
  return turns.filter((t) => t.idx >= sel.from);
}

// ------------------------------------------------------------------ lexicons
/** Second-person words whose spoken form carries gender even when the spelling looks neutral (see NEUTRAL_HEBREW). */
const GENDERED_2P_SPOKEN = ["לך", "שלך", "אותך", "עליך", "איתך", "אתך", "בשבילך", "ממך", "אליך", "אלייך", "בך", "שלומך",
  // 2nd-person past tense: one spelling, two pronunciations (asita / asit)
  "עשית", "היית", "אמרת", "חשבת", "רצית", "הספקת", "שמעת", "ראית", "סיפרת", "החלטת", "ניסית", "דיברת", "הלכת", "יצאת", "הגעת", "ישנת", "אכלת"];
/** unambiguously masculine second person */
const MASC_2P = ["אתה", "בוא"];
/** unambiguously feminine second person (imperative / future 2fs end in -י; 3fs has no -י) */
const FEM_2P = ["בואי", "תגידי", "תעשי", "תחשבי", "תנסי", "תספרי", "תבחרי", "תקשיבי", "תשמעי", "תדמייני", "תרצי", "תזכרי", "תחליטי", "תבדקי"];
/** future 2ms forms; identical in writing to 3fs ("היא תגיד"), so only a signal */
const MASC_2P_AMBIGUOUS = ["תגיד", "תחשוב", "תנסה", "תספר", "תבחר", "תקשיב", "תשמע", "תדמיין", "תרצה", "תזכור", "תחליט", "תבדוק"];
/** formal / written register the persona asks to avoid in spoken Hebrew */
const FORMAL_HE = ["האם", "כיצד", "ניתן", "ברצונך", "אשמח", "בנוגע", "הנך", "עלייך", "מעוניין", "מעוניינת"];
/** formulaic empathy / validation / service phrases */
const FORMULAIC = [
  "אני מבין", "אני מבינה", "מבין אותך", "מבינה אותך", "אני שומע אותך", "אני שומעת אותך", "זה בהחלט מובן", "זה מובן לגמרי", "זה לגיטימי לגמרי",
  "שאלה מצוינת", "שאלה מעולה", "שאלה טובה", "i understand", "i hear you", "great question", "that's totally valid", "that is completely understandable",
  "totally understandable", "i'm sorry to hear", "צר לי לשמוע",
];
/** an assistant / customer-service voice */
const ASSISTANT_VOICE = [
  "איך אוכל לעזור", "במה אוכל לעזור", "אני כאן כדי לעזור", "אשמח לעזור", "כמודל שפה", "כבינה מלאכותית", "as an ai", "as a language model",
  "how can i help", "how can i assist", "i'm here to help", "happy to help", "is there anything else",
];

// ------------------------------------------------------------------ default checks (every scenario)
export interface DefaultCheckContext {
  language: "he" | "en" | "auto";
  /** addressing known to the model at each agent turn (index = agent turn idx) */
  addressingAt: (idx: number) => AddressingValue | null;
  /** agent turn idx after which the end marker is expected (the user asked to stop), if any */
  endExpectedAt?: number;
}

export function defaultChecks(turns: AgentTurn[], ctx: DefaultCheckContext): CheckResult[] {
  const out: CheckResult[] = [];
  const bad = (pred: (t: AgentTurn) => boolean) => turns.filter(pred).map((t) => t.idx);

  // format: everything is spoken
  const fmt = bad((t) => /(^|\n)\s*([-*•]|\d+[.)])\s/.test(t.text) || /[*#`]|\p{Extended_Pictographic}/u.test(t.text));
  out.push({ id: "format_spoken", severity: "hard", pass: !fmt.length, turns: fmt, detail: fmt.length ? "markdown, list or emoji in a spoken reply" : undefined });

  // end marker only when the user asked to stop
  const marker = bad((t) => t.text.includes(END_MARKER) && t.idx !== ctx.endExpectedAt);
  out.push({ id: "end_marker_only_on_request", severity: "hard", pass: !marker.length, turns: marker });

  // voice-length: hard ceiling well above the persona's ~25 words (cut-offs and monologues), signal above 30
  const long = bad((t) => !t.interrupted && words(t.text).length > 45);
  out.push({ id: "length_hard_ceiling_45w", severity: "hard", pass: !long.length, turns: long });
  const longish = bad((t) => !t.interrupted && words(t.text).length > 30);
  out.push({ id: "length_over_30w", severity: "signal", pass: !longish.length, turns: longish });

  const asst = bad((t) => ASSISTANT_VOICE.some((p) => contains(t.text, p)));
  out.push({ id: "no_assistant_voice", severity: "hard", pass: !asst.length, turns: asst });

  // language of the session
  if (ctx.language !== "auto") {
    const wrong = bad((t) => { const d = dominantLanguage(t.text); return d !== "none" && d !== ctx.language; });
    out.push({ id: "session_language", severity: "hard", pass: !wrong.length, turns: wrong });
  }

  // interviewing: two agent turns in a row that both end with a question
  const pairs: number[] = [];
  for (let i = 1; i < turns.length; i++) if (endsWithQuestion(turns[i - 1]!.text) && endsWithQuestion(turns[i]!.text)) pairs.push(turns[i]!.idx);
  out.push({ id: "no_consecutive_questions", severity: "signal", pass: !pairs.length, turns: pairs });

  // menus: a question offering alternatives
  const menu = bad((t) => t.text.split(/(?<=[?.!])\s+/).some((s) => s.trim().endsWith("?") && (/\sאו\s/.test(s) || /\sor\s/i.test(s))));
  out.push({ id: "no_menu_offer", severity: "signal", pass: !menu.length, turns: menu });

  const formulaic = bad((t) => FORMULAIC.some((p) => contains(t.text, p)));
  out.push({ id: "no_formulaic_empathy", severity: "signal", pass: !formulaic.length, turns: formulaic });

  // the same opening word on three or more replies ("וואלה...", "Oh...")
  const firsts = new Map<string, number[]>();
  for (const t of turns) { const f = tokens(t.text)[0]; if (f) firsts.set(f, [...(firsts.get(f) ?? []), t.idx]); }
  const rep = [...firsts.entries()].filter(([, v]) => v.length >= 3);
  out.push({ id: "varied_openings", severity: "signal", pass: !rep.length, detail: rep.map(([k, v]) => `"${k}" x${v.length}`).join(", ") || undefined,
    turns: rep.flatMap(([, v]) => v) });

  if (ctx.language === "he") {
    const formal = bad((t) => tokens(t.text).some((w) => FORMAL_HE.includes(w)));
    out.push({ id: "spoken_register_he", severity: "signal", pass: !formal.length, turns: formal });

    // grammatical addressing: unambiguous forms are hard failures, forms that are also 3rd person feminine only a signal
    const hard: string[] = [];
    const soft: string[] = [];
    for (const t of turns) {
      const a = ctx.addressingAt(t.idx);
      const lexHard = a === null ? [...GENDERED_2P_SPOKEN, ...MASC_2P, ...FEM_2P] : a === "feminine" ? MASC_2P : a === "masculine" ? FEM_2P : [];
      const lexSoft = a === "masculine" || a === "plural" ? [] : MASC_2P_AMBIGUOUS;
      const toks = tokens(t.text).filter((w) => HEB_LETTER.test(w));
      const h = toks.find((w) => heBase(w).some((b) => lexHard.includes(b)));
      const s2 = toks.find((w) => heBase(w).some((b) => lexSoft.includes(b)));
      if (h) hard.push(`${t.idx}:${h}`);
      if (s2) soft.push(`${t.idx}:${s2}`);
    }
    const idxs = (xs: string[]) => xs.map((x) => Number(x.split(":")[0]));
    out.push({ id: "addressing_form", severity: "hard", pass: !hard.length, turns: idxs(hard), detail: hard.join(", ") || undefined });
    out.push({ id: "addressing_form_ambiguous", severity: "signal", pass: !soft.length, turns: idxs(soft), detail: soft.join(", ") || undefined });
  }
  return out;
}

// ------------------------------------------------------------------ scenario-specific checks
export function scenarioChecks(turns: AgentTurn[], specs: CheckSpec[]): CheckResult[] {
  return specs.map((s): CheckResult => {
    if (s.kind === "expect_end_marker") {
      const t = turns.find((x) => x.idx === s.turn);
      return { id: s.id, severity: "hard", pass: !!t && t.text.includes(END_MARKER), turns: [s.turn] };
    }
    const sel = select(turns, s.turns);
    const sev = s.severity ?? "signal";
    if (s.kind === "expect_any") {
      const hits = sel.filter((t) => s.keywords.some((k) => contains(t.text, k)));
      const pass = s.turns === "all" ? hits.length === sel.length : hits.length > 0;
      return { id: s.id, severity: sev, pass: sel.length > 0 && pass, turns: hits.map((t) => t.idx) };
    }
    if (s.kind === "expect_none") {
      const hits = sel.filter((t) => s.keywords.some((k) => contains(t.text, k)));
      return { id: s.id, severity: sev, pass: !hits.length, turns: hits.map((t) => t.idx),
        detail: hits.length ? s.keywords.filter((k) => hits.some((t) => contains(t.text, k))).join(", ") : undefined };
    }
    if (s.kind === "max_question_turns") {
      const q = sel.filter((t) => t.text.includes("?"));
      return { id: s.id, severity: sev, pass: q.length <= s.max, turns: q.map((t) => t.idx), detail: `${q.length} question turns (max ${s.max})` };
    }
    // statement_not_question
    const q = sel.filter((t) => endsWithQuestion(t.text));
    return { id: s.id, severity: sev, pass: !q.length, turns: q.map((t) => t.idx) };
  });
}

// ------------------------------------------------------------------ metrics
export function metrics(turns: AgentTurn[]) {
  const replies = turns.filter((t) => !t.interrupted);
  const wc = replies.map((t) => words(t.text).length);
  let consecutive = 0;
  for (let i = 1; i < turns.length; i++) if (endsWithQuestion(turns[i - 1]!.text) && endsWithQuestion(turns[i]!.text)) consecutive++;
  const responses = turns.filter((t) => t.idx > 0);
  return {
    agent_turns: turns.length,
    question_ending_rate: turns.length ? +(turns.filter((t) => endsWithQuestion(t.text)).length / turns.length).toFixed(3) : 0,
    contains_question_rate: turns.length ? +(turns.filter((t) => t.text.includes("?")).length / turns.length).toFixed(3) : 0,
    consecutive_question_pairs: consecutive,
    mean_words: wc.length ? +(wc.reduce((a, b) => a + b, 0) / wc.length).toFixed(1) : 0,
    max_words: wc.length ? Math.max(...wc) : 0,
    guard_applied_turns: responses.filter((t) => t.guardApplied).length,
    /** ROLLY's grammatical gender when it talks about itself ("אני חושב" / "אני חושבת"); the persona does not define it */
    rolly_self_gender: selfGender(turns),
  };
}

function selfGender(turns: AgentTurn[]): { masculine: number; feminine: number } {
  const c = { masculine: 0, feminine: 0 };
  for (const t of turns) for (const o of observe(t.text)) if (o.kind !== "explicit" && o.form !== "plural") c[o.form]++;
  return c;
}

/** first word of each reply (opener excluded), for suite-level repetition */
export function openingWord(t: AgentTurn): string | null { return t.idx > 0 ? tokens(t.text)[0] ?? null : null; }
