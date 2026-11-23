"""Cleaning helpers shared by data preparation: PII scrubbing, speech-length shortening,
and a filter that drops training replies a safe psychologist assistant must never imitate."""
from __future__ import annotations

import hashlib
import re

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_URL = re.compile(r"(https?://|www\.)\S+", re.I)
_PHONE = re.compile(r"(?<!\d)(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){9,12}\d(?!\d)")
_LONG_ID = re.compile(r"(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)")  # Aadhaar-like 12 digits
_HANDLE = re.compile(r"(?<!\w)@\w{3,}")


def scrub_pii(text: str) -> str:
    text = _EMAIL.sub("[email]", text)
    text = _URL.sub("[link]", text)
    text = _LONG_ID.sub("[id]", text)
    text = _PHONE.sub("[phone]", text)
    return _HANDLE.sub("[handle]", text)


_SENT = re.compile(r"(?<=[.!?।])\s+")


def shorten(reply: str, max_sentences: int = 3) -> str:
    """Spoken-style reply: first sentences, always keeping one open question when the source had one."""
    sents = [s.strip() for s in _SENT.split(reply.strip()) if s.strip()]
    if len(sents) <= max_sentences:
        return " ".join(sents)
    kept = sents[: max_sentences - 1]
    question = next((s for s in sents[max_sentences - 1 :] if s.endswith("?")), None)
    kept.append(question or sents[max_sentences - 1])
    return " ".join(kept)


# Things the assistant must not learn to say (see ananya_prompt.py "MEDICAL LIMITATIONS").
_UNSAFE_REPLY = re.compile(
    r"""(
      \byou\s+(definitely\s+|clearly\s+|probably\s+)?(have|are\s+suffering\s+from|suffer\s+from)\s+
        (clinical\s+)?(depression|bipolar|schizophrenia|ptsd|ocd|adhd|anxiety\s+disorder|bpd|borderline)|
      \byou(\s+are|'re)\s+diagnosed|\bmy\s+diagnosis|
      \b\d+\s?(mg|mcg|ml)\b|\b(sertraline|fluoxetine|escitalopram|alprazolam|clonazepam|lorazepam|diazepam|
        zolpidem|lithium|prozac|xanax|valium)\b|
      (stop|quit|skip|reduce|increase)\s+(taking\s+)?(your\s+)?(medication|meds|pills)|
      \b(overdose|hang|jump|cut)\s+(yourself|from)|
      \bi\s+(am|'m)\s+(a\s+)?(licensed|your)\s+(psychologist|therapist|psychiatrist)|
      \bi\s+promise\s+(i\s+won'?t|not\s+to)\s+tell|
      (just\s+)?(snap\s+out\s+of\s+it|stop\s+being\s+(sad|dramatic))|
      \bit'?s\s+all\s+in\s+your\s+head\b
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def is_unsafe_reply(reply: str) -> bool:
    return bool(_UNSAFE_REPLY.search(reply))


def split_for(key: str, val_pct: int = 5, test_pct: int = 5) -> str:
    """Deterministic train/val/test split from a stable key, so reruns never leak test data into train."""
    bucket = int(hashlib.sha256(key.encode()).hexdigest(), 16) % 100
    if bucket < test_pct:
        return "test"
    if bucket < test_pct + val_pct:
        return "val"
    return "train"
