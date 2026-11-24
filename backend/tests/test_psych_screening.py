"""Dr. Ananya's automatic check-in questionnaires: scoring, consent, flow and crisis stop."""
import asyncio

import pytest

from app.services import psych_screening as ps
from app.websocket import ConnectionManager
from tests.test_websocket import _wire_session

# ── scoring (published cut-offs) ────────────────────────────────────────────


def _run(scale_id, answers):
    s = ps.new_state()
    ps.start(s, scale_id)
    step = None
    for a in answers:
        step = ps.handle(s, str(a))
    return s, step


@pytest.mark.parametrize("total,band", [(0, "minimal"), (4, "minimal"), (5, "mild"), (9, "mild"), (10, "moderate"), (14, "moderate"), (15, "moderately_severe"), (19, "moderately_severe"), (20, "severe"), (27, "severe")])
def test_phq9_bands(total, band):
    answers = [0] * 9  # item 9 stays 0 so the crisis stop does not trigger
    left = total
    for i in range(8):
        answers[i] = min(3, left)
        left -= answers[i]
    s, step = _run("phq9", answers) if total <= 24 else (None, None)
    if total > 24:  # 27 needs item 9 = 3, which (correctly) triggers the crisis stop instead
        s, step = _run("phq9", [3] * 9)
        assert step.crisis and s["result"] is None
        return
    assert s["result"] == {"scale": "phq9", "score": total, "band": band}


@pytest.mark.parametrize("total,band", [(0, "minimal"), (4, "minimal"), (5, "mild"), (10, "moderate"), (15, "severe"), (21, "severe")])
def test_gad7_bands(total, band):
    answers, left = [], total
    for _ in range(7):
        v = min(3, left)
        answers.append(v)
        left -= v
    s, _ = _run("gad7", answers)
    assert s["result"] == {"scale": "gad7", "score": total, "band": band}


def test_who5_is_raw_times_four():
    assert _run("who5", [5] * 5)[0]["result"]["score"] == 100
    assert _run("who5", [0] * 5)[0]["result"]["score"] == 0
    s, _ = _run("who5", [2] * 5)
    assert s["result"] == {"scale": "who5", "score": 40, "band": "low"}
    assert _run("who5", [3] * 5)[0]["result"]["band"] == "usual"


def test_pss10_reverse_scores_items_4_5_7_8():
    assert _run("pss10", [0, 0, 0, 4, 4, 0, 4, 4, 0, 0])[0]["result"]["score"] == 0
    assert _run("pss10", [4, 4, 4, 0, 0, 4, 0, 0, 4, 4])[0]["result"]["score"] == 40
    s, _ = _run("pss10", [2] * 10)
    assert s["result"] == {"scale": "pss10", "score": 20, "band": "moderate"}


def test_item_counts_match_the_instruments():
    assert [len(ps.SCALES[k].items) for k in ("phq9", "gad7", "who5", "pss10")] == [9, 7, 5, 10]


# ── answer parsing ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("text,value", [("not at all", 0), ("Never", 0), ("several days", 1), ("sometimes", 1), ("more than half the days", 2), ("nearly every day", 3), ("every day", 3), ("2", 2), ("0", 0)])
def test_parse_frequency_answers(text, value):
    assert ps.parse_answer(ps.PHQ9, text) == value


def test_parse_rejects_non_answers():
    for t in ["", "I don't know what to say about my job", "4", "banana", "my mother keeps shouting at me every single day at home"]:
        assert ps.parse_answer(ps.PHQ9, t) is None


@pytest.mark.parametrize("text,value", [("all of the time", 5), ("most of the time", 4), ("more than half of the time", 3), ("less than half of the time", 2), ("some of the time", 1), ("at no time", 0)])
def test_parse_who5(text, value):
    assert ps.parse_answer(ps.WHO5, text) == value


@pytest.mark.parametrize("text,value", [("never", 0), ("almost never", 1), ("sometimes", 2), ("fairly often", 3), ("very often", 4)])
def test_parse_pss(text, value):
    assert ps.parse_answer(ps.PSS10, text) == value


# ── which questionnaire, and consent ────────────────────────────────────────


def test_scale_choice_follows_what_the_person_talks_about():
    assert ps.choose_scale("I feel so sad and hopeless, nothing matters") == "phq9"
    assert ps.choose_scale("I'm anxious and worried all the time, I panic") == "gad7"
    assert ps.choose_scale("so much exam pressure and deadlines, I'm overwhelmed") == "pss10"
    assert ps.choose_scale("things are okay I guess") == "who5"


LONG = "I have been struggling a lot with everything lately"


def test_offer_only_after_several_substantive_messages_and_never_for_greetings():
    s = ps.new_state()
    assert not ps.should_offer(s, "hello", "en", True)
    assert not ps.should_offer(s, "ok", "en")
    assert not ps.should_offer(s, LONG, "en")
    assert not ps.should_offer(s, LONG, "en")
    assert ps.should_offer(s, LONG, "en")  # third substantive message


def test_no_offer_in_hindi_or_kannada_because_only_english_wording_is_included():
    s = ps.new_state()
    for _ in range(5):
        assert not ps.should_offer(s, LONG, "kn")
        assert not ps.should_offer(s, LONG, "hi")


def test_never_starts_without_a_yes():
    s = ps.new_state()
    for _ in range(3):
        ps.should_offer(s, LONG, "en")
    text = ps.make_offer(s)
    assert "not a diagnosis" in text and s["phase"] == "offered"
    assert ps.handle(s, "I also can't sleep at night and it is really affecting my work") is None  # kept talking
    assert s["phase"] == "idle" and not s["answers"]


def test_declining_ends_it_for_the_session():
    s = ps.new_state()
    for _ in range(3):
        ps.should_offer(s, LONG, "en")
    ps.make_offer(s)
    assert "no problem" in ps.handle(s, "no thanks").reply
    assert s["done"] and not ps.should_offer(s, LONG, "en")


def test_yes_starts_and_stop_ends():
    s = ps.new_state()
    for _ in range(3):
        ps.should_offer(s, "I feel anxious and worried constantly about everything", "en")
    ps.make_offer(s)
    assert ps.handle(s, "yes please").reply.startswith("Over the last two weeks")
    assert ps.handle(s, "several days").reply.startswith("Next")
    assert "stop there" in ps.handle(s, "stop").reply and s["phase"] == "declined" and s["result"] is None


def test_unclear_answer_is_reasked_once_then_normal_chat_resumes():
    s = ps.new_state()
    ps.start(s, "gad7")
    assert "didn't catch" in ps.handle(s, "hmm").reply
    assert ps.handle(s, "dunno") is None and s["done"]


def test_phq9_item9_stops_and_returns_the_crisis_reply():
    s = ps.new_state()
    ps.start(s, "phq9")
    for _ in range(8):
        ps.handle(s, "0")
    step = ps.handle(s, "several days")
    assert step.crisis and "14416" in step.reply and "112" in step.reply
    assert s["result"] is None and "self-harm" in s["context_note"]


def test_summary_is_not_a_diagnosis_and_leaves_a_note_for_the_model():
    s, step = _run("gad7", [3] * 7)
    assert "not a diagnosis" in step.reply and "doctor or counsellor" in step.reply and "14416" in step.reply
    assert "never diagnose" in s["context_note"] and "21/21" in s["context_note"]


# ── end to end through the websocket turn handler ───────────────────────────


def _harness(monkeypatch, doctor_id):
    m = ConnectionManager()
    ws = _wire_session(m)
    m.session_data["s1"].update(doctor_id=doctor_id, language="en")
    prompts = []

    async def noop(*a, **k):
        return None

    async def animate(session_id, queue):
        while await queue.get() is not None:
            pass

    async def fake_stream(messages, system_prompt=None):
        prompts.append(system_prompt)
        for tok in ["That ", "sounds ", "really ", "hard. ", "I'm ", "here ", "with ", "you."]:
            yield tok

    monkeypatch.setattr(m, "_persist_message", noop)
    monkeypatch.setattr(m, "_ensure_conversation_title", noop)
    monkeypatch.setattr(m, "_animate_from_queue", animate)
    monkeypatch.setattr(m, "_roll_memory", noop, raising=False)
    monkeypatch.setattr("app.websocket.llm_service.stream_response", fake_stream)
    monkeypatch.setattr("app.websocket.tts_service", type("T", (), {"__getattr__": lambda s, n: noop})(), raising=False)

    async def turn(text):
        await asyncio.wait_for(m._handle_text_input_inner("s1", text), timeout=10)

    def assistant_msgs():
        return [x["content"] for x in ws.sent if x.get("type") == "message" and x.get("role") == "assistant"]

    return turn, assistant_msgs, prompts


CONCERNS = [
    "I have been feeling very anxious and worried about my exams",
    "I cannot sleep and my mind keeps racing about everything every night",
    "My parents keep expecting so much and I get scared I will fail them",
]


@pytest.mark.asyncio
async def test_full_conversation_offer_questionnaire_summary(monkeypatch):
    turn, assistant_msgs, prompts = _harness(monkeypatch, "dr_ananya")
    for t in CONCERNS:
        await turn(t)
    assert "quick check-in questionnaire" in assistant_msgs()[-1]  # offered after her normal reply
    assert "sounds really hard" in assistant_msgs()[-2]  # she listened and replied first

    await turn("yes")
    assert "First: feeling nervous, anxious, or on edge" in assistant_msgs()[-1]
    for _ in range(7):
        await turn("more than half the days")
    final = assistant_msgs()[-1]
    assert "GAD-7 score is 14 out of 21" in final and "not a diagnosis" in final

    await turn("The nights are the worst part honestly")  # normal chat resumes with the result in context
    assert "CHECK-IN RESULT" in prompts[-1] and "14/21" in prompts[-1]


@pytest.mark.asyncio
async def test_other_doctors_never_get_check_ins(monkeypatch):
    turn, assistant_msgs, _ = _harness(monkeypatch, "dr_arjun")
    for t in CONCERNS + ["yes"]:
        await turn(t)
    assert not any("questionnaire" in x for x in assistant_msgs())


@pytest.mark.asyncio
async def test_item9_through_the_chat_returns_crisis_help(monkeypatch):
    turn, assistant_msgs, _ = _harness(monkeypatch, "dr_ananya")
    for t in ["I feel so sad and hopeless and empty every single day lately",
              "Nothing matters to me and I feel worthless and alone right now",
              "I just cry all the time and I have no energy for anything at all"]:
        await turn(t)
    await turn("yes")
    for _ in range(8):
        await turn("not at all")
    await turn("several days")  # item 9
    last = assistant_msgs()[-1]
    assert "14416" in last and "112" in last
