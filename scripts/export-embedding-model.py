"""Exporta el Transformer afinado a ONNX q8 compatible con Transformers.js."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_ID = "ibmi-docs/multilingual-e5-base-ibmi-v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Empaqueta el modelo IBM i afinado para runtime Node")
    parser.add_argument("--model", type=Path, default=ROOT / ".tmp/embedding-finetune/model")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / ".tmp/embedding-finetune/finetune-report.json",
    )
    parser.add_argument("--out", type=Path, default=ROOT / "models/ibmi-e5-base-finetuned-v1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    work = ROOT / ".tmp/embedding-model-export"
    raw_onnx = work / "onnx-fp32"
    quantized = work / "onnx-q8"
    shutil.rmtree(work, ignore_errors=True)
    raw_onnx.mkdir(parents=True)
    optimum = resolve_optimum_cli()

    # Se exporta sin O2: optimizar antes de cuantizar puede ocultar tipos
    # intermedios que ONNX Runtime necesita para una cuantización portable.
    run(
        optimum,
        "export",
        "onnx",
        "--model",
        str(args.model),
        "--task",
        "feature-extraction",
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
    config = json.loads((args.out / "config.json").read_text(encoding="utf-8"))
    manifest = {
        "schemaVersion": 1,
        "modelId": args.model_id,
        "baseModel": report["baseModel"],
        "kind": report["kind"],
        "dtype": "q8",
        "dimensions": int(config["hidden_size"]),
        "queryPrefix": "query: ",
        "passagePrefix": "passage: ",
        "onnxSha256": onnx_sha256,
        "onnxParts": onnx_parts,
        "tokenizerSha256": sha256(args.out / "tokenizer.json"),
        "training": {
            "generatedAt": report["generatedAt"],
            "seed": report["seed"],
            "trainCount": report["trainCount"],
            "validationCount": report["validationCount"],
            "testCount": report["testCount"],
            "bestCheckpoint": report.get("bestCheckpoint"),
            "bestValidationMetric": report.get("bestValidationMetric"),
            "loss": report["loss"],
            "holdoutPolicy": report["holdoutPolicy"],
            "baseValidationMrrAt10": report["baseValidationMetrics"]["validation_cosine_mrr@10"],
            "tunedValidationMrrAt10": report["tunedValidationMetrics"]["validation_cosine_mrr@10"],
            "baseBlindTestMrrAt10": report["baseTestMetrics"]["blind_test_cosine_mrr@10"],
            "tunedBlindTestMrrAt10": report["tunedTestMetrics"]["blind_test_cosine_mrr@10"],
            "baseBlindTestTop10": report["baseTestMetrics"]["blind_test_cosine_accuracy@10"],
            "tunedBlindTestTop10": report["tunedTestMetrics"]["blind_test_cosine_accuracy@10"],
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
    """Fragmenta ONNX para GitHub sin alterar el binario reconstruido en postinstall."""

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
