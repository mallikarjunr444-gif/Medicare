"""Safety layer for the AI psychologist (Dr. Ananya), applied around the LLM.

Two deterministic checks that never depend on the model behaving:

* ``is_crisis`` / ``crisis_reply``: suicidal thoughts or self-harm in English, Hindi, Kannada
  (script and romanised). Runs BEFORE generation and is intentionally over-sensitive: a false alarm
  costs one caring message, a miss can cost far more.
* ``review_reply``: after generation, swaps out replies that diagnose, advise on medication,
  promise secrecy, claim to be a licensed clinician or dismiss the person's feelings.
"""
from __future__ import annotations

import re

_CRISIS = re.compile(
    r"""(
      kill(ing)?\s+(myself|my\s*self)|end(ing)?\s+(my|this)\s+(own\s+)?life|tak(e|ing)\s+my\s+(own\s+)?life|
      (too\s+many|overdos\w*|swallow\w*)\s+(of\s+)?(my\s+)?(tablets|pills|medication|meds)|
      want(ed)?\s+(it|this|everything)\s+to\s+(be\s+)?over|
      want(ed)?\s+to\s+die|wanna\s+die|don'?t\s+want\s+to\s+(live|be\s+alive|wake\s+up)|
      no\s+reason\s+to\s+live|better\s+off\s+(dead|without\s+me)|suicid|
      (hurt|harm|cut|cutting|injur\w+)\s+(myself|my\s*self)|self[\s-]?harm|
      end\s+it\s+all|can'?t\s+go\s+on|not\s+worth\s+living|
      mar\s*jana\s+chahta|jeena\s+nahi|jaan\s+de\s+dun|khud\s+ko\s+khatam|
      saayoke|saay?abeku|sayabeku|saybeku|saayabeku|saayo\s*hage|jeevana\s+beda|
      ಸಾಯಬೇಕು|ಸಾಯ್ತೀನಿ|ಜೀವನ\s*ಬೇಡ|ಆತ್ಮಹತ್ಯೆ|आत्महत्या|मरना\s+चाहत|मर\s+जाना\s+चाह|जीना\s+नहीं|खुद\s+को\s+खत्म
    )""",
    re.IGNORECASE | re.VERBOSE,
)

_CRISIS_REPLIES = {
    "en": (
        "I'm really glad you told me, and I'm taking it seriously. You don't have to carry this alone. "
        "Are you safe right now, and is there someone near you who can stay with you? "
        "If you might act on these thoughts, please call 112 (emergency) or Tele-MANAS 14416 (free, 24x7, "
        "in many languages) or go to the nearest hospital now. "
        "I'm an AI, so I can't keep you safe myself, but I'm here to listen while you reach out to someone."
    ),
    "hi": (
        "आपने मुझे बताया, इसके लिए शुक्रिया, और मैं इसे गंभीरता से ले रही हूँ। आपको यह अकेले नहीं उठाना है। "
        "क्या आप अभी सुरक्षित हैं, और क्या कोई आपके पास रह सकता है? "
        "अगर आपको लगता है कि आप खुद को नुकसान पहुँचा सकते हैं, तो कृपया अभी 112 या Tele-MANAS 14416 "
        "(मुफ़्त, 24x7) पर कॉल करें या नज़दीकी अस्पताल जाएँ। "
        "मैं एक AI हूँ और आपको सुरक्षित नहीं रख सकती, पर जब तक आप किसी से संपर्क करते हैं, मैं आपकी बात सुन रही हूँ।"
    ),
    "kn": (
        "ನೀವು ಇದನ್ನು ನನಗೆ ಹೇಳಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದ, ಇದನ್ನು ನಾನು ಗಂಭೀರವಾಗಿ ತೆಗೆದುಕೊಳ್ಳುತ್ತೇನೆ. ಇದನ್ನು ನೀವು ಒಬ್ಬರೇ ಹೊರಬೇಕಿಲ್ಲ. "
        "ನೀವು ಈಗ ಸುರಕ್ಷಿತವಾಗಿದ್ದೀರಾ, ನಿಮ್ಮ ಜೊತೆ ಇರಲು ಯಾರಾದರೂ ಹತ್ತಿರ ಇದ್ದಾರಾ? "
        "ನಿಮಗೆ ನೀವೇ ಹಾನಿ ಮಾಡಿಕೊಳ್ಳಬಹುದು ಎನಿಸಿದರೆ, ದಯವಿಟ್ಟು ಈಗಲೇ 112 ಅಥವಾ Tele-MANAS 14416 "
        "(ಉಚಿತ, 24x7) ಗೆ ಕರೆ ಮಾಡಿ ಅಥವಾ ಹತ್ತಿರದ ಆಸ್ಪತ್ರೆಗೆ ಹೋಗಿ. "
        "ನಾನು AI, ನಿಮ್ಮನ್ನು ಸುರಕ್ಷಿತವಾಗಿಡಲು ನನ್ನಿಂದ ಆಗುವುದಿಲ್ಲ, ಆದರೆ ನೀವು ಯಾರನ್ನಾದರೂ ಸಂಪರ್ಕಿಸುವವರೆಗೆ ನಾನು ಕೇಳುತ್ತಿರುತ್ತೇನೆ."
    ),
}

_FALLBACKS = {
    "en": "That sounds like a lot to carry. I'd like to understand it better. What has been weighing on you most?",
    "hi": "यह काफ़ी भारी लग रहा है। मैं इसे और समझना चाहती हूँ। सबसे ज़्यादा आपको क्या परेशान कर रहा है?",
    "kn": "ಇದು ತುಂಬಾ ಭಾರವಾಗಿ ಅನಿಸುತ್ತಿದೆ. ನಾನು ಇದನ್ನು ಇನ್ನಷ್ಟು ಅರ್ಥಮಾಡಿಕೊಳ್ಳಬೇಕು. ನಿಮಗೆ ಹೆಚ್ಚು ಕಾಡುತ್ತಿರುವುದು ಏನು?",
}

_UNSAFE_REPLY = re.compile(
    r"""(
      \byou\s+(definitely\s+|clearly\s+|probably\s+)?(have|are\s+suffering\s+from|suffer\s+from)\s+
        (clinical\s+)?(depression|bipolar|schizophrenia|ptsd|ocd|adhd|anxiety\s+disorder|bpd|borderline)|
      \byou(\s+are|'re)\s+diagnosed|\bmy\s+diagnosis|\byour\s+diagnosis\s+is|
      \b\d+\s?(mg|mcg|ml)\b|\b(sertraline|fluoxetine|escitalopram|alprazolam|clonazepam|lorazepam|diazepam|
        zolpidem|lithium|prozac|xanax|valium)\b|
      (stop|quit|skip|reduce|increase)\s+(taking\s+)?(your\s+)?(medication|meds|pills|antidepressants?)|
      \b(overdose|hang|jump|cut)\s+(yourself|from)|\bhow\s+to\s+(die|kill|end\s+your\s+life)\b|
      \bi\s+(am|'m)\s+(a\s+)?(licensed|your)\s+(psychologist|therapist|psychiatrist)|
      \bi\s+promise\s+(i\s+won'?t|not\s+to)\s+tell|\b(our|this\s+is\s+our)\s+secret\b|
      (just\s+)?snap\s+out\s+of\s+it|stop\s+being\s+(sad|dramatic)|
      \bit'?s\s+all\s+in\s+your\s+head\b|\bthink\s+positive\b|\bjust\s+be\s+happy\b
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def _lang(language: str | None) -> str:
    code = (language or "en").replace("_", "-").split("-")[0].lower()
    return code if code in _CRISIS_REPLIES else "en"


def is_crisis(text: str) -> bool:
    return bool(_CRISIS.search(text or ""))


def crisis_reply(language: str | None = "en") -> str:
    return _CRISIS_REPLIES[_lang(language)]


def is_unsafe_reply(reply: str) -> bool:
    return bool(_UNSAFE_REPLY.search(reply or ""))


def review_reply(reply: str, language: str | None = "en") -> tuple[str, bool]:
    """Return (reply, replaced). Unsafe replies are replaced whole: patching a diagnosis or a dose
    out of a sentence leaves a reply that still reads like clinical advice."""
    if is_unsafe_reply(reply):
        return _FALLBACKS[_lang(language)], True
    return reply, False
