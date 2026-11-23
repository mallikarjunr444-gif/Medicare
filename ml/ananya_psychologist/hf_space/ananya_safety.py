"""Crisis detection and the fixed crisis reply for Dr. Ananya.

The model is never trusted to handle a crisis on its own: this gate runs BEFORE generation
(in the Space and in evaluation). It is deliberately over-sensitive; a false alarm costs one
caring message, a miss can cost far more. Keep this file identical to hf_space/ananya_safety.py
(tests/test_pipeline.py checks it).
"""
from __future__ import annotations

import re

# English, Hinglish and Kannada (romanised + script) expressions of suicidal thoughts / self-harm.
_CRISIS = re.compile(
    r"""(
      kill(ing)?\s+(myself|my\s*self)|end(ing)?\s+(my|this)\s+(own\s+)?life|tak(e|ing)\s+my\s+(own\s+)?life|(too\s+many|overdos\w*|swallow\w*)\s+(of\s+)?(my\s+)?(tablets|pills|medication|meds)|want\s+(it|this|everything)\s+to\s+(be\s+)?over|
      want(ed)?\s+to\s+die|wanna\s+die|don'?t\s+want\s+to\s+(live|be\s+alive|wake\s+up)|
      no\s+reason\s+to\s+live|better\s+off\s+(dead|without\s+me)|suicid|
      (hurt|harm|cut|cutting|injur\w+)\s+(myself|my\s*self)|self[\s-]?harm|
      end\s+it\s+all|can'?t\s+go\s+on|not\s+worth\s+living|
      mar\s*jana\s+chahta|jeena\s+nahi|jaan\s+de\s+dun|khud\s+ko\s+khatam|
      saayoke|saay?abeku|sayabeku|saybeku|saayabeku|saayo\s*hage|jeevana\s+beda|
      ಸಾಯಬೇಕು|ಸಾಯ್ತೀನಿ|ಜೀವನ\s*ಬೇಡ|आत्महत्या|मरना\s+चाहत|जीना\s+नहीं|खुद\s+को\s+खत्म
    )""",
    re.IGNORECASE | re.VERBOSE,
)

HELPLINES = "112 (emergency), Tele-MANAS 14416 (free, 24x7 mental-health support in India)"

CRISIS_REPLY = (
    "I'm really glad you told me, and I'm taking it seriously. You don't have to carry this alone. "
    "Are you safe right now, and is there someone near you who can stay with you? "
    f"If you might act on these thoughts, please call {HELPLINES} or go to the nearest hospital now. "
    "I'm an AI, so I can't keep you safe myself, but I'm here to listen while you reach out to someone."
)


def is_crisis(text: str) -> bool:
    return bool(_CRISIS.search(text or ""))
