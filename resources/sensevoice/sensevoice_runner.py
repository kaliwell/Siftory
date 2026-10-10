"""Bounded offline SenseVoiceSmall inference worker.

The Electron host supplies bounded JSON lines containing mono 16 kHz PCM16 audio.
The model and Python environment are installed separately in application data.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import sys


MAX_PCM_BYTES = 16_000 * 2 * 30
MAX_DIARIZATION_TURNS = 64
REAL_STDOUT = sys.stdout


def emit(message: dict[str, object]) -> None:
    REAL_STDOUT.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    REAL_STDOUT.flush()


def fail(message: str, request_id: object | None = None) -> None:
    response: dict[str, object] = {"type": "error", "error": str(message)[:2_000]}
    if request_id is not None:
        response["id"] = request_id
    emit(response)


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--vad-dir")
    parser.add_argument("--speaker-dir")
    arguments = parser.parse_args()
    model_dir = os.path.abspath(arguments.model_dir)
    if not os.path.isfile(os.path.join(model_dir, "model.pt")):
        fail("audio-model-missing")
        return 2

    try:
        # FunASR prints model diagnostics to stdout. Keep stdout machine-readable by
        # forwarding those diagnostics to stderr while loading the persistent model.
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            from funasr import AutoModel

            torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
            model = AutoModel(
                model=model_dir,
                trust_remote_code=False,
                device="cpu",
                disable_update=True,
                hub="hf",
            )
            vad_model = None
            speaker_model = None
            if arguments.vad_dir and arguments.speaker_dir:
                vad_model = AutoModel(
                    model=os.path.abspath(arguments.vad_dir),
                    trust_remote_code=False,
                    device="cpu",
                    disable_update=True,
                )
                speaker_model = AutoModel(
                    model=os.path.abspath(arguments.speaker_dir),
                    trust_remote_code=False,
                    device="cpu",
                    disable_update=True,
                )
    except Exception as error:
        fail(f"sensevoice-startup-failed: {error}")
        return 1

    import numpy as np

    emit({"type": "ready", "diarizationReady": vad_model is not None and speaker_model is not None})
    for line in sys.stdin:
        request_id: object | None = None
        try:
            if len(line) >= MAX_PCM_BYTES * 2:
                raise ValueError("request exceeds the bounded line size")
            request = json.loads(line)
            request_id = request.get("id")
            if not isinstance(request_id, int) or request_id < 1:
                raise ValueError("id must be a positive integer")
            encoded = request["pcm16Base64"]
            operation = request.get("operation", "transcribe")
            if operation not in ("transcribe", "diarize"):
                raise ValueError("unsupported operation")
            if not isinstance(encoded, str):
                raise ValueError("pcm16Base64 must be a string")
            raw = base64.b64decode(encoded, validate=True)
            if not raw or len(raw) > MAX_PCM_BYTES or len(raw) % 2:
                raise ValueError("PCM16 evidence is outside the 30 second bound")
        except Exception as error:  # The host receives a bounded diagnostic only.
            fail(f"invalid-audio-request: {error}", request_id)
            continue

        waveform = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if operation == "diarize":
            if vad_model is None or speaker_model is None:
                fail("audio-diarization-model-missing", request_id)
                continue
            try:
                duration_ms = int(len(waveform) * 1000 / 16_000)
                with contextlib.redirect_stdout(sys.stderr):
                    vad_result = vad_model.generate(input=waveform)
                raw_turns = []
                if isinstance(vad_result, list) and vad_result and isinstance(vad_result[0], dict):
                    value = vad_result[0].get("value")
                    if isinstance(value, list):
                        raw_turns = value
                bounded: list[list[int]] = []
                for item in raw_turns[: MAX_DIARIZATION_TURNS * 4]:
                    if not isinstance(item, (list, tuple)) or len(item) != 2:
                        continue
                    start_ms = max(0, min(duration_ms, int(item[0])))
                    end_ms = max(start_ms, min(duration_ms, int(item[1])))
                    if end_ms <= start_ms:
                        continue
                    if bounded and start_ms - bounded[-1][1] <= 350:
                        bounded[-1][1] = max(bounded[-1][1], end_ms)
                    elif len(bounded) < MAX_DIARIZATION_TURNS:
                        bounded.append([start_ms, end_ms])
                turns = []
                for start_ms, end_ms in bounded:
                    turn: dict[str, object] = {"startMs": start_ms, "endMs": end_ms}
                    if end_ms - start_ms >= 500:
                        start_sample = int(start_ms * 16)
                        end_sample = min(len(waveform), int(end_ms * 16))
                        speech = waveform[start_sample:end_sample]
                        with contextlib.redirect_stdout(sys.stderr):
                            speaker_result = speaker_model.generate(input=speech)
                        embedding = (
                            speaker_result[0].get("spk_embedding")
                            if isinstance(speaker_result, list)
                            and speaker_result
                            and isinstance(speaker_result[0], dict)
                            else None
                        )
                        if hasattr(embedding, "detach"):
                            embedding = embedding.detach().cpu().numpy()
                        vector = np.asarray(embedding, dtype="<f4").reshape(-1)
                        norm = float(np.linalg.norm(vector))
                        if vector.size == 192 and np.isfinite(vector).all() and norm > 1e-8:
                            vector = np.asarray(vector / norm, dtype="<f4")
                            turn["embeddingF32Base64"] = base64.b64encode(vector.tobytes()).decode("ascii")
                    turns.append(turn)
                emit({"type": "diarization", "id": request_id, "turns": turns})
            except Exception as error:
                fail(f"audio-diarization-failed: {error}", request_id)
            continue

        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = model.generate(
                    input=waveform,
                    cache={},
                    language="auto",
                    use_itn=True,
                    batch_size=1,
                )
            if not isinstance(result, list) or not result or not isinstance(result[0], dict):
                raise RuntimeError("SenseVoice returned no result")
            raw_text = result[0].get("text")
            if not isinstance(raw_text, str):
                raise RuntimeError("SenseVoice returned no text")
            emit({"type": "result", "id": request_id, "rawText": raw_text[:16_000]})
        except Exception as error:
            fail(f"sensevoice-inference-failed: {error}", request_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
