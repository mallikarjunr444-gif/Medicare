#!/usr/bin/env python3
"""LoRA fine-tune Dr. Ananya on the prepared data (needs a GPU; run on Modal / HF Jobs / your GPU box).

    pip install torch transformers datasets peft trl accelerate bitsandbytes
    python train_lora.py --data data --out ananya-lora

Base model defaults to Qwen2.5-7B-Instruct (Apache-2.0, per the repo's licence audit). Use --base
Qwen/Qwen2.5-3B-Instruct for a smaller GPU. Always run evaluate.py on the result before using it.
"""
import argparse

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

ap = argparse.ArgumentParser()
ap.add_argument("--data", default="data")
ap.add_argument("--out", default="ananya-lora")
ap.add_argument("--base", default="Qwen/Qwen2.5-7B-Instruct")
ap.add_argument("--epochs", type=float, default=2)
ap.add_argument("--lr", type=float, default=1e-4)
ap.add_argument("--no-4bit", action="store_true")
a = ap.parse_args()

tok = AutoTokenizer.from_pretrained(a.base)
quant = None if a.no_4bit else BitsAndBytesConfig(
    load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16
)
model = AutoModelForCausalLM.from_pretrained(a.base, quantization_config=quant, torch_dtype=torch.bfloat16, device_map="auto")

ds = load_dataset("json", data_files={"train": f"{a.data}/train.jsonl", "validation": f"{a.data}/val.jsonl"})
ds = ds.remove_columns([c for c in ds["train"].column_names if c != "messages"])

trainer = SFTTrainer(
    model=model,
    processing_class=tok,
    train_dataset=ds["train"],
    eval_dataset=ds["validation"],
    peft_config=LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM", target_modules="all-linear"),
    args=SFTConfig(
        output_dir=a.out, num_train_epochs=a.epochs, learning_rate=a.lr, per_device_train_batch_size=2,
        gradient_accumulation_steps=8, bf16=True, logging_steps=20, eval_strategy="epoch",
        save_strategy="epoch", max_length=2048, lr_scheduler_type="cosine", warmup_ratio=0.05,
    ),
)
trainer.train()
trainer.save_model(a.out)
tok.save_pretrained(a.out)
