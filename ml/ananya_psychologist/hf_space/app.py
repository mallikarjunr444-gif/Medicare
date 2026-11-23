"""Dr. Ananya - AI Mental Wellness Companion (demo Space).

Set Space variables: BASE_MODEL (default Qwen/Qwen2.5-7B-Instruct) and optional ADAPTER (your LoRA repo,
e.g. medicuslabs6361/ananya-lora). Use ZeroGPU or any GPU hardware. Demo only: an AI, not a clinician.
"""
import os

import gradio as gr
import spaces
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from ananya_prompt import ANANYA_SYSTEM_PROMPT
from ananya_safety import CRISIS_REPLY, is_crisis

BASE = os.getenv("BASE_MODEL", "Qwen/Qwen2.5-7B-Instruct")
ADAPTER = os.getenv("ADAPTER")

tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16)
if ADAPTER:
    from peft import PeftModel

    model = PeftModel.from_pretrained(model, ADAPTER)
model.eval()


@spaces.GPU(duration=60)
def generate(history: list[dict]) -> str:
    model.to("cuda")
    ids = tok.apply_chat_template(
        [{"role": "system", "content": ANANYA_SYSTEM_PROMPT}] + history, add_generation_prompt=True, return_tensors="pt"
    ).to("cuda")
    out = model.generate(ids, max_new_tokens=160, do_sample=True, temperature=0.4, top_p=0.9)
    return tok.decode(out[0][ids.shape[-1]:], skip_special_tokens=True).strip()


def respond(message, history):
    if is_crisis(message):  # safety gate runs before the model, always
        return CRISIS_REPLY
    return generate(history[-12:] + [{"role": "user", "content": message}])


gr.ChatInterface(
    respond,
    type="messages",
    title="Dr. Ananya - AI Mental Wellness Companion",
    description="A supportive AI companion, not a licensed psychologist or doctor. In an emergency call 112; "
    "for free 24x7 support in India call Tele-MANAS 14416.",
    examples=["I'm stressed about my exams and can't focus.", "I feel lonely in my hostel.", "My mind keeps racing at night."],
).launch()
