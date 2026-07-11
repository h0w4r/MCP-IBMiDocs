"""Exporta el cross-encoder IBM i afinado a ONNX q8 para Node local."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "ibmi-docs/mmarco-minilm-ibmi-reranker-v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Empaqueta el reranker IBM i afinado para Transformers.js")
    parser.add_argument("--model", type=Path, default=ROOT / ".tmp/reranker-finetune/model")
    parser.add_argument("--report", type=Path, default=ROOT / ".tmp/reranker-finetune/finetune-report.json")
    parser.add_argument("--out", type=Path, default=ROOT / "models/ibmi-reranker-finetuned-v1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    work = ROOT / ".tmp/reranker-model-export"
    raw_onnx = work / "onnx-fp32"
    quantized = work / "onnx-q8"
    shutil.rmtree(work, ignore_errors=True)
    raw_onnx.mkdir(parents=True)
    optimum = resolve_optimum_cli()

    run(
        optimum,
        "export",
        "onnx",
        "--model",
        str(args.model),
        "--task",
        "text-classification",
        "--library-name",
        "transformers",
        "--opset",
        "18",
        str(raw_onnx),
    )
    run(
        optimum,
        "onnxruntime",
        "quantize",
        "--onnx_model",
        str(raw_onnx),
        "-o",
        str(quantized),
        "--avx2",
        "--per_channel",
    )

    shutil.rmtree(args.out, ignore_errors=True)
    (args.out / "onnx").mkdir(parents=True)
    for name in (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "ort_config.json",
    ):
        shutil.copy2(quantized / name, args.out / name)
    shutil.copy2(quantized / "model_quantized.onnx", args.out / "onnx/model_quantized.onnx")

    onnx_path = args.out / "onnx/model_quantized.onnx"
    onnx_sha256 = sha256(onnx_path)
    onnx_parts = split_onnx(onnx_path, 64 * 1024 * 1024)
    report = json.loads(args.report.read_text(encoding="utf-8"))
    manifest = {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "baseModel": report["baseModel"],
        "kind": report["kind"],
        "dtype": "q8",
        "onnxSha256": onnx_sha256,
        "onnxParts": onnx_parts,
        "tokenizerSha256": sha256(args.out / "tokenizer.json"),
        "training": {
            "generatedAt": report["generatedAt"],
            "seed": report["seed"],
            "trainQuestionCount": report["trainQuestionCount"],
            "feedbackQuestionCount": report.get("feedbackQuestionCount", 0),
            "feedbackRepetitions": report.get("feedbackRepetitions", 1),
            "trainRankingRows": report["trainRankingRows"],
            "validationCount": report["validationCount"],
            "testCount": report["testCount"],
            "bestCheckpoint": report.get("bestCheckpoint"),
            "bestValidationMetric": report.get("bestValidationMetric"),
            "loss": report["loss"],
            "negativeMining": report["negativeMining"],
            "holdoutPolicy": report["holdoutPolicy"],
            "baseValidation": report["baseValidationMetrics"],
            "tunedValidation": report["tunedValidationMetrics"],
            "baseBlindTest": report["baseTestMetrics"],
            "tunedBlindTest": report["tunedTestMetrics"],
        },
    }
    (args.out / "model-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def resolve_optimum_cli() -> str:
    candidate = Path(sys.executable).with_name("optimum-cli.exe" if sys.platform == "win32" else "optimum-cli")
    if candidate.exists():
        return str(candidate)
    discovered = shutil.which("optimum-cli")
    if not discovered:
        raise FileNotFoundError("No se encontró optimum-cli en el entorno Python activo.")
    return discovered


def run(*command: str) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def sha256(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def split_onnx(source: Path, part_size: int) -> list[dict[str, object]]:
    """Fragmenta el ONNX para respetar el límite individual de GitHub."""
    parts: list[dict[str, object]] = []
    with source.open("rb") as stream:
        index = 0
        while block := stream.read(part_size):
            part = source.with_name(f"{source.name}.part-{index:03d}")
            part.write_bytes(block)
            parts.append({"name": part.name, "size": len(block), "sha256": sha256(part)})
            index += 1
    source.unlink()
    return parts


if __name__ == "__main__":
    main()
