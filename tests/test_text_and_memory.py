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
    # the owner's pick from listening samples (2026-11-26): "Zappy" in Latin letters, מָאוֹר with vowels
    assert he_pronounce("עובדים על זאפי") == "עובדים על Zappy"
    assert he_pronounce("בזאפי, ולזאפי.") == "ב-Zappy, ול-Zappy."
    assert he_pronounce("זאפי?") == "Zappy?"
    assert he_pronounce("זאפיות") == "זאפיות"  # a longer word is left alone
    assert he_pronounce("Zappy is fine") == "Zappy is fine"
    assert he_pronounce("בוקר טוב מאור, מה קורה עם זאפי?") == "בוקר טוב מָאוֹר, מה קורה עם Zappy?"
    assert he_pronounce("אמרתי למאור") == "אמרתי למָאוֹר"
    assert he_pronounce("מאוד מאורגן, יש מאורות") == "מאוד מאורגן, יש מאורות"  # other words that contain the letters


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
    for k in ("ROLLY_BLUE_VOICE", "ROLLY_BLUE_SPEED", "ROLLY_BLUE_VOICE_EN", "ROLLY_BLUE_SPEED_EN", "ROLLY_TTS_EN_ENGINE", "ROLLY_TTS_HE_ENGINE"):
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
