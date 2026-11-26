import time

from memory.context import END_MARKER, build_context, seed_store
from memory.store import MemoryStore
from memory.summarizer import _extract_json, fallback_summary, persist_summary
from providers.modular.text import SentenceChunker, clean_for_speech, dominant_language, speech_language, user_wants_to_end


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

