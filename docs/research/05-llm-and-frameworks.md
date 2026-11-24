# 05 — LLMs and real-time voice agent frameworks

Research date: **2026-11-24**. All web sources were accessed on that date.

Claim tags used throughout:

- **[VERIFIED-official]** — read today on the vendor's own page, model card, licence file, docs or API.
- **[PUBLISHED-thirdparty]** — read today on a third-party page (benchmark blog, leaderboard, aggregator).
- **[ESTIMATE]** — my own arithmetic or engineering judgement; the inputs are stated.
- **[UNVERIFIED]** — could not be confirmed from a primary source today (page blocked, only a search snippet, or no data exists).

Access limits in this session: `ai.google.dev`, `livekit.com` and `arxiv.org` were refused by the network policy. Google prices were therefore taken from the Vertex AI pricing page on `cloud.google.com`, LiveKit metering rules from `docs.livekit.io`, and the Dicta paper from Dicta's own PDF. LiveKit Cloud plan prices could only be read from third-party pages and are tagged accordingly.

---

## 0. Executive summary

| Decision | Pick | Why |
|---|---|---|
| Self-hosted real-time LLM | `google/gemma-4-26B-A4B-it` (Apache-2.0), FP8 on one L40S 48 GB, vLLM with prefix caching, thinking off | Only single-GPU open model with both verified Hebrew scores and a MoE speed profile (3.8B active parameters) |
| Self-hosted, 24 GB (L4) fallback | `google/gemma-4-12B-it-qat-w4a16-ct` (Apache-2.0) | Fits 24 GB; Hebrew quality not yet published, must be measured |
| Hebrew reference and offline summariser | `dicta-il/DictaLM-3.0-24B-Thinking` (Apache-2.0), W4A16 or FP8 | Best published Hebrew summarisation and diacritisation; a reasoning model, so poorly suited to the real-time turn |
| Commercial API, Hebrew-first | `gemini-3.1-flash-lite` at $0.25 / $0.025 cached / $1.50 per 1M | Gemini line leads every Hebrew leaderboard tier; $0.00098 per conversational minute with caching |
| Commercial API, price leaders to A/B | `gpt-6-luna` and `claude-haiku-5-5`, both $0.10 / $0.01 cached / $0.50 | $0.00041 per minute with caching; Hebrew quality of these generations is unpublished |
| Burst capacity for the self-hosted model | Hosted Gemma 4 endpoints (DeepInfra, Parasail and others) | Same weights as the self-hosted pick, $0.07–0.20 in / $0.32–0.51 out |
| Framework for the 7-day POC | Pipecat 1.17 (BSD-2-Clause) with SmallWebRTC | First-party local Whisper, Kokoro, Piper and OpenAI-compatible LLM services; per-stage TTFB and a latency-breakdown observer |
| Production transport and orchestration | Self-hosted LiveKit server (Apache-2.0 SFU) with LiveKit Agents workers | WebRTC SFU, TURN, mobile SDKs and worker dispatch; managed agent hosting at $0.01/min is twice the whole budget |

Five findings that change the plan:

1. **The LLM is not the cost problem.** With prompt caching every shortlisted API costs $0.0002–0.0013 per conversational minute, 3–26% of the $0.005 budget. Self-hosting lands in the same range ($0.0003–0.0018), so it no longer wins on price; it wins on latency control and Hebrew tuning. [ESTIMATE]
2. **`gemini-2.5-flash-lite` was retired on 2026-10-20.** Google's cheapest current tier is 2.5–3× dearer on input and 4–6× dearer on output. [VERIFIED-official]
3. **The small commercial tiers now reason by default.** Measured first-token latency on default or low settings is 4–6 s for Gemini Flash-Lite and Claude Haiku 5.5; GPT-6 Luna with reasoning off still averages 1.3 s across the benchmark's workloads. [PUBLISHED-thirdparty]
4. **Neither framework's semantic turn detector covers Hebrew.** LiveKit's lists 14 languages and Pipecat's Smart Turn v3 lists 23; Hebrew is in neither. [VERIFIED-official]
5. **Managed agent hosting breaks the budget on its own.** LiveKit Cloud and Pipecat Cloud both charge about $0.01 per agent minute.

---

## PART 1 — LLMs

### 1.1 What the release landscape looks like today

The model families named in the brief have moved on. These are the current open-weight releases, read from each publisher's Hugging Face organisation today. [VERIFIED-official]

| Family | Current open-weight releases | Notes |
|---|---|---|
| Qwen | Qwen3.5 (0.8B, 2B, 4B, 9B, 27B, 35B-A3B, 122B-A10B, 397B-A17B; Feb–Mar 2026), Qwen3.6 (27B, 35B-A3B; Apr 2026), Qwen3.8-27B (Aug 2026) | All Apache-2.0. `Qwen3.8-Flash-Next` (180B) is **not** Apache: licence `qwen-community-1.0`, gated |
| Gemma | Gemma 4: E2B, E4B, 12B, 26B-A4B, 31B | Apache-2.0. Gemma 3 and 3n remain under the Gemma Terms of Use |
| Llama | Nothing newer than Llama 4 Scout / Maverick (Apr 2025) and Llama 3.3 70B (Nov 2024) on `meta-llama` | Llama Community Licences |
| Mistral | Ministral 3 (3B, 8B, 14B; Dec 2025), Mistral Small 4 (119B MoE, 6.5B active; Mar 2026), Mistral Large 4 | Apache-2.0 |
| Microsoft | phi-4 (14B), Phi-4-mini (3.8B), Aion-1.0-Instruct-2.3B (Nov 2026) | MIT. No "Phi-5" found on the `microsoft` organisation [UNVERIFIED that none exists elsewhere] |
| OpenAI | gpt-oss-20b, gpt-oss-120b (Aug 2025) | Apache-2.0 |
| DeepSeek | DeepSeek-V4.1-Flash-1017 (Oct 2026), V4-Pro | MIT, but 290B–763B parameters: not single-GPU models |
| IBM | Granite 4.2 (3B, 8B, 30B; Aug 2026) | Apache-2.0 |
| Cohere | Command A+ 05-2026 (218B total, 25B active), tiny-aya, aya-expanse | Command A+ is Apache-2.0; the Aya line and Command R are CC-BY-NC |
| Dicta | DictaLM 3.0: 24B, Nemotron-12B, 1.7B (Nov–Dec 2025) | 24B and 1.7B Apache-2.0; 12B under the NVIDIA Open Model License. No newer LLM on the `dicta-il` organisation |

### 1.2 Open-weight candidates for one GPU

Hebrew evidence comes from two public leaderboards described in section 1.3. "Chat-LB mean" is my unweighted mean of the five task scores on the Dicta / MAFAT Hebrew chat leaderboard. [ESTIMATE from PUBLISHED-thirdparty scores]

| Model ID | Licence, commercial use | Params | Context | Tool calling | Hebrew evidence | Fits |
|---|---|---|---|---|---|---|
| `google/gemma-4-26B-A4B-it` | Apache-2.0, yes [VERIFIED-official] | 25.8B total, 3.8B active [VERIFIED-official] | 256K [VERIFIED-official] | Native function calling [VERIFIED-official] | Chat-LB mean 52.8 (nikud 68.1, summarisation 46.0, translation 27.3, trivia 44.5, Winograd 78.1) [PUBLISHED-thirdparty] | L40S at FP8; L4 only at 4-bit [ESTIMATE] |
| `google/gemma-4-31B-it` | Apache-2.0, yes [VERIFIED-official] | 31.3B dense [VERIFIED-official] | 256K [VERIFIED-official] | Native [VERIFIED-official] | Chat-LB mean 59.9; AlephBench 88.1, rank 2 of 6, 0.7 below Gemini 2.5 Flash [PUBLISHED-thirdparty] | L40S at 4-bit or FP8 [ESTIMATE]; unquantised fits one 80 GB H100 [UNVERIFIED, search excerpt of Google's announcement] |
| `google/gemma-4-12B-it` | Apache-2.0, yes [VERIFIED-official] | 11.96B dense, encoder-free multimodal with audio input [VERIFIED-official] | 256K [VERIFIED-official] | Native [VERIFIED-official] | None published [UNVERIFIED]. Prior: `gemma-3-12b-it` scored mean 45.7 [PUBLISHED-thirdparty] | L4 at 4-bit (official QAT `-qat-w4a16-ct` and `-qat-q4_0-gguf`) [VERIFIED-official that checkpoints exist] |
| `google/gemma-4-E4B-it` | Apache-2.0, yes [VERIFIED-official] | 8.0B with embeddings, 4.5B effective [VERIFIED-official] | 128K [VERIFIED-official] | Native [VERIFIED-official] | None published [UNVERIFIED] | L4 |
| `dicta-il/DictaLM-3.0-24B-Thinking` | Apache-2.0, yes [VERIFIED-official] | 23.6B dense, from Mistral-Small-3.1-24B-Base [VERIFIED-official] | 65K native [VERIFIED-official] | Yes, vLLM `hermes` parser [VERIFIED-official] | Chat-LB mean 62.4: nikud 86.9, summarisation 56.9 (best of all open models listed), translation 30.1, trivia 60.1, Winograd 78.1. AlephBench 85.2, rank 3 [PUBLISHED-thirdparty] | L40S at FP8 or W4A16 (official `-FP8`, `-W4A16`, `-GGUF`) [VERIFIED-official that checkpoints exist] |
| `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct` | **NVIDIA Open Model License**, not Apache. "Models are commercially usable"; licence is revocable under its conditions [VERIFIED-official] | 12.3B hybrid-SSM [VERIFIED-official] | 65K [VERIFIED-official] | Yes, `hermes` parser, needs `--trust-remote-code` [VERIFIED-official] | Chat-LB mean 48.4: nikud 76.1, summarisation 33.3, translation 13.5, trivia 45.2, Winograd 73.7 (Dicta's own report) [PUBLISHED-thirdparty] | L4 at FP8 or W4A16 [ESTIMATE] |
| `dicta-il/DictaLM-3.0-1.7B-Instruct` | Apache-2.0, yes [VERIFIED-official] | 1.72B, from Qwen3-1.7B [VERIFIED-official] | 65K [VERIFIED-official] | Yes [VERIFIED-official] | Mean 30.6: too weak to lead a conversation [PUBLISHED-thirdparty] | Any |
| `dicta-il/dictalm2.0-instruct` | Apache-2.0 [VERIFIED-official] | 7.25B [VERIFIED-official] | Not checked [UNVERIFIED] | No [UNVERIFIED] | Superseded by 3.0 | L4 |
| `Qwen/Qwen3.8-27B` | Apache-2.0, yes [VERIFIED-official] | 27.8B dense, hybrid Gated-DeltaNet + attention [VERIFIED-official] | 262K native [VERIFIED-official] | Yes [VERIFIED-official] | None published [UNVERIFIED] | L40S at 4-bit; H100 at FP8 [ESTIMATE] |
| `Qwen/Qwen3.6-35B-A3B` | Apache-2.0, yes [VERIFIED-official] | 36.0B total, 3B active [VERIFIED-official] | 262K [VERIFIED-official] | Yes, `qwen3_coder` parser [VERIFIED-official] | None published [UNVERIFIED]. Prior is mixed: `Qwen3-30B-A3B-Thinking` scored mean 29.9; `Qwen3.5-122B-A10B` scored 61.5 [PUBLISHED-thirdparty] | L40S at FP8 (official `-FP8`) [ESTIMATE] |
| `Qwen/Qwen3.5-9B`, `Qwen3.5-4B` | Apache-2.0, yes [VERIFIED-official] | 9.65B, 4.66B [VERIFIED-official] | 262K [VERIFIED-official] | Yes [VERIFIED-official] | Card claims "201 languages and dialects"; no Hebrew score published [VERIFIED-official for the claim, UNVERIFIED for quality]. `Qwen3-14B` scored mean 27.3 with translation 0.9 [PUBLISHED-thirdparty] | L4 |
| `mistralai/Ministral-3-14B-Instruct-2512` (also 8B, 3B) | Apache-2.0, yes [VERIFIED-official] | 13.9B, 8.9B [VERIFIED-official] | 256K [VERIFIED-official] | Native, vLLM `mistral` parser [VERIFIED-official] | Card lists Arabic, not Hebrew; no score [UNVERIFIED] | "24 GB of VRAM in FP8" for 14B [VERIFIED-official] |
| `mistralai/Mistral-Small-4-119B-2603` | Apache-2.0, yes [VERIFIED-official] | 119B total, 6.5B active [VERIFIED-official] | 256K [VERIFIED-official] | Native [VERIFIED-official] | None [UNVERIFIED] | Not one L40S: card recipe uses `--tensor-parallel-size 2`; NVFP4 checkpoint exists [VERIFIED-official] |
| `mistralai/Mistral-Small-3.2-24B-Instruct-2506` | Apache-2.0, yes [VERIFIED-official] | 24.0B [VERIFIED-official] | Not checked [UNVERIFIED] | Yes [UNVERIFIED] | Parent line of DictaLM 24B; use DictaLM instead | L40S |
| `openai/gpt-oss-20b` | Apache-2.0, yes [VERIFIED-official] | 20.9B total, 3.6B active, MXFP4, "within 16GB of memory" [VERIFIED-official] | 131K [PUBLISHED-thirdparty] | Function calling [VERIFIED-official] | None for 20b. `gpt-oss-120b`: chat-LB mean 48.4, translation 10.8; AlephBench 84.2 [PUBLISHED-thirdparty] | L4 |
| `openai/gpt-oss-120b` | Apache-2.0, yes [VERIFIED-official] | 116.8B total, 5.1B active [VERIFIED-official] | 131K [PUBLISHED-thirdparty] | Yes [VERIFIED-official] | See above | "single 80GB GPU" [VERIFIED-official] |
| `ibm-granite/granite-4.2-8b` (also 3b, 30b) | Apache-2.0, yes [VERIFIED-official] | 8.8B, 29.3B [VERIFIED-official] | 128K native, 512K extended [VERIFIED-official] | Yes [VERIFIED-official] | Tested-language list has Arabic, not Hebrew [VERIFIED-official] | L4 (8b) |
| `microsoft/phi-4`, `Phi-4-mini-instruct` | MIT, yes [VERIFIED-official] | 14.7B, 3.8B [VERIFIED-official] | 16K for phi-4 [VERIFIED-official] | Phi-4-mini yes [UNVERIFIED] | Card: "trained primarily on English text"; multilingual data about 8% [VERIFIED-official] | L4 |
| `meta-llama/Llama-3.3-70B-Instruct` | Llama 3.3 Community License, see 1.4 [VERIFIED-official] | 70.6B [VERIFIED-official] | 128K [UNVERIFIED] | Yes [UNVERIFIED] | Chat-LB mean 41.0, nikud 4.1 [PUBLISHED-thirdparty] | H100 at 4-bit only [ESTIMATE] |
| `meta-llama/Llama-4-Scout-17B-16E-Instruct` | Llama 4 Community License, see 1.4 [VERIFIED-official] | 108.6B total [VERIFIED-official] | Up to 1.3M as hosted [PUBLISHED-thirdparty] | Yes [UNVERIFIED] | None [UNVERIFIED] | Not single L40S [ESTIMATE] |
| `CohereLabs/aya-expanse-8b`, `-32b`; `c4ai-command-r-08-2024`; `tiny-aya-*` | **CC-BY-NC-4.0: no commercial use** [VERIFIED-official] | 8.0B, 32.3B, 32.3B, 3.3B [VERIFIED-official] | Not checked | — | `aya-expanse-32b` mean 45.3 [PUBLISHED-thirdparty] | Excluded on licence |
| `CohereLabs/command-a-plus-05-2026` | Apache-2.0, yes [VERIFIED-official] | 218B total, 25B active [VERIFIED-official] | 128K in, 64K out [VERIFIED-official] | Yes [VERIFIED-official] | Hebrew is one of 48 training languages; no score. Older `command-a-03-2025` scored mean 49.9 [VERIFIED-official / PUBLISHED-thirdparty] | Multi-GPU |
| DeepSeek V4.1 Flash | MIT [VERIFIED-official] | 763B per HF metadata [VERIFIED-official] | 1M [VERIFIED-official] | Yes [VERIFIED-official] | Older `deepseek-chat-v3.1` mean 56.4 [PUBLISHED-thirdparty] | API only for this project |

Thinking-mode notes that matter for voice. [VERIFIED-official]

- Qwen3.5, 3.6 and 3.8 think by default. Disable per request with `chat_template_kwargs: {"enable_thinking": false}`.
- Gemma 4 thinking is triggered by a token at the start of the system prompt and is off when the token is absent (`enable_thinking=False`).
- Granite 4.2 thinks by default; `enable_thinking=False` gives a direct answer.
- gpt-oss always reasons at `low`, `medium` or `high`; there is no off switch on the card.
- DictaLM-3.0-24B-Thinking always emits a thinking block before the answer. Dicta's report measures +303% average tokens against the Instruct variant. The 24B Instruct variant used in that comparison is not on the Hugging Face organisation today.

### 1.3 Hebrew quality evidence

**Dicta / MAFAT Hebrew chat leaderboard** — results dataset `hebrew-llm-leaderboard/chat-results`, last modified 2026-08-31. Five tasks: Nikud (diacritisation), Summarisation and Translation (pairwise win-rate against Gemini 2.5 Pro, judged by GPT-4o), Israeli Trivia, Winograd. [PUBLISHED-thirdparty]

| Model | Nikud | Summ. | Transl. | Trivia | Winograd | Mean [ESTIMATE] |
|---|---|---|---|---|---|---|
| gemini-3-flash-preview | 88.4 | 49.8 | 50.7 | 86.4 | 94.6 | 74.0 |
| gpt-5.1 | 80.6 | 66.0 | 44.2 | 81.7 | 91.0 | 72.7 |
| Qwen3.5-397B-A17B | 78.2 | 47.3 | 42.9 | 72.1 | 86.7 | 65.5 |
| gemini-2.5-flash | 79.5 | 46.9 | 35.0 | 76.4 | 86.0 | 64.8 |
| gpt-5-mini | 66.2 | 55.1 | 41.5 | 69.4 | 88.5 | 64.2 |
| **DictaLM-3.0-24B-Thinking** | 86.9 | 56.9 | 30.1 | 60.1 | 78.1 | 62.4 |
| Qwen3.5-122B-A10B | 67.1 | 46.2 | 31.0 | 70.1 | 93.2 | 61.5 |
| glm-5.3-flash | 35.0 | 60.5 | 40.3 | 76.7 | 93.9 | 61.3 |
| **gemma-4-31B-it** | 73.4 | 48.5 | 33.3 | 58.5 | 86.0 | 59.9 |
| deepseek-chat-v3.1 | 75.3 | 37.1 | 26.0 | 64.5 | 79.1 | 56.4 |
| gemini-2.5-flash-lite | 70.7 | 43.0 | 25.0 | 61.8 | 80.9 | 56.3 |
| **gemma-4-26B-A4B-it** | 68.1 | 46.0 | 27.3 | 44.5 | 78.1 | 52.8 |
| gemma-3-27b-it | 60.2 | 44.5 | 26.7 | 45.5 | 79.9 | 51.4 |
| claude-haiku-4.5 | 62.5 | 44.0 | 13.7 | 52.8 | 76.3 | 49.9 |
| gpt-oss-120b | 49.6 | 34.8 | 10.8 | 74.8 | 71.9 | 48.4 |
| aya-expanse-32b | 45.4 | 29.5 | 17.1 | 53.8 | 80.6 | 45.3 |
| gpt-4o-mini | 50.8 | 23.9 | 11.8 | 54.8 | 77.3 | 43.8 |
| gpt-5-nano | 14.6 | 31.0 | 25.0 | 60.5 | 77.7 | 41.8 |
| Llama-3.3-70B-Instruct | 4.1 | 37.8 | 19.3 | 60.1 | 83.5 | 41.0 |
| Nemotron-3-Nano-30B-A3B | 5.5 | 20.5 | 7.0 | 52.7 | 70.9 | 31.3 |
| Qwen3-30B-A3B-Thinking-2507 | 15.8 | 12.4 | 1.0 | 43.5 | 77.0 | 29.9 |

**AlephBench** — `HebArabNlpProject/AlephBench`, snapshot 2026-05-11, 11 tasks, six models: gemini-2.5-flash 88.8, gemma-4-31b-it 88.1, DictaLM-3.0-24B-Thinking 85.2, gpt-oss-120b 84.2, gemma-3-27b-it 83.5, Hebatron 77.1. [PUBLISHED-thirdparty]

Reading of the evidence:

- **No model at or below 12B from the current generation has a published Hebrew score.** That covers Gemma-4-12B and E4B, Qwen3.5-9B and 4B, Ministral 3, Granite 4.2 and gpt-oss-20b. This is the largest evidence gap for an L4-class deployment. [VERIFIED-official that the result files are absent]
- Hebrew generation quality tracks the family more than the size. Gemma has been consistently usable in Hebrew; the older Qwen3 small and MoE models were close to unusable for Hebrew generation (translation 0.9–1.0), and Qwen3.5 fixed that at 122B and above. Whether the fix reaches 9B is unknown. [ESTIMATE from PUBLISHED-thirdparty scores]
- None of these benchmarks measures spoken, code-switched Hebrew–English dialogue or proactive conversation leading. They are a filter, not a verdict.
- GPT-6 Luna, Claude Haiku 5.5, Gemini 3.1 and 3.5 Flash-Lite and Qwen3.8 are not on either leaderboard. [UNVERIFIED Hebrew quality]

### 1.4 Licence terms that need care

- **Llama 3.3 and Llama 4 Community License.** Royalty-free and commercial use is allowed, with conditions. If you distribute the model or a product containing it you must include the agreement and "prominently display 'Built with Llama'". Use must follow Meta's Acceptable Use Policy. A licensee whose products exceeded 700 million monthly active users on the release date must request a separate licence. [VERIFIED-official, licence text]
- **Llama 4 EU clause.** The Llama 4 Acceptable Use Policy withholds the licence for the multimodal models from individuals domiciled in the EU and companies with a principal place of business there; end users of products are not affected. An Israel-based company is outside this clause; an EU entity is not. [PUBLISHED-thirdparty; the policy page itself was not fetched]
- **Gemma Terms of Use (Gemma 3 and 3n only).** Commercial use is allowed. Use must follow the Prohibited Use Policy, the restrictions must be passed downstream as an enforceable term, and Google reserves the right to restrict usage "remotely or otherwise". [PUBLISHED-thirdparty search excerpt of the official page; page blocked]
- **Gemma 4 is Apache-2.0**, with none of the above. [VERIFIED-official]
- **NVIDIA Open Model License (DictaLM 12B).** Commercially usable and derivatives are allowed; the grant is "revocable" under the licence's conditions. [VERIFIED-official]
- **CC-BY-NC-4.0 (Aya Expanse, Command R, tiny-aya).** Non-commercial only. Excluded. [VERIFIED-official]
- **`qwen-community-1.0` (Qwen3.8-Flash-Next).** Not Apache and gated; terms not reviewed. [VERIFIED-official for the licence tag, UNVERIFIED for terms]

### 1.5 Published throughput and TTFT

No vendor publishes vLLM numbers for the current small models on L4, L40S, A100 or H100 with a 5K-token prompt. What exists:

**Single-GPU serving benchmarks**

| Setup | Result | Tag |
|---|---|---|
| L40S 48 GB, `Qwen3-32B-FP8`, vLLM 0.32, 1,024 in / 256 out, FP8 KV cache | 8 concurrent: 119 tok/s total, 50 ms between tokens (20 tok/s per stream). 32 concurrent: 230 tok/s, 98.5 ms (10 tok/s per stream). 64 concurrent: 229 tok/s, TTFT 40 s, of which about 28 s is queueing | [PUBLISHED-thirdparty, Wojdylak] |
| Same GPU, 32B at 4-bit, 32 concurrent | AWQ 333 tok/s, GPTQ 343 tok/s: 1.44–1.49× the FP8 throughput at equal KV budget | [PUBLISHED-thirdparty] |
| Same GPU, `Qwen3-30B-A3B-FP8` (MoE), SGLang, 32 concurrent | 897 tok/s, TTFT 779 ms mean and 1,303 ms p99, 31 ms between tokens (32 tok/s per stream): 3.6× the dense 32B | [PUBLISHED-thirdparty] |
| Same study, KV cache actually reserved at 0.90 memory for the 32B model | vLLM 35,328 tokens, SGLang 60,954, TensorRT-LLM 71,552 | [PUBLISHED-thirdparty] |
| RTX 6000 Pro 96 GB, `gemma-4-31B-it` FP8, vLLM, 4K context, prefix caching on, 12–24 concurrent | 1,168 tok/s total peak (548 output), about 27 tok/s per request, TTFT 0.73 s median and 19 s p99 | [PUBLISHED-thirdparty, HexGrid] |
| DGX Spark, `gemma-4-26B-A4B`, vLLM, 30 concurrent | 318.5 tok/s aggregate, 253 ms mean TTFT | [UNVERIFIED, search excerpt only] |
| L40S, Llama 3.1 8B FP8 (NVIDIA NIM table quoted by a third party) | 71 tok/s single stream; 2,869 tok/s at 100 concurrent | [UNVERIFIED, search excerpt only] |
| L4, Qwen2.5-7B, vLLM | 4-bit AWQ 1.8× BF16 at 64 concurrent; 1,081 tok/s batch | [UNVERIFIED, repository returned 404] |
| GB200 cluster, `Qwen3.5-397B-A17B-NVFP4`, vLLM disaggregated serving, 8,192 in / 1,024 out | 25,000 total tok/s per GPU at concurrency 64–5,120. Not applicable to one L40S | [VERIFIED-official, vLLM blog] |

**Hosted endpoints as a ceiling on what the same weights can do** (Artificial Analysis, measured from Google Cloud `us-central1` under load, five-day averages; "TTFT" is the first token of any kind, including reasoning tokens). [PUBLISHED-thirdparty]

| Model, provider | TTFT, 1K-token prompt | TTFT, 10K-token prompt | Output speed |
|---|---|---|---|
| gemma-4-31b, Modular (NVFP4) | 0.16 s | 0.41 s | 269–278 tok/s |
| gemma-4-26b-a4b, Makora | 0.35 s | 0.81 s | 197–200 tok/s |
| gemma-4-26b-a4b, DeepInfra (FP8) | 0.45 s | 0.66 s | 68–73 tok/s |
| qwen3.8-27b, Nebius (FP4) | 0.19 s | 2.39 s | 436–463 tok/s |
| qwen3.5-9b, Together (FP8) | 0.24 s | 0.64 s | 139–146 tok/s |
| gpt-oss-20b, Groq | 0.20 s | 0.74 s | 795–872 tok/s |
| gpt-oss-20b, CoreWeave | 0.39 s | 0.43 s | 209 tok/s |
| gpt-oss-120b, Cerebras | 0.24 s | 0.49 s | 1,778–1,916 tok/s |
| deepseek-v4.1-flash-1017, Nebius | 0.17 s | 0.37 s | 220 tok/s |
| ministral-3-14b, Mistral | 0.48 s | 0.93 s | 96–104 tok/s |

What this means for the 100–300 ms TTFT target:

- **A dense model near 30B on one L40S cannot hold 40 tok/s per stream.** The measured figure is 10–20 tok/s. MoE models with 3–4B active parameters, or dense models at or below 12B, are the only single-GPU options. [ESTIMATE from PUBLISHED-thirdparty data]
- **At 5K input tokens, cold-prompt TTFT is 0.3–0.7 s even on the fastest hosted hardware.** The target is reachable only when the prefix is served from a KV or prompt cache, so cache hit rate is the latency lever as well as the cost lever. [ESTIMATE, interpolating the 1K and 10K rows]
- **Queueing, not prefill, is what destroys TTFT under load.** Both single-GPU studies show p99 TTFT blowing up (19 s, 63 s) once concurrency exceeds what the KV cache holds. Capacity must be planned on p95 TTFT, not on aggregate tok/s. [PUBLISHED-thirdparty]
- Network distance is extra: these numbers were measured inside a US cloud region. [VERIFIED-official, AA methodology]

Serving-stack facts. [VERIFIED-official unless tagged]

- vLLM is at 0.34.0 (2026-11-16), Apache-2.0.
- Qwen cards give vLLM and SGLang commands, including multi-token-prediction speculative decoding (`--speculative-config '{"method":"qwen3_next_mtp","num_speculative_tokens":2}'`) and `--language-model-only` to skip the vision tower.
- Dicta recommends vLLM for all DictaLM 3.0 models.
- Official quantised checkpoints: Qwen `-FP8` and `-GPTQ-Int4`; Gemma 4 QAT `q4_0` GGUF and `w4a16` (12B, 31B, E2B, E4B); DictaLM `-FP8`, `-W4A16`, `-GGUF`; Granite `-fp8`, `-nvfp4`, `-GGUF`. For `gemma-4-26B-A4B-it` the 4-bit and FP8 safetensors are community builds (`RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`, `cyankiwi/gemma-4-26B-A4B-it-AWQ-4bit`, `nvidia/Gemma-4-26B-A4B-NVFP4`); Google publishes only the QAT GGUF for that size.
- Whether vLLM's prefix cache works with the hybrid Gated-DeltaNet layers of Qwen3.5 and later was not confirmed. [UNVERIFIED]
- No TGI or llama.cpp concurrency figures for these models were found. [UNVERIFIED]

### 1.6 Low-cost commercial APIs

Prices are USD per 1M tokens, standard (non-batch) tier.

| Provider, model ID | Input | Cached input | Output | Caching terms | Latency evidence | Hebrew evidence |
|---|---|---|---|---|---|---|
| Google `gemini-3.1-flash-lite` | 0.25 | 0.025 | 1.50 | Implicit caching on by default, 90% discount, no storage fee; +10% on non-global endpoints [VERIFIED-official] | TTFT 3.8 s (1K) and 4.8 s (10K) at default thinking on the preview endpoint [PUBLISHED-thirdparty] | Family evidence only: 2.5 Flash-Lite mean 56.3, 3 Flash preview 74.0 [PUBLISHED-thirdparty] |
| Google `gemini-3.5-flash-lite` | 0.30 | 0.03 | 2.50 | Same [VERIFIED-official] | TTFT 5.5 s (1K), 1.1 s multi-turn; 304 tok/s [PUBLISHED-thirdparty] | Same |
| Google `gemini-3.8-flash` | 0.75 until 2026-12-31, then 1.50 | 0.075, then 0.15 | 3.75, then 7.50 | Same [VERIFIED-official] | TTFT 11–23 s at default reasoning [PUBLISHED-thirdparty] | Same |
| Google `gemini-2.5-flash-lite` | 0.10 | 0.01 | 0.40 | — | — | **Retired 2026-10-20** on Vertex; replacement listed as 3.8 Flash, 3.5 Flash-Lite or Gemma 4 [VERIFIED-official] |
| OpenAI `gpt-6-luna` | 0.10 | 0.01 | 0.50 | Cache write 1.25× input for a 30-minute lifetime (0.125), 2.5× for 12 hours; reads 0.1×; minimum 1,024 tokens; implicit or explicit breakpoints [VERIFIED-official] | Non-reasoning: first answer token 1.30 s (all-workload average, including 100K-token prompts) [PUBLISHED-thirdparty] | None for this generation. gpt-5-nano 41.8, gpt-5-mini 64.2 [PUBLISHED-thirdparty] |
| OpenAI `gpt-5.6-luna` | 0.20 | 0.02 | 1.20 | Same scheme [VERIFIED-official] | Not checked | Same |
| OpenAI `gpt-6.1-terra` | 1.00 | 0.05 | 5.00 | Reads 0.05× [VERIFIED-official] | Non-reasoning first answer 2.09 s [PUBLISHED-thirdparty] | Same |
| Anthropic `claude-haiku-5-5` | 0.10 | 0.01 | 0.50 | 5-minute write 0.125, 1-hour write 0.20; minimum cacheable prefix 512 tokens; automatic caching with one `cache_control` field. Prompts over 100K tokens pay 5× [VERIFIED-official] | Adaptive thinking on by default at `medium`; at `low` first answer 6.4 s. Thinking can be disabled at `high` effort or below; no latency figure published for that mode [VERIFIED-official / PUBLISHED-thirdparty] | None for this generation. claude-haiku-4.5 mean 49.9 [PUBLISHED-thirdparty] |
| Anthropic `claude-haiku-4-5` | 1.00 | 0.10 | 5.00 | Minimum 4,096 tokens [VERIFIED-official] | Not checked | Mean 49.9 [PUBLISHED-thirdparty] |
| DeepSeek `deepseek-flash` (V4.1-Flash-1017) | 0.15 off-peak, 0.30 peak | 0.003 off-peak, 0.006 peak | 0.60 off-peak, 1.20 peak | Automatic. Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays [VERIFIED-official] | TTFT 0.77 s (1K), 1.05 s (10K); 171 tok/s [PUBLISHED-thirdparty] | deepseek-chat-v3.1 mean 56.4 [PUBLISHED-thirdparty] |
| Mistral `mistral-small-2603` (Small 4) | 0.15 | 0.015 | 0.60 | Implicit [PUBLISHED-thirdparty, OpenRouter listing] | TTFT 0.60 s (1K), 0.84 s (10K); 162–180 tok/s [PUBLISHED-thirdparty] | None [UNVERIFIED] |
| Mistral `ministral-14b-2512` | 0.20 | 0.02 | 0.20 | Implicit [PUBLISHED-thirdparty] | TTFT 0.48 s (1K) [PUBLISHED-thirdparty] | None [UNVERIFIED] |
| Groq `openai/gpt-oss-20b` | 0.075 | 0.0375 | 0.30 | Automatic, 50% discount, expires after 2 hours unused, not guaranteed [VERIFIED-official] | 1,000 tok/s claimed; TTFT 0.20 s (1K), 0.74 s (10K) measured [VERIFIED-official / PUBLISHED-thirdparty] | See gpt-oss-120b |
| Groq `openai/gpt-oss-120b` | 0.15 | 0.075 | 0.60 | Same [VERIFIED-official] | 500 tok/s claimed; TTFT 0.19 s (1K) [VERIFIED-official / PUBLISHED-thirdparty] | Mean 48.4 [PUBLISHED-thirdparty] |
| Groq `qwen/qwen3.8-27b` (preview) | 0.80 | — | 4.00 | Preview: "should not be used in production" [VERIFIED-official] | 450 tok/s claimed [VERIFIED-official] | None [UNVERIFIED] |
| Cerebras `gpt-oss-120b`, `qwen-3.8-27b` | 0.35; 0.99 | no discount | 0.75; 1.49 | [PUBLISHED-thirdparty, OpenRouter listing; Cerebras price page did not render] | About 3,000 and 1,850 tok/s claimed [VERIFIED-official] | See above |
| DeepInfra `gemma-4-26B-A4B-it` (FP8) | 0.07 | — | 0.34 | None listed [PUBLISHED-thirdparty] | TTFT 0.45 s (1K), 0.66 s (10K); 68–73 tok/s [PUBLISHED-thirdparty] | Mean 52.8 [PUBLISHED-thirdparty] |
| DeepInfra `gemma-4-31B-it` | 0.135–0.20 | 0.075 on one tier | 0.32–0.51 | [PUBLISHED-thirdparty] | TTFT 0.54 s (1K); 23–27 tok/s [PUBLISHED-thirdparty] | Mean 59.9; AlephBench 88.1 [PUBLISHED-thirdparty] |
| DeepInfra `gpt-oss-20b` | 0.03 | 0.015 | 0.14 | Implicit [PUBLISHED-thirdparty] | TTFT 0.51 s (1K); 113 tok/s [PUBLISHED-thirdparty] | See above |
| DeepInfra `Qwen3.5-9B` | 0.08–0.10 | — | 0.12–0.15 | [PUBLISHED-thirdparty] | Not measured on this provider | None [UNVERIFIED] |
| Fireworks, Together `GLM-5.3-Flash` | 0.15 | 0.03 | 0.50 | Fireworks: "cached input billed at half price or less, with no write fee" [VERIFIED-official] | Not checked | Mean 61.3; nikud 35.0 [PUBLISHED-thirdparty] |
| Fireworks, Together `DeepSeek V4.1 Flash 1017` | 0.30 | 0.006 | 1.20 | [VERIFIED-official] | Together TTFT 0.55 s (1K) [PUBLISHED-thirdparty] | See DeepSeek |
| Alibaba `qwen3.7-flash` | 0.03 | 0.006 | 0.13 | Explicit, write 0.038 [PUBLISHED-thirdparty, OpenRouter listing] | Not checked | None [UNVERIFIED] |

Speech-to-speech APIs, for comparison with the cascaded design. [VERIFIED-official prices]

- OpenAI `gpt-live-1.1`: $0.05 per active minute, $0.02 per standby minute. Ten times the whole budget.
- OpenAI `gpt-realtime-2.1-mini`: audio $10 in / $20 out per 1M tokens.
- Gemini 3.8 Live API: audio $3.00 in / $12.00 out per 1M at 25 tokens per second of audio, and the whole session context is re-billed every turn. Thirty seconds of agent speech per minute is 750 output tokens, $0.009 per minute before any input. [ESTIMATE]

### 1.7 Estimated LLM cost per conversational minute

Assumptions from the brief:

- 3 agent turns per conversational minute.
- Each turn sends 2,000 tokens of system prompt and memory plus 3,000 tokens of rolling history (session average), so 5,000 input tokens.
- Each turn produces 60 output tokens.

Per minute that is **15,000 input tokens and 180 output tokens**.

Formulas, with prices in $ per 1M tokens:

- No caching: `cost/min = (15,000 × P_in + 180 × P_out) ÷ 1,000,000`
- With caching at hit rate `h`: `cost/min = 3 × (5,000·h × P_cached + 5,000·(1−h) × P_fresh + 60 × P_out) ÷ 1,000,000`, where `P_fresh` is `P_in`, or `1.25 × P_in` on providers that charge for cache writes (OpenAI GPT-6, Anthropic).

Two hit rates are shown. 97% is the ideal case: only the previous reply and the new user utterance (about 150 tokens) are new each turn. 90% is the planning case: it allows for history re-summarisation rewriting part of the prefix, cache expiry and best-effort caches.

Worked example, `gpt-6-luna`:

- No caching: 15,000 × $0.10/M = $0.001500; 180 × $0.50/M = $0.000090; total **$0.001590/min**.
- 90% hit: reads 13,500 × $0.01/M = $0.000135; writes 1,500 × $0.125/M = $0.000188; output $0.000090; total **$0.000412/min**.

| Provider, model | No caching $/min | 90% hit $/min | 97% hit $/min | $/month at 9M min, 90% hit | Share of $0.005 budget, 90% hit |
|---|---|---|---|---|---|
| Alibaba qwen3.7-flash | 0.000473 | 0.000161 | 0.000128 | 1,446 | 3% |
| DeepInfra gpt-oss-20b | 0.000475 | 0.000273 | 0.000257 | 2,454 | 5% |
| DeepSeek deepseek-flash, off-peak | 0.002358 | 0.000373 | 0.000219 | 3,361 | 7% |
| **OpenAI gpt-6-luna** | 0.001590 | 0.000412 | 0.000292 | 3,712 | 8% |
| **Anthropic claude-haiku-5-5** | 0.001590 | 0.000412 | 0.000292 | 3,712 | 8% |
| Mistral mistral-small-2603 | 0.002358 | 0.000535 | 0.000394 | 4,820 | 11% |
| Mistral ministral-14b-2512 | 0.003036 | 0.000606 | 0.000417 | 5,454 | 12% |
| Groq gpt-oss-20b | 0.001179 | 0.000673 | 0.000633 | 6,055 | 13% |
| Fireworks / Together GLM-5.3-Flash | 0.002340 | 0.000720 | 0.000594 | 6,480 | 14% |
| DeepSeek deepseek-flash, peak | 0.004716 | 0.000747 | 0.000438 | 6,723 | 15% |
| OpenAI gpt-5.6-luna | 0.003216 | 0.000861 | 0.000620 | 7,749 | 17% |
| **Google gemini-3.1-flash-lite** | 0.004020 | 0.000982 | 0.000746 | 8,842 | 20% |
| DeepInfra gemma-4-26B-A4B (no cache discount) | 0.001111 | — | — | 10,001 | 22% |
| Google gemini-3.5-flash-lite | 0.004950 | 0.001305 | 0.001021 | 11,745 | 26% |
| DeepInfra gemma-4-31B-it (cached tier) | 0.002117 | 0.001307 | 0.001244 | 11,761 | 26% |
| Groq gpt-oss-120b | 0.002358 | 0.001345 | 0.001267 | 12,110 | 27% |
| DeepInfra Qwen3.5-9B (no cache discount) | 0.001527 | — | — | 13,743 | 31% |
| Google gemini-3.8-flash, intro price | 0.011925 | 0.002812 | 0.002104 | 25,312 | 56% |
| OpenAI gpt-6.1-terra | 0.015900 | 0.003450 | 0.002190 | 31,050 | 69% |
| Anthropic claude-haiku-4-5 | 0.015900 | 0.004125 | 0.002917 | 37,125 | 83% |
| Cerebras gpt-oss-120b (no cache discount) | 0.005385 | 0.005385 | 0.005385 | 48,465 | 108% |
| Google gemini-3.8-flash, from 2027-01-01 | 0.023850 | 0.005625 | 0.004208 | 50,625 | 113% |
| Groq qwen3.8-27b preview (no cache discount) | 0.012720 | — | — | 114,480 | 254% |

All figures in this table are [ESTIMATE] computed from the prices in 1.6.

Things the table does not show:

- **Input dominates.** Input is 15,000 tokens against 180 of output, so without caching the input price is 94–99% of the bill. A cheap output price is nearly irrelevant; a deep cache discount is everything.
- **Hidden reasoning tokens are billed as output.** If a model emits 200 reasoning tokens per turn, output goes from 180 to 780 tokens per minute. On `gemini-3.5-flash-lite` that adds $0.0015/min, more than the entire cached bill. Thinking must be off or minimal for cost as well as latency. [ESTIMATE]
- **Cache lifetime fits the turn cadence.** Turns are about 20 seconds apart; the shortest lifetimes are 5 minutes (Anthropic) and 30 minutes (OpenAI). Only the first turn of a session, or the first after a long pause, pays the full write. [ESTIMATE]
- **Summarisation is a separate cost line.** Capping history at 3,000 tokens needs periodic summarisation calls, and every rewrite invalidates the cached history. Summarise in large, infrequent steps and keep the 2,000-token system and memory block byte-stable at the front of the prompt. [ESTIMATE]
- **DeepSeek's peak window overlaps the Israeli morning.** 06:00–10:00 UTC is 08:00–12:00 in Israel in winter. [ESTIMATE from VERIFIED-official hours]

**Self-hosted equivalent.** [ESTIMATE throughout; the capacity figure is the thing the POC must measure]

- GPU prices (third-party trackers, September–November 2026): L4 $0.44–0.80/h; L40S $0.92 (Hostinger), $0.99 (RunPod), $1.86 (AWS g6e.xlarge); H100 median $3.92/h, range $2.14–12.29. One tracker reports H100 prices rising through 2026. [PUBLISHED-thirdparty]
- Decode demand is small: 180 tok/min is 3 tok/s per conversation. At 40 tok/s a conversation is actively generating 7.5% of the time, so 16 simultaneous streams cover about 210 conversations.
- Prefill is the constraint. Without a cache hit, 210 conversations need 10.5 turns/s × 5,000 = 52,500 prompt tokens per second, beyond one L40S for a model of this size. With a 90% hit rate it is about 5,000.
- KV cache memory decides the hit rate. The L40S study above measured only 35K tokens of KV cache next to a 32B FP8 model. A 26 GB FP8 MoE leaves more, but every warm conversation needs about 5,000 tokens of it.
- Planning range: **50–150 concurrent conversations per L40S** at p95 TTFT under 300 ms.
- Cost: `GPU $/h ÷ (conversations × 60 × utilisation)`. At 35% average utilisation (commute peaks), the range is $0.92 ÷ (150 × 60 × 0.35) = **$0.00029/min** to $1.86 ÷ (50 × 60 × 0.35) = **$0.00177/min**.
- Fleet size: 9M minutes a month is 300,000 a day. If 60% falls in two 2-hour commute windows, average concurrency in those windows is 750 and the peak about 1,100. That is 8–22 L40S at peak.

Self-hosting therefore costs about the same as `gpt-6-luna` or `claude-haiku-5-5` with caching. The case for it is TTFT control, Hebrew fine-tuning and data residency, not price.

### 1.8 Recommendations — LLM

**Self-hosted pick**

- Model: `google/gemma-4-26B-A4B-it`, Apache-2.0.
- Quantisation: FP8 on L40S 48 GB (`RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`, a community build; validate it against the BF16 original on Hebrew before trusting it). On H100, BF16 or FP8.
- Serving: vLLM 0.34 with `--enable-prefix-caching`, FP8 KV cache, text-only mode, thinking token absent from the system prompt, one stable system-plus-memory prefix per user. Run SGLang as the comparison arm: in the one published L40S study vLLM was 19–23% behind it on throughput, and SGLang reserved 73% more KV cache at the same memory setting. [PUBLISHED-thirdparty]
- Why this one: it is the only single-GPU candidate with both a published Hebrew result above the previous-generation small commercial tiers (mean 52.8, against 49.9 for Claude Haiku 4.5 and 43.8 for GPT-4o-mini) and a MoE compute profile that can hold 40+ tok/s per stream under concurrency.

**Arms to run against it in the POC**

1. `google/gemma-4-12B-it-qat-w4a16-ct` on L4 — the cheapest plausible deployment; Hebrew unmeasured.
2. `Qwen/Qwen3.6-35B-A3B-FP8` on L40S — same MoE profile, stronger general benchmarks, Hebrew unmeasured.
3. `dicta-il/DictaLM-3.0-24B-Thinking-W4A16` on L40S — Hebrew quality ceiling. Expect it to fail the TTFT target because of the thinking block; its natural role is the background history and memory summariser, where its summarisation score (56.9) is the best of any open model listed.
4. `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-FP8` on L4 — non-thinking, Hebrew-specialised, hybrid-SSM; weaker scores (mean 48.4) and a non-Apache licence.

**Commercial pick**

- Hebrew-first: `gemini-3.1-flash-lite`, $0.25 / $0.025 / $1.50, **$0.00098/min** at 90% cache hit. Chosen on family evidence: Gemini leads the Hebrew chat leaderboard at every tier. Its measured default-mode TTFT of 3.8–4.8 s is disqualifying unless thinking can be set to minimal; that is the first thing to test.
- Price leaders: `gpt-6-luna` (reasoning off) and `claude-haiku-5-5` (effort `low`, thinking disabled), both **$0.00041/min** at 90% hit. Neither has a published Hebrew score or a published sub-second TTFT in non-thinking mode.
- Hybrid architecture: self-host Gemma 4 for base load, overflow to a hosted Gemma 4 endpoint with the same weights, and route quality-sensitive turns (planning, teaching) to the commercial model.

**Decision for you:** the 12B-and-under models have no Hebrew evidence at all. If the POC shows `gemma-4-12B-it` is not good enough in spoken Hebrew, the deployment unit becomes an L40S rather than an L4, roughly doubling the GPU price per hour.

---

## PART 2 — Real-time voice agent frameworks

### 2.1 LiveKit Agents versus Pipecat

| Dimension | LiveKit Agents | Pipecat |
|---|---|---|
| Version, licence | `livekit-agents` 1.8.13 stable, 2.0.0b2 beta (2026-11-18); Apache-2.0. LiveKit server (SFU) also Apache-2.0 [VERIFIED-official] | `pipecat-ai` 1.17.0 (2026-11-22); BSD-2-Clause, copyright Daily [VERIFIED-official] |
| Languages | Python and Node.js [VERIFIED-official] | Python server; JS, iOS, Android client SDKs [VERIFIED-official] |
| Transport | WebRTC through a LiveKit SFU room; agent joins as a participant. SIP supported [VERIFIED-official] | Pluggable: Daily (WebRTC cloud), LiveKit, SmallWebRTC (peer-to-peer, no account), FastAPI and plain WebSocket, telephony serializers [VERIFIED-official] |
| VAD | Silero plugin [VERIFIED-official] | Silero analyser [VERIFIED-official] |
| Semantic turn detection | `TurnDetector`, multimodal. `v1` runs on LiveKit Inference in the cloud; `v1-mini` runs locally on CPU and is free. **14 languages: no Hebrew** [VERIFIED-official] | `LocalSmartTurnAnalyzerV3`, default stop strategy, local ONNX, 8M parameters, BSD-2-Clause weights and training code. **23 languages: no Hebrew** [VERIFIED-official] |
| Turn detection cost when self-hosted | `v1`: 7,500 requests a month free, then $0.50 per 1,000 on paid plans. Self-hosted production defaults to `v1-mini` [VERIFIED-official] | Free; "as little as 10ms on some CPUs", about 65 ms on a Pipecat Cloud 1x instance [VERIFIED-official] |
| Interruption handling | Adaptive interruption model (separates barge-in from backchannel) on LiveKit Inference; self-hosted agents get 40,000 checks a month, then $1.20 per 1,000; falls back to VAD [VERIFIED-official] | Interruptions built in; user-turn start and stop strategies; a `backchannel-detector` model exists on the Pipecat HF organisation [VERIFIED-official] |
| Local Whisper / faster-whisper | No first-party plugin among the package extras. The OpenAI STT plugin can target an OpenAI-compatible gateway [VERIFIED-official] | `WhisperSTTService` "uses Faster Whisper" on CPU or CUDA; MLX variant for Apple Silicon [VERIFIED-official] |
| vLLM / OpenAI-compatible LLM | Yes: OpenAI plugin with a custom base URL; Ollama plugin [VERIFIED-official] | Yes: `OpenAILLMService` with a base URL; `OLLamaLLMService` [VERIFIED-official] |
| Kokoro, Piper, Chatterbox | None first-party. Needs a custom TTS plugin or an OpenAI-compatible TTS server [VERIFIED-official for absence in extras] | `KokoroTTSService` (kokoro-onnx, local), `PiperTTSService`, `XTTSVLLMTTSService`. Chatterbox only through a hosted provider (GMI Cloud); local needs a custom service [VERIFIED-official] |
| OpenAI Realtime, Gemini Live | Both, plus OpenAI GPT-Live and Azure [VERIFIED-official] | Both, plus Gemini Live on Vertex [VERIFIED-official] |
| Per-stage metrics | Per-plugin `metrics_collected` (LLM `ttft`, TTS `ttfb`, EOU `end_of_utterance_delay`, `transcription_delay`). Per-turn `ChatMessage.metrics`: `llm_node_ttft`, `tts_node_ttfb`, `e2e_latency`, `playback_latency`. Session traces export as OTLP JSON [VERIFIED-official] | `enable_metrics=True` gives TTFB and processing time for every service plus TTS text-aggregation time. `UserBotLatencyObserver` emits user-to-bot latency with a per-service breakdown. OpenTelemetry tracing built in [VERIFIED-official] |
| Managed hosting price | LiveKit Cloud: $0.01 per agent-session minute beyond plan allowance; Ship $50/month with 5,000 minutes, Scale $500/month with 50,000 [PUBLISHED-thirdparty; official page blocked]. Metered per second, 10-second minimum [VERIFIED-official] | Pipecat Cloud: `agent-1x` $0.01 per active minute, $0.0005 per reserved minute; WebRTC voice transport free; Krisp VIVA included [VERIFIED-official] |
| Transport-only price | WebRTC participant minutes: 150,000 included on Ship then $0.0005; 1.5M on Scale then $0.0004; data transfer $0.10–0.12/GB [PUBLISHED-thirdparty] | Daily, self-hosted bots: not checked [UNVERIFIED]. SmallWebRTC: free, you run it |
| Self-hosting | LiveKit server self-hosted with "full support" for the Agents framework; single server per room; Kubernetes and multi-region guides; TURN and TLS configuration. Agent servers connect out over WebSocket and need no inbound ports [VERIFIED-official] | Any container host. SmallWebRTC needs your own TURN for hard NATs [ESTIMATE] |
| Scaling model | Worker pool; LiveKit server balances job dispatch; one sub-process per job. "4 cores and 8GB per agent server", handling "10-25 concurrent jobs". Load test: 30 VAD-only agents on 4 cores used about 3.8 cores and 2.8 GB. Default load threshold is 0.7 CPU [VERIFIED-official] | One pipeline per session. Pipecat Cloud runs "one active session at a time" per instance. Self-hosted per-session CPU and RAM: no published figure [VERIFIED-official / UNVERIFIED] |
| Known limitations | Best turn and interruption models are cloud-metered and do not cover Hebrew; local open models need custom plugins; Cloud noise cancellation (Krisp) is not available self-hosted | SmallWebRTC is peer-to-peer with no SFU, edge network or built-in resilience "at scale"; production guidance points to Daily or LiveKit transports; you build your own worker dispatch |

SFU capacity reference: LiveKit's published benchmark on a 16-core `c2-standard-16` shows 10 audio publishers and 3,000 subscribers at 80% CPU. No published figure for thousands of 1:1 rooms. [VERIFIED-official]

### 2.2 Other options, briefly

| Option | Licence | What it is | Verdict for this project |
|---|---|---|---|
| Vocode (`vocode-core`) | MIT [VERIFIED-official] | Python voice-agent library, telephony-centred | Last PyPI release August 2024. Treat as unmaintained [VERIFIED-official for the date] |
| TEN Framework | Apache-2.0 **with added conditions**: may not be hosted "on any End User devices, including … mobile terminal devices", and may not be deployed in a way that competes with Agora [VERIFIED-official] | Agora-backed graph framework; ships TEN VAD and TEN Turn Detection; quickstart needs Agora credentials | Licence conditions and Agora coupling make it a poor fit |
| FastRTC | MIT [VERIFIED-official] | "Turn any python function into a real-time audio and video stream over WebRTC or WebSockets"; built-in pause detection; mounts on FastAPI | Fine for a one-day demo. Last release 0.0.34 on 2025-11-24; no per-stage metrics or worker model [VERIFIED-official for the date] |
| Kyutai Unmute | MIT [VERIFIED-official] | Wraps any text LLM with Kyutai streaming STT and TTS; browser to backend over WebSocket; needs a GPU with at least 16 GB VRAM; Kyutai runs GPT-OSS 120B behind it | Useful reference architecture. Hebrew support in Kyutai STT and TTS not established [UNVERIFIED] |
| Ultravox | MIT code [VERIFIED-official] | Audio-in, text-out LLM that removes the separate ASR stage; default built on Llama 3.3 70B with an 8B variant | Removes STT latency but inherits the Llama licence and has no Hebrew evidence. README news stops at v0.5, February 2025 [VERIFIED-official / UNVERIFIED for newer releases] |
| Bare WebSocket or `aiortc` | aiortc BSD-3-Clause, 1.16.0 (2026-11-06) [VERIFIED-official] | Build everything yourself | Maximum control over instrumentation, but turn-taking, interruption, jitter handling and reconnection all become your code. Not for a 7-day POC |

### 2.3 WebRTC versus WebSocket for in-car mobile users

Pipecat's own transport guide states the case plainly. [VERIFIED-official]

- **Head-of-line blocking.** WebSocket runs on TCP, which retransmits lost packets and stalls everything behind them. For audio, a dropped packet is better discarded.
- **Opus loss tolerance.** Opus forward error correction and packet-loss concealment are designed for UDP delivery; on TCP they do not help.
- **Timing.** WebRTC provides RTP timestamps and a jitter buffer; over WebSocket you write your own.
- **Echo cancellation.** Acoustic echo cancellation, noise suppression and gain control are part of the WebRTC client stack and are not available to an arbitrary WebSocket stream. In a car, with the agent's voice on the cabin speakers, this decides whether barge-in works at all.
- **Network changes.** WebRTC handles ICE restarts when the phone moves between cells or from Wi-Fi to cellular. Over WebSocket you rebuild reconnection yourself.
- The guide's conclusion: WebSocket is for server-to-server links and text-only bots.

Consequences for this product. [ESTIMATE]

- Production must be WebRTC from the phone, with a TURN/TLS fallback for carrier networks that block UDP.
- Use an SFU or edge network rather than peer-to-peer to the bot, so the first hop is short and the server side can be scaled and moved independently of the client.
- Client-side AEC handles the phone speaker. Bluetooth hands-free and CarPlay / Android Auto audio routes change the echo path and sample rate; test them on real vehicles.
- The same client stack should be used in the POC if end-to-end latency numbers are to mean anything; a WebSocket POC will under-report jitter-buffer and AEC delay.

### 2.4 Recommendations — framework

**(i) Seven-day measurement POC: Pipecat, with `SmallWebRTCTransport`.**

- Every candidate component in this research has a first-party Pipecat service: faster-whisper, Kokoro, Piper, any OpenAI-compatible endpoint (vLLM), Ollama, OpenAI Realtime and Gemini Live. In LiveKit the local STT and TTS models would each need a custom plugin or a shim server first.
- Instrumentation is a configuration flag plus one observer: per-service TTFB, processing time, TTS text-aggregation time, and user-stopped-speaking to bot-started-speaking latency with a per-service breakdown, exportable through OpenTelemetry.
- The frame pipeline makes it straightforward to add custom timestamps at any boundary.
- SmallWebRTC needs no account or media server and still exercises a real WebRTC client stack.
- The turn detector is local, free and retrainable, which matters because Hebrew is not covered out of the box.

**(ii) Production with thousands of concurrent mobile users: self-hosted LiveKit server as the media layer, LiveKit Agents workers on top.**

- An SFU with TURN, multi-region deployment and native iOS, Android, Flutter and React Native SDKs is the part that is expensive to build and that Pipecat does not provide by itself.
- Worker dispatch, per-job process isolation, load-based admission and graceful draining are built in.
- Self-hosting is required by the budget. Managed agent hosting is $0.01/min on either vendor, twice the all-in target. Even transport-only on LiveKit Cloud is two participants × $0.0004–0.0005 = $0.0008–0.0010/min, 16–20% of the budget. [ESTIMATE from PUBLISHED-thirdparty prices]
- Orchestration compute when self-hosted: at 10–25 sessions per 4-core server, peak load of about 1,100 sessions needs 44–110 servers. [ESTIMATE from VERIFIED-official sizing]

The cost of this split is a port of the agent logic from Pipecat to LiveKit Agents after the POC. The alternative that avoids the port is Pipecat on `LiveKitTransport` against the same self-hosted SFU; you then own worker dispatch and scaling. Choose that route if the POC shows that Pipecat's local turn model, retrained for Hebrew, is materially better than what LiveKit offers self-hosted.

**Hebrew turn detection is an open work item in either framework.** Options, in increasing effort: VAD silence plus STT endpointing; LiveKit `v1-mini` or Smart Turn v3 used as-is on Hebrew (both are audio-based, so they may transfer partially, unmeasured); fine-tune Smart Turn v3 on Hebrew audio using its published training code. [ESTIMATE]

---

## 3. What the POC must measure, because no source answers it

1. Spoken Hebrew and code-switched quality of `gemma-4-26B-A4B-it`, `gemma-4-12B-it`, `Qwen3.6-35B-A3B`, `gemini-3.1-flash-lite`, `gpt-6-luna` and `claude-haiku-5-5` on the product's own conversation-leading prompts.
2. p50 and p95 TTFT at 5,000 input tokens with a warm prefix cache, per model and GPU, at 1, 16, 50 and 100 concurrent conversations with 20-second turn spacing.
3. Concurrent conversations per L4 and per L40S before p95 TTFT exceeds 300 ms. This single number sets the self-hosted cost.
4. Actual cache hit rate under the real history-summarisation policy.
5. Non-thinking-mode TTFT of the three commercial models from an Israel or EU region.
6. End-of-turn accuracy of Smart Turn v3 and LiveKit `v1-mini` on Hebrew speech.

---

## Sources

All accessed 2026-11-24.

**Model cards, licences and Hebrew evaluation**

- Hugging Face model API and READMEs: https://huggingface.co/Qwen/Qwen3.8-27B · https://huggingface.co/Qwen/Qwen3.8-Flash-Next · https://huggingface.co/Qwen/Qwen3.6-35B-A3B · https://huggingface.co/Qwen/Qwen3.5-9B · https://huggingface.co/Qwen/Qwen3.5-4B
- https://huggingface.co/google/gemma-4-12B-it · https://huggingface.co/google/gemma-4-26B-A4B-it · https://huggingface.co/google/gemma-4-31B-it · https://huggingface.co/google/gemma-4-E4B-it · https://huggingface.co/google/gemma-3-12b-it (licence metadata)
- https://huggingface.co/dicta-il/DictaLM-3.0-24B-Thinking · https://huggingface.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct · https://huggingface.co/dicta-il/DictaLM-3.0-1.7B-Instruct · https://huggingface.co/dicta-il/dictalm2.0-instruct
- Dicta-LM 3.0 technical report: https://www.dicta.org.il/publications/DictaLM_3_0___Techincal_Report.pdf
- Hebrew chat leaderboard results: https://huggingface.co/datasets/hebrew-llm-leaderboard/chat-results · space: https://huggingface.co/spaces/hebrew-llm-leaderboard/chat-leaderboard
- AlephBench: https://huggingface.co/datasets/HebArabNlpProject/AlephBench
- https://huggingface.co/mistralai/Ministral-3-14B-Instruct-2512 · https://huggingface.co/mistralai/Mistral-Small-4-119B-2603 · https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506
- https://huggingface.co/openai/gpt-oss-20b · https://huggingface.co/openai/gpt-oss-120b
- https://huggingface.co/ibm-granite/granite-4.2-8b · https://huggingface.co/microsoft/phi-4 · https://huggingface.co/microsoft/Phi-4-mini-instruct · https://huggingface.co/microsoft/Aion-1.0-Instruct-2.3B
- https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017 · https://huggingface.co/CohereLabs/command-a-plus-05-2026-bf16 · https://huggingface.co/CohereLabs/aya-expanse-8b · https://huggingface.co/CohereLabs/aya-expanse-32b · https://huggingface.co/CohereLabs/c4ai-command-r-08-2024 · https://huggingface.co/CohereLabs/tiny-aya-global
- https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct · https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct
- Llama licences: https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama4/LICENSE · https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama3_3/LICENSE
- NVIDIA Open Model License: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- Gemma Terms of Use (search excerpt only, page blocked): https://ai.google.dev/gemma/terms
- Gemma 4 announcement (search excerpt only, page blocked): https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/

**Serving benchmarks**

- L40S, vLLM vs SGLang vs TensorRT-LLM: https://michalwojdylak.com/blog/llm-inference-benchmarks-vllm-sglang-tensorrt-llm
- Gemma-4 31B on vLLM under load: https://huggingface.co/blog/hexgridcloud/gemma-4-31b-vllm-on-rtx-6000-pro
- vLLM, 25K TPS per GPU on Qwen3.5: https://vllm-project.github.io/2026/08/06/qwen35-25k-tps.html
- vLLM package metadata: https://pypi.org/pypi/vllm/json
- Search excerpts only: https://medium.com/@james-tang/benchmarking-gemma-4-26b-a4b-on-the-dgx-spark-dc8245292095 · https://eurokommerz.at/blog/nvidia-l40s-real-benchmarks/ · https://github.com/Aman12x/vllm-serving-bench
- Artificial Analysis provider leaderboard and methodology: https://artificialanalysis.ai/leaderboards/providers · https://artificialanalysis.ai/methodology/performance-benchmarking
- Artificial Analysis model pages: https://artificialanalysis.ai/models/gemma-4-31b/providers · https://artificialanalysis.ai/models/gemma-4-26b-a4b/providers · https://artificialanalysis.ai/models/qwen3-8-27b/providers · https://artificialanalysis.ai/models/qwen3-5-9b/providers · https://artificialanalysis.ai/models/gpt-oss-20b/providers · https://artificialanalysis.ai/models/gpt-oss-120b/providers · https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017/providers · https://artificialanalysis.ai/models/gemini-3-5-flash-lite/providers · https://artificialanalysis.ai/models/gemini-3-1-flash-lite/providers · https://artificialanalysis.ai/models/gpt-6-luna/providers · https://artificialanalysis.ai/models/claude-haiku-5-5/providers · https://artificialanalysis.ai/models/ministral-3-14b/providers · https://artificialanalysis.ai/models/mistral-small-4/providers

**Commercial API pricing and caching**

- Google Vertex AI pricing: https://cloud.google.com/vertex-ai/generative-ai/pricing · model retirement table: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions · context caching: https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview
- OpenAI pricing: https://platform.openai.com/docs/pricing · prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing · models: https://platform.claude.com/docs/en/about-claude/models/overview · Haiku 5.5: https://platform.claude.com/docs/en/models/haiku-5-5/overview · prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching · effort: https://platform.claude.com/docs/en/build-with-claude/effort
- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
- Groq models and prices: https://console.groq.com/docs/models · prompt caching: https://console.groq.com/docs/prompt-caching
- Cerebras model catalogue: https://inference-docs.cerebras.ai/models/overview
- Fireworks: https://fireworks.ai/pricing · Together: https://www.together.ai/pricing · DeepInfra: https://deepinfra.com/pricing · Mistral: https://mistral.ai/pricing
- OpenRouter model catalogue and per-provider endpoints (third-party price listing): https://openrouter.ai/api/v1/models
- GPU price trackers (search excerpts): https://aimultiple.com/gpu-index · https://www.hostinger.com/tutorials/?p=158956 · https://neurohive.io/en/guides/cloud-gpu-pricing/

**Frameworks**

- LiveKit docs: https://docs.livekit.io/llms.txt · billing: https://docs.livekit.io/deploy/admin/billing.md · quotas: https://docs.livekit.io/deploy/admin/quotas-and-limits.md · turn detector: https://docs.livekit.io/agents/logic/turns/turn-detector.md · adaptive interruption: https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling.md · metrics: https://docs.livekit.io/agents/observability/data.md · self-hosting: https://docs.livekit.io/transport/self-hosting.md · agent deployment sizing: https://docs.livekit.io/deploy/custom/deployments.md · SFU benchmark: https://docs.livekit.io/transport/self-hosting/benchmark.md · OpenAI-compatible LLMs: https://docs.livekit.io/agents/models/llm/openai-compatible-llms.md · OpenAI STT: https://docs.livekit.io/agents/models/stt/openai.md
- LiveKit Cloud plan prices (official page blocked; figures from search excerpts of): https://livekit.com/pricing · https://www.cekura.ai/blogs/livekit-pricing · https://usagepricing.com/blueprint/livekit
- LiveKit packages and licences: https://pypi.org/pypi/livekit-agents/json · https://raw.githubusercontent.com/livekit/agents/main/LICENSE · https://raw.githubusercontent.com/livekit/livekit/master/LICENSE
- Pipecat docs: https://docs.pipecat.ai/llms.txt · metrics: https://docs.pipecat.ai/pipecat/fundamentals/metrics.md · latency observer: https://docs.pipecat.ai/api-reference/server/utilities/observers/user-bot-latency-observer.md · choosing a transport: https://docs.pipecat.ai/client/concepts/choosing-a-transport.md · Smart Turn: https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview.md · Whisper: https://docs.pipecat.ai/api-reference/server/services/stt/whisper.md · Pipecat Cloud scaling: https://docs.pipecat.ai/pipecat-cloud/fundamentals/scaling.md
- Pipecat Cloud pricing: https://www.daily.co/pricing/pipecat-cloud/
- Pipecat package and licence: https://pypi.org/pypi/pipecat-ai/json · https://raw.githubusercontent.com/pipecat-ai/pipecat/main/LICENSE
- Smart Turn v3: https://huggingface.co/pipecat-ai/smart-turn-v3 · https://raw.githubusercontent.com/pipecat-ai/smart-turn/main/README.md
- TEN licence and README: https://raw.githubusercontent.com/TEN-framework/ten-framework/main/LICENSE · https://raw.githubusercontent.com/TEN-framework/ten-framework/main/README.md
- Vocode: https://pypi.org/pypi/vocode/json · https://raw.githubusercontent.com/vocodedev/vocode-core/main/LICENSE
- FastRTC: https://pypi.org/pypi/fastrtc/json · https://raw.githubusercontent.com/gradio-app/fastrtc/main/README.md
- Unmute: https://raw.githubusercontent.com/kyutai-labs/unmute/main/README.md
- Ultravox: https://raw.githubusercontent.com/fixie-ai/ultravox/main/README.md
- aiortc: https://pypi.org/pypi/aiortc/json
