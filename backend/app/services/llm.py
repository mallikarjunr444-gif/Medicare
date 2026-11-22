"""
LLM facade for the chat pipeline.

Provider-agnostic interface that currently supports Anthropic (default) and
OpenAI. The Anthropic path takes advantage of:

  * **Prompt caching** — the system prompt is wrapped in a content block
    with `cache_control={"type": "ephemeral"}`. Cached reads cost ~10% of
    fresh input, which dominates per-token cost for chatty avatars that
    share a system prompt across many turns. Workspace-isolated as of
    Anthropic's Feb 2026 change.
  * **Extended thinking (opt-in)** — when callers pass `thinking=True`
    we set `thinking={"type": "enabled", "budget_tokens": ...}` so the
    model reasons internally before answering. Reserved for hard turns;
    using it on every turn would multiply token cost.

Exceptions are re-raised as `LLMError` subclasses so the WebSocket pipeline
can distinguish rate-limit / auth / network failures and surface
appropriate user-facing messages.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

import anthropic
import openai

from app.config import settings

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful AI assistant in a real-time avatar conversation system. "
    "Keep replies concise and conversational so they can be spoken aloud."
)

# Extended-thinking budget. Claude 4.x Opus supports up to 128k thinking
# tokens; for an interactive avatar we want responses fast, so we cap the
# budget low. Increase for research/agentic use cases.
_DEFAULT_THINKING_BUDGET = 4096


class LLMError(Exception):
    """Base class — chat pipeline catches this and emits a typed WS error."""


class LLMRateLimited(LLMError):
    """Provider returned 429."""


class LLMAuthError(LLMError):
    """Provider returned 401/403 — usually a misconfigured API key."""


class LLMUnavailable(LLMError):
    """Network failure, timeout, or 5xx from the provider."""


def _cacheable_system(system_prompt: Optional[str]) -> list[dict]:
    """
    Build a system block list with prompt-cache marking applied to the
    (long-lived) system prompt. The SDK accepts either a plain string OR
    a list of blocks; blocks are needed to attach `cache_control` per-block.
    """
    text = system_prompt or DEFAULT_SYSTEM_PROMPT
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def _map_anthropic_exception(exc: Exception) -> LLMError:
    """Translate Anthropic SDK exceptions into the typed LLMError hierarchy."""
    if isinstance(exc, anthropic.RateLimitError):
        return LLMRateLimited(str(exc))
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return LLMAuthError(str(exc))
    if isinstance(
        exc,
        (anthropic.APITimeoutError, anthropic.APIConnectionError, anthropic.InternalServerError),
    ):
        return LLMUnavailable(str(exc))
    if isinstance(exc, anthropic.BadRequestError):
        # 400 from Anthropic is usually our bug, not theirs — surface verbatim.
        return LLMError(f"Invalid request to Anthropic: {exc}")
    return LLMError(str(exc))


def _map_openai_exception(exc: Exception) -> LLMError:
    if isinstance(exc, openai.RateLimitError):
        return LLMRateLimited(str(exc))
    if isinstance(exc, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return LLMAuthError(str(exc))
    if isinstance(
        exc, (openai.APITimeoutError, openai.APIConnectionError, openai.InternalServerError)
    ):
        return LLMUnavailable(str(exc))
    return LLMError(str(exc))


class LLMService:
    """LLM Service for AI responses."""

    def __init__(self, spec: Optional[Dict[str, Any]] = None):
        """Build the main backend, or (with `spec`) one backup backend.

        `spec` keys: provider, model, api_key, base_url. A backup never has its
        own backups, and does not inherit the main backend's base URL.
        """
        is_backup = spec is not None
        spec = spec or {}
        self.provider = spec.get("provider") or settings.LLM_PROVIDER
        self.model = spec.get("model") or settings.LLM_MODEL
        self.temperature = settings.LLM_TEMPERATURE
        self.max_tokens = settings.LLM_MAX_TOKENS
        # Opt-in reasoning cap for OpenAI-compatible "thinking" models (e.g.
        # Ollama cloud glm-*:cloud / kimi-*:cloud). "none" disables reasoning
        # so they return normal `content`. Empty → not sent (default behavior).
        self.reasoning_effort = settings.LLM_REASONING_EFFORT or None
        self.fallbacks: List["LLMService"] = [] if is_backup else self._build_fallbacks()
        self._down_until = 0.0

        # With a backup available, fail fast (no SDK back-off retries) and let
        # the failover loop switch instead.
        client_opts: Dict[str, Any] = {"timeout": settings.LLM_REQUEST_TIMEOUT_S}
        if self.fallbacks:
            client_opts["max_retries"] = 0

        if self.provider == "anthropic":
            self.client = anthropic.AsyncAnthropic(
                api_key=spec.get("api_key") or settings.ANTHROPIC_API_KEY, **client_opts
            )
        elif self.provider == "ollama":
            # Ollama (and vLLM / LM Studio / OpenRouter) speak the OpenAI
            # wire protocol — reuse the OpenAI client against their base URL.
            # Fully local and free; no API key required (the client insists
            # on a non-empty string, so we pass a placeholder).
            configured_url = spec.get("base_url") if is_backup else settings.OPENAI_BASE_URL
            base_url = configured_url or "http://localhost:11434/v1"
            self.client = openai.AsyncOpenAI(
                api_key=spec.get("api_key") or settings.OPENAI_API_KEY or "ollama",
                base_url=base_url,
                **client_opts,
            )
            self.provider = "openai"  # downstream code paths are identical
            logger.info(f"LLM provider 'ollama' → OpenAI-compatible client at {base_url}")
        elif self.provider == "openai":
            self.client = openai.AsyncOpenAI(
                api_key=spec.get("api_key") or settings.OPENAI_API_KEY,
                # None → api.openai.com
                base_url=spec.get("base_url") if is_backup else settings.OPENAI_BASE_URL,
                **client_opts,
            )
        else:
            # Fail here rather than leaving `self.client` unset. Without this a
            # typo in LLM_PROVIDER surfaced much later as an opaque
            # AttributeError from inside the turn pipeline, pointing at the
            # wrong thing entirely.
            raise LLMError(
                f"Unsupported LLM_PROVIDER {self.provider!r}. "
                f"Expected one of: anthropic, openai, ollama."
            )

    @staticmethod
    def _build_fallbacks() -> List["LLMService"]:
        """Backup backends from LLM_FALLBACK_* and LLM_FALLBACKS. Bad entries are skipped."""
        specs: List[Dict[str, Any]] = []
        if settings.LLM_FALLBACK_PROVIDER and settings.LLM_FALLBACK_MODEL:
            specs.append({
                "provider": settings.LLM_FALLBACK_PROVIDER,
                "model": settings.LLM_FALLBACK_MODEL,
                "base_url": settings.LLM_FALLBACK_BASE_URL,
                "api_key": settings.LLM_FALLBACK_API_KEY,
            })
        if settings.LLM_FALLBACKS.strip():
            try:
                extra = json.loads(settings.LLM_FALLBACKS)
                specs.extend(item for item in extra if isinstance(item, dict))
            except (ValueError, TypeError):
                logger.warning("LLM_FALLBACKS is not valid JSON; ignoring it")

        backups: List[LLMService] = []
        for spec in specs:
            try:
                backups.append(LLMService(spec))
            except LLMError as exc:
                logger.warning("Skipping LLM backup %r: %s", spec.get("model"), exc)
        if backups:
            logger.info("LLM failover chain: main + %s", [b.model for b in backups])
        return backups

    # ── failover ─────────────────────────────────────────────────────────────

    def _chain(self) -> List["LLMService"]:
        """Main backend then backups, leaving out any that failed recently."""
        backends = [self, *getattr(self, "fallbacks", [])]
        now = time.monotonic()
        healthy = [b for b in backends if getattr(b, "_down_until", 0.0) <= now]
        return healthy or backends  # everything cooling down: try them all anyway

    def _mark_down(self) -> None:
        self._down_until = time.monotonic() + settings.LLM_BACKEND_COOLDOWN_S

    def _mark_ok(self) -> None:
        self._down_until = 0.0

    # ── non-streaming ────────────────────────────────────────────────────────

    async def generate_response(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
        thinking: bool = False,
    ) -> str:
        """One reply, switching to a backup model if the current one fails or is too slow."""
        last_error: Optional[Exception] = None
        for backend in self._chain():
            try:
                text = await asyncio.wait_for(
                    backend._generate_single(messages, system_prompt, thinking),
                    timeout=settings.LLM_REQUEST_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                last_error = LLMUnavailable(f"{backend.model} did not answer in time")
            except LLMError as exc:
                last_error = exc
            except Exception as exc:  # defensive: never let one backend end the turn
                last_error = LLMError(str(exc))
            else:
                backend._mark_ok()
                return text
            backend._mark_down()
            logger.warning("LLM backend %s failed (%s); trying the next", backend.model, last_error)
        raise last_error or LLMUnavailable("No LLM backend available")

    async def _generate_single(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
        thinking: bool = False,
    ) -> str:
        if self.provider == "anthropic":
            return await self._generate_anthropic(messages, system_prompt, thinking)
        if self.provider == "openai":
            return await self._generate_openai(messages, system_prompt)
        raise LLMError(f"Unsupported LLM provider: {self.provider}")

    async def _generate_anthropic(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str],
        thinking: bool,
    ) -> str:
        kwargs: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "system": _cacheable_system(system_prompt),
            "messages": messages,
        }
        # Extended thinking — model "thinks" privately before answering. The
        # thinking tokens still count against output budget so we widen
        # max_tokens to cover both. Per Anthropic docs, temperature must be 1
        # when extended thinking is enabled.
        if thinking:
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": _DEFAULT_THINKING_BUDGET}
            kwargs["max_tokens"] = max(self.max_tokens + _DEFAULT_THINKING_BUDGET, self.max_tokens)
            kwargs["temperature"] = 1.0

        try:
            response = await self.client.messages.create(**kwargs)
        except Exception as e:
            mapped = _map_anthropic_exception(e)
            logger.error(
                "anthropic_call_failed",
                extra={"error_type": type(e).__name__, "mapped": type(mapped).__name__},
            )
            raise mapped from e

        # Find the first text block (skip thinking blocks if any).
        for block in response.content or []:
            if getattr(block, "type", None) == "text" and hasattr(block, "text"):
                self._log_usage(response.usage, thinking)
                return block.text

        raise LLMError("Anthropic response contained no text block")

    def _openai_extra(self) -> dict:
        """Extra request params for the OpenAI-compatible path.

        `reasoning_effort` is forwarded via `extra_body` (not a named kwarg) so
        it lands in the raw request body regardless of SDK version and is a
        no-op for servers that ignore it. Needed for Ollama cloud thinking
        models — see LLM_REASONING_EFFORT.
        """
        if self.reasoning_effort:
            return {"extra_body": {"reasoning_effort": self.reasoning_effort}}
        return {}

    async def _generate_openai(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
    ) -> str:
        if system_prompt:
            messages = [{"role": "system", "content": system_prompt}] + messages

        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                **self._openai_extra(),
            )
        except Exception as e:
            mapped = _map_openai_exception(e)
            logger.error("openai_call_failed", extra={"error_type": type(e).__name__})
            raise mapped from e

        if not response.choices:
            raise LLMError("OpenAI-compatible response contained no choices")
        return response.choices[0].message.content or ""

    # ── streaming ────────────────────────────────────────────────────────────

    async def stream_response(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        """Stream a reply, switching to a backup model if the current one fails or stays silent.

        Switching is only possible before the first words are sent. Once words have
        reached the patient the reply cannot be restarted elsewhere, so a failure after
        that point is raised as before.
        """
        chain = self._chain()
        last_error: Optional[Exception] = None
        for position, backend in enumerate(chain):
            is_last = position == len(chain) - 1
            stream = backend._stream_single(messages, system_prompt)
            try:
                first = await asyncio.wait_for(
                    stream.__anext__(),
                    timeout=None if is_last else settings.LLM_FIRST_TOKEN_TIMEOUT_S,
                )
            except StopAsyncIteration:
                if is_last:
                    return  # nothing left to try: an empty reply, as before
                last_error = LLMUnavailable(f"{backend.model} returned an empty reply")
            except asyncio.TimeoutError:
                last_error = LLMUnavailable(f"{backend.model} sent nothing within the time limit")
            except Exception as exc:
                last_error = exc
            else:
                try:
                    yield first
                    async for token in stream:
                        yield token
                except Exception:
                    backend._mark_down()  # failed after words were sent: cannot restart elsewhere
                    raise
                backend._mark_ok()
                return
            try:
                await stream.aclose()
            except Exception:
                pass
            backend._mark_down()
            logger.warning("LLM backend %s failed (%s); trying the next", backend.model, last_error)
        if isinstance(last_error, LLMError):
            raise last_error
        raise LLMUnavailable(str(last_error) if last_error else "No LLM backend available")

    async def _stream_single(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        if self.provider == "anthropic":
            async for chunk in self._stream_anthropic(messages, system_prompt):
                yield chunk
        elif self.provider == "openai":
            async for chunk in self._stream_openai(messages, system_prompt):
                yield chunk
        else:
            raise LLMError(f"Unsupported LLM provider: {self.provider}")

    async def _stream_anthropic(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        try:
            async with self.client.messages.stream(
                model=self.model,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                system=_cacheable_system(system_prompt),
                messages=messages,
            ) as stream:
                async for text in stream.text_stream:
                    yield text
        except Exception as e:
            mapped = _map_anthropic_exception(e)
            logger.error("anthropic_stream_failed", extra={"error_type": type(e).__name__})
            raise mapped from e

    async def _stream_openai(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        if system_prompt:
            messages = [{"role": "system", "content": system_prompt}] + messages

        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                stream=True,
                **self._openai_extra(),
            )
            async for chunk in stream:
                # OpenAI sends a final usage-only chunk with an empty
                # `choices` list when stream_options.include_usage is set, and
                # several OpenAI-compatible servers (Ollama, vLLM, OpenRouter)
                # emit one unconditionally. Indexing [0] blindly raised
                # IndexError on that terminal chunk, failing the turn *after*
                # the user had already seen the whole reply.
                if not chunk.choices:
                    continue
                content = chunk.choices[0].delta.content
                if content:
                    yield content
        except Exception as e:
            mapped = _map_openai_exception(e)
            logger.error("openai_stream_failed", extra={"error_type": type(e).__name__})
            raise mapped from e

    # ── helpers ──────────────────────────────────────────────────────────────

    def _log_usage(self, usage, thinking: bool) -> None:
        if usage is None:
            return
        try:
            logger.info(
                "llm_usage",
                extra={
                    "in_tokens": getattr(usage, "input_tokens", 0),
                    "out_tokens": getattr(usage, "output_tokens", 0),
                    "cache_create_tokens": getattr(usage, "cache_creation_input_tokens", 0),
                    "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0),
                    "thinking": thinking,
                },
            )
        except Exception:
            pass


# Global instance
llm_service = LLMService()
