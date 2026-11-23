#!/usr/bin/env python3
"""Build Dr. Ananya's supervised fine-tuning data from public datasets (+ optional consented app chats).

    pip install datasets
    python prepare_data.py --out data                      # public sources
    python prepare_data.py --out data --esconv ESConv.json # add ESConv (download from its GitHub repo)
    python prepare_data.py --out data --app-chats chats.jsonl --consent-file consented_users.txt

Output: data/{train,val,test}.jsonl, each line {"messages": [system, user, assistant, ...], "source": ...}.
Every reply is PII-scrubbed, shortened to spoken length and dropped if it would teach unsafe habits
(diagnosing, medication advice, methods, claiming to be a licensed therapist). Test split is hashed
from the conversation text, so it never leaks into training.

LICENCES: check each source before commercial use (see SOURCES). ESConv and some others are
research / non-commercial; set --commercial-only to skip those.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

from data_utils import is_unsafe_reply, scrub_pii, shorten, split_for

ROOT = Path(__file__).resolve().parents[2]
PROMPT_FILE = ROOT / "backend" / "app" / "services" / "ananya_prompt.py"

# name -> (hub id, context column, response column, licence note, commercial use OK?)
SOURCES = {
    "amod-counseling": ("Amod/mental_health_counseling_conversations", "Context", "Response", "RAIL-D (gated; accept terms on the Hub, verify)", False),
}


def system_prompt() -> str:
    spec = importlib.util.spec_from_file_location("ananya_prompt", PROMPT_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.ANANYA_SYSTEM_PROMPT


def clean_reply(text: str) -> str | None:
    reply = shorten(scrub_pii(text.strip()))
    words = len(reply.split())
    if words < 6 or words > 90 or is_unsafe_reply(reply):
        return None
    return reply


def example(system: str, turns: list[tuple[str, str]], source: str) -> dict | None:
    """turns: [(role, text)] ending with the assistant reply to learn."""
    msgs = [{"role": "system", "content": system}]
    for role, text in turns[:-1]:
        msgs.append({"role": role, "content": scrub_pii(text.strip())})
    reply = clean_reply(turns[-1][1])
    if reply is None or not msgs[1:]:
        return None
    msgs.append({"role": "assistant", "content": reply})
    return {"messages": msgs, "source": source}


def from_hub(name: str, system: str):
    from datasets import load_dataset

    hub_id, ctx, resp, _lic, _ok = SOURCES[name]
    for row in load_dataset(hub_id, split="train"):
        if row.get(ctx) and row.get(resp):
            ex = example(system, [("user", row[ctx]), ("assistant", row[resp])], name)
            if ex:
                yield ex


def from_esconv(path: Path, system: str):
    """ESConv: seeker -> user, supporter -> assistant; one example per supporter turn (last 6 turns of context)."""
    for dialog in json.loads(path.read_text(encoding="utf-8")):
        turns: list[tuple[str, str]] = []
        for t in dialog.get("dialog", []):
            role = "user" if t["speaker"] == "seeker" else "assistant"
            turns.append((role, t["content"]))
            if role == "assistant" and len(turns) > 1 and turns[0][0] == "user":
                window = turns[-7:]
                while window and window[0][0] != "user":
                    window = window[1:]
                if window and window[-1][0] == "assistant":
                    ex = example(system, window, "esconv")
                    if ex:
                        yield ex


def from_app_chats(path: Path, consent_file: Path, system: str):
    """Real MediCare consultations. Only users listed in the consent file are read; PII is scrubbed.
    Expected line: {"user_id": "...", "turns": [{"role": "user"|"assistant", "text": "..."}]}"""
    consented = {l.strip() for l in consent_file.read_text().splitlines() if l.strip()}
    for line in path.read_text(encoding="utf-8").splitlines():
        rec = json.loads(line)
        if rec.get("user_id") not in consented:
            continue
        turns = [(t["role"], t["text"]) for t in rec["turns"] if t.get("text")]
        for i, (role, _) in enumerate(turns):
            if role == "assistant" and i > 0:
                window = turns[max(0, i - 6) : i + 1]
                while window and window[0][0] != "user":
                    window = window[1:]
                if len(window) > 1:
                    ex = example(system, window, "app-chat")
                    if ex:
                        yield ex


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("data"))
    ap.add_argument("--esconv", type=Path)
    ap.add_argument("--app-chats", type=Path)
    ap.add_argument("--consent-file", type=Path, help="text file of user ids who agreed to training use")
    ap.add_argument("--commercial-only", action="store_true")
    ap.add_argument("--skip-hub", action="store_true")
    a = ap.parse_args()
    if a.app_chats and not a.consent_file:
        ap.error("--app-chats requires --consent-file (only consenting users' chats may be used)")

    system = system_prompt()
    rows = []
    if not a.skip_hub:
        for name, (_i, _c, _r, _l, commercial) in SOURCES.items():
            if a.commercial_only and not commercial:
                continue
            rows += list(from_hub(name, system))
    if a.esconv and not a.commercial_only:
        rows += list(from_esconv(a.esconv, system))
    if a.app_chats:
        rows += list(from_app_chats(a.app_chats, a.consent_file, system))

    a.out.mkdir(parents=True, exist_ok=True)
    seen, buckets = set(), {"train": [], "val": [], "test": []}
    for r in rows:
        key = json.dumps(r["messages"][1:], ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        buckets[split_for(r["messages"][1]["content"])].append(r)
    for split, items in buckets.items():
        (a.out / f"{split}.jsonl").write_text("\n".join(json.dumps(i, ensure_ascii=False) for i in items) + "\n", encoding="utf-8")
        print(split, len(items))


if __name__ == "__main__":
    main()
