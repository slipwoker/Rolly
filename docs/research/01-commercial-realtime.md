# 01 — Commercial real-time speech-to-speech APIs ("Architecture A", the quality baseline)

Research date / access date for every source: **2026-11-24**.
Scope: commercial conversational voice APIs for a proactive, barge-in capable, Hebrew + English in-car companion with 30-minute sessions and thousands of concurrent users.

## 0. Read this first

### 0.1 What could and could not be checked

This research session ran behind a network allowlist. Most vendor documentation hosts were **blocked** and could not be fetched: `developers.openai.com`, `platform.openai.com`, `openai.com`, `ai.google.dev`, `docs.cloud.google.com`, `elevenlabs.io`, `deepgram.com`, `hume.ai`, `aws.amazon.com`, `learn.microsoft.com`, `azure.microsoft.com`, `docs.x.ai`, `cartesia.ai`, `vapi.ai`, `retellai.com`, `ultravox.ai`, `artificialanalysis.ai`.

Reachable primary sources, which were read directly:

- `cloud.google.com` — the Google Cloud generative AI pricing page (Live API prices and billing rules).
- PyPI — the official SDK packages `openai` 3.58.0 and `google-genai` 3.6.1 (type definitions, docstrings, connection code).
- `raw.githubusercontent.com` — `google-gemini/cookbook` (official Live API samples), `VapiAI/docs`, `BerriAI/litellm` (third-party price registry), `fixie-ai/ultravox`.
- `huggingface.co` — the official Ultravox model card.

Everything else comes from web-search result summaries of the vendor pages. Those are marked **[UNVERIFIED]** even when the underlying page is official, because the page itself was not read. To close the gap, allow the hosts above in the session network settings and re-run the checks listed in section 9.

### 0.2 Claim tags

| Tag | Meaning |
| --- | --- |
| **[VERIFIED-official]** | Read directly today in an official vendor source (pricing page, official SDK package, official sample repo, official model card). |
| **[PUBLISHED-thirdparty]** | Published by a third party (price registry, benchmark, news, forum post). Not confirmed against the vendor. |
| **[ESTIMATE]** | My own arithmetic or inference from the stated assumptions. |
| **[UNVERIFIED]** | The official page could not be fetched; the claim is known only from a search-result summary, or sources conflict. |

### 0.3 Headline findings

1. The landscape moved since mid-2026. OpenAI now has **two** voice APIs: the token-priced Realtime API (`gpt-realtime-2.1`, `gpt-realtime-2.1-mini`) and a new full-duplex **GPT-Live** API (`gpt-live-1`, `gpt-live-1.1`) on a separate endpoint, priced flat per minute. [VERIFIED-official: both model families and both endpoints are in the `openai` 3.58.0 SDK]
2. `gpt-realtime` and `gpt-realtime-mini` are **deprecated, shutdown 2027-01-20**. Do not build the POC on them. [VERIFIED-official: SDK docstring]
3. Google's current model is **`gemini-3.8-live`**. Audio is $3.00 in / $12.00 out per 1M tokens at 25 tokens per second, with **no cached-input price**, and the whole session context is re-billed every turn. [VERIFIED-official: Google Cloud pricing page]
4. Because of point 3, Gemini's cost per minute rises steeply through a long session. My estimate is about $0.02 in minute 1 but about $0.23 averaged over 30 minutes without context compression. [ESTIMATE]
5. Hebrew is the weak point everywhere. No vendor publishes Hebrew quality numbers. Google lists Hebrew for 3.8 Live, but a developer-forum thread reports a Hebrew regression. OpenAI publishes no Hebrew statement for either API; community reports are mixed. [UNVERIFIED / PUBLISHED-thirdparty, see sections 2 and 3]
6. No commercial speech-to-speech API reaches the $0.01, $0.005 or $0.001 per minute targets. The $0.05 target is reachable with three options (section 5). [ESTIMATE]

## 1. Comparison table

Cost columns use the assumptions in section 4. "Min 1" is the first minute of a session; "30-min avg" is the mean per-minute cost over a 30-minute session.

| Provider / model ID | Type | List price | Est. $/min, min 1 | Est. $/min, 30-min avg | Hebrew | Session limit |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI Realtime `gpt-realtime-2.1` | Native S2S, turn-based | Audio $32 in / $0.40 cached / $64 out per 1M; text $4 / $0.40 / $24 [PUBLISHED-thirdparty] | $0.060 cached, $0.099 uncached [ESTIMATE] | $0.077 ideal cache; $1.45 with no caching [ESTIMATE] | Not stated by OpenAI; mixed community reports [UNVERIFIED] | 60 min [UNVERIFIED] |
| OpenAI Realtime `gpt-realtime-2.1-mini` | Native S2S, turn-based | Audio $10 / $0.30 / $20 per 1M; text $0.60 / $0.06 / $2.40 [PUBLISHED-thirdparty] | $0.017 cached, $0.027 uncached [ESTIMATE] | $0.030 ideal cache; $0.45 with no caching [ESTIMATE] | Same as above [UNVERIFIED] | 60 min [UNVERIFIED] |
| OpenAI GPT-Live `gpt-live-1`, `gpt-live-1.1` | Native S2S, full duplex | $0.05/min active, $0.02/min standby (WebRTC only) [UNVERIFIED] | $0.050 [ESTIMATE] | $0.050 [ESTIMATE] | No language list published [UNVERIFIED] | A limit exists; value not found [VERIFIED-official that it exists] |
| Google `gemini-3.8-live` | Native S2S, turn-based | Audio $3 in / $12 out per 1M; text $0.75 / $4.50; no cache price [VERIFIED-official] | $0.019 [ESTIMATE] | $0.23 no compression; $0.17 cookbook compression; $0.06 tight window [ESTIMATE] | Listed as supported (`he`); regression reported [UNVERIFIED / PUBLISHED-thirdparty] | 15 min audio without compression; about 10 min per connection [UNVERIFIED] |
| ElevenLabs Agents | Cascade (STT + LLM + TTS) | $0.08/min + LLM [PUBLISHED-thirdparty] | about $0.09 [ESTIMATE] | about $0.09–0.10 [ESTIMATE] | Likely yes, depends on TTS model [UNVERIFIED] | Not checked |
| Deepgram Voice Agent API | Cascade | $0.075/min standard; $0.065 BYO TTS [PUBLISHED-thirdparty, sources conflict] | $0.075 [ESTIMATE] | $0.075 [ESTIMATE] | STT yes (Nova-3 `he`); TTS not confirmed [UNVERIFIED] | Not checked |
| Hume EVI (3, 4-mini) | Native S2S | about $0.02–0.06/min by plan [PUBLISHED-thirdparty] | $0.02–0.06 [ESTIMATE] | $0.02–0.06 [ESTIMATE] | No — not in the published list [PUBLISHED-thirdparty] | Not checked |
| Amazon Nova 2 Sonic (`amazon.nova-2-sonic-v1:0`) | Native S2S | Speech $3 in / $12 out per 1M; text $0.33 / $2.75 [PUBLISHED-thirdparty] | $0.009–0.023 audio only [ESTIMATE] | Unknown; depends on context billing [UNVERIFIED] | No — 7 languages, no Hebrew [UNVERIFIED] | Not confirmed |
| Azure Voice Live | Managed wrapper over OpenAI realtime / Azure Speech | Token-based tiers (Pro / Standard / Lite); current rates not retrievable [UNVERIFIED] | Not computable | Not computable | Yes — listed [UNVERIFIED] | 30 min reported for Azure OpenAI realtime [PUBLISHED-thirdparty] |
| xAI Grok Voice (`grok-voice-3.0`) | Native S2S | $0.08/min; some pages still say $0.05 [PUBLISHED-thirdparty, conflict] | $0.05–0.08 [ESTIMATE] | $0.05–0.08 [ESTIMATE] | Unknown ("25+ languages", no list) [UNVERIFIED] | Not checked |
| Cartesia Line | Cascade | $0.03 or $0.06/min + LLM [UNVERIFIED, conflict] | $0.035–0.07 [ESTIMATE] | $0.04–0.08 [ESTIMATE] | TTS yes; streaming STT reportedly English-only [UNVERIFIED / PUBLISHED-thirdparty] | Not checked |
| Vapi (orchestrator) | Cascade or S2S pass-through | $0.05/min hosting + STT + LLM + TTS [PUBLISHED-thirdparty] | $0.08–0.13 [PUBLISHED-thirdparty] | $0.08–0.13 [PUBLISHED-thirdparty] | Depends on chosen components | Not checked |
| Retell AI (orchestrator) | Cascade | $0.07–0.31/min [PUBLISHED-thirdparty] | about $0.125 typical [PUBLISHED-thirdparty] | about $0.125 [PUBLISHED-thirdparty] | "55+ languages", Hebrew not named [UNVERIFIED] | Not checked |
| Ultravox Realtime (hosted) | Speech-in LLM + TTS | $0.05/min [UNVERIFIED] | $0.050 [ESTIMATE] | $0.050 [ESTIMATE] | No — `he` absent from the v0.7 model card [VERIFIED-official] | Not checked |

## 2. OpenAI

### 2.1 Realtime API (token-priced, turn-based)

**Models.** The session `model` field in the official SDK accepts: `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime`, `gpt-realtime-2025-08-28`, `gpt-realtime-mini`, `gpt-realtime-mini-2025-10-06`, `gpt-realtime-mini-2025-12-15`, plus older `gpt-4o-realtime-preview*` IDs. [VERIFIED-official: `openai` 3.58.0, `types/realtime/realtime_session_create_request.py`]

**Deprecations.** `gpt-realtime`, `gpt-realtime-2025-08-28`, `gpt-realtime-mini` and `gpt-realtime-mini-2025-12-15` have an announced shutdown date of 2027-01-20. [VERIFIED-official: same file]

**Release.** `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` were released in early July 2026 (sources say July 6 or July 9). OpenAI describes 2.1 as better at letters and numbers, at silence and noise, and at responding naturally to interruptions. [UNVERIFIED: search summary of the OpenAI model page; PUBLISHED-thirdparty for dates]

**Prices per 1M tokens.**

| Model | Text in | Cached text in | Text out | Audio in | Cached audio in | Audio out |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-realtime-2.1` | $4.00 | $0.40 | $24.00 | $32.00 | $0.40 | $64.00 |
| `gpt-realtime-2.1-mini` | $0.60 | $0.06 | $2.40 | $10.00 | $0.30 | $20.00 |
| `gpt-realtime-1.5` | $4.00 | $0.40 | $16.00 | $32.00 | $0.40 | $64.00 |

[PUBLISHED-thirdparty: LiteLLM `model_prices_and_context_window.json`, fetched today. The audio figures match search summaries of the OpenAI model pages, which are UNVERIFIED because the pages were blocked.]

**Audio token rates.** User audio is 1 token per 100 ms (600 tokens per minute of speech). Assistant audio is 1 token per 50 ms (1,200 tokens per minute of speech). [UNVERIFIED: search summary of OpenAI's realtime-costs guide]

**Context window.** `gpt-realtime-2.1` and the mini: 128,000 tokens in, 32,000 out. [PUBLISHED-thirdparty: LiteLLM; UNVERIFIED search summary of the model page agrees]

**How billing accumulates.** Usage is reported per response, and "output from previous turns (text and audio tokens) will become the input for later turns". Cached tokens are counted as a subset of input tokens, with separate cached audio, text and image counts. [VERIFIED-official: `realtime_response_usage.py`, `realtime_response_usage_input_token_details.py`]

**Transports.** WebSocket (`/realtime`), WebRTC and SIP. The SDK has `realtime.connect()` for WebSocket, `realtime.calls` for call control, and `client_secrets` for ephemeral browser tokens. Some events are documented as "WebRTC/SIP only". [VERIFIED-official: `resources/realtime/`, `output_audio_buffer_clear_event.py`]

**Audio formats.** `audio/pcm` at 24 kHz only, `audio/pcmu` (G.711 μ-law) and `audio/pcma` (G.711 A-law). [VERIFIED-official: `realtime_audio_formats.py`]

**Turn detection.** [VERIFIED-official: `realtime_audio_input_turn_detection.py`]

- `server_vad`: `threshold` (default 0.5), `prefix_padding_ms` (default 300), `silence_duration_ms` (default 500), `create_response`, `interrupt_response`, and `idle_timeout_ms`.
- `semantic_vad`: `eagerness` of `low`, `medium`, `high` or `auto`, with maximum timeouts of 8 s, 4 s and 2 s. It uses a turn-detection model to judge whether the user has finished.
- `null` turns detection off; the client then commits audio and requests responses manually.
- `idle_timeout_ms` makes the model speak after user silence and emits `input_audio_buffer.timeout_triggered`. It is supported in `server_vad` mode only. This is directly useful for a proactive companion.

**Interruption and truncation.** [VERIFIED-official: SDK docstrings]

- With `interrupt_response: true`, a VAD start event cancels the in-progress response.
- `input_audio_buffer.speech_started` is the client's signal to stop local playback.
- `conversation.item.truncate` (`item_id`, `content_index: 0`, `audio_end_ms`) tells the server how much audio the user actually heard. The server generates audio faster than real time, and truncation also deletes the unheard transcript from context.
- `response.cancel` cancels a response manually.
- `output_audio_buffer.clear` is WebRTC/SIP only. On WebSocket the client owns the playback buffer.

**Context truncation.** `truncation` is `auto`, `disabled`, or `{type: "retention_ratio", retention_ratio, token_limits: {post_instructions}}`. Truncating busts the prompt cache for the next turn; a retention ratio below 1 amortises that. The docstring calls a lower token limit "an effective way to control token usage and cost". [VERIFIED-official: `realtime_truncation_retention_ratio.py`, `realtime_session_create_request.py`]

**Input noise reduction.** `near_field` or `far_field`. `far_field` is the relevant setting for a car cabin microphone. [VERIFIED-official: `noise_reduction_type.py`, `realtime_audio_config_input.py`]

**Tool calling.** Function tools, MCP tools, `tool_choice`, and `parallel_tool_calls` (reasoning models only). Reasoning effort is `minimal` to `xhigh`. [VERIFIED-official: SDK types]

**Voices.** `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`, or a custom voice ID. OpenAI recommends `marin` and `cedar`. The voice cannot change once audio has been produced. [VERIFIED-official: `realtime_audio_config_output.py`]

**Input transcription.** It is asynchronous, runs through a separate transcription model, and "should be treated as guidance ... rather than precisely what the model heard". Options include `gpt-transcribe`, `gpt-live-transcribe` and `gpt-realtime-whisper`; `whisper-1` and the `gpt-4o-*-transcribe` models shut down 2027-02-26. It accepts a `language` hint in ISO-639-1. It is billed separately. [VERIFIED-official: `audio_transcription.py`, `realtime_audio_config_input.py`]

**Session length.** 60 minutes maximum, up from 30. [UNVERIFIED: search summary of OpenAI's "Developer notes on the Realtime API"; a third-party host lists 60 minutes for the 2.1 family]

**Hebrew.** OpenAI publishes no Hebrew statement for the realtime models that I could find. [UNVERIFIED] Evidence found:

- A developer reported `gpt-realtime` (v1) as "one of the best speech-to-speech models available" for Hebrew, and a noticeable drop in pronunciation quality on `gpt-realtime-1.5`, which made the team revert. [PUBLISHED-thirdparty: OpenAI community forum, single report]
- A LiveKit thread about a Hebrew agent on `gpt-realtime-2.1` reports inaccurate input transcripts although the model understood correctly. The suggested fix was a separate STT. [PUBLISHED-thirdparty]
- Microsoft's Voice Live language page lists Hebrew as supported for `gpt-realtime` and `gpt-realtime-mini`. [UNVERIFIED: search summary of the Microsoft page]
- Note the v1 model those good reports refer to is the one being shut down in January 2027.

**Data terms.** `/v1/realtime`: not used for training, 30-day abuse-monitoring retention, no application state, eligible for Zero Data Retention. ZDR needs prior approval from OpenAI. [UNVERIFIED: search summary of OpenAI's "your data" guide; the table could not be read directly]

### 2.2 GPT-Live API (flat per-minute, full duplex) — new

**What it is.** A separate API at `/live/sessions`, with models `gpt-live-1` and `gpt-live-1.1`. [VERIFIED-official: `openai` 3.58.0, `resources/live/`, `types/live/session_config.py`] Released in the API on 2026-09-10. [UNVERIFIED: search summary of OpenAI's announcement]

**Price.** $0.05 per minute active, billed per second with no rounding up. `gpt-live-1.1` adds a $0.02 per minute standby rate while inference is paused. Backend model and tool usage is billed separately. Creating a WebRTC session bills 15 seconds. [UNVERIFIED: search summaries of the OpenAI model pages] The SDK confirms the mechanism: usage is reported as `seconds`, `active_seconds` and `paused_seconds`, and pausing via `idle_timeout_s` applies to WebRTC sessions. [VERIFIED-official: `session_usage.py`, `media_session_config_param.py`]

**Architecture.** The Live model handles the voice conversation. Work it cannot do itself is *delegated* to your application (`client`), to a Responses model, or to the Decisions API. [VERIFIED-official: `session_config.py`]

**No turn events.** The client event list has no cancel, truncate or commit event. Transcripts arrive as deltas that "do not define complete turns". Interruption is handled inside the model. [VERIFIED-official: `client_event.py`, `input_transcript_delta_event.py`]

**Useful for a proactive companion.** [VERIFIED-official: SDK types]

- `session.commentary.append`: give the model something to say (up to 500 tokens).
- `session.thinking.append`: silent context.
- `session.instructions.append`: add developer instructions mid-session (up to 500 tokens).
- Initial instructions up to 16,384 tokens, immutable after startup. Initial text history up to 128 messages and 8,192 tokens by default.

**Transports and audio.** WebSocket, WebRTC and SIP. WebSocket audio is PCM16 mono at 16 or 24 kHz, or G.711. [VERIFIED-official: `audio_format.py`]

**Session limit.** A duration limit exists: `session.closed` has reason `expired` "for the session duration limit", and sessions carry `expires_at`. [VERIFIED-official: `session_closed_event.py`, `session_resource.py`] The value was not found; one blog says about 30 minutes. [UNVERIFIED]

**Concurrency.** 25 concurrent sessions at Tier 1, 50 at Tier 2, 200 at Tier 3, 300 at Tier 4, 500 at Tier 5. [PUBLISHED-thirdparty, citing the OpenAI model page] This is far below "thousands of concurrent users" without a negotiated limit.

**Hebrew.** No published language list. The 1.1 update names better accents in French, German, Hindi, Mexican Spanish, Korean and Japanese only. [PUBLISHED-thirdparty] Hebrew support is unknown. [UNVERIFIED]

**Data terms.** `/v1/live/sessions` is listed as ZDR-eligible "with limitations"; sessions are stored only if `store: true`, which defaults to false. [UNVERIFIED for the ZDR row; VERIFIED-official for the `store` default]

## 3. Google Gemini Live API

**Models.** [VERIFIED-official unless noted]

- `gemini-3.8-live` — the model used by Google's own cookbook samples. On Google Cloud it is priced as "Gemini 3.8 Live API". [cookbook `quickstarts/Get_started_LiveAPI.py`; Google Cloud pricing page]
- `gemini-3.8-live-extended-thinking` — reasons while speaking. [cookbook WebSocket notebook model selector]
- `gemini-3.1-flash-live-preview` — previous preview. Reported retired from the Gemini Developer API on 2026-11-17. [PUBLISHED-thirdparty]
- `gemini-live-2.5-flash-native-audio` — earlier GA model on Google Cloud, discontinuation date 2026-12-13. [PUBLISHED-thirdparty: LiteLLM; UNVERIFIED search summary of the Google Cloud model page agrees]
- 3.8 Live launched in mid-September 2026 (sources say September 15 or 24) and is labelled stable. [UNVERIFIED]

**Naming.** Google Cloud now calls Vertex AI the "Gemini Enterprise Agent Platform" in SDK and docs text. [VERIFIED-official: `google-genai` 3.6.1 docstrings]

**Prices per 1M tokens — Gemini 3.8 Live API, Google Cloud, "Non-global" row.** [VERIFIED-official: Google Cloud pricing page]

| Item | Price |
| --- | --- |
| Input: text | $0.75 |
| Input: audio | $3.00 |
| Input: video, image | $1.00 |
| Output: text (response and reasoning) | $4.50 |
| Output: audio | $12.00 |
| Cached input | N/A |

The Gemini Developer API is listed at the same rates by a third-party registry. [PUBLISHED-thirdparty: LiteLLM] The `ai.google.dev` pricing page could not be fetched.

**Billing rules.** [VERIFIED-official: Google Cloud pricing page, "Live API Billing Details"]

- Audio converts at 25 tokens per second, input and output.
- Consumption is calculated per turn, where a turn is one user input plus the model's response.
- "Users are charged for all tokens present in the Session Context Window during that turn."
- "Tokens from past turns are re-processed and billed in every new turn, up to the configured context window size limit."
- Audio-to-text transcription, when enabled, is charged at the text output rate.
- Thinking tokens are billed; they are reported in the `thoughts` field of usage metadata.

**Silence.** By default a user turn includes only detected activity, not silence (`TURN_INCLUDES_ONLY_ACTIVITY`). [VERIFIED-official: `google-genai` `TurnCoverage`]

**Session limits.** Audio-only sessions are limited to about 15 minutes without context window compression, and a connection lasts about 10 minutes. Compression extends sessions; session resumption carries state across connections. Resumption handles are valid 2 hours on the Gemini API and 24 hours on Google Cloud. All Live models have a 128k-token context. [UNVERIFIED: search summaries of Google's session-management pages] The mechanisms themselves are confirmed in the SDK: `context_window_compression` (`trigger_tokens`, `sliding_window.target_tokens`), `session_resumption` (`handle`), and a `go_away` server message with `time_left`. [VERIFIED-official]

**A 30-minute session therefore needs both** compression and reconnect-with-resumption logic. [ESTIMATE, from the limits above]

**Barge-in.** Default `activity_handling` is `START_OF_ACTIVITY_INTERRUPTS`: user speech cuts off the model's response. The server sends `server_content.interrupted = true`, which is the signal to stop and empty the playback queue. [VERIFIED-official: `ActivityHandling`, `LiveServerContent`] VAD is tunable through `automatic_activity_detection` (start and end sensitivity, `prefix_padding_ms`, `silence_duration_ms`) or can be disabled in favour of client `activity_start` / `activity_end` signals. [VERIFIED-official]

**Proactive audio.** `proactivity.proactive_audio`: "the model can reject responding to the last prompt ... ignore out of context speech or ... stay silent if the user did not make a request". [VERIFIED-official] In 3.8 Live it is reported as on by default and not switchable off. [UNVERIFIED] Note this feature is about *not answering* irrelevant audio. It does not make the model start talking on its own; an app-side trigger is still needed (send `realtimeInput.text` or `clientContent`).

**Affective dialog.** `enable_affective_dialog` exists in the SDK. [VERIFIED-official] For 3.8 Live, sources conflict: Google's developer guide reportedly says it is on by default, other write-ups say the flag was removed. [UNVERIFIED]

**Tool calling.** Function declarations and Google Search work in Live sessions; code execution is not supported. The model blocks until the client returns a `toolResponse`. [VERIFIED-official: cookbook WebSocket notebook]

**Hebrew.**

- Google's 3.8 Live model page lists Hebrew (`he`) among supported languages. [UNVERIFIED: search summary]
- Google says 3.8 Live switches automatically among 97 languages. [PUBLISHED-thirdparty: TechRepublic]
- A Google AI developer-forum thread titled "Gemini Live 3.8 feels like a regression for Hebrew" reports that the model fails to understand common words such as "כן" and repeatedly asks the user to repeat. Staff asked for a sample recording; no fix is recorded. [PUBLISHED-thirdparty: single user report]
- Other forum threads report accent drift mid-sentence and session drops (1011 / 1008) on 3.8 Live. [PUBLISHED-thirdparty]
- The fallback models are disappearing: 3.1 Flash Live is reported retired and 2.5 native audio ends 2026-12-13.

**Scale.** 1,000 concurrent sessions per project by default on Google Cloud for the 2.5 native-audio model; the 3.8 figure was not found. The Gemini Developer API does not publish a concurrent-session number. [UNVERIFIED]

**Data terms.** On Google Cloud, zero data retention is available if session resumption is left off; resumption caches text, audio and outputs for up to 24 hours. [UNVERIFIED: search summary of Google's data-governance page] The 30-minute design needs resumption, so it conflicts with strict zero retention on Google Cloud. [ESTIMATE]

## 4. Cost arithmetic

### 4.1 Assumptions

- One connected minute = 24 s user speech (40%), 24 s agent speech (40%), 12 s silence (20%).
- 4 turns per minute: each turn is a 6 s user utterance and a 6 s agent reply. Realtime APIs bill the context once per response, so the turn count matters; a 2-turn sensitivity is in 4.5.
- System prompt + memory = 1,500 text tokens, sent as input on every turn.
- Agent transcript ≈ 20 text tokens per 6 s reply (80 per minute), billed as text output.
- Silence is not billed as audio input (server VAD commits only speech; Gemini default excludes inactivity).
- History kept in context as audio: user audio at the input rate, agent audio at the output rate. For Gemini this is an assumption; if agent audio is not re-billed, see 4.4.
- Not included: input transcription, tool calls, reasoning or thinking tokens, telephony, your own servers.
- "Ideal cache" for OpenAI = everything already sent in the previous request is billed at the cached rate; only the last agent reply and the new user audio are uncached. Real cache hit rates are lower; see 4.5.

All figures in this section are [ESTIMATE] built on the prices in sections 2 and 3.

### 4.2 OpenAI `gpt-realtime-2.1`, minute 1

Per-turn tokens: user audio 6 s × 10 = 60; agent audio 6 s × 20 = 120; agent text 20.

Input per turn (text / audio):

| Turn | Text in | Audio in |
| --- | --- | --- |
| 1 | 1,500 | 60 |
| 2 | 1,520 | 240 |
| 3 | 1,540 | 420 |
| 4 | 1,560 | 600 |
| Sum | 6,120 | 1,320 |

Without caching:

- Text in: 6,120 × $4 / 1M = $0.02448
- Audio in: 1,320 × $32 / 1M = $0.04224
- Audio out: 480 × $64 / 1M = $0.03072
- Text out: 80 × $24 / 1M = $0.00192
- **Total = $0.0994 per minute**

With ideal caching:

- Turn 1 (nothing cached): 1,500 × $4/1M + 60 × $32/1M = $0.00792
- Turn 2: cached 1,560 × $0.40/1M = $0.00062; uncached 20 × $4/1M + 180 × $32/1M = $0.00584; total $0.00646
- Turn 3: cached 1,760 × $0.40/1M = $0.00070; uncached $0.00584; total $0.00654
- Turn 4: cached 1,960 × $0.40/1M = $0.00078; uncached $0.00584; total $0.00662
- Input sum $0.02755 + output $0.03264 = **$0.0602 per minute**

### 4.3 Over a 30-minute session

History grows by 800 tokens per minute (240 user audio + 480 agent audio + 80 text), reaching 24,000 tokens at minute 30. That fits the 128k window, so no truncation is forced.

| Model, setting | Min 1 | Min 10 | Min 30 | 30-min avg | 30-min session |
| --- | --- | --- | --- | --- | --- |
| `gpt-realtime-2.1`, no caching | $0.099 | $0.940 | $2.809 | $1.454 | $43.63 |
| `gpt-realtime-2.1`, ideal cache | $0.060 | $0.070 | $0.096 | $0.077 | $2.32 |
| `gpt-realtime-2.1-mini`, no caching | $0.027 | $0.288 | $0.867 | $0.447 | $13.41 |
| `gpt-realtime-2.1-mini`, ideal cache | $0.017 | $0.026 | $0.043 | $0.030 | $0.91 |
| `gpt-live-1` / `gpt-live-1.1` (flat, WebSocket) | $0.050 | $0.050 | $0.050 | $0.050 | $1.50 |

Why the uncached number explodes: at minute 30 each turn re-sends about 21,600 audio tokens of history. At $32 per 1M that is $0.69 per turn; at the cached $0.40 per 1M it is $0.009.

GPT-Live arithmetic: 60 s × ($0.05 / 60) = $0.05 per connected minute regardless of who is speaking. Over WebSocket there is no standby rate, so silence costs the same as speech. A 1,500-token memory fits inside the 16,384-token instruction allowance at no extra charge. Delegated backend calls are extra.

### 4.4 Google `gemini-3.8-live`

Per-turn tokens: user audio 6 s × 25 = 150; agent audio 6 s × 25 = 150. No cached price exists, so "with caching" equals "without caching".

Minute 1:

- Text in: 4 × 1,500 = 6,000 × $0.75 / 1M = $0.00450 (plus $0.00009 for transcript text carried in history)
- Audio in: turn inputs of 150 + 450 + 750 + 1,050 = 2,400 × $3 / 1M = $0.00720
- Audio out: 600 × $12 / 1M = $0.00720
- Text out (transcription): 80 × $4.50 / 1M = $0.00036
- **Total = $0.0194 per minute**

Over 30 minutes, history grows by 1,200 audio tokens per minute and is re-billed at $3 per 1M on each of 4 turns:

| Setting | Min 1 | Min 10 | Min 30 | 30-min avg | 30-min session |
| --- | --- | --- | --- | --- | --- |
| No compression | $0.019 | $0.151 | $0.444 | $0.232 | $6.95 |
| Cookbook compression (trigger 25,600, target 12,800) | $0.019 | $0.151 | $0.144 | $0.170 | $5.11 |
| Tight window (trigger 8,000, target 4,000) | $0.019 | $0.056 | $0.063 | $0.059 | $1.76 |
| No compression, agent audio not re-billed | $0.017 | $0.084 | $0.232 | $0.125 | $3.74 |

Notes:

- The cookbook settings do not trigger until about minute 20, so they barely help a 30-minute session.
- The tight window keeps only about 100 seconds of audio in context. Conversation memory then has to come from a rolling text summary that the app injects. Whether 8,000 is an allowed `trigger_tokens` value was not verified. [UNVERIFIED]
- The audio-only floor, with zero context, is 600 × $3/1M + 600 × $12/1M = **$0.009 per minute**. That alone is already at the $0.01 target.

### 4.5 Sensitivity

2 turns per minute (12 s each) instead of 4:

| Model, setting | Min 1 | 30-min avg |
| --- | --- | --- |
| `gpt-realtime-2.1`, ideal cache | $0.055 | $0.066 |
| `gpt-realtime-2.1-mini`, ideal cache | $0.016 | $0.024 |
| `gemini-3.8-live`, no compression | $0.013 | $0.120 |
| `gemini-3.8-live`, tight window | $0.013 | $0.033 |

Imperfect caching on OpenAI (linear mix of the ideal and uncached cases), 30-minute average:

| Cache effectiveness | `gpt-realtime-2.1` | `gpt-realtime-2.1-mini` |
| --- | --- | --- |
| 100% | $0.077 | $0.030 |
| 90% | $0.215 | $0.072 |
| 80% | $0.353 | $0.114 |
| 50% | $0.766 | $0.239 |

This is the main cost risk on OpenAI. Bounding the context limits the exposure. With `truncation` set to keep about 8,000 post-instruction tokens:

| Cache effectiveness | `gpt-realtime-2.1` | `gpt-realtime-2.1-mini` |
| --- | --- | --- |
| 100% | $0.083 | $0.027 |
| 90% | $0.132 | $0.042 |
| 80% | $0.180 | $0.057 |

For reference, Vapi's own cost estimator assumes a 50% cache hit rate for models that support caching. [VERIFIED-official: VapiAI/docs `understanding-cost.mdx`] The POC should log `cached_tokens` from every `response.done` to measure the real rate.

### 4.6 Other providers

All [ESTIMATE] on the list prices in section 1.

- **ElevenLabs Agents:** $0.08 × 1 connected minute = $0.08, plus LLM pass-through. With a small LLM at about $0.15–0.60 per 1M input tokens and roughly 4 × (1,500 + history) input tokens per minute, the LLM adds about $0.002–0.02. Total about $0.09–0.10.
- **Deepgram Voice Agent:** $0.075 × 1 = $0.075 on the bundled tier; $0.065 with your own TTS, plus that TTS.
- **Hume EVI:** $0.02–0.06 × 1, by model and plan.
- **Amazon Nova 2 Sonic:** audio only, at 10 tokens/s: (240 × $3 + 240 × $12) / 1M = $0.0036. At 25 tokens/s: (600 × $3 + 600 × $12) / 1M = $0.009. The token rate is not confirmed; third parties quote about $0.015 per minute. If context is re-billed like Gemini's, a 30-minute average would be many times higher.
- **Azure Voice Live:** not computable; current token rates could not be retrieved. With an OpenAI realtime model behind it, expect the section 4.3 figures plus Azure's margin.
- **xAI Grok Voice:** $0.08 × 1 = $0.08 (or $0.05 if the older rate still applies).
- **Cartesia Line:** $0.03 or $0.06 × 1, plus LLM about $0.005–0.02.
- **Vapi:** $0.05 hosting + STT + LLM + TTS; the vendor's calculator is reported at $0.082–0.129 all-in.
- **Retell:** $0.055 infrastructure + LLM + TTS; about $0.125 for a common configuration.
- **Ultravox:** $0.05 × 1 = $0.05, billed in 6-second increments.

### 4.7 Independent measured costs

Artificial Analysis reports cost "per hour of input audio" from its own benchmark runs. This unit is not the same as a connected conversational minute, so compare with care. [PUBLISHED-thirdparty: Artificial Analysis posts and leaderboard, as summarised in search results]

| Model | Reported | Per minute of input audio |
| --- | --- | --- |
| Gemini 3.8 Live | $0.84 / hour | $0.014 |
| Gemini 3.1 Flash Live (High) | $1.75 / hour | $0.029 |
| Gemini 3.8 Live Extended Thinking (High) | $3.50 / hour | $0.058 |
| GPT-Live-1 (Sol, low) | $4.47 / hour | $0.075 |
| GPT-Realtime-2.1 (High) | $10.75 / hour | $0.179 |

A third-party write-up puts a continuous two-way Gemini 3.8 Live call at about $1.38 per hour ($0.023 per minute), from the $0.005 in + $0.018 out per-minute list equivalents. [PUBLISHED-thirdparty] That matches my minute-1 figure and ignores context re-billing.

## 5. Cost targets

| Target | Reachable with a commercial S2S API? |
| --- | --- |
| $0.05 / min | Yes, three ways: `gpt-realtime-2.1-mini` with caching and bounded context (about $0.03–0.06); `gpt-live-1.1` (exactly $0.05); `gemini-3.8-live` with a tight context window (about $0.03–0.06). [ESTIMATE] |
| $0.01 / min | No. Gemini's audio-only floor is $0.009 before any system prompt or history. [ESTIMATE] |
| $0.005 / min | No. [ESTIMATE] |
| $0.001 / min | No. [ESTIMATE] |

The lower three targets need a different architecture (self-hosted or cascaded with on-device components). This architecture serves as the quality ceiling to measure those against.

## 6. Latency figures

| Figure | Source type |
| --- | --- |
| GPT-Live-1: turn-taking latency cut to 0.8 s | Vendor claim, reported by news coverage [PUBLISHED-thirdparty] |
| GPT-Live-1 time to first audio 1.24 s (Sol, low) and 1.34 s (Astra, medium) on Big Bench Audio | Independent measurement, Artificial Analysis [PUBLISHED-thirdparty] |
| OpenAI: p95 latency reduced by at least 25% across Realtime voice models via caching | Vendor claim [UNVERIFIED: search summary] |
| Gemini 2.5 Flash Native Audio Dialog time to first audio 0.63 s | Independent, Artificial Analysis [PUBLISHED-thirdparty] |
| Grok Voice Think Fast 2.0 (High) 0.70 s; Eleven Realtime v1 Max 0.57 s; Phonic 1 (High) 0.61 s; Deepslate Opal 0.44 s | Independent, Artificial Analysis [PUBLISHED-thirdparty] |
| Gemini 3.8 Live time to first audio | Not found |
| `gpt-realtime-2.1` time to first audio | Not found |
| "300–500 ms" for both OpenAI and Gemini Live; "OpenAI about 8× faster than Gemini Live" | Conflicting blog claims [UNVERIFIED] |

Artificial Analysis also notes that listener preference in its Speech Agent Arena rises as time to first audio falls. [PUBLISHED-thirdparty] None of these numbers are for Hebrew or for a mobile network in a moving car. The POC must measure its own.

## 7. Recommendation

**Use two baselines, on one shared server-side audio harness:**

1. **OpenAI Realtime API — `gpt-realtime-2.1`**, with `gpt-realtime-2.1-mini` as the cost variant on the same code path.
2. **Google Gemini Live API — `gemini-3.8-live`.**

**Why these two.**

- They are the two current-generation native speech-to-speech models with a documented server-side WebSocket protocol, tool calling, and barge-in. [VERIFIED-official: SDKs]
- Hebrew is decisive and unproven on both, and the evidence points in opposite directions: Google lists Hebrew officially but has a regression report on the current model; OpenAI lists nothing but has positive (and mixed) developer reports. Testing both is the only way to settle it. [ESTIMATE]
- They bracket the cost range: about $0.06–0.10 per minute for `gpt-realtime-2.1`, about $0.02–0.06 for the mini and for Gemini with a tight window. [ESTIMATE]
- OpenAI gives the most explicit interruption control (`conversation.item.truncate` keeps the model's memory aligned with what the driver actually heard) and a `far_field` noise-reduction mode suited to a car. [VERIFIED-official]
- Gemini has the lowest list price and a built-in "do not answer irrelevant speech" behaviour, useful with passengers and radio in the cabin. [VERIFIED-official for the feature]

**Add a third, short spike: `gpt-live-1.1`.** It is full duplex, costs exactly the $0.05 target with no caching risk, and has purpose-built events for making the agent speak proactively. It is not a primary baseline because Hebrew support is undocumented, the session limit is unknown, and the published concurrency caps top out at 500. Spend an hour on a Hebrew smoke test before investing more. [ESTIMATE]

**Not recommended as baselines.** Nova Sonic, Hume EVI and Ultravox do not list Hebrew. Grok Voice does not publish its language list. ElevenLabs, Deepgram, Cartesia, Vapi and Retell are cascades or orchestrators; they belong in the cascaded-architecture comparison, where ElevenLabs and Cartesia Hebrew TTS are worth testing.

**What the POC must measure, because nobody publishes it.**

- Hebrew comprehension on short words ("כן", "לא", numbers, street names) and Hebrew–English code-switching, with road noise.
- Hebrew speech naturalness and accent, by blind listening with native speakers.
- Time to first audio and barge-in stop time over a mobile connection.
- Actual billed cost per minute over full 30-minute sessions, including `cached_tokens` on OpenAI and `usageMetadata` on Gemini.

## 8. Implementation notes for the top two (WebSocket, server-side)

### 8.1 OpenAI Realtime API

All items [VERIFIED-official] from the `openai` 3.58.0 SDK unless tagged otherwise.

**Connect**

```
wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1
Authorization: Bearer $OPENAI_API_KEY
```

The SDK builds the URL as base URL + `/realtime` with `model` as a query parameter, and sends only the bearer header (no beta header). Each client message is limited to 15 MiB of audio per append event.

**Session configuration** — sent as `session.update` after the server's `session.created`:

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "instructions": "<system prompt + memory>",
    "output_modalities": ["audio"],
    "audio": {
      "input": {
        "format": {"type": "audio/pcm", "rate": 24000},
        "noise_reduction": {"type": "far_field"},
        "transcription": {"model": "gpt-transcribe", "language": "he"},
        "turn_detection": {
          "type": "semantic_vad",
          "eagerness": "auto",
          "create_response": true,
          "interrupt_response": true
        }
      },
      "output": {
        "format": {"type": "audio/pcm", "rate": 24000},
        "voice": "marin"
      }
    },
    "tools": [],
    "tool_choice": "auto",
    "truncation": {
      "type": "retention_ratio",
      "retention_ratio": 0.8,
      "token_limits": {"post_instructions": 8000}
    }
  }
}
```

`voice` and `model` cannot be changed by a later update once audio has been produced. `reasoning: {"effort": ...}` is available on reasoning models. The specific values above are a starting point, not a tested configuration. [ESTIMATE]

**Client events**

| Purpose | Event |
| --- | --- |
| Stream microphone audio | `input_audio_buffer.append` with base64 `audio` (no acknowledgement) |
| Manual turn end (VAD off) | `input_audio_buffer.commit`, then `response.create` |
| Make the agent speak (proactive) | `response.create`, optionally with per-response `instructions` |
| Inject text or tool output | `conversation.item.create` (for tools: item type `function_call_output` with `call_id` and `output`), then `response.create` |
| Stop the current reply | `response.cancel` |
| Tell the server what was actually heard | `conversation.item.truncate` with `item_id`, `content_index: 0`, `audio_end_ms` |

**Server events**

| Purpose | Event |
| --- | --- |
| Session lifecycle | `session.created`, `session.updated`, `error`, `rate_limits.updated` |
| User started / stopped speaking | `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`, `input_audio_buffer.committed` |
| Idle timeout fired | `input_audio_buffer.timeout_triggered` |
| Agent audio | `response.output_audio.delta` (base64), `response.output_audio.done` |
| Agent transcript | `response.output_audio_transcript.delta`, `.done` |
| User transcript | `conversation.item.input_audio_transcription.delta`, `.completed`, `.failed` |
| Tool call | `response.function_call_arguments.delta`, `.done` |
| Turn finished, with usage | `response.done` (`usage.input_token_details.cached_tokens` and audio/text splits) |
| Truncation acknowledged | `conversation.item.truncated` |

**Barge-in sequence on WebSocket**

1. Receive `input_audio_buffer.speech_started`.
2. Stop playback immediately and drop queued audio. Note how many milliseconds of the current item were played.
3. The server cancels the response itself when `interrupt_response` is true; otherwise send `response.cancel`.
4. Send `conversation.item.truncate` with the played duration.

`output_audio_buffer.clear` is for WebRTC and SIP only.

### 8.2 Google Gemini Live API

Items are [VERIFIED-official] from `google-genai` 3.6.1 and the `google-gemini/cookbook` samples unless tagged otherwise.

**Connect — Gemini Developer API**

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
x-goog-api-key: $GEMINI_API_KEY
```

The cookbook passes the key as `?key=` in the URL instead; the SDK sends the header. Model name: `models/gemini-3.8-live`.

**Connect — Google Cloud**

```
wss://{location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent
Authorization: Bearer <OAuth access token>
```

Model name: `projects/{project}/locations/{location}/publishers/google/models/gemini-3.8-live`. The host pattern and `v1beta1` default come from the SDK's base-URL code; confirm the regional host for the chosen location. [VERIFIED-official for the path and auth; ESTIMATE for the exact host string]

**First message — `setup`** (JSON, camelCase). Wait for `setupComplete` before sending anything else.

```json
{
  "setup": {
    "model": "models/gemini-3.8-live",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": {
        "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Zephyr"}}
      }
    },
    "systemInstruction": {"parts": [{"text": "<system prompt + memory>"}]},
    "tools": [{"functionDeclarations": []}],
    "realtimeInputConfig": {
      "automaticActivityDetection": {"silenceDurationMs": 500},
      "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
      "turnCoverage": "TURN_INCLUDES_ONLY_ACTIVITY"
    },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {},
    "contextWindowCompression": {
      "triggerTokens": 25600,
      "slidingWindow": {"targetTokens": 12800}
    },
    "sessionResumption": {},
    "proactivity": {"proactiveAudio": true}
  }
}
```

The compression values are the ones in Google's cookbook. `speechConfig.languageCode` exists in the SDK; whether 3.8 Live honours it for Hebrew was not verified. [UNVERIFIED] The camelCase spelling of nested fields not shown in the cookbook (`triggerTokens`, `slidingWindow`, `silenceDurationMs`) follows the SDK's field names converted to JSON; check against a live session. [ESTIMATE]

**Client messages**

| Purpose | Message |
| --- | --- |
| Stream microphone audio | `{"realtimeInput": {"audio": {"data": "<base64>", "mimeType": "audio/pcm;rate=16000"}}}` |
| Send text in real time (also a proactive nudge) | `{"realtimeInput": {"text": "..."}}` |
| Append history or a full turn | `{"clientContent": {"turns": [...], "turnComplete": true}}` — this interrupts any current generation |
| Microphone closed | `{"realtimeInput": {"audioStreamEnd": true}}` |
| Manual VAD | `{"realtimeInput": {"activityStart": {}}}` and `{"realtimeInput": {"activityEnd": {}}}` |
| Tool result | `{"toolResponse": {"functionResponses": [{"id": "...", "name": "...", "response": {...}}]}}` |

Input audio is 16-bit PCM mono at 16 kHz; output is 24 kHz PCM. [VERIFIED-official: cookbook constants]

**Server messages**

| Purpose | Field |
| --- | --- |
| Setup acknowledged | `setupComplete` |
| Agent audio | `serverContent.modelTurn.parts[].inlineData.data` (base64 PCM) |
| Barge-in happened | `serverContent.interrupted: true` — stop and empty the playback queue |
| Generation / turn finished | `serverContent.generationComplete`, `serverContent.turnComplete` |
| Model is waiting for more speech | `serverContent.waitingForInput` |
| User transcript | `serverContent.inputTranscription.text` |
| Agent transcript | `serverContent.outputTranscription.text` |
| Tool call / cancel | `toolCall.functionCalls[]` (`id`, `name`, `args`), `toolCallCancellation.ids[]` |
| Usage | `usageMetadata` (`promptTokenCount`, `responseTokenCount`, `thoughtsTokenCount`, per-modality details) |
| Connection about to close | `goAway.timeLeft` |
| Resumption handle | `sessionResumptionUpdate.newHandle`, `.resumable` |

**30-minute session loop**

1. Enable `sessionResumption` and `contextWindowCompression` in `setup`.
2. Store the latest `newHandle` whenever `resumable` is true.
3. On `goAway` or disconnect, open a new WebSocket and send `setup` with `sessionResumption.handle` set to the stored handle.
4. Buffer microphone audio during the switch.

There is no client "cancel" or "truncate" message. Interruption is driven by detected user activity, or by sending `clientContent`.

### 8.3 OpenAI GPT-Live (for the spike)

[VERIFIED-official] from the `openai` 3.58.0 SDK.

- Connect: `wss://api.openai.com/v1/live/sessions` with `Authorization: Bearer $OPENAI_API_KEY`. No query parameters; the model goes in the session config.
- First message: `{"type": "session.start", "session": {"model": "gpt-live-1.1", "instructions": "...", "audio": {"format": {"type": "audio/pcm", "rate": 24000}, "output": {"voice": "marin"}}, "delegation": {"type": "client"}}}`. Wait for `session.started`.
- Audio in: `session.input_audio.append` with base64 `audio`. Audio out: `session.output_audio.delta` with base64 `delta`.
- Transcripts: `session.input_transcript.delta`, `session.output_transcript.delta` (with `start_ms` / `end_ms`; no "done" event).
- Make the agent say something: `session.commentary.append`. Silent context: `session.thinking.append`. New instructions: `session.instructions.append`.
- Tools: `session.delegation.created` carries a delegation ID; reply with a commentary or instructions append that references it.
- Mute: `session.input_audio.mute` / `.unmute`. Usage: `session.usage.updated`. End: `session.close` → `session.closed`.
- Open question: how fast the server delivers audio over WebSocket, and so how much the client must discard locally when the user interrupts. The SDK does not say.

## 9. Open items to verify once the vendor hosts are reachable

1. OpenAI pricing page: confirm all `gpt-realtime-2.1` / mini rates, the GPT-Live active and standby rates, and audio tokens per second.
2. OpenAI: Realtime maximum session length; GPT-Live maximum session length; Realtime concurrency limits by tier; ZDR rows for `/v1/realtime` and `/v1/live/sessions`.
3. OpenAI: any language list for GPT-Live and the realtime models.
4. Google: the `gemini-3.8-live` model page (language list including Hebrew, token limits, proactive audio and affective dialog status), the Gemini Developer API price row, allowed range for `triggerTokens`, concurrency quota for 3.8 Live, and whether agent audio is held in context as audio tokens.
5. Google: status of the Hebrew regression forum thread.
6. Artificial Analysis: time to first audio for Gemini 3.8 Live and `gpt-realtime-2.1`.
7. The secondary providers' official price pages (ElevenLabs, Deepgram, Hume, AWS, Azure, xAI, Cartesia, Retell, Ultravox) and their Hebrew statements.

## 10. Sources

All accessed 2026-11-24.

**Read directly (primary)**

- Google Cloud generative AI pricing (Live API prices and billing rules): https://cloud.google.com/vertex-ai/generative-ai/pricing (served at https://cloud.google.com/model-garden/pricing)
- `openai` Python SDK 3.58.0 (PyPI wheel; `resources/realtime/`, `resources/live/`, `types/realtime/`, `types/live/`): https://pypi.org/project/openai/
- `google-genai` Python SDK 3.6.1 (PyPI wheel; `live.py`, `types.py`, `_live_converters.py`): https://pypi.org/project/google-genai/
- Google Gemini cookbook, Live API sample: https://raw.githubusercontent.com/google-gemini/cookbook/main/quickstarts/Get_started_LiveAPI.py
- Google Gemini cookbook, raw WebSocket notebook: https://raw.githubusercontent.com/google-gemini/cookbook/main/quickstarts/websockets/Get_started_LiveAPI.ipynb
- Ultravox v0.7 model card: https://huggingface.co/fixie-ai/ultravox-v0_7-glm-4_6
- Ultravox repository README: https://raw.githubusercontent.com/fixie-ai/ultravox/main/README.md
- Vapi docs, pricing and cost model: https://raw.githubusercontent.com/VapiAI/docs/main/fern/billing/pricing-and-success-packages.mdx and https://raw.githubusercontent.com/VapiAI/docs/main/fern/assistants/model-intelligence/understanding-cost.mdx

**Read directly (third-party)**

- LiteLLM model price registry: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

**Seen only through search-result summaries (pages blocked in this session)**

OpenAI
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-realtime-2.1
- https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.openai.com/api/docs/models/gpt-live-1.1
- https://developers.openai.com/api/docs/guides/realtime-costs
- https://developers.openai.com/api/docs/guides/voice-latency-cost
- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/docs/guides/your-data
- https://developers.openai.com/blog/realtime-api
- https://openai.com/index/introducing-gpt-live-1-in-the-api/
- https://community.openai.com/t/gpt-realtime-1-5-is-live-in-realtime-api/1374919
- https://community.openai.com/t/realtime-api-not-working-well-in-hebrew/1088205
- https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896
- https://community.openai.com/t/gpt-live-1-1-is-rolling-out-with-new-voices-and-better-accents/1406704
- https://community.livekit.io/t/inaccurate-transcript-despite-correct-realtime-understanding/1829
- https://learn.microsoft.com/en-us/azure/foundry/openai/gpt-live-reference

Google
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/live-api/session-management
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-live
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/start-manage-session
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance
- https://firebase.google.com/docs/ai-logic/live-api/limits-and-specs
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-gemini-3-8-live-extended-thinking/
- https://discuss.ai.google.dev/t/gemini-live-3-8-feels-like-a-regression-for-hebrew/185811
- https://discuss.ai.google.dev/t/3-8-live-accent-drifts-mid-sentence/187193
- https://discuss.ai.google.dev/t/gemini-3-8-live-1011-1008-session-drops-runaway-audio-and-output-transcription-with-unspoken-text/190881
- https://www.techrepublic.com/article/news-gemini-3-8-live-models/
- https://www.developersdigest.tech/blog/gemini-live-tts-retirement-november-2026

Benchmarks
- https://artificialanalysis.ai/speech-to-speech
- https://artificialanalysis.ai/articles/announcing-the-artificial-analysis-speech-to-speech-index
- https://artificialanalysis.ai/articles/announcing-the-speech-agent-arena
- https://x.com/ArtificialAnlys/status/2099977691172888709
- https://x.com/ArtificialAnlys/status/2115836126925901915

Other providers
- ElevenLabs: https://elevenlabs.io/pricing/agents ; https://help.elevenlabs.io/hc/en-us/articles/29298127196945-Which-languages-can-I-use-with-ElevenLabs-Agents-formerly-Conversational-AI ; https://www.stork.ai/blog/elevenlabs-agents-pricing-2026
- Deepgram: https://www.deepgram.com/pricing ; https://deepgram.com/blog/speech-to-text-for-hebrew-persian-urdu-on-nova-3 ; https://developers.deepgram.com/changelog/2026/9/3 ; https://usagepricing.com/blueprint/deepgram
- Hume: https://hume.ai/pricing ; https://dev.hume.ai/docs/speech-to-speech-evi ; https://usagepricing.com/blueprint/hume-ai ; https://rywalker.com/research/hume-evi
- Amazon Nova Sonic: https://aws.amazon.com/bedrock/pricing/ ; https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.md ; https://aws.amazon.com/blogs/aws/introducing-amazon-nova-2-sonic-next-generation-speech-to-speech-model-for-conversational-ai ; https://cloudprice.net/models/amazon-nova-2-sonic ; https://cloudvisor.co/amazon-nova-models-speech-to-speech-agent/
- Azure Voice Live: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-language-support ; https://azure.microsoft.com/en-us/pricing/details/speech/ ; https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/azure-ai-voice-live-api-what%E2%80%99s-new-and-the-pricing-announcement/4428687
- xAI: https://docs.x.ai/developers/pricing ; https://docs.x.ai/developers/models/voice-agent-api ; https://x.ai/api/voice ; https://www.technobezz.com/news/xai-launches-grok-voice-per-minute
- Cartesia: https://cartesia.ai/pricing ; https://docs.cartesia.ai/pricing ; https://cartesia.ai/languages/hebrew ; https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
- Vapi / Retell: https://vapi.ai/pricing ; https://www.retellai.com/comparisons/retell-vs-vapi ; https://dupple.com/learn/vapi-vs-retell-ai
- Ultravox: https://ultravox.ai/pricing ; https://docs.ultravox.ai/gettingstarted
