"""OpenAI-compatible chat-completions client (streaming).

One client covers every text LLM used in the POC: self-hosted vLLM / llama.cpp / Ollama
and commercial OpenAI-compatible endpoints (OpenAI, Gemini's OpenAI-compatible endpoint,
Groq, Cerebras, Together, ...).  Swapping self-hosted for commercial is a config change.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

import httpx


@dataclass
class LLMResult:
    text: str = ""
    ttft_ms: Optional[float] = None
    total_ms: Optional[float] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    cached_tokens: Optional[int] = None
    finish_reason: Optional[str] = None
    extra: dict = field(default_factory=dict)


class OpenAICompatLLM:
    def __init__(self, cfg: dict):
        self.base_url = cfg["base_url"].rstrip("/")
        self.model = cfg.get("model", "default")
        key_env = cfg.get("api_key_env")
        # When running behind a credential-injecting proxy the key is a placeholder.
        self.api_key = (os.environ.get(key_env) if key_env else None) or cfg.get("api_key") or "not-needed"
        self.temperature = float(cfg.get("temperature", 0.6))
        self.max_tokens = int(cfg.get("max_tokens", 160))
        self.extra_body = dict(cfg.get("extra_body") or {})
        # Newer hosted models reject `max_tokens` (they want `max_completion_tokens`) and some reject `temperature`.
        self.token_param = cfg.get("token_param") or "max_tokens"
        self.omit_temperature = str(cfg.get("omit_temperature", "")).lower() in ("1", "true", "yes")
        if cfg.get("reasoning_effort"):
            self.extra_body["reasoning_effort"] = cfg["reasoning_effort"]
        self.include_usage = bool(cfg.get("include_usage", True))
        self.name = cfg.get("name") or f"{self.model}@{self.base_url}"
        timeout = httpx.Timeout(connect=10, read=float(cfg.get("read_timeout_s", 120)), write=10, pool=10)
        limits = httpx.Limits(max_connections=200, max_keepalive_connections=50)
        self._client = httpx.AsyncClient(timeout=timeout, limits=limits)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _body(self, messages: list[dict], stream: bool, max_tokens: int | None, temperature: float | None, **kw) -> dict:
        body = {"model": self.model, "messages": messages, "stream": stream, self.token_param: max_tokens or self.max_tokens}
        if not self.omit_temperature:
            body["temperature"] = self.temperature if temperature is None else temperature
        if stream and self.include_usage:
            body["stream_options"] = {"include_usage": True}
        body.update(self.extra_body)
        body.update(kw)
        return body

    async def stream(self, messages: list[dict], result: LLMResult, max_tokens: int | None = None,
                     temperature: float | None = None) -> AsyncIterator[str]:
        """Yield text deltas; fills `result` with timings and token usage."""
        t0 = time.monotonic()
        body = self._body(messages, True, max_tokens, temperature)
        async with self._client.stream("POST", f"{self.base_url}/chat/completions", headers=self._headers(), json=body) as resp:
            if resp.status_code >= 400:
                detail = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise RuntimeError(f"LLM HTTP {resp.status_code}: {detail}")
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                usage = obj.get("usage")
                if usage:
                    result.prompt_tokens = usage.get("prompt_tokens")
                    result.completion_tokens = usage.get("completion_tokens")
                    details = usage.get("prompt_tokens_details") or {}
                    result.cached_tokens = details.get("cached_tokens")
                if obj.get("timings"):
                    result.extra["timings"] = obj["timings"]  # llama.cpp server
                for choice in obj.get("choices") or []:
                    delta = (choice.get("delta") or {}).get("content")
                    if choice.get("finish_reason"):
                        result.finish_reason = choice["finish_reason"]
                    if delta:
                        if result.ttft_ms is None:
                            result.ttft_ms = (time.monotonic() - t0) * 1000
                        result.text += delta
                        yield delta
        result.total_ms = (time.monotonic() - t0) * 1000

    async def complete(self, messages: list[dict], max_tokens: int = 600, temperature: float = 0.2, **kw) -> LLMResult:
        t0 = time.monotonic()
        body = self._body(messages, False, max_tokens, temperature, **kw)
        resp = await self._client.post(f"{self.base_url}/chat/completions", headers=self._headers(), json=body)
        if resp.status_code >= 400:
            raise RuntimeError(f"LLM HTTP {resp.status_code}: {resp.text[:500]}")
        obj = resp.json()
        usage = obj.get("usage") or {}
        return LLMResult(
            text=obj["choices"][0]["message"].get("content") or "",
            total_ms=(time.monotonic() - t0) * 1000,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            cached_tokens=(usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            finish_reason=obj["choices"][0].get("finish_reason"),
        )

    async def aclose(self) -> None:
        await self._client.aclose()
