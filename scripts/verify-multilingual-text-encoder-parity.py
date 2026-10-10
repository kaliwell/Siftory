"""Parity check: torch sentence-transformers (fp32 reference) vs the shipped
ONNX quint8 export + JS-equivalent mean pooling + Dense projection.

Mirrors the OSNet export acceptance protocol (torch vs ONNX cosine ~= 1.0),
isolating quantization error from the model's intrinsic anisotropy.

Usage (from repo root, requires .venv-parity with torch/sentence-transformers/onnxruntime):
    .venv-parity/Scripts/python.exe scripts/verify-multilingual-text-encoder-parity.py

Set HTTPS_PROXY/HTTP_PROXY first if your network requires a proxy for the initial fp32 download (539MB).
"""

import os
import sys

import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(
    REPO_ROOT,
    "ai-models",
    "clip_vit_b32_multilingual_v1_text",
    "sentence-transformers",
    "clip-ViT-B-32-multilingual-v1",
)
ONNX_PATH = os.path.join(MODEL_DIR, "onnx", "model_quint8_avx2.onnx")
DENSE_PATH = os.path.join(MODEL_DIR, "2_Dense", "model.safetensors")
MODEL_ID = "sentence-transformers/clip-ViT-B-32-multilingual-v1"

SENTENCES = [
    "一只猫",
    "a cat",
    "红色连衣裙",
    "a red dress",
    "夜晚的城市街道",
    "a city street at night",
    "穿着白色袜子的小女孩",
    "quantum physics",
    "海边日落",
    "people playing soccer on the beach",
]


def load_dense_weights():
    import json
    import struct

    with open(DENSE_PATH, "rb") as f:
        header_len = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(header_len))
        meta = header["linear.weight"]
        start, end = meta["data_offsets"]
        data = f.read(end - start)
    weights = np.frombuffer(data, dtype="<f4").reshape(meta["shape"])
    return weights  # [512, 768], torch nn.Linear layout


def onnx_embed(session, tokenizer, dense, sentences):
    inputs = tokenizer(
        sentences,
        padding=True,
        truncation=True,
        max_length=128,
        return_tensors="np",
    )
    outputs = session.run(
        None,
        {
            "input_ids": inputs["input_ids"].astype(np.int64),
            "attention_mask": inputs["attention_mask"].astype(np.int64),
        },
    )
    hidden = outputs[0]  # [batch, seq, 768]
    mask = inputs["attention_mask"][..., None].astype(np.float32)
    pooled = (hidden * mask).sum(axis=1) / np.clip(mask.sum(axis=1), 1e-9, None)
    projected = pooled @ dense.T
    return projected / np.linalg.norm(projected, axis=1, keepdims=True)


def main():
    if not os.path.exists(ONNX_PATH):
        print(f"SKIP: {ONNX_PATH} missing")
        return 2

    import onnxruntime as ort
    from sentence_transformers import SentenceTransformer
    from transformers import AutoTokenizer

    print("loading torch reference (fp32, first run downloads ~539MB)...")
    reference = SentenceTransformer(MODEL_ID, device="cpu")
    ref_vectors = reference.encode(SENTENCES, normalize_embeddings=True)

    print("running ONNX quint8 + manual pooling/dense ...")
    session = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    onnx_vectors = onnx_embed(session, tokenizer, load_dense_weights(), SENTENCES)

    worst = 1.0
    failed = False
    for sentence, ref, got in zip(SENTENCES, ref_vectors, onnx_vectors):
        cos = float(np.dot(ref, got))
        worst = min(worst, cos)
        status = "OK " if cos >= 0.999 else "LOW"
        print(f"{status} cos={cos:.6f}  {sentence}")
        if cos < 0.999:
            failed = True

    print(f"worst cosine: {worst:.6f}")
    print("PARITY OK" if not failed else "PARITY BELOW 0.999 (quantization drift)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
