"""Speech-recognition accuracy benchmark (word error rate), clean and with synthetic road noise.

Data: FLEURS test split (Google, CC BY 4.0) - real human read speech, Hebrew (he_il) and
English (en_us).  Noise: benchmarks.synth.road_noise mixed at fixed speech-to-noise ratios.

    python -m benchmarks.stt_wer --lang he --n 40 --models ivrit-ai/whisper-large-v3-turbo-ct2 \
        deepdml/faster-whisper-large-v3-turbo-ct2 --snr clean 10 5 0

Results: benchmarks/results/stt_wer_<lang>_<timestamp>.json  (per utterance + aggregates)
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import platform
import re
import tarfile
import time
import unicodedata
from pathlib import Path

import jiwer
import numpy as np
import soundfile as sf
import soxr

from .synth import SR, mix_at_snr, road_noise

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "models" / "datasets" / "fleurs"
RESULTS = ROOT / "benchmarks" / "results"
LANG = {"he": "he_il", "en": "en_us"}


def normalize(text: str, lang: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))  # strips niqqud and accents
    text = text.lower()
    text = re.sub(r"[־\-–—]", " ", text)  # maqaf / dashes separate words
    text = re.sub(r"[^\w\s֐-׿]", "", text)
    text = re.sub(r"_", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def load_fleurs(lang: str, n: int, max_s: float = 20.0) -> list[dict]:
    from huggingface_hub import hf_hub_download

    code = LANG[lang]
    tsv = hf_hub_download("google/fleurs", f"data/{code}/test.tsv", repo_type="dataset")
    tar = hf_hub_download("google/fleurs", f"data/{code}/audio/test.tar.gz", repo_type="dataset")
    rows = {}
    with open(tsv, encoding="utf-8") as f:
        for r in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(r) >= 3:
                rows.setdefault(r[1], r[2])  # filename -> raw transcription (first speaker reading)
    wanted = sorted(rows)[: n * 3]
    out_dir = DATA / code
    out_dir.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    with tarfile.open(tar, "r:gz") as t:
        for member in t:
            name = Path(member.name).name
            if not member.isfile() or name not in wanted:
                continue
            data = t.extractfile(member).read()
            audio, sr = sf.read(io.BytesIO(data), dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr != SR:
                audio = soxr.resample(audio, sr, SR)
            if len(audio) / SR > max_s:
                continue
            items.append({"id": name, "ref": rows[name], "audio": audio.astype(np.float32)})
    items.sort(key=lambda x: x["id"])
    return items[:n]


def run(lang: str, n: int, models: list[str], snrs: list[str], device: str, compute: str, threads: int) -> dict:
    from faster_whisper import WhisperModel

    items = load_fleurs(lang, n)
    noise = road_noise(60.0)
    out = {
        "benchmark": "stt_wer", "language": lang, "dataset": f"google/fleurs {LANG[lang]} test (CC BY 4.0)",
        "n_utterances": len(items), "audio_seconds": round(sum(len(i["audio"]) for i in items) / SR, 1),
        "noise": "synthetic road noise (benchmarks.synth.road_noise), SNR measured over active speech",
        "host": {"platform": platform.platform(), "processor": platform.processor(), "device": device, "compute_type": compute,
                 "cpu_threads": threads},
        "decoding": {"beam_size": 1, "language_forced": lang, "condition_on_previous_text": False},
        "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "results": [],
    }
    for mid in models:
        t0 = time.time()
        api = None
        if mid.startswith("api:"):
            # commercial transcription over HTTPS, e.g. "api:gpt-transcribe" (base URL / key from the environment)
            import asyncio
            import os

            from providers.modular.stt import OpenAICompatSTT
            api = OpenAICompatSTT({"base_url": os.environ.get("ROLLY_STT_API_BASE", "https://api.openai.com/v1"),
                                   "model": mid[4:], "api_key_env": "ROLLY_STT_API_KEY"})
            loop = asyncio.new_event_loop()
            model = None
        else:
            model = WhisperModel(mid, device=device, compute_type=compute, cpu_threads=threads)
        load_s = time.time() - t0
        for snr in snrs:
            refs, hyps, per, proc_s = [], [], [], 0.0
            for it in items:
                audio = it["audio"] if snr == "clean" else mix_at_snr(it["audio"], noise, float(snr))
                t1 = time.time()
                if api is not None:
                    hyp = loop.run_until_complete(api.transcribe(audio, lang)).text
                else:
                    segs, _ = model.transcribe(audio, language=lang, beam_size=1, without_timestamps=True,
                                               condition_on_previous_text=False, temperature=0.0)
                    hyp = " ".join(s.text.strip() for s in segs)
                dt = time.time() - t1
                proc_s += dt
                r, h = normalize(it["ref"], lang), normalize(hyp, lang)
                refs.append(r)
                hyps.append(h)
                per.append({"id": it["id"], "ref": r, "hyp": h, "wer": round(jiwer.wer(r, h), 4) if r else None,
                            "audio_s": round(len(it["audio"]) / SR, 2), "proc_s": round(dt, 2)})
            audio_s = sum(p["audio_s"] for p in per)
            res = {"model": mid, "snr_db": snr, "wer": round(jiwer.wer(refs, hyps), 4), "cer": round(jiwer.cer(refs, hyps), 4),
                   "rtf": round(proc_s / audio_s, 3), "model_load_s": round(load_s, 1), "utterances": per}
            out["results"].append(res)
            print(f"[{lang}] {mid.split('/')[-1]:36s} snr={snr:>5}  WER={res['wer']*100:5.1f}%  CER={res['cer']*100:5.1f}%  RTF={res['rtf']}", flush=True)
            _save(out, lang)
        del model
    return out


def _save(out: dict, lang: str) -> Path:
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"stt_wer_{lang}_{out['started'].replace(':', '').replace('-', '')}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="he", choices=["he", "en"])
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--models", nargs="+", default=["ivrit-ai/whisper-large-v3-turbo-ct2"])
    ap.add_argument("--snr", nargs="+", default=["clean", "10", "5", "0"])
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute", default="default")
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    run(a.lang, a.n, a.models, a.snr, a.device, a.compute, a.threads)
