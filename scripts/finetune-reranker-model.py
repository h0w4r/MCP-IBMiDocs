"""Fine-tuning del cross-encoder multilingüe para reranking IBM i.

El fixture global de evaluación queda completamente fuera del entrenamiento.
Los negativos se minan por cercanía del bi-encoder afinado, no mediante listas
de términos, categorías o reglas IBM i escritas a mano.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sqlite3
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
import numpy as np
from datasets import Dataset, concatenate_datasets
from sentence_transformers import SentenceTransformer
from sentence_transformers.cross_encoder import (
    CrossEncoder,
    CrossEncoderTrainer,
    CrossEncoderTrainingArguments,
)
from sentence_transformers.cross_encoder.evaluation import CrossEncoderRerankingEvaluator
from sentence_transformers.cross_encoder.losses import BinaryCrossEntropyLoss, MultipleNegativesRankingLoss
from sentence_transformers.sentence_transformer.training_args import BatchSamplers


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SEED = 20260710
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "


@dataclass(frozen=True)
class QaCase:
    """Par pregunta/respuesta apto para entrenamiento o evaluación."""

    case_id: str
    question: str
    answer: str
    source_id: str


def parse_args() -> argparse.Namespace:
    """Define un experimento reproducible y configurable."""
    parser = argparse.ArgumentParser(description="Fine-tuning del reranker Transformer IBM i Docs")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT / "data/eval/question-bank/dev-question-bank.full-local.json",
    )
    parser.add_argument(
        "--holdout",
        type=Path,
        default=ROOT / "tests/fixtures/dev-question-bank.global.json",
    )
    parser.add_argument(
        "--feedback",
        type=Path,
        default=ROOT / "data/training/neural-feedback-v1.json",
        help="Casos de retroalimentación observados en uso real, sin reglas runtime.",
    )
    parser.add_argument(
        "--semantic-model",
        type=Path,
        default=ROOT / ".tmp/embedding-finetune/model",
    )
    parser.add_argument(
        "--query-head",
        type=Path,
        help="Cabeza neuronal query->passage usada por runtime para minar candidatos end-to-end.",
    )
    parser.add_argument("--base-model", default="cross-encoder/mmarco-mMiniLMv2-L12-H384-v1")
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp/reranker-finetune")
    parser.add_argument("--max-train-cases", type=int, default=6_000)
    parser.add_argument("--feedback-repetitions", type=int, default=1)
    parser.add_argument("--validation-cases", type=int, default=200)
    parser.add_argument("--hard-negatives", type=int, default=1)
    parser.add_argument("--eval-negatives", type=int, default=19)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=2e-6)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--loss", choices=("relative", "bce"), default="relative")
    parser.add_argument("--feedback-corpus-only", action="store_true")
    parser.add_argument(
        "--feedback-corpus-replay-cases",
        type=int,
        default=1_000,
        help=(
            "Cantidad de casos generales reinyectados al ajustar feedback contra el corpus. "
            "Evita olvido catastrófico sin introducir reglas runtime."
        ),
    )
    parser.add_argument("--corpus-pack", type=Path, default=ROOT / "data/pack")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser.parse_args()


def main() -> None:
    """Entrena, valida y abre el test ciego únicamente al finalizar."""
    args = parse_args()
    configure_reproducibility(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)

    raw_train = read_json_array(args.dataset)
    raw_holdout = read_json_array(args.holdout)
    holdout = deduplicate_cases(to_usable_cases(raw_holdout, require_answered=False), unique_questions=True)
    if len(holdout) <= args.validation_cases:
        raise ValueError(f"Holdout insuficiente: {len(holdout)} casos para {args.validation_cases} de validación.")

    holdout_ids = {case.case_id for case in holdout}
    holdout_questions = {fold(case.question) for case in holdout}
    holdout_pairs = {pair_signature(case) for case in holdout}
    train_candidates = [
        case
        for case in to_usable_cases(raw_train, require_answered=True)
        if case.case_id not in holdout_ids
        and fold(case.question) not in holdout_questions
        and pair_signature(case) not in holdout_pairs
    ]
    train_candidates = deduplicate_cases(train_candidates, unique_questions=False)
    random.Random(args.seed).shuffle(train_candidates)
    replay_train = train_candidates[: args.max_train_cases]
    feedback_train = []
    if args.feedback.exists():
        feedback_train = [
            case
            for case in to_usable_cases(read_json_array(args.feedback), require_answered=True)
            if case.case_id not in holdout_ids
            and fold(case.question) not in holdout_questions
            and pair_signature(case) not in holdout_pairs
        ]
    train = deduplicate_cases(replay_train, unique_questions=False)
    # Pondera feedback escaso dentro del replay sin introducir reglas runtime.
    # Cada repetición sigue actualizando los pesos completos del Transformer.
    for repetition in range(max(1, args.feedback_repetitions)):
        train.extend(
            QaCase(
                case_id=f"{case.case_id}#feedback-{repetition}",
                question=case.question,
                answer=case.answer,
                source_id=case.source_id,
            )
            for case in feedback_train
        )
    random.Random(args.seed + 1).shuffle(train)
    if not args.feedback_corpus_only and len(train) < min(5_000, args.max_train_cases):
        raise ValueError(f"Solo quedaron {len(train)} pares limpios para el reranker.")

    holdout_order = list(holdout)
    random.Random(args.seed).shuffle(holdout_order)
    validation = holdout_order[: args.validation_cases]
    test = holdout_order[args.validation_cases :]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    semantic_model = SentenceTransformer(str(args.semantic_model), device=device)
    semantic_model.max_seq_length = 512
    query_head = load_query_head(args.query_head) if args.query_head else None
    feedback_mining: list[dict[str, Any]] = []
    if args.feedback_corpus_only:
        feedback_dataset, feedback_mining = build_feedback_corpus_dataset(
            semantic_model,
            feedback_train,
            args.corpus_pack,
            repetitions=max(1, args.feedback_repetitions),
            negatives_per_query=args.hard_negatives,
            loss=args.loss,
            seed=args.seed,
            query_head=query_head,
        )
        replay_subset = replay_train[: max(0, args.feedback_corpus_replay_cases)]
        if replay_subset:
            replay_negative_indices = mine_semantic_negatives(
                semantic_model,
                replay_subset,
                negatives_per_query=args.hard_negatives,
                batch_size=max(32, args.batch_size * 4),
                query_head=query_head,
            )
            replay_dataset = (
                build_binary_dataset(replay_subset, replay_negative_indices, args.seed + 17)
                if args.loss == "bce"
                else build_ranking_dataset(replay_subset, replay_negative_indices, args.seed + 17)
            )
            train_dataset = concatenate_datasets([feedback_dataset, replay_dataset]).shuffle(
                seed=args.seed + 23
            )
        else:
            train_dataset = feedback_dataset
    else:
        train_negative_indices = mine_semantic_negatives(
            semantic_model,
            train,
            negatives_per_query=args.hard_negatives,
            batch_size=max(32, args.batch_size * 4),
            query_head=query_head,
        )
        train_dataset = (
            build_binary_dataset(train, train_negative_indices, args.seed)
            if args.loss == "bce"
            else build_ranking_dataset(train, train_negative_indices, args.seed)
        )

    validation_samples = build_reranking_samples(
        semantic_model,
        validation,
        negatives_per_query=args.eval_negatives,
        batch_size=max(32, args.batch_size * 4),
        query_head=query_head,
    )
    test_samples = build_reranking_samples(
        semantic_model,
        test,
        negatives_per_query=args.eval_negatives,
        batch_size=max(32, args.batch_size * 4),
        query_head=query_head,
    )
    del semantic_model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    validation_evaluator = CrossEncoderRerankingEvaluator(
        validation_samples,
        at_k=10,
        name="validation",
        batch_size=max(16, args.batch_size * 2),
        show_progress_bar=True,
    )
    test_evaluator = CrossEncoderRerankingEvaluator(
        test_samples,
        at_k=10,
        name="blind_test",
        batch_size=max(16, args.batch_size * 2),
        show_progress_bar=True,
    )

    model = CrossEncoder(
        args.base_model,
        device=device,
        num_labels=1,
        max_length=args.max_length,
        trust_remote_code=False,
    )
    base_validation_metrics = validation_evaluator(model, output_path=str(args.output / "base-validation"))
    primary_metric = validation_evaluator.primary_metric
    effective_loss = args.loss
    loss = (
        BinaryCrossEntropyLoss(model)
        if effective_loss == "bce"
        else MultipleNegativesRankingLoss(model, num_negatives=4, scale=10.0)
    )
    training_args = CrossEncoderTrainingArguments(
        output_dir=str(args.output / "checkpoints"),
        overwrite_output_dir=True,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        warmup_ratio=0.1,
        weight_decay=0.01,
        max_grad_norm=1.0,
        fp16=torch.cuda.is_available(),
        tf32=torch.cuda.is_available(),
        batch_sampler=(BatchSamplers.BATCH_SAMPLER if effective_loss == "bce" else BatchSamplers.NO_DUPLICATES),
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model=primary_metric,
        greater_is_better=True,
        logging_steps=50,
        report_to="none",
        run_name="ibmi-docs-reranker-finetune",
        seed=args.seed,
        data_seed=args.seed,
        dataloader_num_workers=0,
        dataloader_pin_memory=torch.cuda.is_available(),
        save_safetensors=True,
    )
    trainer = CrossEncoderTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        loss=loss,
        evaluator=validation_evaluator,
    )
    train_result = trainer.train()
    final_model_dir = args.output / "model"
    trainer.model.save_pretrained(str(final_model_dir))
    tuned_validation_metrics = validation_evaluator(
        trainer.model,
        output_path=str(args.output / "tuned-validation"),
    )
    tuned_test_metrics = test_evaluator(trainer.model, output_path=str(args.output / "tuned-test"))

    # La línea base del test se calcula después del entrenamiento para que el
    # test ciego no influya en decisiones de checkpoint ni hiperparámetros.
    base_model = CrossEncoder(
        args.base_model,
        device=device,
        num_labels=1,
        max_length=args.max_length,
        trust_remote_code=False,
    )
    base_test_metrics = test_evaluator(base_model, output_path=str(args.output / "base-test"))
    del base_model

    report = {
        "schemaVersion": 1,
        "kind": "full-transformer-cross-encoder-finetune",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "baseModel": args.base_model,
        "semanticNegativeMiner": str(args.semantic_model.resolve()),
        "neuralQueryHead": str(args.query_head.resolve()) if args.query_head else None,
        "modelDirectory": str(final_model_dir.resolve()),
        "modelSha256": directory_digest(final_model_dir),
        "device": device,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "seed": args.seed,
        "epochs": args.epochs,
        "batchSize": args.batch_size,
        "learningRate": args.learning_rate,
        "maxLength": args.max_length,
        "hardNegativesPerPositive": args.hard_negatives,
        "evaluationNegativesPerQuery": args.eval_negatives,
        "trainQuestionCount": len(train),
        "feedbackQuestionCount": len(feedback_train),
        "feedbackRepetitions": max(1, args.feedback_repetitions),
        "trainRankingRows": len(train_dataset),
        "validationCount": len(validation),
        "testCount": len(test),
        "trainSourceCounts": dict(Counter(case.source_id for case in train).most_common()),
        "holdoutPolicy": (
            "El fixture global completo se excluye por ID, firma de pregunta y firma pregunta/respuesta; "
            "validación selecciona el checkpoint y test se abre al final."
        ),
        "negativeMining": (
            "Vecinos semánticos del bi-encoder IBM i y su cabeza neuronal query->passage; "
            "sin términos ni categorías manuales."
            if args.query_head
            else "Vecinos semánticos del bi-encoder IBM i afinado; sin términos ni categorías manuales."
        ),
        "loss": (
            "BinaryCrossEntropyLoss con positivos y negativos semánticos explícitos."
            if effective_loss == "bce"
            else "MultipleNegativesRankingLoss relativa con negativos semánticos difíciles e in-batch."
        ),
        "feedbackCorpusOnly": args.feedback_corpus_only,
        "feedbackCorpusReplayCases": (
            min(len(replay_train), max(0, args.feedback_corpus_replay_cases))
            if args.feedback_corpus_only
            else 0
        ),
        "feedbackCorpusMining": feedback_mining,
        "primaryValidationMetric": primary_metric,
        "baseValidationMetrics": base_validation_metrics,
        "tunedValidationMetrics": tuned_validation_metrics,
        "baseTestMetrics": base_test_metrics,
        "tunedTestMetrics": tuned_test_metrics,
        "trainerMetrics": train_result.metrics,
        "bestCheckpoint": Path(trainer.state.best_model_checkpoint).name if trainer.state.best_model_checkpoint else None,
        "bestValidationMetric": trainer.state.best_metric,
    }
    (args.output / "finetune-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


def mine_semantic_negatives(
    model: SentenceTransformer,
    cases: list[QaCase],
    *,
    negatives_per_query: int,
    batch_size: int,
    query_head: dict[str, Any] | None = None,
) -> list[list[int]]:
    """Mina respuestas cercanas pero no equivalentes para cada pregunta."""
    questions = model.encode(
        [QUERY_PREFIX + case.question for case in cases],
        batch_size=batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )
    answers = model.encode(
        [PASSAGE_PREFIX + case.answer for case in cases],
        batch_size=batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )
    questions = apply_query_head(questions, query_head)
    device = model.device
    return select_negative_indices(
        torch.from_numpy(questions).to(device),
        torch.from_numpy(answers.astype(np.float32)).to(device),
        cases,
        negatives_per_query,
    )


def select_negative_indices(
    question_vectors: torch.Tensor,
    answer_vectors: torch.Tensor,
    cases: list[QaCase],
    count: int,
) -> list[list[int]]:
    """Selecciona top-k por coseno en bloques sin materializar una matriz N²."""
    selected: list[list[int]] = []
    folded_questions = [fold(case.question) for case in cases]
    folded_answers = [fold(case.answer) for case in cases]
    candidate_k = min(len(cases), max(32, count * 12))
    for start in range(0, len(cases), 256):
        scores = question_vectors[start : start + 256] @ answer_vectors.T
        indices = torch.topk(scores, k=candidate_k, dim=1).indices.cpu().tolist()
        for row_offset, ranked in enumerate(indices):
            source_index = start + row_offset
            negatives: list[int] = []
            for candidate_index in ranked:
                if candidate_index == source_index:
                    continue
                if folded_questions[candidate_index] == folded_questions[source_index]:
                    continue
                if folded_answers[candidate_index] == folded_answers[source_index]:
                    continue
                negatives.append(candidate_index)
                if len(negatives) >= count:
                    break
            if len(negatives) < count:
                raise ValueError(f"No se pudieron minar {count} negativos para {cases[source_index].case_id}.")
            selected.append(negatives)
    return selected


def build_feedback_corpus_dataset(
    model: SentenceTransformer,
    feedback: list[QaCase],
    corpus_pack: Path,
    *,
    repetitions: int,
    negatives_per_query: int,
    loss: str,
    seed: int,
    query_head: dict[str, Any] | None = None,
) -> tuple[Dataset, list[dict[str, Any]]]:
    """Mina positivos y negativos reales del mismo corpus usado por runtime.

    El positivo maximiza la similitud con la respuesta esperada. Los negativos
    maximizan simultáneamente afinidad con la pregunta y desacuerdo con esa
    respuesta, lo que favorece confusiones semánticas reales sin listas de
    términos ni casos codificados en el runtime.
    """
    sqlite_path = corpus_pack / "ibmi-docs.sqlite"
    if not sqlite_path.exists():
        raise FileNotFoundError(f"No existe el SQLite del corpus: {sqlite_path}")
    with sqlite3.connect(sqlite_path) as connection:
        rows = connection.execute(
            """
            SELECT d.id, d.title, d.breadcrumbs_json, d.category, d.version,
                   c.body, v.dimensions, v.vector
            FROM documents d
            JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
            JOIN document_vectors v ON v.document_id = d.id
            ORDER BY d.id
            """
        ).fetchall()
    if not rows:
        raise ValueError("El corpus no contiene documentos vectorizados para minar feedback.")

    dimensions = int(rows[0][6])
    document_vectors = np.vstack([
        np.frombuffer(row[7], dtype="<f4", count=dimensions)
        for row in rows
    ])
    question_vectors = model.encode(
        [QUERY_PREFIX + case.question for case in feedback],
        batch_size=64,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    question_vectors = apply_query_head(question_vectors, query_head)
    answer_vectors = model.encode(
        [QUERY_PREFIX + case.answer for case in feedback],
        batch_size=64,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )

    ranking_records: list[tuple[str, ...]] = []
    binary_records: list[tuple[str, str, float]] = []
    mining: list[dict[str, Any]] = []
    for case_index, case in enumerate(feedback):
        positive_scores = document_vectors @ answer_vectors[case_index]
        positive_index = int(np.argmax(positive_scores))
        question_scores = document_vectors @ question_vectors[case_index]
        # Los negativos deben reproducir el pool que verá el reranker en
        # producción: los falsos positivos más altos de la cabeza neuronal.
        # Solo se excluyen pasajes casi equivalentes al positivo según el mismo
        # espacio semántico, evitando etiquetar como negativo otro documento
        # conceptualmente correcto sin recurrir a nombres o categorías.
        contrast_scores = question_scores.copy()
        equivalent_floor = float(positive_scores[positive_index]) * 0.85
        negative_indices = [
            int(index)
            for index in np.argsort(contrast_scores)[::-1]
            if int(index) != positive_index
            and float(positive_scores[int(index)]) < equivalent_floor
        ][:negatives_per_query]
        if len(negative_indices) < negatives_per_query:
            raise ValueError(f"No se pudieron minar negativos de corpus para {case.case_id}.")
        positive_passage = render_corpus_feedback_passage(rows[positive_index])
        negative_passages = [render_corpus_feedback_passage(rows[index]) for index in negative_indices]
        for _ in range(repetitions):
            if loss == "bce":
                binary_records.append((case.question, positive_passage, 1.0))
                binary_records.extend(
                    (case.question, passage, 0.0)
                    for passage in negative_passages
                )
            else:
                ranking_records.append(tuple([case.question, positive_passage, *negative_passages]))
        mining.append({
            "caseId": case.case_id,
            "positiveDocumentId": rows[positive_index][0],
            "positiveTitle": rows[positive_index][1],
            "positiveSimilarity": float(positive_scores[positive_index]),
            "negativeDocuments": [
                {
                    "documentId": rows[index][0],
                    "title": rows[index][1],
                    "questionSimilarity": float(question_scores[index]),
                    "answerSimilarity": float(positive_scores[index]),
                    "contrastScore": float(contrast_scores[index]),
                }
                for index in negative_indices
            ],
        })
    if loss == "bce":
        random.Random(seed).shuffle(binary_records)
        return Dataset.from_dict({
            "query": [record[0] for record in binary_records],
            "passage": [record[1] for record in binary_records],
            "label": [record[2] for record in binary_records],
        }), mining
    random.Random(seed).shuffle(ranking_records)
    columns: dict[str, list[str]] = {
        "query": [record[0] for record in ranking_records],
        "positive": [record[1] for record in ranking_records],
    }
    for negative_index in range(negatives_per_query):
        columns[f"negative_{negative_index + 1}"] = [
            record[negative_index + 2]
            for record in ranking_records
        ]
    return Dataset.from_dict(columns), mining


def render_corpus_feedback_passage(row: tuple[Any, ...]) -> str:
    """Replica el formato de entrada usado por neuralReranker.ts."""
    breadcrumbs = json.loads(str(row[2] or "[]"))
    return ". ".join(filter(None, [
        str(row[1]),
        " > ".join(map(str, breadcrumbs)) if isinstance(breadcrumbs, list) else "",
        str(row[3]),
        f"IBM i {row[4]}",
        str(row[5]),
    ]))


def build_ranking_dataset(cases: list[QaCase], negatives: list[list[int]], seed: int) -> Dataset:
    """Construye filas n-tuple para aprender orden relativo sin etiquetas absolutas."""
    records: list[tuple[str, ...]] = []
    for index, case in enumerate(cases):
        records.append(tuple([
            case.question,
            case.answer,
            *[cases[negative_index].answer for negative_index in negatives[index]],
        ]))
    random.Random(seed).shuffle(records)
    columns: dict[str, list[str]] = {
        "query": [record[0] for record in records],
        "positive": [record[1] for record in records],
    }
    for negative_index in range(len(negatives[0])):
        columns[f"negative_{negative_index + 1}"] = [record[negative_index + 2] for record in records]
    return Dataset.from_dict(columns)


def build_binary_dataset(cases: list[QaCase], negatives: list[list[int]], seed: int) -> Dataset:
    """Construye pares etiquetados y evita falsos negativos entre paráfrasis."""
    records: list[tuple[str, str, float]] = []
    for index, case in enumerate(cases):
        records.append((case.question, case.answer, 1.0))
        records.extend(
            (case.question, cases[negative_index].answer, 0.0)
            for negative_index in negatives[index]
        )
    random.Random(seed).shuffle(records)
    return Dataset.from_dict({
        "query": [record[0] for record in records],
        "passage": [record[1] for record in records],
        "label": [record[2] for record in records],
    })


def build_reranking_samples(
    model: SentenceTransformer,
    cases: list[QaCase],
    *,
    negatives_per_query: int,
    batch_size: int,
    query_head: dict[str, Any] | None = None,
) -> list[dict[str, str | list[str]]]:
    """Crea candidatos semánticamente difíciles para evaluación de ranking."""
    question_vectors = model.encode(
        [QUERY_PREFIX + case.question for case in cases],
        batch_size=batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    answer_vectors = model.encode(
        [PASSAGE_PREFIX + case.answer for case in cases],
        batch_size=batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    question_vectors = apply_query_head(question_vectors, query_head)
    device = model.device
    negative_indices = select_negative_indices(
        torch.from_numpy(question_vectors).to(device),
        torch.from_numpy(answer_vectors.astype(np.float32)).to(device),
        cases,
        negatives_per_query,
    )
    return [
        {
            "query": case.question,
            "positive": [case.answer],
            "negative": [cases[index].answer for index in negative_indices[case_index]],
        }
        for case_index, case in enumerate(cases)
    ]


def configure_reproducibility(seed: int) -> None:
    """Fija semillas del experimento, no decisiones del runtime."""
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True


def load_query_head(directory: Path) -> dict[str, Any]:
    """Carga la MLP residual que gobierna la recuperación del runtime."""
    manifest = json.loads((directory / "model-manifest.json").read_text(encoding="utf-8"))
    dimensions = int(manifest["dimensions"])
    hidden = int(manifest["hiddenDimensions"])
    raw = np.fromfile(directory / "neural-query-head.f32", dtype="<f4")
    expected = dimensions * hidden + hidden + hidden * dimensions + dimensions
    if raw.size != expected:
        raise ValueError(f"La cabeza neuronal contiene {raw.size} floats; se esperaban {expected}.")
    offset = 0
    w1 = raw[offset : offset + dimensions * hidden].reshape(dimensions, hidden)
    offset += dimensions * hidden
    b1 = raw[offset : offset + hidden]
    offset += hidden
    w2 = raw[offset : offset + hidden * dimensions].reshape(hidden, dimensions)
    offset += hidden * dimensions
    b2 = raw[offset : offset + dimensions]
    return {
        "dimensions": dimensions,
        "hidden": hidden,
        "alpha": float(manifest["alpha"]),
        "w1": w1,
        "b1": b1,
        "w2": w2,
        "b2": b2,
    }


def apply_query_head(vectors: np.ndarray, head: dict[str, Any] | None) -> np.ndarray:
    """Transforma preguntas hacia el espacio passage sin reglas léxicas."""
    values = vectors.astype(np.float32, copy=False)
    if head is None:
        return values
    if values.shape[1] != int(head["dimensions"]):
        raise ValueError(
            f"Dimensiones incompatibles: embedding={values.shape[1]}, head={head['dimensions']}."
        )
    hidden = values @ head["w1"] + head["b1"]
    coefficient = np.sqrt(2.0 / np.pi)
    hidden = 0.5 * hidden * (1.0 + np.tanh(coefficient * (hidden + 0.044715 * hidden**3)))
    learned = hidden @ head["w2"] + head["b2"]
    adapted = (1.0 - head["alpha"]) * values + head["alpha"] * learned
    norms = np.linalg.norm(adapted, axis=1, keepdims=True)
    return (adapted / np.maximum(norms, 1e-12)).astype(np.float32)


def read_json_array(source: Path) -> list[dict[str, Any]]:
    payload = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise TypeError(f"{source} no contiene un arreglo JSON.")
    return payload


def to_usable_cases(records: list[dict[str, Any]], *, require_answered: bool) -> list[QaCase]:
    cases: list[QaCase] = []
    for record in records:
        if record.get("evaluationEligible") is False:
            continue
        extraction = record.get("extraction") if isinstance(record.get("extraction"), dict) else {}
        quality = str(extraction.get("extractionQuality") or "answered")
        if require_answered and quality not in {"answered", "multiple-choice"}:
            continue
        question = clean_text(record.get("question"))
        answer = clean_text(record.get("expectedAnswerSummary"))
        if len(question) < 8 or len(answer) < 24:
            continue
        if require_answered and looks_like_unanswered_prompt(answer):
            continue
        cases.append(
            QaCase(
                case_id=str(record.get("id") or stable_id(question, answer)),
                question=question,
                answer=answer,
                source_id=str(record.get("sourceId") or extraction.get("sourceKind") or "unknown"),
            )
        )
    return cases


def deduplicate_cases(cases: list[QaCase], *, unique_questions: bool) -> list[QaCase]:
    unique: dict[str, QaCase] = {}
    for case in cases:
        key = fold(case.question) if unique_questions else pair_signature(case)
        unique.setdefault(key, case)
    return list(unique.values())


def pair_signature(case: QaCase) -> str:
    return hashlib.sha256(f"{fold(case.question)}\n{fold(case.answer)}".encode("utf-8")).hexdigest()


def stable_id(question: str, answer: str) -> str:
    return hashlib.sha256(f"{question}\n{answer}".encode("utf-8")).hexdigest()[:24]


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def fold(value: str) -> str:
    normalized = unicodedata.normalize("NFD", clean_text(value))
    return "".join(character for character in normalized if unicodedata.category(character) != "Mn").lower()


def looks_like_unanswered_prompt(answer: str) -> bool:
    lowered = fold(answer)
    return lowered.endswith("?") or any(
        marker in lowered
        for marker in (
            "click here for the answer",
            "answer not available",
            "refer to the following",
            "please explain",
        )
    )


def directory_digest(directory: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(path for path in directory.rglob("*") if path.is_file()):
        digest.update(str(file.relative_to(directory)).replace("\\", "/").encode("utf-8"))
        digest.update(file.read_bytes())
    return digest.hexdigest()


if __name__ == "__main__":
    main()
