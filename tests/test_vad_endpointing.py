"""Endpointer behaviour on real synthesised speech (needs the downloaded models)."""
import numpy as np

from providers.modular.vad import Endpointer, SileroVAD, VadConfig


def _feed(ep, audio, agent_audible=False):
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    out = []
    for i in range(0, len(pcm), 640):
        out += [(e.kind, e.audio_ms, ep._stream_ms) for e in ep.feed(pcm[i:i + 640], agent_audible=agent_audible)]
    return out


def test_start_eager_end_sequence_and_timing(models_available):
    from benchmarks.synth import user_speech_sync

    speech = user_speech_sync("Yes, let's continue with that topic.", "en")
    lead, tail = np.zeros(16000, np.float32), np.zeros(24000, np.float32)
    cfg = VadConfig()
    ev = _feed(Endpointer(SileroVAD("models/silero_vad.onnx"), cfg), np.concatenate([lead, speech, tail]))
    kinds = [k for k, _, _ in ev]
    assert kinds[0] == "start" and kinds[-1] == "end" and "eager" in kinds
    start_emitted = ev[0][2]
    assert 1000 <= start_emitted <= 1000 + 400, "speech onset must be detected within 400 ms"
    true_end = 1000 + len(speech) / 16
    end_emitted = ev[-1][2]
    assert cfg.endpoint_silence_ms - 100 <= end_emitted - true_end <= cfg.endpoint_silence_ms + 250
    eager_emitted = next(t for k, _, t in ev if k == "eager")
    assert eager_emitted < end_emitted - 200, "the speculative point must give a real head start"


def test_silence_and_road_noise_do_not_trigger(models_available):
    from benchmarks.synth import road_noise

    ep = Endpointer(SileroVAD("models/silero_vad.onnx"), VadConfig())
    assert _feed(ep, np.zeros(16000 * 5, np.float32)) == []
    assert [k for k, _, _ in _feed(ep, road_noise(10.0) * 0.05, agent_audible=True)] == []
