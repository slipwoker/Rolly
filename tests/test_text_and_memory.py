import time

from memory.context import END_MARKER, build_context, seed_store
from memory.store import MemoryStore
from memory.summarizer import _extract_json, fallback_summary, persist_summary
from providers.modular.text import SentenceChunker, clean_for_speech, dominant_language, user_wants_to_end


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
