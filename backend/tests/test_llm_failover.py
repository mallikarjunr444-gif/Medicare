"""If one AI model errors or stays silent, the turn moves to a backup instead of failing."""

import asyncio

import pytest

from app.config import settings
from app.services.llm import LLMService, LLMUnavailable


def _backend(name, *, tokens=(), fail=None, hang=False):
    """A backend whose streaming/non-streaming calls are scripted."""
    svc = object.__new__(LLMService)
    svc.model = name
    svc.fallbacks = []
    svc._down_until = 0.0
    svc.calls = 0

    async def stream(messages, system_prompt=None):
        svc.calls += 1
        if hang:
            await asyncio.sleep(60)
        if fail:
            raise fail
        for t in tokens:
            yield t

    async def generate(messages, system_prompt=None, thinking=False):
        svc.calls += 1
        if hang:
            await asyncio.sleep(60)
        if fail:
            raise fail
        return "".join(tokens)

    svc._stream_single = stream
    svc._generate_single = generate
    return svc


def _chain(main, *backups):
    main.fallbacks = list(backups)
    return main


@pytest.fixture(autouse=True)
def _fast_limits(monkeypatch):
    monkeypatch.setattr(settings, "LLM_FIRST_TOKEN_TIMEOUT_S", 0.2)
    monkeypatch.setattr(settings, "LLM_REQUEST_TIMEOUT_S", 0.2)
    monkeypatch.setattr(settings, "LLM_BACKEND_COOLDOWN_S", 30.0)


async def _collect(svc):
    return "".join([t async for t in svc.stream_response([{"role": "user", "content": "hi"}])])


async def test_error_on_main_switches_to_backup():
    main = _backend("main", fail=LLMUnavailable("down"))
    backup = _backend("backup", tokens=["Hello ", "there"])
    assert await _collect(_chain(main, backup)) == "Hello there"


async def test_silent_main_switches_to_backup_within_the_time_limit():
    main = _backend("main", hang=True)
    backup = _backend("backup", tokens=["ok"])
    assert await asyncio.wait_for(_collect(_chain(main, backup)), timeout=2) == "ok"


async def test_failed_backend_is_skipped_on_the_next_turn():
    main = _backend("main", fail=LLMUnavailable("down"))
    backup = _backend("backup", tokens=["a"])
    svc = _chain(main, backup)
    await _collect(svc)
    await _collect(svc)
    assert main.calls == 1  # second turn went straight to the backup
    assert backup.calls == 2


async def test_main_that_recovers_after_cooldown_is_used_again():
    main = _backend("main", tokens=["m"])
    backup = _backend("backup", tokens=["b"])
    svc = _chain(main, backup)
    main._down_until = 0.0
    assert await _collect(svc) == "m"


async def test_all_backends_failing_raises_a_typed_error():
    svc = _chain(_backend("a", fail=LLMUnavailable("x")), _backend("b", fail=LLMUnavailable("y")))
    with pytest.raises(LLMUnavailable):
        await _collect(svc)


async def test_failure_after_words_were_sent_is_not_restarted_elsewhere():
    main = _backend("main")

    async def partial(messages, system_prompt=None):
        yield "Hel"
        raise LLMUnavailable("dropped")

    main._stream_single = partial
    backup = _backend("backup", tokens=["unused"])
    svc = _chain(main, backup)
    got = []
    with pytest.raises(LLMUnavailable):
        async for t in svc.stream_response([]):
            got.append(t)
    assert got == ["Hel"] and backup.calls == 0


async def test_generate_response_switches_to_backup():
    main = _backend("main", fail=LLMUnavailable("down"))
    backup = _backend("backup", tokens=["answer"])
    assert await _chain(main, backup).generate_response([{"role": "user", "content": "q"}]) == "answer"


async def test_generate_response_times_out_to_backup():
    main = _backend("main", hang=True)
    backup = _backend("backup", tokens=["fast"])
    assert await _chain(main, backup).generate_response([]) == "fast"


def test_backups_are_built_from_settings(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "openai")
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "k")
    monkeypatch.setattr(settings, "LLM_FALLBACK_PROVIDER", "openai")
    monkeypatch.setattr(settings, "LLM_FALLBACK_MODEL", "backup-model")
    monkeypatch.setattr(settings, "LLM_FALLBACK_BASE_URL", "http://backup:1/v1")
    monkeypatch.setattr(settings, "LLM_FALLBACK_API_KEY", "k2")
    monkeypatch.setattr(settings, "LLM_FALLBACKS", '[{"provider":"ollama","model":"llama3.1"}, "junk"]')
    svc = LLMService()
    assert [b.model for b in svc.fallbacks] == ["backup-model", "llama3.1"]
    assert "backup:1" in str(svc.fallbacks[0].client.base_url)
    assert svc.fallbacks[1].fallbacks == []  # a backup never has its own backups


def test_invalid_fallback_json_is_ignored(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "openai")
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "k")
    monkeypatch.setattr(settings, "LLM_FALLBACK_PROVIDER", "")
    monkeypatch.setattr(settings, "LLM_FALLBACKS", "{not json")
    assert LLMService().fallbacks == []
