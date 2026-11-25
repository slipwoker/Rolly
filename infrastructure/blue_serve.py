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
script = sys.argv[1]
sys.argv = [script] + sys.argv[2:]
runpy.run_path(script, run_name="__main__")
