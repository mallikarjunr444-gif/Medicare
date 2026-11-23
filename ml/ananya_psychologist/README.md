# Dr. Ananya - AI Psychologist / Mental Wellness kit

Train, benchmark and demo Dr. Ananya's counselling skill. Nothing here has been trained yet: it is the
tested pipeline. The results come from running it on your GPU.

1. **Data**: `python prepare_data.py --out data` (public Hub data; add `--esconv ESConv.json` for ESConv;
   `--app-chats chats.jsonl --consent-file consented_users.txt` for real MediCare chats, only for users who agreed).
   PII is scrubbed, replies are cut to spoken length, unsafe replies (diagnosis, medication, methods) are dropped.
   Check every dataset's licence first (`--commercial-only` skips research-only sources).
2. **Baseline**: `python evaluate.py --backend hf --base Qwen/Qwen2.5-7B-Instruct`
3. **Train** (GPU): `python train_lora.py --data data --out ananya-lora`
4. **Compare**: `python evaluate.py --backend hf --base Qwen/Qwen2.5-7B-Instruct --adapter ananya-lora`
   Report the baseline and tuned numbers side by side; `benchmark_report.json` keeps every transcript.
5. **Demo**: create a Gradio Space, upload `hf_space/*`, set `BASE_MODEL` and `ADAPTER` variables, pick ZeroGPU/GPU.

Safety: `ananya_safety.py` runs before the model in the demo and benchmark (crisis -> 112 / Tele-MANAS 14416).
The benchmark checks crisis handling, boundaries and spoken style. It is a screening check, not clinical
validation: have a licensed professional review transcripts before real users see the model.

`python -m pytest tests` runs the pipeline tests. Keep `hf_space/ananya_prompt.py` and `ananya_safety.py` in sync (tested).
