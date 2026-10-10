#!/usr/bin/env python3
"""Isolated ONNX Runtime CUDA runner used by the DINO/CLIP provider PoC."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import onnxruntime as ort


DTYPES = {
    "float32": np.float32,
    "int64": np.int64,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--input-manifest", required=True)
    parser.add_argument("--output-raw", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--iterations", type=int, default=5)
    return parser.parse_args()


def read_inputs(manifest_path: Path) -> tuple[dict[str, np.ndarray], dict]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise ValueError("input manifest schemaVersion must be 1")
    tensors: dict[str, np.ndarray] = {}
    for entry in manifest.get("tensors", []):
        name = entry.get("name")
        dtype_name = entry.get("dtype")
        dimensions = entry.get("dimensions")
        relative_path = entry.get("file")
        if not isinstance(name, str) or dtype_name not in DTYPES:
            raise ValueError("input tensor name or dtype is invalid")
        if not isinstance(dimensions, list) or not dimensions:
            raise ValueError(f"{name}: dimensions are invalid")
        if not all(isinstance(value, int) and value > 0 for value in dimensions):
            raise ValueError(f"{name}: dimensions must be positive integers")
        if not isinstance(relative_path, str) or Path(relative_path).name != relative_path:
            raise ValueError(f"{name}: tensor file must be a local basename")
        raw_path = manifest_path.parent / relative_path
        tensor = np.fromfile(raw_path, dtype=DTYPES[dtype_name])
        expected = int(np.prod(dimensions))
        if tensor.size != expected:
            raise ValueError(f"{name}: expected {expected} values, found {tensor.size}")
        tensors[name] = tensor.reshape(dimensions)
    if not tensors:
        raise ValueError("input manifest contains no tensors")
    return tensors, manifest


def profile_provider_assignments(profile_path: Path) -> tuple[dict[str, int], dict[str, dict[str, int]], dict[str, list[str]]]:
    events = json.loads(profile_path.read_text(encoding="utf-8"))
    assignments: dict[str, dict[str, str]] = defaultdict(dict)
    for event in events:
        arguments = event.get("args") or {}
        provider = arguments.get("provider")
        operation = arguments.get("op_name") or event.get("name")
        node = event.get("name")
        if isinstance(provider, str) and isinstance(operation, str) and isinstance(node, str):
            assignments[provider][node.removesuffix("_kernel_time")] = operation
    node_counts = {provider: len(nodes) for provider, nodes in sorted(assignments.items())}
    operation_counts = {
        provider: dict(sorted(Counter(nodes.values()).items()))
        for provider, nodes in sorted(assignments.items())
    }
    node_names = {provider: sorted(nodes) for provider, nodes in sorted(assignments.items())}
    return node_counts, operation_counts, node_names


def main() -> int:
    args = parse_args()
    if args.iterations < 1 or args.iterations > 100:
        raise ValueError("iterations must be between 1 and 100")

    model_path = Path(args.model_path).resolve()
    input_manifest_path = Path(args.input_manifest).resolve()
    output_raw_path = Path(args.output_raw).resolve()
    report_path = Path(args.report).resolve()
    output_raw_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    nvidia_root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    dll_directory_handles = []
    if os.name == "nt" and nvidia_root.is_dir():
        bin_directories = sorted(nvidia_root.glob("*/bin"))
        os.environ["PATH"] = os.pathsep.join(
            [*(str(directory) for directory in bin_directories), os.environ.get("PATH", "")]
        )
        for bin_directory in bin_directories:
            dll_directory_handles.append(os.add_dll_directory(str(bin_directory)))
    ort.preload_dlls(directory="")
    available_providers = ort.get_available_providers()
    if "CUDAExecutionProvider" not in available_providers:
        raise RuntimeError("CUDAExecutionProvider is not available")

    feeds, manifest = read_inputs(input_manifest_path)
    output_name = manifest.get("outputName")
    if not isinstance(output_name, str) or not output_name:
        raise ValueError("input manifest outputName is required")

    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.enable_profiling = True
    session_options.profile_file_prefix = str(report_path.parent / "cuda-profile")
    providers = [
        (
            "CUDAExecutionProvider",
            {
                "device_id": "0",
                "do_copy_in_default_stream": "1",
                "gpu_mem_limit": str(3_221_225_472),
                "use_tf32": "0",
            },
        ),
        "CPUExecutionProvider",
    ]

    load_started = time.perf_counter()
    session = ort.InferenceSession(str(model_path), sess_options=session_options, providers=providers)
    load_ms = (time.perf_counter() - load_started) * 1000
    if output_name not in {item.name for item in session.get_outputs()}:
        raise ValueError(f"model does not expose output {output_name}")

    session.run([output_name], feeds)
    durations_ms: list[float] = []
    output: np.ndarray | None = None
    for _ in range(args.iterations):
        started = time.perf_counter()
        output = session.run([output_name], feeds)[0]
        durations_ms.append((time.perf_counter() - started) * 1000)
    if output is None:
        raise RuntimeError("CUDA inference returned no output")
    output = np.asarray(output, dtype=np.float32)
    output.tofile(output_raw_path)

    profile_path = Path(session.end_profiling()).resolve()
    provider_node_counts, provider_operation_counts, provider_nodes = profile_provider_assignments(
        profile_path
    )
    cuda_nodes = provider_node_counts.get("CUDAExecutionProvider", 0)
    report = {
        "schemaVersion": 1,
        "runtime": {
            "ortVersion": ort.__version__,
            "buildInfo": ort.get_build_info(),
            "availableProviders": available_providers,
            "sessionProviders": session.get_providers(),
            "privateDllDirectories": len(dll_directory_handles),
        },
        "model": manifest.get("model"),
        "output": {
            "name": output_name,
            "dtype": "float32",
            "dimensions": list(output.shape),
            "values": int(output.size),
            "allFinite": bool(np.isfinite(output).all()),
        },
        "performance": {
            "loadMs": load_ms,
            "warmupRuns": 1,
            "iterations": args.iterations,
            "durationsMs": durations_ms,
            "medianMs": statistics.median(durations_ms),
            "meanMs": statistics.mean(durations_ms),
        },
        "providerNodeCounts": provider_node_counts,
        "providerOperationCounts": provider_operation_counts,
        "providerNodes": provider_nodes,
        "cudaAssigned": cuda_nodes > 0,
        "profileFile": profile_path.name,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["output"]["allFinite"] and report["cudaAssigned"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
