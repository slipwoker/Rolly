import os
import time

from memory.context import END_MARKER, build_context, seed_store
from memory.store import MemoryStore
from memory.summarizer import _extract_json, fallback_summary, persist_summary
from providers.modular.text import (LOOKUP_MARKER, MarkerFilter, SentenceChunker, clean_for_speech, dominant_language,
                                    foreign_language, has_words, he_pronounce, mark_foreign, speech_language, user_wants_to_end)


def test_chunker_releases_first_clause_early_and_whole_sentences_after():
    c = SentenceChunker()
    out = []
    for tok in "Good morning Daniel, you have about thirty minutes. Yesterday we discussed the go to market choice. Want to continue?".split(" "):
        out += c.feed(tok + " ")
    out += c.flush()
    assert out[0] == "Good morning Daniel, you have about thirty minutes."[: len(out[0])]
    assert len(out[0]) <= 52  # first chunk is short so audio starts early
    assert "".join(out).replace(" ", "") == "GoodmorningDaniel,youhaveaboutthirtyminutes.Yesterdaywediscussedthegotomarketchoice.Wanttocontinue?"


def test_chunker_never_speaks_the_end_marker_and_does_not_split_decimals():
    c = SentenceChunker()
    out = c.feed("It costs 3.5 dollars in total, which is fine. Bye for now. " + END_MARKER) + c.flush()
    assert all(END_MARKER not in x and "<" not in x for x in out)
    assert any("3.5 dollars" in x for x in out)


def test_clean_for_speech_strips_markdown_and_emoji():
    assert clean_for_speech("**Great** idea 🙂 — see [this](http://x.y)") == "Great idea — see"


def test_language_routing():
    assert dominant_language("בוקר טוב נועה") == "he"
    assert dominant_language("Good morning") == "en"
    assert dominant_language("נמשיך עם ה-payments module?") == "he"
    assert dominant_language("123", default="he") == "he"


def test_end_intent_guard():
    assert user_wants_to_end("Okay, that's enough for today, thanks, bye.")
    assert user_wants_to_end("טוב, זה מספיק להיום, להתראות")
    assert user_wants_to_end("[arrival_soon event] ...")
    assert not user_wants_to_end("Yes, let's continue with that.")
    assert not user_wants_to_end("כן, בואי נמשיך")


def test_context_contains_profile_memory_and_proactive_opener(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite3")
    assert seed_store(store) == 2
    ctx = build_context(store, "noa", None, {"duration_min": 25})
    sp = ctx["system_prompt"]
    assert ctx["language"] == "he" and "Hebrew" in sp
    assert "payments module" in sp and "board meeting" in sp and "about 25 minutes" in sp
    assert "Yoav" in sp  # open action item
    assert ctx["opener_instruction"] and "journey_start" in ctx["opener_instruction"]
    assert build_context(store, "noa", None, {"duration_min": 25, "proactive": False})["opener_instruction"] is None


def test_summary_persistence_feeds_the_next_session_and_erasure_works(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite3")
    seed_store(store)
    summary = {"summary": "Daniel decided to sell through home-care agencies first.", "decisions": ["agencies first"],
               "action_items": ["Email three agencies by Friday"], "unresolved_topics": ["Pricing model for agencies"],
               "resolved_topics": ["Go-to-market choice for the fall-detection idea: direct to families versus through home-care agencies"],
               "new_user_facts": ["Daniel's sister works at a home-care agency"], "method": "llm"}
    store.create_session("s1", "daniel", "mock", "Agent A", "en", {}, {})
    persist_summary(store, "daniel", "s1", summary)
    sp = build_context(store, "daniel", None, {"duration_min": 30})["system_prompt"]
    assert "sell through home-care agencies first" in sp
    assert "Pricing model for agencies" in sp and "Email three agencies by Friday" in sp
    assert "direct to families versus through home-care agencies" not in sp.split("Unresolved topics:")[1].split("Open action items")[0]
    assert "sister works at a home-care agency" in sp
    store.delete_user_data("daniel")
    assert store.get_user("daniel") is None and store.get_memories("daniel") == [] and store.get_session("s1") is None


def test_retention_purge_removes_old_transcripts(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite3")
    store.create_session("old", "u", "mock", "A", "en", {}, {})
    store.add_turn("old", 0, "user", "hello")
    store._exec("UPDATE sessions SET started_at=? WHERE session_id='old'", (time.time() - 40 * 86400,))
    assert store.purge_older_than(30)["sessions_purged"] == 1
    assert store.get_turns("old") == []


def test_summariser_helpers():
    assert _extract_json('<think>x</think> here {"summary": "ok", "topics": []} tail')["summary"] == "ok"
    assert fallback_summary([])["method"] == "fallback_no_llm"


def test_cost_model_arithmetic_matches_the_brief():
    from finops.cost_model import build, demand, load

    p = load()
    d = demand(p, 10000)
    assert d["minutes_per_day"] == 300_000 and d["minutes_per_month"] == 9_000_000 and d["hours_per_day"] == 5000
    o = build(p)
    targets = {t["usd_per_min"]: t["monthly_usd"] for t in o["target_table_10k_dau"]}
    assert targets == {0.05: 450_000, 0.01: 90_000, 0.005: 45_000, 0.001: 9_000}
    # a fleet sized for the commute peak is badly utilised; autoscaling must be cheaper per minute
    m = {x["arch"]: x for x in o["monthly"] if x["dau"] == 10000}
    assert m["B:owned_l40s:base"]["fleet"]["realised_utilisation"] < 0.3
    assert m["B:l40s_runpod:base"]["fleet"]["realised_utilisation"] > 0.5
    # commercial realtime is at least an order of magnitude above self-hosted variable cost
    assert m["A:openai_gpt_realtime_2_1_mini"]["usd_per_min_variable"] > 10 * m["B:l40s_runpod:base"]["usd_per_min_variable"]


def test_question_guard_only_after_a_question():
    from providers.modular.text import QUESTION_GUARD_NOTE, ends_with_question, question_guard_note
    assert ends_with_question("וואלה, פקקים זה הכי מעצבן. היה משהו ספציפי?")
    assert ends_with_question("so what happened with the meeting? ")
    assert ends_with_question('he said "really?"')
    assert not ends_with_question("סבבה, נשמור על שקט.")
    assert not ends_with_question("רגע, זה אליי? כי נשמע לי שזה היה לנוסע.")  # question in the middle, statement at the end
    assert not ends_with_question("מה דעתך על —")  # cut off before the question mark
    q = {"role": "assistant", "content": "יש משהו מעניין שקרה היום?"}
    s = {"role": "assistant", "content": "האמת, לדעתי פקקים זה הזמן הכי טוב לפודקאסט."}
    u = {"role": "user", "content": "לא"}
    assert question_guard_note([]) is None  # the opener
    assert question_guard_note([q, u]) == QUESTION_GUARD_NOTE
    assert question_guard_note([s, u]) is None
    assert question_guard_note([q, u, s, u]) is None  # only the most recent reply counts


def test_turn_notes_live_for_their_turns_and_stay_out_of_history():
    from providers.modular.text import TurnNotes
    n = TurnNotes()
    assert n.text("מה נשמע") is None
    n.add("About three minutes are left: start wrapping up.", turns=2)
    n.add("  ", turns=3)  # empty: ignored
    assert n.text("מה נשמע") == "[Note for this turn, not said by the user: About three minutes are left: start wrapping up.]"
    n.consume("מה נשמע")
    assert len(n) == 1
    n.add("Nothing was saved: ask what to note.")  # a second note, for one turn
    assert n.text("אוקיי").count("[Note for this turn") == 2
    n.consume("אוקיי")
    assert n.text("אוקיי") is None  # both used up
    n.add("x" * 2000, turns=99)
    assert len(n.text("היי")) < 700  # clipped
    for _ in range(TurnNotes.MAX_TURNS):
        n.text("היי")
        n.consume("היי")
    assert n.text("היי") is None  # never lives longer than MAX_TURNS
    for i in range(6):
        n.add(f"note {i}")
    assert len(n) == TurnNotes.MAX_NOTES  # only the newest few are kept
    n.add("note 5", turns=3)  # the same note again renews it instead of piling up
    assert len(n) == TurnNotes.MAX_NOTES


def test_conditional_note_waits_for_a_dry_turn():
    """The next plan item is shown only when the user answered with a word or two, twice in a row; until then it waits."""
    from providers.modular.text import TurnNotes
    n = TurnNotes()
    n.add("Bring up: sport.", turns=1, max_user_words=2, min_streak=2)
    # a real question: the note stays out of the turn and is not used up
    assert n.text("אז מה אתה חושב, שווה לי להמשיך עם הסטארט-אפ?") is None
    n.consume("אז מה אתה חושב, שווה לי להמשיך עם הסטארט-אפ?")
    assert len(n) == 1
    # one short answer is an acknowledgement, not yet a dry conversation
    assert n.text("אוקיי.") is None
    n.consume("אוקיי.")
    # the second short answer in a row: now
    assert n.text("לא יודע") == "[Note for this turn, not said by the user: Bring up: sport.]"
    n.consume("לא יודע")
    assert len(n) == 0  # shown once
    # the opener instruction is not something the user said
    n.add("Bring up: podcasts.", max_user_words=2)
    assert n.text("[journey_start] open") is None
    assert n.text(None) is None
    assert n.text("סתם") is not None
    # a conditional note that never gets its turn is dropped in the end
    m = TurnNotes()
    m.add("stale", max_user_words=2)
    for _ in range(TurnNotes.MAX_WAIT):
        assert m.text("משפט ארוך עם הרבה מילים בתוכו") is None
        m.consume("משפט ארוך עם הרבה מילים בתוכו")
    assert len(m) == 0
    # an unconditional note is not affected by any of this
    m.add("pacing")
    assert m.text("משפט ארוך עם הרבה מילים בתוכו") is not None


def test_session_sampling_options_are_whitelisted_and_bounded():
    from providers.modular.pipeline import LLM_OPTION_BOUNDS
    from providers.modular.llm import OpenAICompatLLM
    assert set(LLM_OPTION_BOUNDS) == {"temperature", "top_p", "presence_penalty", "frequency_penalty", "repetition_penalty"}
    lo, hi = LLM_OPTION_BOUNDS["repetition_penalty"]
    assert (lo, hi) == (1.0, 1.3)
    llm = OpenAICompatLLM({"base_url": "http://127.0.0.1:1/v1", "model": "local"})
    body = llm._body([{"role": "user", "content": "x"}], True, None, 0.7, repetition_penalty=1.05)
    assert body["temperature"] == 0.7 and body["repetition_penalty"] == 1.05 and body["max_tokens"] == 160


def test_pipeline_adds_caller_notes_to_the_turn_only():
    """The note reaches the model next to the user's words and is not written into the history."""
    from providers.modular.pipeline import ModularProvider
    from providers.modular.text import TurnNotes
    p = ModularProvider.__new__(ModularProvider)  # only what _messages needs, no models
    p.history = [{"role": "assistant", "content": "האמת, לדעתי זה רעיון טוב."}]
    p.question_guard = True
    p.notes = TurnNotes()

    class Ctx:
        system_prompt = "SYSTEM"
    p.ctx = Ctx()
    assert p._messages("מה נשמע")[-1]["content"] == "מה נשמע"
    p.notes.add("About half of the ride is over.", turns=1)
    msgs = p._messages("מה נשמע")
    assert msgs[-1]["content"].endswith("[Note for this turn, not said by the user: About half of the ride is over.]")
    assert msgs[0] == {"role": "system", "content": "SYSTEM"}
    assert all("Note for this turn" not in m["content"] for m in p.history)  # history untouched
    p.notes.consume("מה נשמע")
    assert p._messages("מה נשמע")[-1]["content"] == "מה נשמע"


def test_hebrew_pronunciation_fixes_zappy_only_as_a_word():
    from providers.modular.text import he_pronounce
    # the owner's pick from listening samples (2026-11-26): "Zappy" in Latin letters
    assert he_pronounce("עובדים על זאפי") == "עובדים על Zappy"
    assert he_pronounce("בזאפי, ולזאפי.") == "ב-Zappy, ול-Zappy."
    assert he_pronounce("זאפי?") == "Zappy?"
    assert he_pronounce("זאפיות") == "זאפיות"  # a longer word is left alone
    assert he_pronounce("Zappy is fine") == "Zappy is fine"
    assert he_pronounce("בוקר טוב מאור, מה קורה עם זאפי?") == "בוקר טוב מאור, מה קורה עם Zappy?"
    # no table of names: a name is pinned per conversation (pronounce.py); the voice gets it as phonemes
    pin = {"מאור": "maʔˈoʁ"}
    assert he_pronounce("בוקר טוב מאור, מה קורה עם זאפי?", pin) == "בוקר טוב <he>maʔˈoʁ</he>, מה קורה עם Zappy?"
    assert he_pronounce("תודה מאור!", pin) == "תודה <he>maʔˈoʁ</he>!"
    assert he_pronounce("אמרתי למאור", pin) == "אמרתי <he>lemaʔˈoʁ</he>"
    assert he_pronounce("מאוד מאורגן, יש מאורות", pin) == "מאוד מאורגן, יש מאורות"
    assert he_pronounce("תודה מאור!") == "תודה מאור!"  # nothing pinned: the voice's own reading


def test_hebrew_letters_never_go_to_the_english_voice():
    # the piece the live pipeline cut on 2026-11-26: more Latin letters than Hebrew ones
    chunks = []
    c = SentenceChunker()
    for ch in 'אז נגיד "Un café, por favor". נשמע לך קל מדי?':
        chunks += c.feed(ch)
    chunks += c.flush()
    assert chunks == ['אז נגיד "Un café, por favor".', "נשמע לך קל מדי?"]
    assert dominant_language(chunks[0]) == "en"  # the old routing
    assert [speech_language(x, "he") for x in chunks] == ["he", "he"]
    assert speech_language(chunks[0], None) == "he"  # also when the conversation's language is detected
    assert speech_language("My friend שרה said hi", "en") == "he"


def test_a_short_foreign_phrase_keeps_the_hebrew_voice_in_a_hebrew_conversation():
    assert speech_language("¿Buenos días?", "he") == "he"
    assert speech_language("Un café, por favor.", "he") == "he"
    # English conversations and long English passages use the English voice
    assert speech_language("Good morning, how was the drive?", "en") == "en"
    assert speech_language("Good morning.", None) == "en"
    assert speech_language("This is a much longer answer that the model gave entirely in English for some reason.", "he") == "en"
    assert speech_language("123", "he") == "he" and speech_language("...", None, "en") == "en"


def test_a_spanish_italian_or_german_phrase_is_marked_for_its_own_pronunciation():
    assert mark_foreign('אז נגיד "Un café, por favor".') == 'אז נגיד "<es>Un café, por favor</es>".'
    assert mark_foreign("אוקיי, ננסה. ¿Buenos días? ככה זה נשמע לי.") == "אוקיי, ננסה. <es>¿Buenos días?</es> ככה זה נשמע לי."
    assert mark_foreign("אומרים שם Quanto costa? וגם Grazie mille.") == "אומרים שם <it>Quanto costa?</it> וגם <it>Grazie mille.</it>"
    assert mark_foreign("בגרמנית זה Guten Morgen, vielen Dank.") == "בגרמנית זה <de>Guten Morgen, vielen Dank.</de>"
    assert foreign_language("¿Dónde está el baño?") == "es"


def test_english_names_and_tech_words_are_left_as_they_are():
    for text in ["אני עובד על Zappy כבר שנה.", "תנסה משהו של Bonobo,", "אולי איזה Lo-fi או טכנו עמוק", "ב-Da Enzo יש תור",
                 "הוא אמר לי good morning ואז הלך.", "שים לי את זה ב-todo list", "טסים ל-Los Angeles", "תעשה לי favor",
                 "זה ה-playlist של Daft Punk", "נשתמש ב-Socket.io", "בלי Latin בכלל"]:
        assert mark_foreign(text) == text, text
    # the names with a fixed reading are not touched either
    assert mark_foreign(he_pronounce("בוקר טוב מאור, מה עם זאפי?")) == he_pronounce("בוקר טוב מאור, מה עם זאפי?")


def test_the_language_the_user_is_practising_decides_unclear_phrases():
    assert foreign_language("Me encanta viajar") is None  # no word the list knows
    assert foreign_language("Me encanta viajar", "es") == "es"
    assert foreign_language("Me llamo Rolly") == "es"
    assert mark_foreign("תגידי Me encanta viajar ותראי", "es") == "תגידי <es>Me encanta viajar</es> ותראי"
    # one unknown word, English, or an unsupported hint: unchanged
    assert foreign_language("Bonobo", "es") is None
    assert foreign_language("good morning", "es") is None
    assert foreign_language("Me encanta viajar", "fr") is None
    # a clear phrase wins over the hint
    assert foreign_language("Grazie mille", "es") == "it"


def test_the_lookup_marker_is_never_spoken_or_shown():
    reply = "בודק, שנייה. " + LOOKUP_MARKER
    assert clean_for_speech(reply) == "בודק, שנייה."
    # the chunker never cuts inside the marker, and what it hands to the voice has no marker
    c = SentenceChunker()
    chunks = []
    for piece in ["בודק, ", "שנייה. ", "<", "lookup", "/>"]:
        chunks += c.feed(piece)
    chunks += c.flush()
    assert chunks == ["בודק, שנייה."]
    # the text shown while the reply streams: the marker arrives in pieces and none of them gets through
    for pieces in (["בודק. ", "<", "lookup", "/>"], ["בודק. <look", "up/>"], ["ביי! ", "<end", "_session", "/>"], ["בודק. <lookup/>"]):
        f = MarkerFilter()
        shown = "".join(f.feed(p) for p in pieces) + f.flush()
        assert "<" not in shown and shown.strip() in ("בודק.", "ביי!"), (pieces, shown)
    # text that only looks like a tag is not swallowed
    f = MarkerFilter()
    assert "".join(f.feed(p) for p in ["3 < 5 ", "וגם <b>", " וזהו <"]) + f.flush() == "3 < 5 וגם <b> וזהו <"


def test_a_piece_with_nothing_to_say_is_not_sent_to_a_voice():
    assert not has_words("—") and not has_words("...") and not has_words(" ?! ")
    assert has_words("כן.") and has_words("14") and has_words("Zappy")


def test_the_pods_voices_are_the_ones_the_owner_chose(monkeypatch):
    """P1-D36: Hebrew `ariel` and English `jonathan`, both BlueV3 at speed 1.0, from the same voice server; Piper is the English
    fallback; without the pod's switch the English voice stays what it was."""
    from providers.registry import ProviderRegistry
    for k in ("ROLLY_BLUE_VOICE", "ROLLY_BLUE_SPEED", "ROLLY_BLUE_VOICE_EN", "ROLLY_BLUE_SPEED_EN", "ROLLY_TTS_EN_ENGINE", "ROLLY_TTS_HE_ENGINE", "ROLLY_BLUE_STREAM", "ROLLY_TTS_MERGE_CHARS"):
        monkeypatch.delenv(k, raising=False)
    path = os.path.join(os.path.dirname(__file__), "..", "config", "providers.yaml")
    plain = ProviderRegistry(path).entries["modular-selfhosted"]["tts"]
    assert plain["en"]["engine"] == "sherpa" and plain["he"]["engine"] == "renikud_piper"  # nothing changes without the pod's settings
    monkeypatch.setenv("ROLLY_TTS_HE_ENGINE", "blue")
    monkeypatch.setenv("ROLLY_TTS_EN_ENGINE", "blue")  # what infrastructure/start_worker.sh sets
    tts = ProviderRegistry(path).entries["modular-selfhosted"]["tts"]
    he, en = tts["he"], tts["en"]
    assert (he["engine"], he["blue_voice"], float(he["blue_speed"]), he.get("blue_language", "he")) == ("blue", "ariel", 1.0, "he")
    assert (en["engine"], en["blue_voice"], float(en["blue_speed"]), en["blue_language"]) == ("blue", "jonathan", 1.0, "en")
    assert he["blue_url"] == en["blue_url"]  # one voice server
    assert en["fallback"]["kind"] == "vits" and "lessac" in en["fallback"]["model_dir"]
    assert he["fallback"]["engine"] == "renikud_piper"
    # the engines the router builds name the voice and the speed
    from providers.modular.tts import BlueTTS
    assert "bluev3:jonathan:speed1" in BlueTTS(en).name and "bluev3:ariel:speed1" in BlueTTS(he).name
    # P1-D37, chosen in two blind listenings: a whole piece in one synthesis, short sentences kept together; no trimming, no cap
    for v in (he, en):
        b = BlueTTS(v)
        assert (b.stream, b.trim, b.pause_cap_ms) == (False, False, 0)
    assert tts_cfg_merge(path) == 70


def tts_cfg_merge(path):
    from providers.registry import ProviderRegistry
    return int(ProviderRegistry(path).entries["modular-selfhosted"]["tts_merge_chars"])


def _pcm(parts, rate=44100):
    """parts: list of ("sil", ms) or ("tone", ms) -> PCM16 bytes"""
    import numpy as np
    out = []
    for kind, ms in parts:
        n = int(rate * ms / 1000)
        out.append((np.zeros(n) if kind == "sil" else 0.3 * np.sin(2 * np.pi * 220 * np.arange(n) / rate)))
    return (np.clip(np.concatenate(out), -1, 1) * 32767).astype("<i2").tobytes()


def _silent_edges_ms(pcm: bytes, rate=44100, thresh=0.006):
    import numpy as np
    x = np.abs(np.frombuffer(pcm, dtype="<i2").astype(float) / 32768)
    idx = np.where(x > thresh)[0]
    return idx[0] / rate * 1000, (len(x) - idx[-1]) / rate * 1000, len(x) / rate * 1000


def test_a_piece_loses_the_silence_it_starts_and_ends_with_and_gets_a_fixed_gap():
    from providers.modular.shape import PieceShaper
    raw = _pcm([("sil", 150), ("tone", 600), ("sil", 300), ("tone", 500), ("sil", 400)])  # a pause INSIDE the piece too
    sh = PieceShaper(44100, gap_ms=150, lead_ms=20)
    # fed in odd-sized chunks, like the network delivers it
    out = b"".join(sh.feed(raw[i:i + 4801]) for i in range(0, len(raw), 4801)) + sh.finish()
    lead, trail, total = _silent_edges_ms(out)
    assert lead <= 30                       # a few ms of the leading silence stay, so the first sound is not abrupt
    assert abs(trail - 150) <= 12           # exactly the fixed gap, not the model's 400 ms
    assert abs(total - (20 + 600 + 300 + 500 + 150)) <= 25  # the pause inside the piece is untouched
    assert len(out) % 2 == 0


def test_the_shaper_never_cuts_speech_and_handles_empty_and_silent_pieces():
    from providers.modular.shape import PieceShaper
    raw = _pcm([("tone", 300)])
    sh = PieceShaper(44100)
    out = sh.feed(raw) + sh.finish()
    assert len(out) >= len(raw)  # all of the speech, plus the gap
    assert PieceShaper(44100).finish() == b""                       # nothing spoken, nothing added
    sh2 = PieceShaper(44100); assert sh2.feed(_pcm([("sil", 500)])) != b"x" and sh2.finish() == b""  # only silence: nothing to say


def test_short_sentences_are_kept_together_after_the_first_piece_when_merging_is_on():
    text = "בוקר טוב מאור. עם ילדים הייתי הולך על אי רגוע. אתונה נשמעת לי עמוסה. ככה זה."
    def pieces(**kw):
        c = SentenceChunker(**kw); out = []
        for ch in text:
            out += c.feed(ch)
        return out + c.flush()
    plain = pieces()
    assert plain[0] == "בוקר טוב מאור." and len(plain) >= 4  # a piece per sentence, as before
    merged = pieces(merge_chars=70)
    assert merged[0] == "בוקר טוב מאור."                         # the first piece is still early
    assert len(merged) == 2 and merged[1].count(".") >= 3         # the rest together, one synthesis
    assert " ".join(merged) == " ".join(plain)                    # the same words



def test_a_pause_cap_shortens_only_the_long_silences():
    import numpy as np
    from providers.modular.shape import PauseCap
    sr = 24000
    tone = (np.sin(np.arange(sr // 5) * 0.3) * 8000).astype("<i2")
    sil = lambda ms: np.zeros(sr * ms // 1000, dtype="<i2")
    pcm = np.concatenate([sil(600), tone, sil(200), tone, sil(700), tone, sil(500)]).tobytes()
    cap = PauseCap(sr, 350)
    out = b"".join(cap.feed(pcm[i:i + 1000]) for i in range(0, len(pcm), 1000)) + cap.finish()  # odd chunking on purpose
    n = len(out) // 2
    # 600 -> 350, 200 stays, 700 -> 350, 500 -> 350: 750 ms removed; the tones are intact
    assert abs(n - (len(pcm) // 2 - sr * 750 // 1000)) <= 2 * (sr // 100)
    got = np.frombuffer(out, dtype="<i2")
    assert int((np.abs(got) > 1000).sum()) == int((np.abs(np.frombuffer(pcm, dtype="<i2")) > 1000).sum())
    assert PauseCap(sr, 350).finish() == b""


def test_a_lookup_request_survives_a_reply_that_is_cancelled_right_after_it():
    """2026-11-26: the user spoke right after "אני בודק", the reply was cancelled and the request, reported only at the end of a
    reply, was lost (then the model told the user it had found nothing).  It is reported as soon as the marker is written."""
    import asyncio
    from providers import base
    from providers.modular.pipeline import ModularProvider, _Gate
    from providers.modular.text import TurnNotes

    events = []

    class LLM:
        name = "fake"

        async def stream(self, messages, res, **kw):
            for piece in ["אני בודק ", "<look", "up/>", ".", " עוד משהו אחרי"]:
                yield piece
                if piece == ".":
                    await asyncio.sleep(30)  # still "speaking" when the user cuts in

    class TTS:
        name = "fake"

        async def synth(self, chunk, hint=None, foreign=None):
            return
            yield  # an empty async generator

    class Ctx:
        system_prompt = "S"
        language = "he"

    async def go(typed_text):
        p = ModularProvider.__new__(ModularProvider)
        p.history, p.question_guard, p.notes, p.ctx = [], False, TurnNotes(), Ctx()
        p.llm, p.tts, p.config, p._foreign = LLM(), TTS(), {}, None
        p._turn_state = None

        async def emit(type_, audio=None, sample_rate=0, **data):
            events.append(type_)
        p.emit = emit
        gate = _Gate(p, committed=True)
        task = asyncio.create_task(p._run_turn(gate, text=typed_text, typed=True))
        await asyncio.sleep(0.3)
        task.cancel()
        try:
            await task
        except BaseException:
            pass

    asyncio.run(go("מה יש במבצע?"))
    assert events.count(base.LOOKUP_REQUESTED) == 1
    events.clear()
    asyncio.run(go("[lookup_result - not said by the user] x"))  # a reply to a lookup result never asks for another one
    assert base.LOOKUP_REQUESTED not in events


def test_a_waiting_topic_is_not_shown_on_a_turn_where_the_user_asked_something():
    from providers.modular.text import TurnNotes
    n = TurnNotes()
    n.add("Bring up this now: reggae.", turns=1, max_user_words=6, min_streak=1)
    assert n.text("וואלה עובר בסדר, מה איתך?") is None  # a question: it gets an answer, not our topic
    n.consume("וואלה עובר בסדר, מה איתך?")
    assert "reggae" in (n.text("עובר בסדר") or "")  # the next short statement takes it


def test_a_name_read_differently_by_position_is_pinned_to_its_reading_in_the_middle_of_a_sentence():
    from providers.modular.pronounce import analyze, usable_name

    def fake(text):  # the voice's front end: reads מאור "me-or" alone and at the end, "ma-or" elsewhere; דנה always the same
        if "מאור" in text:
            ma = "maʔˈoʁ" if ("היי" in text or "אני איתך" in text) else "meʔˈoʁ"
            return "<he>" + text.replace("מאור", ma) + "</he>"
        return "<he>" + text.replace("דנה", "dˈana") + "</he>"
    a = analyze("מאור", fake)
    assert not a["stable"] and a["pinned"] == "maʔˈoʁ" and set(a["candidates"]) == {"maʔˈoʁ", "meʔˈoʁ"}
    assert a["candidates"][0] == "meʔˈoʁ"  # most common first; the pin is not "the most common"
    d = analyze("דנה", fake)
    assert d["stable"] and d["candidates"] == ["dˈana"]
    assert usable_name("מאור") == "מאור" and usable_name("מאור כהן") == "מאור" and usable_name("Dan") is None and usable_name(None) is None


def test_the_conversation_pins_a_name_only_when_it_is_unstable_and_the_users_correction_wins(monkeypatch):
    import asyncio
    import providers.modular.pipeline as pl
    from providers.modular.tts import TTSRouter

    class Probe:
        enabled = True

        async def pins(self, name, timeout=None):
            return {"מאור": "maʔˈoʁ"} if name == "מאור" else {}
    monkeypatch.setattr(pl, "get_probe", lambda url, cache=None: Probe())

    def session(profile, language="he"):
        p = pl.ModularProvider.__new__(pl.ModularProvider)

        class Ctx:
            session_id = "abcdef123456"
        Ctx.profile, Ctx.language = profile, language
        p.ctx, p.config = Ctx(), {"pronounce_url": "http://x"}
        p.tts = TTSRouter({"he": {"engine": "x"}, "default": "he"})
        asyncio.run(p._load_pronunciations())
        return p.tts.pronunciations
    assert session({"name": "מאור"}) == {"מאור": "maʔˈoʁ"}
    assert session({"name": "דנה"}) == {}  # stable: left alone
    assert session({"name": "מאור"}, "en") == {}
    assert session({"name": "מאור", "name_pron": {"name": "מאור", "ipa": "meʔˈoʁ"}}) == {"מאור": "meʔˈoʁ"}  # the user chose
    assert session({"name": "מאור כהן", "name_pron": {"name": "מאור", "ipa": "meʔˈoʁ"}}) == {"מאור": "meʔˈoʁ"}
    assert session({"name": "דנה", "name_pron": {"name": "מאור", "ipa": "meʔˈoʁ"}}) == {}  # the name changed: the choice is stale
    assert session({"name": None}) == {}


# ---- a false interruption must not make the same sentence be said twice (2026-11-28: the opener, and a tool answer when a push notification buzzed)
from providers.modular.text import chunks_left, tail_from  # noqa: E402

SENTENCE = "בוקר טוב מאור, איך מתחיל לך היום?"


def test_cut_chunk_nearly_all_heard_is_not_said_again():
    synth = [(SENTENCE, 2.4)]
    assert chunks_left([SENTENCE], synth, 2.0) == []   # 83% heard
    assert chunks_left([SENTENCE], synth, 1.9) == []   # 79% heard


def test_cut_chunk_half_heard_is_said_from_where_it_was_cut_not_from_the_start():
    left = chunks_left([SENTENCE], [(SENTENCE, 2.4)], 1.3)  # 54% heard
    assert left == ["מאור, איך מתחיל לך היום?"]              # one word of overlap, nothing of "בוקר טוב"
    assert chunks_left([SENTENCE], [(SENTENCE, 2.4)], 0.2) == [SENTENCE]  # hardly anything heard: the whole sentence


def test_tail_from_keeps_short_texts_whole_and_never_returns_nothing():
    assert tail_from("כן בסדר גמור", 0.6) == "כן בסדר גמור"
    long = "יש לך פגישה עם Pipper-ai ו-Zappy ביום שני ב-10:00 בתל אביב."
    for f in (0.3, 0.5, 0.74):
        t = tail_from(long, f)
        assert t and long.endswith(t)
    assert len(tail_from(long, 0.7)) < len(tail_from(long, 0.35))


def test_short_cut_chunk_heard_half_with_little_left_counts_as_said():
    assert chunks_left(["כן."], [("כן.", 0.6)], 0.35) == []        # 58% heard, 0.25 s left
    assert chunks_left(["כן."], [("כן.", 0.6)], 0.1) == ["כן."]    # barely started


def test_later_chunks_are_still_said_and_played_ones_are_not():
    every = ["אחד.", "שניים.", "שלושה."]
    synth = [("אחד.", 1.0), ("שניים.", 1.0)]               # the third chunk's audio was not made yet
    assert chunks_left(every, synth, 0.1) == every
    assert chunks_left(every, synth, 1.9) == ["שלושה."]    # the second was nearly all heard
    assert chunks_left(every, synth, 5.0) == ["שלושה."]    # all that exists was played; the rest was never made
    assert chunks_left(every, [], 0.5) == every


# ---- barge-in is checked before the agent is cut (2026-11-28: a phone buzzing on its mount cut the agent, which then said the sentence again)
def _bargein_rig(verify_ms=300.0, stt_text="", stt_raises=False, scripted=None):
    import asyncio
    import numpy as np
    from providers import base
    from providers.modular.pipeline import ModularProvider, _Gate
    from providers.modular.vad import VadEvent, VadConfig

    log = {"emitted": [], "cancelled": [], "dropped": 0, "stt_calls": 0, "turns": 0}

    class Res:
        def __init__(self, text):
            self.text, self.audio_s, self.no_speech_prob, self.avg_logprob = text, 0.8, 0.1, -0.2

    class STT:
        name = "fake"

        async def transcribe(self, audio, hint):
            log["stt_calls"] += 1
            if stt_raises:
                raise RuntimeError("gpu busy")
            return Res(stt_text)

    class EP:
        gate_db = None
        strict = False
        _stream_ms = 1000.0

        def __init__(self):
            self.script = list(scripted or [])

        def feed(self, pcm, agent_audible=False):
            return self.script.pop(0) if self.script else []

        def peek(self):
            return np.zeros(8000, dtype=np.float32), {"level_db": -20.0}

        def drop_utterance(self):
            log["dropped"] += 1

    class Ctx:
        language = "he"

    p = ModularProvider.__new__(ModularProvider)
    p._closed, p._last_audible_t, p.vad_cfg, p.endpointer = False, 0.0, VadConfig(), EP()
    p.bargein_verify_ms, p._probe, p._utt, p._verdict_open = verify_ms, None, {}, None
    p.stt, p.ctx, p.unclear_max_s, p.unclear_logprob, p.level_gate_db = STT(), Ctx(), 1.5, -0.5, 0.0
    p._ref_level, p._echo_level, p._last_reply_text, p._turn_state = None, None, "", {"full_reply": "יש לך פגישה ביום שני"}

    class T:
        def done(self):
            return False

    p._turn, p._gate = T(), type("G", (), {"committed": True})()
    p.client_is_playing = lambda: True
    p._bargein_gate = lambda: None

    async def emit(type_, audio=None, sample_rate=0, **data):
        log["emitted"].append((type_, data.get("name")))
    p.emit = emit

    async def cancel(emit_interrupt, detect_audio_ms=None):
        log["cancelled"].append(emit_interrupt)
    p._cancel_turn = cancel

    async def outcome(*a, **k):
        return None
    p._turn_end_outcome = outcome
    return p, log, VadEvent, base


def _run(p, n_frames=30):
    import asyncio

    async def go():
        for _ in range(n_frames):
            await p.push_audio(b"\x00" * 640)  # 20 ms
            await asyncio.sleep(0)
        await asyncio.sleep(0.01)
        await p.push_audio(b"\x00" * 640)
    asyncio.run(go())


def test_a_noise_that_looks_like_speech_does_not_cut_the_agent():
    from providers.modular.vad import VadEvent
    p, log, _VadEvent, base = _bargein_rig(stt_text="", scripted=[[VadEvent("start", 900.0)]])
    _run(p)
    assert log["stt_calls"] == 1 and log["cancelled"] == [] and log["dropped"] == 1
    assert base.USER_SPEECH_STARTED not in [e[0] for e in log["emitted"]]          # the phone is not told the user spoke
    assert ("metric", "bargein_rejected_no_words") in [(e[0], e[1]) for e in log["emitted"]] or any(e[1] == "bargein_rejected_no_words" for e in log["emitted"])


def test_a_hallucinated_transcript_of_noise_does_not_cut_the_agent_either():
    from providers.modular.vad import VadEvent
    p, log, _V, base = _bargein_rig(stt_text="תודה.", scripted=[[VadEvent("start", 900.0)]])
    _run(p)
    assert log["cancelled"] == [] and log["dropped"] == 1


def test_real_words_cut_the_agent_once_they_are_confirmed():
    from providers.modular.vad import VadEvent
    p, log, _V, base = _bargein_rig(stt_text="רגע, עצור שנייה", scripted=[[VadEvent("start", 900.0)]])
    _run(p)
    assert log["cancelled"] == [True] and log["dropped"] == 0
    assert [e[0] for e in log["emitted"]].count(base.USER_SPEECH_STARTED) == 1


def test_nothing_is_cut_before_the_check_has_the_audio_it_needs():
    import asyncio
    from providers.modular.vad import VadEvent
    p, log, _V, base = _bargein_rig(stt_text="עצור", scripted=[[VadEvent("start", 900.0)]])

    async def go():
        for _ in range(5):  # 100 ms of 300
            await p.push_audio(b"\x00" * 640)
            await asyncio.sleep(0)
    asyncio.run(go())
    assert log["stt_calls"] == 0 and log["cancelled"] == []


def test_if_the_check_cannot_run_the_agent_is_cut_as_before():
    from providers.modular.vad import VadEvent
    p, log, _V, base = _bargein_rig(stt_raises=True, scripted=[[VadEvent("start", 900.0)]])
    _run(p)
    assert log["cancelled"] == [True]


def test_with_the_check_off_the_agent_is_cut_at_once():
    import asyncio
    from providers.modular.vad import VadEvent
    p, log, _V, base = _bargein_rig(verify_ms=0, scripted=[[VadEvent("start", 900.0)]])
    asyncio.run(p.push_audio(b"\x00" * 640))
    assert log["cancelled"] == [True] and log["stt_calls"] == 0


def test_a_short_sound_that_ends_before_the_check_point_is_checked_at_its_end_and_dropped_if_noise():
    import numpy as np
    from providers.modular.vad import VadEvent
    audio = np.zeros(6400, dtype=np.float32)
    p, log, _V, base = _bargein_rig(stt_text="", scripted=[[VadEvent("start", 900.0)], [VadEvent("eager", 1000.0, audio, {"level_db": -20.0})], [VadEvent("end", 1000.0, audio, {"level_db": -20.0})]])
    _run(p, n_frames=3)
    assert log["cancelled"] == [] and log["dropped"] == 1
    assert base.USER_SPEECH_STOPPED not in [e[0] for e in log["emitted"]]
