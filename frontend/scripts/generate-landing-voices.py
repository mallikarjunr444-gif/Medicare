#!/usr/bin/env python3
"""Record Dr. Ananya's landing-page lines with Microsoft's neural female voices.

Run once on a machine with internet access (the sandbox this repo was edited in cannot reach it):

    pip install edge-tts
    python frontend/scripts/generate-landing-voices.py

Writes frontend/public/audio/landing/<kind>-<lang>.mp3 plus manifest.json. The landing page
(lib/landingVoice.ts) uses these clips when present, so Kannada, Hindi and English sound equally
sweet on every device, even phones with no Kannada text-to-speech installed. Without them the page
falls back to the best voice installed on the visitor's device.
"""
import asyncio
import json
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]
LINES = json.loads((ROOT / "lib" / "landingLines.json").read_text(encoding="utf-8"))
OUT = ROOT / "public" / "audio" / "landing"

# Soft, warm female voices; slightly slower and higher than default.
VOICES = {"kn": "kn-IN-SapnaNeural", "hi": "hi-IN-SwaraNeural", "en": "en-IN-NeerjaNeural"}
RATE, PITCH = "-8%", "+4Hz"


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    done = []
    for kind in ("greet", "reply"):
        for lang, voice in VOICES.items():
            clip_id = f"{kind}-{lang}"
            await edge_tts.Communicate(LINES[kind][lang], voice, rate=RATE, pitch=PITCH).save(str(OUT / f"{clip_id}.mp3"))
            done.append(clip_id)
            print("wrote", clip_id)
    (OUT / "manifest.json").write_text(json.dumps(done), encoding="utf-8")


asyncio.run(main())
