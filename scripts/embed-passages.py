#!/usr/bin/env python3
"""Genera embeddings de build con el Transformer IBM i afinado.

Este helper pertenece al flujo de desarrollo del corpus. No forma parte del
runtime MCP ni se ejecuta en la instalación de usuarios finales.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer


def parse_args() -> argparse.Namespace:
    """Lee y valida los argumentos del acelerador de build."""
    parser = argparse.ArgumentParser(description="Genera vectores float32 normalizados para el data pack IBM i.")
    parser.add_argument("--model", required=True, help="Checkpoint Sentence Transformers afinado.")
    parser.add_argument("--input", required=True, help="JSONL con un texto JSON por línea.")
    parser.add_argument("--output", required=True, help="Archivo binario float32 de salida.")
    parser.add_argument("--batch-size", type=int, default=128, help="Tamaño de lote de inferencia.")
    return parser.parse_args()


def load_texts(input_path: Path) -> list[str]:
    """Carga JSONL preservando exactamente el orden emitido por TypeScript."""
    texts: list[str] = []
    with input_path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, str):
                raise ValueError(f"La línea {line_number} no contiene una cadena JSON.")
            texts.append(value)
    if not texts:
        raise ValueError("El archivo de entrada no contiene pasajes.")
    return texts


def main() -> int:
    """Codifica el corpus con GPU si existe y CPU en caso contrario."""
    args = parse_args()
    model_path = Path(args.model).resolve()
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    if not model_path.is_dir():
        raise FileNotFoundError(f"No existe el checkpoint afinado: {model_path}")

    texts = load_texts(input_path)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(
        f"[ibmi-docs] PyTorch cargará {len(texts)} pasajes en {device} "
        f"con batch={max(1, args.batch_size)}.",
        file=sys.stderr,
        flush=True,
    )
    model = SentenceTransformer(str(model_path), device=device)
    vectors = model.encode(
        texts,
        batch_size=max(1, args.batch_size),
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )
    normalized = np.asarray(vectors, dtype="<f4", order="C")
    if normalized.ndim != 2 or normalized.shape[0] != len(texts):
        raise ValueError(f"Forma de embeddings inesperada: {normalized.shape}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.tofile(output_path)
    print(
        f"[ibmi-docs] PyTorch escribió {normalized.shape[0]}x{normalized.shape[1]} "
        f"vectores en {output_path}.",
        file=sys.stderr,
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
