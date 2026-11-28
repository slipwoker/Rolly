"""Text utilities for speech: incremental sentence chunking and language routing."""
from __future__ import annotations

import re

from memory.context import END_MARKER

_HEB = re.compile(r"[֐-׿]")
_LAT = re.compile(r"[A-Za-z]")
_STRIP = re.compile(r"[*_#`~>|]+|\[(?:[^\]]*)\]\([^)]*\)")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")
# The LLM may *propose* ending the session with the end marker, but small models over-use it,
# so the pipeline only honours it when the user's last words plausibly ask to stop.
END_INTENT = re.compile(
    r"\b(bye|goodbye|good night|that'?s enough|that is enough|let'?s stop|stop (for )?(now|today|here)|enough for (now|today)|"
    r"we('| ha)ve arrived|i('m| am) (here|done)|we'?re (here|done)|see you|talk (to you )?later|end the (conversation|session|call))\b"
    r"|להתראות|ביי|מספיק|נעצור|תעצרי|תעצור|הגעתי|הגענו|נדבר אחר כך|נדבר מחר|סיימנו|נסיים|לילה טוב",
    re.I,
)


def user_wants_to_end(user_text: str | None) -> bool:
    if not user_text:
        return False
    return user_text.lstrip().startswith("[") or bool(END_INTENT.search(user_text))


_HARD = ".!?…\n"
_SOFT = ",;:—–"


def dominant_language(text: str, default: str = "en") -> str:
    h, l = len(_HEB.findall(text)), len(_LAT.findall(text))
    if h == 0 and l == 0:
        return default
    return "he" if h >= l * 0.5 and h > 0 else "en"


_LATIN_WORD = re.compile(r"[A-Za-z\u00c0-\u024f']+")
SHORT_FOREIGN_WORDS = 8


def speech_language(text: str, hint: str | None = None, default: str = "en") -> str:
    """Which voice speaks a piece of a reply.

    Hebrew letters always go to the Hebrew voice: the English voice spells them out ("Hebrew letter alef, Hebrew letter
    zayin...").  That happened on 2026-11-26 with `אז נגיד "Un café, por favor".`, which has more Latin letters than
    Hebrew ones and was sent to the English voice.  A short phrase in Latin letters inside a Hebrew conversation also
    stays with the Hebrew voice (it reads Latin words as words), so the voice does not change in the middle of a reply.
    """
    h, latin = len(_HEB.findall(text)), _LATIN_WORD.findall(text)
    if h:
        return "he"
    if not latin:
        return hint if hint in ("he", "en") else default
    if hint == "he" and len(latin) <= SHORT_FOREIGN_WORDS:
        return "he"
    return "en"


# -- a phrase in another language, spoken with that language's pronunciation -----------------------------------------
# The Hebrew voice (BlueV3) also speaks Spanish, Italian and German in the same voice when a phrase is wrapped in a
# language tag (<es>…</es>).  Unmarked Latin text is read with English pronunciation ("por favor" came out "por
# fay-vor"; measured on the pod, 2026-11-26).  The words below are common, and none of them is an English word.
FOREIGN_LANGS = ("es", "it", "de")
_FOREIGN_WORDS = {
    "es": set("""hola gracias por  buenos buenas días dias tardes noches señor señora cómo como está estás estoy
        dónde donde qué que cuánto cuanto cuesta quiero quisiera tengo tiene tienes puedo puede hablo habla hablas español
        inglés baño cuenta cerveza agua mucho muchas muchos muy bien adiós adios hasta luego mañana perdón perdon disculpe
        siento  eres   usted nosotros llamo llamas nombre para  cuatro cinco también pero porque cuando aquí
        allí ahora hoy amigo amiga bueno buena vamos salud aeropuerto estación habitación comida desayuno calle izquierda
        derecha ayuda necesito gusta encantado igualmente nada  claro vale leche """.split()),
    "it": set("""ciao grazie prego buongiorno buonasera buonanotte arrivederci per favore piacere scusi scusa sta stai sono
        sei dove quanto costa vorrei posso parlo parla italiano inglese bagno conto birra acqua molto bene domani oggi
        adesso perché quando qui anche  lei noi chiamo tavolo  quattro cinque sì allora amico amica buono buona
        andiamo salute aeroporto stazione colazione sinistra destra aiuto bisogno tutto niente certo  gli della delle
        degli che non più mille caffè""".split()),
    "de": set("""hallo danke bitte guten gute morgen abend nacht tschüss auf wiedersehen wie geht ich du bist ist wieviel
        kostet möchte spreche sprechen deutsch englisch toilette rechnung bier wasser sehr schlecht heute jetzt warum wann
        auch aber und nicht ein eine einen das der zwei drei vier fünf ja nein freund prost flughafen bahnhof zimmer
        frühstück rechts hilfe brauche alles nichts heiße entschuldigung vielen dank""".split()),
}
_FOREIGN_CHARS = {"es": "¿¡ñ", "it": "àèìòù", "de": "äöüß"}
_ENGLISH_WORDS = set("""the and is are you your my i to of in on for with this that it good morning hello hi thanks thank
    please what where how do not yes okay ok let go we at be have has was will can new one two three music play list
    playlist focus work day time app phone email call meeting start stop cool nice love like more from by or as an all up
    out about get just so but if when who why coffee water beer bathroom it's i'm don't""".split())
# Latin words with spaces or commas between them, with Spanish opening marks and a closing ? or !
_LATIN_RUN = re.compile(r"[¿¡]?[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'’-]*(?:[ ,]+[¿¡]?[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'’-]*)*[?!.]?")


def foreign_language(phrase: str, hint: str | None = None) -> str | None:
    """The language a phrase in Latin letters should be pronounced in, or None for English / unknown (read as today).

    `hint` is the language the user is practising, when the caller knows it: a phrase of two words or more that is
    not recognisably English then goes to that language.
    """
    words = [w.lower().strip("'’-") for w in _LATIN_WORD.findall(phrase)]
    if not words:
        return None
    english = sum(w in _ENGLISH_WORDS for w in words)
    best, score = None, 0
    for lang in FOREIGN_LANGS:
        n = sum(w in _FOREIGN_WORDS[lang] for w in words) + 2 * sum(ch in phrase for ch in _FOREIGN_CHARS[lang])
        if n > score:
            best, score = lang, n
    if best and score > english:
        return best
    if hint in FOREIGN_LANGS and len(words) >= 2 and english == 0:
        return hint
    return None


def mark_foreign(text: str, hint: str | None = None) -> str:
    """Wrap Spanish, Italian and German phrases in the voice model's language tags; everything else is unchanged."""
    def wrap(m: re.Match) -> str:
        lang = foreign_language(m.group(0), hint)
        return f"<{lang}>{m.group(0)}</{lang}>" if lang else m.group(0)
    return _LATIN_RUN.sub(wrap, text)


_QUESTION_END = re.compile(r"\?[\s\"'”’»)\]]*$")


def ends_with_question(text: str) -> bool:
    """True when a reply ends with a question (ignoring the end marker and the " —" of a cut-off reply)."""
    t = (text or "").replace(END_MARKER, " ").strip().rstrip("—-").strip()
    return bool(_QUESTION_END.search(t))


# Appended to the user's message (never stored in history) when Rolly's previous reply was a question.
# The persona already says "do not end every turn with a question", but a small model loses that rule in a long
# system prompt; a note next to the turn is followed far more reliably (owner's phone tests, 2026-11-25).
QUESTION_GUARD_NOTE = (
    "[Note for this turn only, not said by the user: your previous reply ended with a question. "
    "This time do not ask anything. React briefly, then say something of your own: an opinion, an idea, "
    "something interesting, or pick one concrete topic and start talking about it. "
    "End with a statement, not a question.]")


def question_guard_note(history: list[dict]) -> str | None:
    """The note to add to this turn when the last thing Rolly said was a question, else None."""
    last = next((m for m in reversed(history) if m.get("role") == "assistant"), None)
    return QUESTION_GUARD_NOTE if last and ends_with_question(last.get("content", "")) else None


class TurnNotes:
    """Notes from the caller (the app that owns the conversation) for the model's next turns: pacing of the ride
    ("three minutes left, start wrapping up"), memory hints.  Like the question guard they are appended to the user's
    message for a turn and never stored in history; unlike it they come from outside and live for a set number of
    turns.  They never start a turn and never interrupt one.

    A note can be CONDITIONAL: `max_user_words` (with `min_streak`) shows it only on a turn where the user said at most
    that many words, for at least that many turns in a row, i.e. when the conversation has run dry.  The condition is
    checked here because only this side knows what the user said before the reply is generated; the small model obeys
    a note as a command, so "if they give you little, bring up X" in the text itself made it bring up X in answer to
    a real question (measured, 2026-11-26).  A conditional note waits, unconsumed, until its turn comes or it expires."""

    MAX_CHARS = 600
    MAX_TURNS = 6
    MAX_NOTES = 4
    MAX_WAIT = 14  # replies a conditional note may wait before it is dropped

    def __init__(self) -> None:
        self._notes: list[dict] = []
        self._dry_streak = 0  # consecutive user turns of at most DRY_WORDS words, before the current one
        self._shown: list[dict] = []

    DRY_WORDS = 2

    def add(self, text: str, turns: int = 1, max_user_words: int | None = None, min_streak: int = 1) -> None:
        text = " ".join(str(text or "").split())[: self.MAX_CHARS]
        if not text:
            return
        turns = max(1, min(self.MAX_TURNS, int(turns or 1)))
        self._notes = [n for n in self._notes if n["text"] != text]  # the same note again just renews it
        self._notes.append({"text": text, "turns": turns, "waited": 0,
                            "max_user_words": None if max_user_words is None else max(0, int(max_user_words)),
                            "min_streak": max(1, int(min_streak or 1))})
        self._notes = self._notes[-self.MAX_NOTES:]

    @staticmethod
    def _words(user_text: str | None) -> int:
        return len((user_text or "").split())

    def _applies(self, n: dict, user_text: str | None) -> bool:
        if n["max_user_words"] is None:
            return True
        if user_text is None or user_text.lstrip().startswith("["):  # an event prompt (the opener), not something the user said
            return False
        if "?" in user_text or "؟" in user_text:  # a question is for answering: no topic of ours on that turn (2026-11-26)
            return False
        words = self._words(user_text)
        if words > n["max_user_words"]:
            return False
        streak = (self._dry_streak if words <= self.DRY_WORDS else 0) + 1
        return streak >= n["min_streak"]

    def text(self, user_text: str | None = None) -> str | None:
        """What to append to this turn's user message, or None.  Remembers which notes were shown (for `consume`)."""
        self._shown = [n for n in self._notes if self._applies(n, user_text)]
        if not self._shown:
            return None
        return "\n".join(f"[Note for this turn, not said by the user: {n['text']}]" for n in self._shown)

    def consume(self, user_text: str | None = None) -> None:
        """One reply was given.  Notes that were in view lose a turn; conditional notes that were not keep waiting."""
        shown = {id(n) for n in self._shown}
        for n in self._notes:
            if id(n) in shown:
                n["turns"] -= 1
            elif n["max_user_words"] is not None:
                n["waited"] += 1
        self._notes = [n for n in self._notes if n["turns"] > 0 and n["waited"] < self.MAX_WAIT]
        self._shown = []
        if user_text is not None and not user_text.lstrip().startswith("["):
            self._dry_streak = self._dry_streak + 1 if self._words(user_text) <= self.DRY_WORDS else 0

    def __len__(self) -> int:
        return len(self._notes)


# Hebrew words the voice front end reads wrongly.  Applied only to the text sent to a Hebrew voice (history and transcripts
# keep the plain spelling).  Value: the spelling to speak instead.  Brand words only: זאפי (the owner's company) is read
# "zaffy" because an unmarked פ in the middle is read as f; in Latin letters the Hebrew voice says it right (listening samples,
# 2026-11-26).  A user's NAME is not handled here but per conversation (pronounce.py): the same front end reads some names
# differently depending on their place in the sentence, and a table of names cannot cover them.
HE_PRONUNCIATION: dict[str, str] = {
    "זאפי": "Zappy",
}
# how a prefix letter before a pinned word is said
_PREFIX_PHONEMES = {"": "", "ו": "ve", "ה": "ha", "ב": "be", "ל": "le", "מ": "mi", "ש": "ʃe", "כ": "ke"}
_HE_LETTER = "א-ת"


def _he_pattern(word: str) -> re.Pattern:
    # optional one- or two-letter prefixes (ו, ה, ב, ל, מ, ש, כ: "בזאפי", "ושזאפי"); not inside a longer word
    return re.compile(rf"(?<![{_HE_LETTER}])([והבלמשכ]{{0,2}}){re.escape(word)}(?![{_HE_LETTER}])")


_HE_PATTERNS = [(_he_pattern(w), v) for w, v in HE_PRONUNCIATION.items()]


def he_pronounce(text: str, phonemes: dict[str, str] | None = None) -> str:
    """Replace words from HE_PRONUNCIATION with their reading, keeping any prefix letters.  `phonemes` ({word: phonemes}, the
    names pinned for this conversation) is for a voice that takes inline `<he>…</he>` phoneme spans: those words are given as
    phonemes, which that voice passes on unchanged."""
    for word, ph in (phonemes or {}).items():
        def sub(m, ph=ph):
            pre = m.group(1)
            if not all(c in _PREFIX_PHONEMES for c in pre):
                return m.group(0)
            return "<he>" + "".join(_PREFIX_PHONEMES[c] for c in pre) + ph + "</he>"
        text = _he_pattern(word).sub(sub, text)
    for pat, v in _HE_PATTERNS:
        # a Hebrew prefix letter before a word written in Latin letters takes a hyphen, as in written Hebrew ("ב-Zappy")
        joiner = "-" if v[:1].isascii() and v[:1].isalpha() else ""
        text = pat.sub(lambda m, v=v, joiner=joiner: (m.group(1) + joiner if m.group(1) else "") + v, text)
    return text


# Appended by the model when it needs to check something online.  The caller (rolly-api) does the search; here the
# marker is only kept out of what is spoken and shown, and reported after the turn (pipeline.py).
LOOKUP_MARKER = "<lookup/>"
MARKERS = (END_MARKER, LOOKUP_MARKER)
_WORDY = re.compile(r"[0-9A-Za-z\u00c0-\u024f\u0590-\u05ff]")


def has_words(text: str) -> bool:
    """False for a piece with nothing to say ("—", "...").  The main Hebrew voice answers such input with an error,
    and its backup then spoke a fraction of a second in another voice (seen as 0.2 s at the backup's sample rate)."""
    return bool(_WORDY.search(text or ""))


class MarkerFilter:
    """Keeps markers out of the text shown while a reply streams.

    A marker arrives in several pieces ("<", "lookup", "/>"), so removing it from each piece does not work: the
    pieces from a "<" are held back until the tag is complete (then dropped if it is a marker) or clearly not a tag.
    """

    def __init__(self) -> None:
        self._held = ""

    def feed(self, delta: str) -> str:
        buf = self._held + delta
        out, self._held = "", ""
        while buf:
            lt = buf.find("<")
            if lt < 0:
                out += buf
                break
            out += buf[:lt]
            buf = buf[lt:]
            gt = buf.find(">")
            if gt < 0:
                if len(buf) > 20 or not any(m.startswith(buf) for m in MARKERS):
                    out += buf  # not the beginning of a marker after all
                else:
                    self._held = buf
                break
            tag, buf = buf[:gt + 1], buf[gt + 1:]
            if tag not in MARKERS:
                out += tag
        return out

    def flush(self) -> str:
        out, self._held = self._held, ""
        return out


def clean_for_speech(text: str) -> str:
    text = text.replace(END_MARKER, " ").replace(LOOKUP_MARKER, " ")
    text = _STRIP.sub(" ", text)
    text = _EMOJI.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


class SentenceChunker:
    """Splits a token stream into speakable chunks.

    The first chunk is released early (at a clause boundary) because time-to-first-audio
    is what the user perceives as latency; later chunks are whole sentences, which gives
    the TTS better prosody.
    """

    def __init__(self, first_min_chars: int = 24, min_chars: int = 40, max_chars: int = 220, merge_chars: int = 0):
        self.first_min = first_min_chars
        self.min = min_chars
        self.max = max_chars
        # After the first piece, short sentences are kept together until the piece has this many characters, so they are
        # spoken in one synthesis with the voice's own natural pause between them (0 = every sentence is a piece, as before).
        self.merge = merge_chars
        self._buf = ""
        self._emitted = 0

    def feed(self, delta: str) -> list[str]:
        self._buf += delta
        out: list[str] = []
        while True:
            cut = self._find_cut()
            if cut < 0:
                break
            chunk, self._buf = self._buf[:cut], self._buf[cut:]
            chunk = clean_for_speech(chunk)
            if chunk:
                out.append(chunk)
                self._emitted += 1
        return out

    def _find_cut(self) -> int:
        buf = self._buf
        # never cut in the middle of a possible end marker / tag
        lt = buf.rfind("<")
        limit = len(buf) if lt < 0 or ">" in buf[lt:] else lt
        need = self.first_min if self._emitted == 0 else self.min
        for i in range(limit):
            ch = buf[i]
            floor = min(need, 12) if self._emitted == 0 else max(min(need, 12), self.merge)
            if ch in _HARD and i + 1 >= floor:
                # require following whitespace/end so "3.5" or "e.g." are not split mid-token
                if i + 1 < len(buf):
                    if buf[i + 1] in " \n\"'”)":
                        return i + 1
                    if ch == "\n":
                        return i + 1
                continue
            if ch in _SOFT and i + 1 >= need and self._emitted == 0 and i + 1 < len(buf) and buf[i + 1] == " ":
                return i + 1
        if limit >= self.max:
            sp = buf.rfind(" ", 0, self.max)
            return sp + 1 if sp > 0 else self.max
        return -1

    def flush(self) -> list[str]:
        chunk = clean_for_speech(self._buf)
        self._buf = ""
        return [chunk] if chunk else []



# -- telling the agent's own voice and stray sounds from a real interruption ----------------------
# Words that always count as an interruption, however short or unclear the recognition was.
STOP_WORDS = {"רגע", "עצור", "עצרי", "די", "שנייה", "שניה", "חכה", "חכי", "סטופ", "שקט", "stop", "wait", "hold", "pause", "enough", "quiet"}
_WORD = re.compile(r"[\w\u0590-\u05ff']+")
_NIQQUD = re.compile(r"[\u0591-\u05c7]")


def _tokens(text: str) -> list[str]:
    return _WORD.findall(_NIQQUD.sub("", (text or "").replace("\u2019", "'").replace("\u05f3", "'")).lower())


def has_stop_word(text: str) -> bool:
    return any(t in STOP_WORDS for t in _tokens(text))


def echo_like(heard: str, agent_text: str) -> bool:
    """True if `heard` is (mostly) made of words the agent was just saying.

    Used only for sound that started while the agent was audible: without headphones the microphone
    picks up the loudspeaker, and what comes back is recognised as "user speech"."""
    import difflib

    h, a = _tokens(heard), _tokens(agent_text)
    if not h or not a or (len(h) == 1 and h[0] in STOP_WORDS):
        return False
    def same(w: str, x: str) -> bool:
        if w == x:
            return True
        if len(w) < 3:
            return False
        # an echo that was cut short gives the beginning of a word ("more" for "morning")
        return x.startswith(w[:3]) and (x.startswith(w) or w.startswith(x) or difflib.SequenceMatcher(None, w, x).ratio() >= 0.5) \
            or difflib.SequenceMatcher(None, w, x).ratio() >= 0.8

    hits = sum(1 for w in h if any(same(w, x) for x in a))
    return hits / len(h) >= 0.7


# A reply cut off by something that was not the user (a cough, a phone vibrating) is said again from where it was cut, not from the
# start of the chunk: a chunk is a whole sentence, so saying it again meant the user heard the same sentence twice (seen on the opener
# on 2026-11-28 and on a tool answer when a push notification buzzed).
RESUME_HEARD_FRACTION = 0.75  # this much of the cut chunk heard: count it as said
RESUME_NEARLY_FRACTION = 0.5  # ... or this much, when what is left is under RESUME_LEFT_S
RESUME_LEFT_S = 0.7
RESUME_FROM_START = 0.3       # less than this heard: the whole chunk again; more: only its tail


def tail_from(text: str, heard: float) -> str:
    """The part of `text` still to say when the first `heard` (0..1) of it was said: from the word being said at the cut, one word
    earlier so the join is natural. Short texts are said whole."""
    words = text.split()
    if len(words) < 4:
        return text
    target, pos, cut = heard * len(text), 0, len(words) - 1
    for i, w in enumerate(words):
        end = pos + len(w)
        if end >= target:
            cut = i
            break
        pos = end + 1
    return " ".join(words[max(0, cut - 1):])


def chunks_left(every: list[str], synthesized: list[tuple[str, float]], played_s: float) -> list[str]:
    """The chunks of a reply still to say after `played_s` seconds of playback. `synthesized` = (text, seconds of audio) of the chunks
    whose audio exists, in order; `every` = all chunks of the reply. A fully played chunk is done; the chunk playing when the reply was
    cut is done too if nearly all of it was heard, is said from where it was cut if about half was heard, and said whole if hardly any
    was; later chunks are not done."""
    done, acc = 0, 0.0
    for _text, dur in synthesized:
        end = acc + dur
        if end <= played_s:
            done += 1
        else:
            heard = (played_s - acc) / dur if dur > 0 else 1.0
            if heard >= RESUME_HEARD_FRACTION or (heard >= RESUME_NEARLY_FRACTION and end - played_s <= RESUME_LEFT_S):
                done += 1
            elif heard >= RESUME_FROM_START and done < len(every):
                return [tail_from(every[done], heard)] + every[done + 1:]
            break
        acc = end
    return every[done:]
