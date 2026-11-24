"""Automatic, conversational mental-health check-ins for Dr. Ananya.

Flow (all deterministic, no LLM, so scoring is exact and cannot be talked out of its rules):

  1. Ananya listens normally. After the person has shared a few concerns she asks, once or twice at
     most, whether they would like a short check-in questionnaire (never starts without a "yes").
  2. She asks the questions one at a time. The person can answer in words or numbers, and can say
     "stop" at any time. Anything that is not an answer ends the questionnaire and goes back to normal
     conversation.
  3. She scores it and gives a gentle, non-diagnostic summary. The result is also given to the model
     (``context_note``) so the rest of the conversation can follow up on it.

PHQ-9 item 9 (thoughts of self-harm) answered above 0 stops everything and returns the crisis reply.

Scales: PHQ-9, GAD-7 (Pfizer, free to use), WHO-5 and PSS-10 (items as in frontend/lib/wellness).
Only English wording is included: validated Hindi/Kannada versions must come from their rights holders,
so in other languages no questionnaire is offered. DASS-21 and PSQI are not included yet.
These are screening tools. They never diagnose.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.services import psych_safety

FREQ4 = ["Not at all", "Several days", "More than half the days", "Nearly every day"]


@dataclass(frozen=True)
class Scale:
    id: str
    name: str
    intro: str  # spoken before the first item
    items: tuple[str, ...]
    options: tuple[str, ...]  # index = position; value = values[i]
    values: tuple[int, ...]
    reverse: tuple[int, ...] = ()
    stem: str = ""


PHQ9 = Scale(
    "phq9", "PHQ-9",
    "Over the last two weeks, how often have you been bothered by each of these?",
    (
        "little interest or pleasure in doing things",
        "feeling down, depressed, or hopeless",
        "trouble falling or staying asleep, or sleeping too much",
        "feeling tired or having little energy",
        "poor appetite or overeating",
        "feeling bad about yourself, or that you are a failure or have let yourself or your family down",
        "trouble concentrating on things, such as reading the newspaper or watching television",
        "moving or speaking so slowly that other people could have noticed, or the opposite, being so fidgety or restless that you have been moving around a lot more than usual",
        "thoughts that you would be better off dead, or of hurting yourself in some way",
    ),
    tuple(FREQ4), (0, 1, 2, 3),
)
GAD7 = Scale(
    "gad7", "GAD-7",
    "Over the last two weeks, how often have you been bothered by each of these?",
    (
        "feeling nervous, anxious, or on edge",
        "not being able to stop or control worrying",
        "worrying too much about different things",
        "trouble relaxing",
        "being so restless that it is hard to sit still",
        "becoming easily annoyed or irritable",
        "feeling afraid, as if something awful might happen",
    ),
    tuple(FREQ4), (0, 1, 2, 3),
)
WHO5 = Scale(
    "who5", "WHO-5",
    "Over the last two weeks, how much has each of these been true for you?",
    (
        "I have felt cheerful and in good spirits",
        "I have felt calm and relaxed",
        "I have felt active and vigorous",
        "I woke up feeling fresh and rested",
        "My daily life has been filled with things that interest me",
    ),
    ("All of the time", "Most of the time", "More than half of the time", "Less than half of the time", "Some of the time", "At no time"),
    (5, 4, 3, 2, 1, 0),
)
PSS10 = Scale(
    "pss10", "PSS-10",
    "These questions are about your feelings and thoughts during the last month.",
    (
        "In the last month, how often have you been upset because of something that happened unexpectedly?",
        "In the last month, how often have you felt that you were unable to control the important things in your life?",
        "In the last month, how often have you felt nervous and stressed?",
        "In the last month, how often have you felt confident about your ability to handle your personal problems?",
        "In the last month, how often have you felt that things were going your way?",
        "In the last month, how often have you found that you could not cope with all the things that you had to do?",
        "In the last month, how often have you been able to control irritations in your life?",
        "In the last month, how often have you felt that you were on top of things?",
        "In the last month, how often have you been angered because of things that were outside of your control?",
        "In the last month, how often have you felt difficulties were piling up so high that you could not overcome them?",
    ),
    ("Never", "Almost never", "Sometimes", "Fairly often", "Very often"), (0, 1, 2, 3, 4),
    reverse=(3, 4, 6, 7),
)
SCALES = {s.id: s for s in (PHQ9, GAD7, WHO5, PSS10)}

# ── answer parsing ──────────────────────────────────────────────────────────

_STOP = re.compile(r"^\s*(stop|skip|cancel|quit|enough|not now|no more|i don'?t want to (do|continue)|let'?s stop|rukiye|bas)\b", re.I)
_YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok|okay|alright|fine|go ahead|please do|let'?s do it|sounds good|haan|haa|ha|ji|sari)\b", re.I)
_NO = re.compile(r"^\s*(no|nope|nah|not now|no thanks|not really|later|maybe later|nahi|beda)\b", re.I)

_FREQ_WORDS: list[tuple[re.Pattern, int]] = [
    (re.compile(r"nearly every|almost every|every ?day|daily|always|roz|har din", re.I), 3),
    (re.compile(r"more than half|most days|most of the days|aadhe se", re.I), 2),
    (re.compile(r"several|a few days|few days|sometimes|once in a while|kuch din", re.I), 1),
    (re.compile(r"not at all|never|none|not once|kabhi nahi|bilkul nahi", re.I), 0),
]
_WHO_WORDS: list[tuple[re.Pattern, int]] = [
    (re.compile(r"all of the time|all the time|always", re.I), 5),
    (re.compile(r"most of the time|most times", re.I), 4),
    (re.compile(r"more than half", re.I), 3),
    (re.compile(r"less than half", re.I), 2),
    (re.compile(r"some of the time|sometimes|a little", re.I), 1),
    (re.compile(r"at no time|never|not at all|none", re.I), 0),
]
_PSS_WORDS: list[tuple[re.Pattern, int]] = [
    (re.compile(r"very often|all the time|always", re.I), 4),
    (re.compile(r"fairly often|often", re.I), 3),
    (re.compile(r"almost never|hardly ever|rarely", re.I), 1),
    (re.compile(r"never|not at all", re.I), 0),
    (re.compile(r"sometimes|sometime", re.I), 2),
]
_WORDS = {"phq9": _FREQ_WORDS, "gad7": _FREQ_WORDS, "who5": _WHO_WORDS, "pss10": _PSS_WORDS}


def parse_answer(scale: Scale, text: str) -> int | None:
    """Return the item value for a reply, or None if it is not clearly an answer."""
    t = (text or "").strip()
    if not t or len(t.split()) > 8:
        return None
    if re.fullmatch(r"\d", t):
        v = int(t)
        return v if v in scale.values else None
    for pattern, value in _WORDS[scale.id]:
        if pattern.search(t):
            return value
    return None


# ── choosing a scale and the offer ──────────────────────────────────────────

_CUES = {
    "phq9": re.compile(r"\b(sad|down|hopeless|empty|worthless|numb|depress\w*|cry\w*|no interest|nothing matters|lonely|alone|low mood|no energy|giving up)\b", re.I),
    "gad7": re.compile(r"\b(anxi\w*|worr\w*|nervous|panic\w*|afraid|scared|on edge|overthink\w*|restless|fear\w*|racing)\b", re.I),
    "pss10": re.compile(r"\b(stress\w*|overwhelm\w*|pressure|exams?|deadlines?|burn\w*|workload|too much|can'?t cope)\b", re.I),
}


def choose_scale(concern_text: str) -> str:
    scores = {k: len(p.findall(concern_text)) for k, p in _CUES.items()}
    best = max(scores, key=lambda k: (scores[k], -list(scores).index(k)))
    return best if scores[best] else "who5"


_OFFER_FOCUS = {
    "phq9": "how low or down you have been feeling",
    "gad7": "how much worry and anxiety you have been dealing with",
    "pss10": "how much stress you have been under",
    "who5": "how you have been feeling in general",
}


def offer_text(scale_id: str) -> str:
    return (
        f"If you'd like, we can do a quick check-in questionnaire about {_OFFER_FOCUS[scale_id]}. "
        "It takes about two minutes, it's not a diagnosis, and you can stop any time. Would you like to try it?"
    )


# ── state machine ───────────────────────────────────────────────────────────


@dataclass
class Step:
    reply: str
    crisis: bool = False


def new_state() -> dict:
    return {"phase": "idle", "concern_turns": 0, "concern_text": "", "offers": 0, "scale": None, "answers": [], "retries": 0, "done": False, "context_note": None, "result": None}


def _ask(scale: Scale, index: int) -> str:
    n = len(scale.items)
    opts = ", ".join(o.lower() if i else o for i, o in enumerate(scale.options[:-1])) + f", or {scale.options[-1].lower()}"
    lead = f"{scale.intro} First: " if index == 0 else ("Next: " if index < n - 1 else "Last one: ")
    stem = scale.items[index]
    if scale.id == "who5":
        body = f"{lead}{stem}."
    elif scale.id == "pss10":
        body = f"{lead}{stem}"
    else:
        body = f"{lead}{stem}?"
    reminder = f" ({opts})" if index == 0 or index % 3 == 0 else ""
    return body + reminder


def _score(scale: Scale, answers: list[int]) -> tuple[int, str, str]:
    """Return (raw score, band key, plain-language band)."""
    if scale.id == "pss10":
        raw = sum((4 - v) if i in scale.reverse else v for i, v in enumerate(answers))
        return raw, ("low" if raw <= 13 else "moderate" if raw <= 26 else "high"), ("lower" if raw <= 13 else "moderate" if raw <= 26 else "higher") + " stress"
    raw = sum(answers)
    if scale.id == "who5":
        pct = raw * 4
        return pct, ("low" if pct < 50 else "usual"), "lower than usual well-being" if pct < 50 else "well-being in the usual range"
    if scale.id == "gad7":
        k = "minimal" if raw <= 4 else "mild" if raw <= 9 else "moderate" if raw <= 14 else "severe"
        return raw, k, f"{k} anxiety symptoms"
    k = "minimal" if raw <= 4 else "mild" if raw <= 9 else "moderate" if raw <= 14 else "moderately_severe" if raw <= 19 else "severe"
    return raw, k, f"{k.replace('_', ' ')} low-mood symptoms"


_MAX = {"phq9": 27, "gad7": 21, "who5": 100, "pss10": 40}
_NEEDS_SUPPORT = {"moderate", "moderately_severe", "severe", "high", "low"}


def _summary(scale: Scale, raw: int, band_key: str, band: str) -> str:
    out = (
        f"Thank you for answering all of those. Your {scale.name} score is {raw} out of {_MAX[scale.id]}, "
        f"which points to {band}. This is a screening check, not a diagnosis."
    )
    if band_key in _NEEDS_SUPPORT:
        out += " Because it's on the higher side, I'd really encourage talking with a doctor or counsellor about it."
    if (scale.id == "phq9" and raw >= 15) or (scale.id == "gad7" and raw >= 15):
        out += " Tele-MANAS, 14416, is free and open 24 hours if you'd like to talk to someone."
    return out + " What stood out to you as you went through those?"


def _context_note(scale: Scale, raw: int, band: str) -> str:
    return (
        f"CHECK-IN RESULT (the user completed the {scale.name} questionnaire in this chat; screening only, not a diagnosis): "
        f"score {raw}/{_MAX[scale.id]}, {band}. Use it gently: do not recite numbers unless asked, never diagnose or name a disorder, "
        "follow up on what the person finds hardest, and encourage a qualified professional if the result is on the higher side."
    )


def start(state: dict, scale_id: str) -> None:
    state.update(phase="asking", scale=scale_id, answers=[], retries=0)


def should_offer(state: dict, user_text: str, language: str, is_greeting: bool = False) -> bool:
    """Record a user message while idle; True when it is time to offer a check-in."""
    if state["phase"] != "idle" or state["done"] or (language or "en").split("-")[0].lower() != "en":
        return False
    if is_greeting or len(user_text.split()) < 6:
        return False
    state["concern_turns"] += 1
    state["concern_text"] = (state["concern_text"] + " " + user_text)[-1500:]
    if state["concern_turns"] >= 3 and state["offers"] < 2 and state["concern_turns"] - state.get("last_offer_turn", -9) >= 3:
        state["last_offer_turn"] = state["concern_turns"]
        return True
    return False


def make_offer(state: dict) -> str:
    state["offers"] += 1
    state["phase"] = "offered"
    state["scale"] = choose_scale(state["concern_text"])
    return offer_text(state["scale"])


def handle(state: dict, text: str, language: str = "en") -> Step | None:
    """Process a user message in the 'offered' or 'asking' phase. None = not ours, continue as normal chat."""
    phase = state["phase"]
    if phase == "offered":
        if _NO.match(text):
            state.update(phase="declined", done=True)
            return Step("Of course, no problem at all. We can just keep talking. What's on your mind?")
        if _YES.match(text):
            start(state, state["scale"])
            return Step(_ask(SCALES[state["scale"]], 0))
        state["phase"] = "idle"  # they carried on talking; the offer lapses
        return None
    if phase != "asking":
        return None

    scale = SCALES[state["scale"]]
    if _STOP.match(text):
        state.update(phase="declined", done=True)
        return Step("That's completely fine, we'll stop there. Thank you for trying. Tell me more about how you're doing.")
    value = parse_answer(scale, text)
    if value is None:
        state["retries"] += 1
        if state["retries"] > 1 or len(text.split()) > 8:
            state.update(phase="declined", done=True)  # a normal message, not an answer: back to conversation
            return None
        opts = ", ".join(o.lower() for o in scale.options)
        return Step(f"Sorry, I didn't catch that. You can answer with: {opts}. Or say stop if you'd like to skip this.")
    state["retries"] = 0
    index = len(state["answers"])
    state["answers"].append(value)
    if scale.id == "phq9" and index == 8 and value > 0:
        state.update(phase="done", done=True, context_note="CHECK-IN: the user answered yes to thoughts of self-harm on the PHQ-9. Stay with them warmly and encourage immediate human support (112, Tele-MANAS 14416).")
        return Step(psych_safety.crisis_reply(language), crisis=True)
    if len(state["answers"]) < len(scale.items):
        return Step(_ask(scale, len(state["answers"])))
    raw, band_key, band = _score(scale, state["answers"])
    state.update(phase="done", done=True, result={"scale": scale.id, "score": raw, "band": band_key}, context_note=_context_note(scale, raw, band))
    return Step(_summary(scale, raw, band_key, band))
