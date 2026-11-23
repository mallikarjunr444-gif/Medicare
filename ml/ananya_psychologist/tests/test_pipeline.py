import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ananya_safety as safety
import data_utils as du
import prepare_data as pd

HERE = Path(__file__).resolve().parents[1]


def test_scrub_pii():
    t = du.scrub_pii("mail me a.b@x.com or +91 98765 43210, see https://x.io, id 1234 5678 9012 @someone")
    assert "@" not in t.replace("[handle]", "") and "98765" not in t and "x.io" not in t and "5678" not in t


def test_shorten_keeps_question():
    r = "One. Two. Three. Four. Why do you think that is?"
    out = du.shorten(r)
    assert out.count(".") + out.count("?") == 3 and out.endswith("?")


def test_unsafe_reply_filter():
    for bad in ["You probably have depression.", "Take 50 mg of sertraline.", "Stop taking your medication.", "I am a licensed psychologist."]:
        assert du.is_unsafe_reply(bad)
    assert not du.is_unsafe_reply("That sounds exhausting. What has been weighing on you most?")


def test_crisis_detection():
    for t in ["I want to kill myself", "mujhe jeena nahi hai", "ನನಗೆ ಸಾಯಬೇಕು", "मैं आत्महत्या के बारे में सोच रहा हूँ", "I want to hurt myself"]:
        assert safety.is_crisis(t), t
    assert not safety.is_crisis("My exam is killing me with stress, I can't focus")


def test_all_crisis_cases_detected():
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    missed = [c["user"] for c in cases["crisis"] if not safety.is_crisis(c["user"])]
    assert not missed, missed


def test_space_copy_in_sync():
    assert (HERE / "ananya_safety.py").read_text() == (HERE / "hf_space/ananya_safety.py").read_text()
    ns = {}
    exec((HERE / "hf_space/ananya_prompt.py").read_text(encoding="utf-8"), ns)
    assert pd.system_prompt() == ns["ANANYA_SYSTEM_PROMPT"]


def test_example_building_and_split():
    ex = pd.example("SYS", [("user", "I feel low."), ("assistant", "That sounds hard to carry. What happened today? Tell me more.")], "t")
    assert ex and ex["messages"][-1]["role"] == "assistant"
    assert pd.example("SYS", [("user", "x"), ("assistant", "You have depression for sure, take 20 mg.")], "t") is None
    assert du.split_for("abc") == du.split_for("abc")
