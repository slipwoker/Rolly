"""Self-hosted Hebrew TTS: ReNikud G2P (Hebrew text -> stressed IPA) + a Piper/VITS Hebrew voice.

Both models are run directly with ONNX Runtime (no Piper engine, which is GPL-3):
  * G2P   : renikud/renikud `model.onnx`            (CC BY 4.0)
  * voice : thewh1teagle/piper-he-noa `*.onnx`      (CC BY 4.0, trained on synthetic speech)

The G2P decoding below is adapted from the `renikud-onnx` reference implementation
(https://github.com/thewh1teagle/renikud, CC BY 4.0, Melichov / Kolani / Alper).

Known limitations (documented in LICENSES.md / FINAL_REPORT.md):
  * Latin-script words inside Hebrew text are approximated letter-by-letter, not properly
    phonemised; digits should already be spelled out by the LLM.
  * Synthesis is per chunk (not frame-streaming).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncIterator

import numpy as np
import onnxruntime as ort

STRESS = "ˈ"
_LATIN_IPA = {
    "a": "a", "b": "b", "c": "k", "d": "d", "e": "e", "f": "f", "g": "ɡ", "h": "h", "i": "i", "j": "dʒ", "k": "k",
    "l": "l", "m": "m", "n": "n", "o": "o", "p": "p", "q": "k", "r": "ʁ", "s": "s", "t": "t", "u": "u", "v": "v",
    "w": "w", "x": "ks", "y": "j", "z": "z",
}
_DIGITS_HE = ["אפס", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע"]


def _session(path: str, threads: int, provider: str) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if provider == "cuda" else ["CPUExecutionProvider"]
    return ort.InferenceSession(path, opts, providers=providers)


class ReNikudG2P:
    """Hebrew grapheme-to-phoneme (unvocalised text -> IPA with stress)."""

    def __init__(self, model_path: str, threads: int = 1, provider: str = "cpu"):
        self._s = _session(model_path, threads, provider)
        meta = self._s.get_modelmeta().custom_metadata_map
        self._vocab: dict[str, int] = json.loads(meta["vocab"])
        self._cons = {int(k): v for k, v in json.loads(meta["consonant_vocab"]).items()}
        self._vowel = {int(k): v for k, v in json.loads(meta["vowel_vocab"]).items()}
        self._cls, self._sep = int(meta["cls_token_id"]), int(meta["sep_token_id"])
        self._constraints: dict[str, list[int]] = json.loads(meta["letter_consonant_constraints"])
        self._geresh: dict[str, str] = json.loads(meta.get("geresh_map", "{}"))

    @staticmethod
    def _is_he(c: str) -> bool:
        return "א" <= c <= "ת"

    def phonemize(self, text: str) -> str:
        text = re.sub(r"[׳'`´]", "'", text)
        text = re.sub(r'[״“”]', '"', text)
        norm = unicodedata.normalize("NFD", text)
        unk = self._vocab.get("[UNK]", 0)
        ids = [self._cls] + [self._vocab.get(c, unk) for c in norm] + [self._sep]
        cons_l, vow_l, stress_l = self._s.run(
            ["consonant_logits", "vowel_logits", "stress_logits"],
            {"input_ids": np.array([ids], dtype=np.int64), "attention_mask": np.ones((1, len(ids)), dtype=np.int64)})
        cons_l, vow_l, stress_l = cons_l[0], vow_l[0], stress_l[0]
        cons_p, vow_p = cons_l.argmax(-1), vow_l.argmax(-1)
        # one stressed letter per word: the letter with the highest stress logit
        stressed: set[int] = set()
        for m in re.finditer(r"\S+", norm):
            toks = [i + 1 for i in range(m.start(), m.end()) if self._is_he(norm[i])]
            if toks:
                stressed.add(max(toks, key=lambda t: stress_l[t, 1]))
        out: list[str] = []
        for i, ch in enumerate(norm):
            t = i + 1
            if not self._is_he(ch):
                if ch not in ("'", '"'):
                    out.append(ch)
                continue
            cid = int(cons_p[t])
            allowed = self._constraints.get(ch)
            if allowed is not None and cid not in allowed:
                cid = max(allowed, key=lambda x: cons_l[t, x])
            cons = self._cons.get(cid, "∅")
            if ch in self._geresh and i + 1 < len(norm) and norm[i + 1] == "'":
                cons = self._geresh[ch]
            vowel = self._vowel.get(int(vow_p[t]), "∅")
            is_stressed = t in stressed
            word_final = i + 1 >= len(norm) or not norm[i + 1].isalpha()
            if ch == "ח" and word_final and vowel == "a":  # furtive patah
                out.append((STRESS if is_stressed else "") + "aχ")
            else:
                out.append(("" if cons == "∅" else cons) + (STRESS if is_stressed else "") + ("" if vowel == "∅" else vowel))
        return "".join(out)


def normalize_hebrew_text(text: str) -> str:
    """Minimal normaliser: spell digits one by one and approximate Latin words in IPA-like letters."""
    text = re.sub(r"\d", lambda m: " " + _DIGITS_HE[int(m.group(0))] + " ", text)
    text = text.replace("%", " אחוז ").replace("&", " ו ")
    return re.sub(r"\s+", " ", text).strip()


def latin_to_ipa(word: str) -> str:
    return "".join(_LATIN_IPA.get(c, "") for c in word.lower())


class RenikudPiperTTS:
    def __init__(self, cfg: dict):
        d = cfg.get("model_dir", "models/hebrew-tts")
        voice = os.path.join(d, cfg.get("voice_file", "he_IL-noa-medium.onnx"))
        g2p = os.path.join(d, cfg.get("g2p_file", "renikud.onnx"))
        for p in (voice, voice + ".json", g2p):
            if not os.path.exists(p):
                raise FileNotFoundError(f"Hebrew TTS file missing: {p} (run infrastructure/download_models.sh)")
        conf = json.load(open(voice + ".json", encoding="utf-8"))
        self.sample_rate = int(conf["audio"]["sample_rate"])
        self._id_map: dict[str, list[int]] = conf["phoneme_id_map"]
        inf = conf.get("inference", {})
        self._scales = np.array([float(cfg.get("noise_scale", inf.get("noise_scale", 0.667))),
                                 float(cfg.get("length_scale", inf.get("length_scale", 1.0))),
                                 float(cfg.get("noise_w", inf.get("noise_w", 0.8)))], dtype=np.float32)
        self._sid = np.array([int(cfg.get("speaker_id", conf.get("default_speaker_id", 0)))], dtype=np.int64)
        threads = int(cfg.get("num_threads", 2))
        provider = cfg.get("provider", "cpu")
        n = int(cfg.get("num_instances", 1))
        self._g2p = ReNikudG2P(g2p, threads=1, provider="cpu")
        self._g2p_lock = threading.Lock()
        self._voices = [_session(voice, threads, provider) for _ in range(n)]
        self._free: asyncio.Queue | None = None
        self._pool = ThreadPoolExecutor(max_workers=n, thread_name_prefix="tts-he")
        self.name = f"renikud+piper-he-noa:{provider}"

    def phonemes(self, text: str) -> str:
        text = normalize_hebrew_text(text)
        text = re.sub(r"[A-Za-z]+", lambda m: latin_to_ipa(m.group(0)), text)
        with self._g2p_lock:
            return self._g2p.phonemize(text)

    def _ids(self, phonemes: str) -> np.ndarray:
        pad = self._id_map["_"]
        ids = list(self._id_map["^"]) + list(pad)
        for ph in unicodedata.normalize("NFD", phonemes):
            if ph in self._id_map:
                ids += self._id_map[ph] + pad
        ids += self._id_map["$"]
        return np.array([ids], dtype=np.int64)

    def _synth(self, sess: ort.InferenceSession, text: str) -> bytes:
        ids = self._ids(self.phonemes(text))
        audio = sess.run(None, {"input": ids, "input_lengths": np.array([ids.shape[1]], dtype=np.int64),
                                "scales": self._scales, "sid": self._sid})[0].reshape(-1)
        return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()

    async def synth(self, text: str, language: str | None = None) -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        if self._free is None:
            self._free = asyncio.Queue()
            for s in self._voices:
                self._free.put_nowait(s)
        sess = await self._free.get()
        try:
            pcm = await loop.run_in_executor(self._pool, self._synth, sess, text)
        finally:
            self._free.put_nowait(sess)
        step = self.sample_rate * 2 // 5  # 200 ms pieces so barge-in can cut playback finely
        for i in range(0, len(pcm), step):
            yield pcm[i: i + step]
