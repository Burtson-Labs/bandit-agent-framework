"""SFT with LoRA/QLoRA through Unsloth + TRL, assistant tokens only, checkpointed for resume."""
from __future__ import annotations

import glob
import os
import signal
import time
from typing import Callable

from . import data

TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


class Stop:
    """SIGTERM (pod eviction, node drain, Job delete) → save a checkpoint and stop cleanly."""

    requested = False

    @classmethod
    def install(cls) -> None:
        signal.signal(signal.SIGTERM, lambda *_: setattr(cls, "requested", True))


def latest_checkpoint(output_dir: str) -> str | None:
    found = sorted(glob.glob(os.path.join(output_dir, "checkpoint-*")), key=lambda p: int(p.rsplit("-", 1)[-1]))
    return found[-1] if found else None


def render(tokenizer, rows: list[dict], family: str, max_len: int) -> tuple[list[str], int]:
    texts, dropped = [], 0
    for row in rows:
        messages, tools = data.to_chat(row)
        if not any(m["role"] == "assistant" for m in messages):
            dropped += 1
            continue
        kwargs = {"tokenize": False, "add_generation_prompt": False}
        if tools:
            kwargs["tools"] = tools
        text = tokenizer.apply_chat_template(messages, **kwargs)
        if len(tokenizer(text, add_special_tokens=False)["input_ids"]) > max_len:
            dropped += 1           # never train on a truncated trajectory (it would teach cut-off answers)
            continue
        texts.append(text)
    return texts, dropped


def run_sft(spec: dict, train_rows: list[dict], eval_rows: list[dict], output_dir: str,
            report: Callable[..., None], *, smoke: bool) -> tuple[object, object, dict]:
    import torch
    from unsloth import FastLanguageModel  # noqa: I001 — Unsloth must import before transformers/trl
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer

    hyper = spec["hyper"]
    max_len = int(hyper["maxSeqLen"])
    report(status="preparing", stage="loading base model", message=spec["hf"])
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=spec["hf"], max_seq_length=max_len, load_in_4bit=spec["method"] == "qlora", dtype=None,
        token=os.getenv("HF_TOKEN") or None)
    model = FastLanguageModel.get_peft_model(
        model, r=int(hyper["rank"]), lora_alpha=int(hyper["alpha"]), lora_dropout=0, bias="none",
        target_modules=TARGET_MODULES, use_gradient_checkpointing="unsloth", random_state=3407)

    train_texts, dropped = render(tokenizer, train_rows, spec["family"], max_len)
    eval_texts, _ = render(tokenizer, eval_rows, spec["family"], max_len)
    if not train_texts:
        raise RuntimeError(f"no trainable examples fit in maxSeqLen={max_len} ({dropped} too long)")
    report(status="preparing", stage="dataset", message=f"{len(train_texts)} train / {len(eval_texts)} eval examples "
                                                          f"({dropped} longer than {max_len} tokens skipped)")
    tokens_per_example = sum(len(tokenizer(t, add_special_tokens=False)["input_ids"]) for t in train_texts[:200]) / min(200, len(train_texts))

    batch, accum = int(hyper["batch"]), int(hyper["gradAccum"])
    config = SFTConfig(
        output_dir=output_dir, dataset_text_field="text", max_length=max_len, packing=False,
        per_device_train_batch_size=batch, gradient_accumulation_steps=accum,
        num_train_epochs=float(hyper["epochs"]), max_steps=20 if smoke else -1,
        learning_rate=float(hyper["lr"]), lr_scheduler_type="cosine", warmup_ratio=0.03, weight_decay=0.01,
        optim="adamw_8bit", bf16=torch.cuda.is_bf16_supported(), fp16=not torch.cuda.is_bf16_supported(),
        logging_steps=1 if smoke else 5, save_strategy="steps", save_steps=10 if smoke else 50, save_total_limit=3,
        eval_strategy="steps" if eval_texts else "no", eval_steps=10 if smoke else 50,
        per_device_eval_batch_size=1, report_to="none", seed=3407, dataset_num_proc=1)

    class Progress(TrainerCallback):
        def __init__(self):
            self.started = time.monotonic()
            self.first_step = None

        def on_log(self, args, state, control, logs=None, **kw):
            logs = logs or {}
            step, total = state.global_step, state.max_steps
            if self.first_step is None:
                self.first_step = (step, time.monotonic())
            s0, t0 = self.first_step
            rate = (step - s0) / max(1e-6, time.monotonic() - t0)
            eta = (total - step) / rate if rate > 0 else None
            tps = rate * batch * accum * tokens_per_example if rate > 0 else None
            try:
                report(status="training", step=step, totalSteps=total, epoch=round(state.epoch or 0, 3),
                       loss=logs.get("loss"), evalLoss=logs.get("eval_loss"),
                       tokensPerSec=round(tps) if tps else None, etaSeconds=round(eta) if eta else None)
            except Exception as exc:  # Cancelled → stop at the next step boundary
                if type(exc).__name__ == "Cancelled":
                    control.should_save = True
                    control.should_training_stop = True
                    Stop.requested = True

        def on_step_end(self, args, state, control, **kw):
            if Stop.requested:
                control.should_save = True
                control.should_training_stop = True

    trainer = SFTTrainer(model=model, processing_class=tokenizer, args=config,
                         train_dataset=Dataset.from_dict({"text": train_texts}),
                         eval_dataset=Dataset.from_dict({"text": eval_texts}) if eval_texts else None,
                         callbacks=[Progress()])
    markers = data.RESPONSE_MARKERS[spec["family"]]
    trainer = train_on_responses_only(trainer, instruction_part=markers["instruction"], response_part=markers["response"])
    # The checkpoint directory is per run, so any checkpoint there is this run's: a pod retry inside the
    # Job (eviction, OOM, node reboot) and an explicit resume both continue from it.
    resume = latest_checkpoint(output_dir)
    if resume:
        report(status="training", stage="resuming", message=os.path.basename(resume))
    result = trainer.train(resume_from_checkpoint=resume)
    metrics = dict(result.metrics or {})
    if eval_texts:
        metrics.update(trainer.evaluate())
    return model, tokenizer, {"trainExamples": len(train_texts), "evalExamples": len(eval_texts),
                              "skippedTooLong": dropped, "stopped": Stop.requested,
                              **{k: v for k, v in metrics.items() if isinstance(v, (int, float))}}
