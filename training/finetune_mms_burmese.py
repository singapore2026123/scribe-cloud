# -*- coding: utf-8 -*-
"""Fine-tune facebook/mms-1b-all (Burmese adapter) on KWSH care speech recordings.

Prerequisites:
  - GPU (Colab T4/A100 recommended)
  - pip install transformers datasets librosa soundfile jiwer accelerate
  - A labeled dataset: WAV files + ground-truth Burmese transcripts

Usage:
  1. Prepare data/train.jsonl and data/eval.jsonl with format:
     {"audio": "path/to/recording.wav", "text": "ကိုယ်အပူချိန် ၃၆.၆ ဒီဂရီ"}
  2. Upload to Colab or training server
  3. Run: python finetune_mms_burmese.py --data_dir ./data --output_dir ./mms-kwsh
  4. Upload the fine-tuned adapter to the HF Space

The script fine-tunes ONLY the adapter layers (LoRA-style), keeping the base
model frozen. This is efficient (~50MB output) and avoids catastrophic forgetting.
"""
import argparse, json, os
import torch
import librosa
import numpy as np
from dataclasses import dataclass
from typing import Dict, List, Optional, Union
from transformers import (
    Wav2Vec2ForCTC, AutoProcessor, TrainingArguments, Trainer
)
from datasets import Dataset, Audio
import evaluate


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data_dir", default="./data", help="Dir with train.jsonl and eval.jsonl")
    p.add_argument("--output_dir", default="./mms-kwsh", help="Output directory for fine-tuned model")
    p.add_argument("--epochs", type=int, default=30, help="Training epochs")
    p.add_argument("--batch_size", type=int, default=8, help="Per-device batch size")
    p.add_argument("--lr", type=float, default=1e-4, help="Learning rate")
    p.add_argument("--max_audio_sec", type=float, default=15.0, help="Max audio length in seconds")
    p.add_argument("--freeze_base", action="store_true", default=True, help="Freeze base model, train adapter only")
    return p.parse_args()


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def prepare_dataset(entries, processor, max_sec):
    audio_arrays = []
    texts = []
    for e in entries:
        path = e["audio"]
        text = e["text"].strip()
        if not text or not os.path.exists(path):
            continue
        y, sr = librosa.load(path, sr=16000, mono=True)
        if len(y) / 16000 > max_sec:
            y = y[:int(max_sec * 16000)]
        audio_arrays.append(y)
        texts.append(text)

    def process_batch(batch):
        inputs = processor(batch["audio"], sampling_rate=16000, return_tensors="pt", padding=True)
        with processor.as_target_processor():
            labels = processor(batch["text"], return_tensors="pt", padding=True)
        batch["input_values"] = inputs.input_values
        batch["labels"] = labels.input_ids
        return batch

    ds = Dataset.from_dict({"audio": audio_arrays, "text": texts})
    return ds


@dataclass
class DataCollatorCTCWithPadding:
    processor: AutoProcessor
    padding: Union[bool, str] = True

    def __call__(self, features: List[Dict[str, Union[List[int], torch.Tensor]]]) -> Dict[str, torch.Tensor]:
        input_values = [{"input_values": f["input_values"]} for f in features]
        batch = self.processor.pad(input_values, padding=self.padding, return_tensors="pt")

        label_features = [{"input_ids": f["labels"]} for f in features]
        with self.processor.as_target_processor():
            labels_batch = self.processor.pad(label_features, padding=self.padding, return_tensors="pt")

        labels = labels_batch["input_ids"].masked_fill(labels_batch.attention_mask.ne(1), -100)
        batch["labels"] = labels
        return batch


def compute_metrics(pred, processor):
    cer_metric = evaluate.load("cer")
    pred_logits = pred.predictions
    pred_ids = np.argmax(pred_logits, axis=-1)
    pred_str = processor.batch_decode(pred_ids)

    label_ids = pred.label_ids
    label_ids[label_ids == -100] = processor.tokenizer.pad_token_id
    label_str = processor.batch_decode(label_ids, group_tokens=False)

    cer = cer_metric.compute(predictions=pred_str, references=label_str)
    return {"cer": cer}


def main():
    args = parse_args()

    print("Loading MMS model + Burmese adapter...")
    processor = AutoProcessor.from_pretrained("facebook/mms-1b-all")
    model = Wav2Vec2ForCTC.from_pretrained("facebook/mms-1b-all")
    processor.tokenizer.set_target_lang("mya")
    model.load_adapter("mya")

    if args.freeze_base:
        for name, param in model.named_parameters():
            if "adapter" not in name and "lm_head" not in name:
                param.requires_grad = False
        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total = sum(p.numel() for p in model.parameters())
        print(f"Trainable: {trainable:,} / {total:,} ({100*trainable/total:.1f}%)")

    print("Loading training data...")
    train_entries = load_jsonl(os.path.join(args.data_dir, "train.jsonl"))
    eval_entries = load_jsonl(os.path.join(args.data_dir, "eval.jsonl"))
    print(f"  Train: {len(train_entries)}, Eval: {len(eval_entries)}")

    train_ds = prepare_dataset(train_entries, processor, args.max_audio_sec)
    eval_ds = prepare_dataset(eval_entries, processor, args.max_audio_sec)

    def preprocess(batch):
        audio = batch["audio"]
        inputs = processor(audio, sampling_rate=16000, return_tensors="np", padding=False)
        batch["input_values"] = inputs.input_values[0]
        with processor.as_target_processor():
            batch["labels"] = processor(batch["text"]).input_ids
        return batch

    train_ds = train_ds.map(preprocess, remove_columns=["audio", "text"])
    eval_ds = eval_ds.map(preprocess, remove_columns=["audio", "text"])

    data_collator = DataCollatorCTCWithPadding(processor=processor)

    training_args = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        learning_rate=args.lr,
        warmup_steps=100,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="cer",
        greater_is_better=False,
        logging_steps=10,
        fp16=torch.cuda.is_available(),
        gradient_accumulation_steps=2,
        group_by_length=True,
        report_to="none",
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=data_collator,
        compute_metrics=lambda pred: compute_metrics(pred, processor),
        tokenizer=processor,
    )

    print("Starting fine-tuning...")
    trainer.train()
    trainer.save_model(args.output_dir)
    processor.save_pretrained(args.output_dir)
    print(f"Fine-tuned model saved to {args.output_dir}")
    print("Upload the output directory to HF Space to use the fine-tuned adapter.")


if __name__ == "__main__":
    main()
