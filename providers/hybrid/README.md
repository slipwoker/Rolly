# Architecture D — hybrid

There is no separate code: a hybrid is the modular pipeline (`providers/modular/pipeline.py`) with one or more stages
pointed at a commercial API in `config/providers.yaml`.

| Stage | Self-hosted engine | Commercial engine available in code |
|---|---|---|
| STT | `faster_whisper` | `openai_compat` (`/v1/audio/transcriptions`) |
| LLM | any OpenAI-compatible server (vLLM, llama.cpp) | any OpenAI-compatible API (set `ROLLY_HYBRID_LLM_*`) |
| TTS | `sherpa` (Kokoro, Piper), `renikud_piper` (Hebrew) | `openai_compat` (`/v1/audio/speech`), `elevenlabs` |

The predefined `hybrid-apillm` provider keeps speech local and sends only text to a commercial LLM.
The commercial engines were not exercised in the POC session (no API keys).
