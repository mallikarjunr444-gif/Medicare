"""AI psychologist (Dr. Ananya) safety: crisis handling and reply review.

What a real psychologist would and would not do is encoded here as checks:
  * take suicidal thoughts seriously, in the person's own language, and point to human help
  * never diagnose, advise on medication, promise secrecy, claim to be a licensed clinician,
    give methods, or dismiss feelings ("snap out of it")
  * do not over-react to everyday stress or figures of speech
"""
import asyncio

import pytest

from app.services import psych_safety as ps
from app.websocket import ConnectionManager
from tests.test_websocket import FakeWebSocket, _wire_session  # noqa: F401

CRISIS = [
    "I want to kill myself", "I don't want to live anymore", "everyone would be better off without me",
    "I've been thinking about ending my life", "I want to hurt myself tonight", "I can't go on, I want to die",
    "I have been cutting myself again", "There is no reason to live", "I took too many tablets and I want it to be over",
    "I'm planning to end it all after my exams", "life is not worth living",
    "nanage saayabeku anisthide", "mujhe jeena nahi hai, mar jana chahta hu",
    "ನನಗೆ ಸಾಯಬೇಕು ಅನಿಸುತ್ತಿದೆ", "ಆತ್ಮಹತ್ಯೆ ಮಾಡಿಕೊಳ್ಳಬೇಕು ಅನಿಸ್ತಿದೆ", "मैं आत्महत्या के बारे में सोच रहा हूँ", "मुझे मर जाना है, मैं जीना नहीं चाहता",
]
EVERYDAY = [
    "My exams are killing me with stress", "I'm dying of embarrassment", "this heat is killing me",
    "I cut my finger while cooking", "I feel lonely in my hostel", "I can't sleep because my mind is racing",
    "My parents keep comparing me to my cousin", "I'm so tired of studying",
]


@pytest.mark.parametrize("text", CRISIS)
def test_crisis_messages_are_detected(text):
    assert ps.is_crisis(text), text


@pytest.mark.parametrize("text", EVERYDAY)
def test_everyday_stress_is_not_a_crisis(text):
    assert not ps.is_crisis(text), text


@pytest.mark.parametrize("lang,marker", [("en", "Tele-MANAS"), ("hi", "Tele-MANAS"), ("kn", "Tele-MANAS"), ("hi-IN", "Tele-MANAS"), ("xx", "Tele-MANAS")])
def test_crisis_reply_offers_human_help_in_every_language(lang, marker):
    reply = ps.crisis_reply(lang)
    assert marker in reply and "14416" in reply and "112" in reply
    assert "?" in reply or "?" in reply  # asks whether the person is safe
    assert not ps.is_unsafe_reply(reply)


def test_crisis_reply_is_in_the_selected_language():
    assert any("ಀ" <= ch <= "೿" for ch in ps.crisis_reply("kn"))
    assert any("ऀ" <= ch <= "ॿ" for ch in ps.crisis_reply("hi"))
    assert ps.crisis_reply("en").isascii()


def test_crisis_reply_is_honest_about_being_an_ai_and_never_promises_secrecy():
    assert "AI" in ps.crisis_reply("en")
    assert "secret" not in ps.crisis_reply("en").lower()


UNSAFE = [
    "You probably have depression.", "You definitely have bipolar disorder.", "Your diagnosis is generalised anxiety.",
    "Take 50 mg of sertraline at night.", "You could try alprazolam for this.", "Stop taking your antidepressants if you feel fine.",
    "I am a licensed psychologist and I can treat you.", "I promise I won't tell anyone, this is our secret.",
    "Just snap out of it.", "It's all in your head.", "Stop being dramatic.", "Just think positive!", "Here is how to end your life.",
]
SAFE = [
    "That sounds exhausting. What has been weighing on you most?",
    "It makes sense that you feel anxious before exams. What happens in your body when it starts?",
    "I'm an AI, not a psychologist, but I'm here to listen. Would you like to tell me more?",
    "A counsellor or doctor could help you look at this properly. Would you be open to that?",
]


@pytest.mark.parametrize("reply", UNSAFE)
def test_unsafe_replies_are_replaced_whole(reply):
    out, replaced = ps.review_reply(reply, "en")
    assert replaced and out != reply and "?" in out
    assert not ps.is_unsafe_reply(out)


@pytest.mark.parametrize("reply", SAFE)
def test_good_replies_pass_untouched(reply):
    assert ps.review_reply(reply, "en") == (reply, False)


def test_replacement_follows_the_users_language():
    out, _ = ps.review_reply("You definitely have depression.", "kn")
    assert any("ಀ" <= ch <= "೿" for ch in out)


# ── end to end through the websocket turn handler ───────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("doctor_id", ["dr_ananya", "dr_arjun"])
async def test_crisis_turn_bypasses_the_llm_and_replies_with_help(monkeypatch, doctor_id):
    m = ConnectionManager()
    ws = _wire_session(m)
    m.session_data["s1"].update(doctor_id=doctor_id, language="hi")
    persisted, animated = [], []

    async def persist(session_id, role, content, **kw):
        persisted.append((role, content))

    async def animate(session_id, queue):
        while (item := await queue.get()) is not None:
            animated.append(item)

    async def never(*a, **k):
        raise AssertionError("LLM must not be called for a crisis message")

    monkeypatch.setattr(m, "_persist_message", persist)
    monkeypatch.setattr(m, "_animate_from_queue", animate)
    for name in ("_ensure_conversation_title", "_roll_memory"):
        monkeypatch.setattr(m, name, never, raising=False)
    monkeypatch.setattr("app.websocket.llm_service", type("L", (), {"__getattr__": lambda s, n: never})(), raising=False)

    await asyncio.wait_for(m._handle_text_input_inner("s1", "मुझे मर जाना है, मैं जीना नहीं चाहता"), timeout=5)

    replies = [x for x in ws.sent if x.get("role") == "assistant"]
    assert replies and replies[0]["is_emergency"] is True
    assert "14416" in replies[0]["content"] and "112" in replies[0]["content"]
    assert any("ऀ" <= ch <= "ॿ" for ch in replies[0]["content"])
    assert persisted[0][0] == "user" and persisted[-1] == ("assistant", replies[0]["content"])
    assert animated == [replies[0]["content"]]
