"""Shaping the pauses between the pieces of one spoken reply.

A reply is spoken piece by piece (the first one early, for latency).  The voice model adds silence of its own at the start
and at the end of every piece it synthesises (measured with BlueV3, 2026-11-26: 120-164 ms before and 278-535 ms after), so
between two sentences the listener hears 0.5-0.7 s of nothing, where the same two sentences synthesised as one text have
a natural pause of about 0.37 s.  `PieceShaper` removes the silence a piece starts and ends with and puts a fixed, short gap
after it, so the pause between pieces is decided here.  Pauses INSIDE a piece are left exactly as the model made them.
"""
from __future__ import annotations

import numpy as np

FRAME_MS = 10
SILENCE_PEAK = 0.006  # about -44 dBFS: below it a 10 ms frame counts as silence (speech here is around -14 dBFS)


class PieceShaper:
    """Streaming: `feed` PCM16 mono chunks of one piece, `finish` at its end.  Output is PCM16 LE bytes."""

    def __init__(self, sample_rate: int, gap_ms: int = 150, lead_ms: int = 20):
        self.frame = max(1, int(sample_rate * FRAME_MS / 1000))
        self.gap = np.zeros(int(sample_rate * gap_ms / 1000), dtype="<i2").tobytes()
        self.lead_frames = max(0, lead_ms // FRAME_MS)  # a little of the leading silence is kept, so the first sound is not abrupt
        self._carry = np.zeros(0, dtype="<i2")  # samples of an unfinished frame
        self._pending: list[bytes] = []  # silent frames not yet known to be inside the speech
        self._started = False
        self._lead_kept = 0

    def _frames(self, samples: np.ndarray) -> bytes:
        out = []
        for i in range(0, len(samples), self.frame):
            fr = samples[i:i + self.frame]
            silent = float(np.max(np.abs(fr.astype(np.float32))) / 32768.0) < SILENCE_PEAK if len(fr) else True
            if silent:
                if not self._started:
                    if self._lead_kept < self.lead_frames:
                        self._lead_kept += 1
                        out.append(fr.tobytes())
                else:
                    self._pending.append(fr.tobytes())  # maybe a pause inside the speech, maybe the end
            else:
                self._started = True
                if self._pending:
                    out.append(b"".join(self._pending))  # it was a pause inside the speech: keep it
                    self._pending = []
                out.append(fr.tobytes())
        return b"".join(out)

    def feed(self, pcm: bytes) -> bytes:
        n = len(pcm) >> 1
        if not n:
            return b""
        samples = np.concatenate([self._carry, np.frombuffer(pcm, dtype="<i2", count=n)])
        whole = (len(samples) // self.frame) * self.frame
        self._carry = samples[whole:].copy()
        return self._frames(samples[:whole]) if whole else b""

    def finish(self) -> bytes:
        """The end of the piece: the silence held back is dropped, and the fixed gap follows."""
        out = self._frames(self._carry) if len(self._carry) else b""
        self._carry = np.zeros(0, dtype="<i2")
        self._pending = []
        return out + (self.gap if self._started else b"")
