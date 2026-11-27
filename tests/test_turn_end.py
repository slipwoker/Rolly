"""Smart end of turn: the verdicts on what the user said so far, the endpointer's per-utterance silence, and the pipeline's metrics."""
import asyncio

import numpy as np
import pytest

from providers.modular.turnend import CONTINUE, DONE, UNSURE, judge, mode_from, override_for
from providers.modular.vad import Endpointer, VadConfig, WINDOW

# (what the user had said when they paused, what it should be taken as): written by hand, Hebrew and English
CASES = [
    # finished
    ("וואלה עובר בסדר, מה איתך?", DONE), ("מה אתה חושב על זה?", DONE), ("כן", DONE), ("לא", DONE), ("יאללה", DONE), ("סבבה", DONE),
    ("אני אוהב אותו מאוד.", DONE), ("זה היה ממש כיף.", DONE), ("תודה רבה!", DONE), ("What do you think?", DONE), ("Yes", DONE),
    ("I love that song.", DONE), ("that was great!", DONE), ("אני בדרך לעבודה, יש לי פגישה חשובה.", DONE), ("ביי", DONE),
    # clearly not finished
    ("ואז הלכתי לשם ו", CONTINUE), ("אני חושב שאולי כדאי ש", CONTINUE), ("אני רוצה לספר לך על זה,", CONTINUE), ("אממ", CONTINUE),
    ("אני הולך עם", CONTINUE), ("הלכתי לבקר את", CONTINUE), ("זה היה בגלל", CONTINUE), ("אבל", CONTINUE), ("כי", CONTINUE),
    ("אני חושב ש...", CONTINUE), ("I was thinking about the", CONTINUE), ("so um", CONTINUE), ("and then", CONTINUE),
    ("I wanted to talk to you about", CONTINUE), ("well,", CONTINUE), ("it was kind of", CONTINUE), ("אה", CONTINUE), ("הממ", CONTINUE),
    ("הייתי בדרך לשם ואז כאילו", CONTINUE),
    # can not tell: the usual silence
    ("אני הולך לעבודה", UNSURE), ("תנסה עוד פעם לחפש", UNSURE), ("I am driving to work", UNSURE), ("", UNSURE), ("בוב מארלי", UNSURE),
    ("אני אוהב אותו מאוד", UNSURE), ("ככה", UNSURE),
]


@pytest.mark.parametrize("text,expected", CASES)
def test_verdict_on_what_was_said_so_far(text, expected):
    assert judge(text) == expected


def test_modes_and_the_silence_each_verdict_gets():
    assert [mode_from(x) for x in ("on", "OFF", "shadow", "", None, "nonsense")] == ["on", "off", "shadow", "shadow", "shadow", "shadow"]
    assert override_for(CONTINUE, "on") == 1400.0 and override_for(DONE, "on") == 0.0 and override_for(UNSURE, "on") is None
    assert override_for(CONTINUE, "shadow") is None and override_for(DONE, "off") is None  # only "on" changes anything


class FakeVad:  # speech where the signal is loud
    def prob(self, w):
        return 1.0 if float(np.abs(w).mean()) > 0.01 else 0.0


def _frames(ep, ms, loud):
    events = []
    for _ in range(int(ms / 32)):
        w = (np.sin(np.arange(WINDOW) * 0.3) * 0.3 if loud else np.zeros(WINDOW)).astype(np.float32)
        events += ep.feed((w * 32767).astype("<i2").tobytes())
    return [e.kind for e in events]


def _endpointer():
    return Endpointer(FakeVad(), VadConfig(eager_silence_ms=256, endpoint_silence_ms=544, pre_roll_ms=64))


def test_the_usual_silence_ends_a_turn_and_a_verdict_can_move_that_point():
    ep = _endpointer()
    assert "start" in _frames(ep, 800, True)
    assert _frames(ep, 288, False) == ["eager"]  # 256 ms of silence
    assert _frames(ep, 320, False) == ["end"]  # 544 ms

    # "continue": wait longer; the user speaks again after 1 second: a pause, not an end
    ep = _endpointer(); _frames(ep, 800, True); _frames(ep, 288, False)
    assert ep.set_endpoint_override(1400.0)
    assert _frames(ep, 700, False) == []  # past 544 ms and nothing ended
    assert _frames(ep, 160, True) == ["resume"] and ep.endpoint_override_ms is None  # the override belongs to that pause only
    assert _frames(ep, 288, False) == ["eager"]
    assert _frames(ep, 320, False) == ["end"]  # the next pause has the usual silence again

    # "continue" and the user really is done: the turn ends at the longer silence
    ep = _endpointer(); _frames(ep, 800, True); _frames(ep, 288, False); ep.set_endpoint_override(1400.0)
    kinds = _frames(ep, 1300, False)
    assert kinds == ["end"]

    # "done": ends at once
    ep = _endpointer(); _frames(ep, 800, True); _frames(ep, 288, False); ep.set_endpoint_override(0.0)
    assert _frames(ep, 32, False) == ["end"]


def test_a_verdict_that_arrives_too_late_changes_nothing():
    ep = _endpointer(); _frames(ep, 800, True)
    assert ep.set_endpoint_override(1400.0) is False  # no pause yet (the eager point has not been reached)
    _frames(ep, 288, False); _frames(ep, 320, False)  # the turn ended
    assert ep.set_endpoint_override(1400.0) is False and ep.endpoint_override_ms is None
    ep2 = _endpointer(); _frames(ep2, 800, True); _frames(ep2, 288, False); _frames(ep2, 160, True)
    assert ep2.set_endpoint_override(1400.0) is False  # the user already spoke again


def test_the_pipeline_records_the_verdict_and_what_followed_and_applies_it_only_in_mode_on():
    from providers import base
    from providers.modular.pipeline import ModularProvider

    def provider(mode):
        p = ModularProvider.__new__(ModularProvider)
        p.turn_end_mode, p._verdict_open = mode, None
        p.endpointer = _endpointer()
        _frames(p.endpointer, 800, True); _frames(p.endpointer, 288, False)
        p.metrics = []

        async def emit(type_, audio=None, sample_rate=0, **data):
            p.metrics.append(data["name"])
        p.emit = emit
        return p
    p = provider("shadow")
    asyncio.run(p._turn_end_verdict("ואז הלכתי לשם ו", {"speech_ms": 900}))
    asyncio.run(p._turn_end_outcome("resumed"))
    assert p.metrics == ["turn_end_continue", "turn_end_resumed_continue"] and p.endpointer.endpoint_override_ms is None
    p = provider("on")
    asyncio.run(p._turn_end_verdict("ואז הלכתי לשם ו", {"speech_ms": 900}))
    asyncio.run(p._turn_end_outcome("ended"))
    assert p.metrics == ["turn_end_continue_applied", "turn_end_ended_continue"]
    asyncio.run(p._turn_end_outcome("ended"))
    assert p.metrics[-1] == "turn_end_ended_continue" and len(p.metrics) == 2  # reported once
