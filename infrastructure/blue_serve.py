"""Start the BlueTTS OpenAI-compatible server with every ONNX model on the GPU.

BlueTTS passes its execution providers to its own four graphs, but the Hebrew text front end (RenikudPlus, a 1.2 GB
model) builds its session with ONNX Runtime's defaults, i.e. on the CPU.  Measured on the GPU pod (128 visible CPUs,
quota of about 13): that front end alone took 2.4-2.6 s per sentence, the rest about 0.3 s.  This launcher makes
sessions that name no provider use the GPU (CPU as fallback) with a bounded thread pool, then runs the stock server.

    python blue_serve.py <path to BlueTTS/examples/openai_server.py> [server arguments...]
"""
import os
import runpy
import sys

import onnxruntime as ort

_Original = ort.InferenceSession
_THREADS = int(os.environ.get("ROLLY_BLUE_THREADS", "4"))
_GPU = "CUDAExecutionProvider" in ort.get_available_providers() and os.environ.get("ROLLY_BLUE_BACKEND", "gpu") == "gpu"


class _Session(_Original):
    def __init__(self, path_or_bytes, sess_options=None, providers=None, provider_options=None, **kwargs):
        if sess_options is None:
            sess_options = ort.SessionOptions()
            sess_options.intra_op_num_threads = _THREADS
        if providers is None and _GPU:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        super().__init__(path_or_bytes, sess_options, providers=providers, provider_options=provider_options, **kwargs)
        name = os.path.basename(path_or_bytes) if isinstance(path_or_bytes, str) else "<bytes>"
        print(f"[blue_serve] {name}: {self.get_providers()[0]}", flush=True)


ort.InferenceSession = _Session


def _start_name_probe(bundle: str) -> None:
    """Serve the Hebrew front end for names on 127.0.0.1:1921 (`POST /phonemize {"word": ...}`), in this process so that its
    model also runs on the GPU.  The pipeline uses it to pin a name that the front end reads differently by position
    (providers/modular/pronounce.py).  Any failure only switches the probe off."""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    state: dict = {}
    lock = threading.Lock()

    def load() -> None:
        try:
            sys.path.insert(0, root)
            from blue_onnx import TextProcessor, load_cfgs
            from providers.modular.pronounce import analyze
            cfgs = load_cfgs(os.path.join(bundle, "onnx"), None)
            fe = os.path.join(bundle, "frontend")
            shipped = os.path.join(fe, "renikud", "model.onnx")
            tp = TextProcessor(shipped if os.path.exists(shipped) else None, release=cfgs.get("blue_release"),
                               frontend_dir=fe if os.path.isdir(fe) else None)
            tp.phonemize("היי, מה קורה?", lang="he")  # builds the model now, not on the first name
            state["tp"], state["analyze"] = tp, analyze
            print("[blue_serve] name probe ready on 127.0.0.1:1921", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[blue_serve] name probe off: {e!r}", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, code: int, obj: dict) -> None:
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):  # noqa: N802
            if self.path != "/phonemize" or "tp" not in state:
                return self._send(503, {"error": "not ready"})
            try:
                word = str(json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}").get("word", ""))
                if not (2 <= len(word) <= 12):
                    return self._send(400, {"error": "word"})
                with lock:
                    result = state["analyze"](word, lambda t: state["tp"].phonemize(t, lang="he"))
                self._send(200, result)
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": repr(e)[:200]})

    try:
        server = ThreadingHTTPServer(("127.0.0.1", 1921), Handler)
    except OSError as e:
        print(f"[blue_serve] name probe off: {e!r}", flush=True)
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=load, daemon=True).start()


script = sys.argv[1]
sys.argv = [script] + sys.argv[2:]
if "--bundle" in sys.argv and os.environ.get("ROLLY_NAME_PROBE", "1") == "1":
    _start_name_probe(sys.argv[sys.argv.index("--bundle") + 1])
runpy.run_path(script, run_name="__main__")
