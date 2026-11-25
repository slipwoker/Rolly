"""Diagnostics for the BlueV3 voice on a GPU host: which ONNX Runtime provider each graph really uses and how long
one sentence takes, on GPU and on CPU with different thread counts.  Run with the BlueV3 environment's Python."""
import os, sys, time
B = sys.argv[1]
os.environ.setdefault("POLYG2P_DATA", B + "/bundle/frontend/polyg2p_data"); os.environ.setdefault("BLUE_ONNX_PRECISION", "fp32")
import onnxruntime as ort
print("onnxruntime", ort.__version__, "| available:", ort.get_available_providers(), "| cpus visible:", os.cpu_count(), "| affinity:", len(os.sched_getaffinity(0)))
try: print("cgroup cpu.max:", open("/sys/fs/cgroup/cpu.max").read().strip(), "| load:", open("/proc/loadavg").read().strip())
except Exception as e: print("cgroup:", e)
from blue_onnx import BlueTTS
T = "נו, מה קרה עם ששת הראיונות שעוד רצית לקבוע למשפחות?"
def run(label, **kw):
    try:
        t = time.monotonic(); tts = BlueTTS(onnx_dir=B + "/bundle/onnx", style_json=B + "/voice/daniel.json", **kw); load = time.monotonic() - t
    except Exception as e:
        print(label, "LOAD FAILED:", repr(e)[:300]); return
    used = {}
    for name, obj in vars(tts.tts).items():
        if hasattr(obj, "get_providers"): used[name] = obj.get_providers()[0].replace("ExecutionProvider", "")
    times = []
    for _ in range(4):
        t = time.monotonic(); x, sr = tts.synthesize(T, lang="he", speed=1.2); times.append(round(time.monotonic() - t, 2))
    print(f"{label}: load {load:.1f} s | graphs on: {used} | {len(x)/sr:.1f} s of audio in {times} s")
if "CUDAExecutionProvider" in ort.get_available_providers():
    run("GPU, default options", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    run("GPU, heuristic conv search", providers=[("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"])
# where does the time go?  time the Hebrew text front end on its own
try:
    tts = BlueTTS(onnx_dir=B + "/bundle/onnx", style_json=B + "/voice/daniel.json", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    tp = tts.tts.text_processor if hasattr(tts.tts, "text_processor") else None
    for name, obj in list(vars(tts.tts).items()) + (list(vars(tp).items()) if tp else []):
        if "renikud" in name.lower() or "g2p" in name.lower():
            ph = getattr(obj, "phonemize", None)
            if ph:
                ts = []
                for _ in range(3):
                    t = time.monotonic(); ph(T); ts.append(round(time.monotonic() - t, 2))
                print("text front end", name, "alone:", ts, "s")
except Exception as e:
    print("front-end timing failed:", repr(e)[:200])
