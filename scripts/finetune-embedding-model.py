"""Fine-tuning reproducible del bi-encoder semántico IBM i Docs.

El dataset global de evaluación se reserva por completo: sus IDs y firmas
normalizadas se excluyen del entrenamiento antes de construir los lotes.
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
from datasets import Dataset
from sentence_transformers import (
    SentenceTransformer,
    SentenceTransformerTrainer,
    SentenceTransformerTrainingArguments,
)
from sentence_transformers.sentence_transformer.evaluation import InformationRetrievalEvaluator
from sentence_transformers.sentence_transformer.losses import MultipleNegativesRankingLoss
from sentence_transformers.sentence_transformer.training_args import BatchSamplers


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SEED = 20260710
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "


@dataclass(frozen=True)
class QaCase:
    """Par pregunta/respuesta mínimo usado por el entrenamiento y el holdout."""

    case_id: str
    question: str
    answer: str
    source_id: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fine-tuning completo del Transformer E5 para IBM i Docs")
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
        help="Casos de feedback real usados solo durante el entrenamiento.",
    )
    parser.add_argument("--base-model", default="intfloat/multilingual-e5-small")
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp/embedding-finetune")
    parser.add_argument("--max-train-cases", type=int, default=8_000)
    parser.add_argument("--feedback-repetitions", type=int, default=1)
    parser.add_argument("--corpus-pack", type=Path, default=ROOT / "data/pack")
    parser.add_argument("--max-corpus-cases", type=int, default=10_000)
    parser.add_argument("--validation-cases", type=int, default=200)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    configure_reproducibility(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)

    raw_train = read_json_array(args.dataset)
    raw_holdout = read_json_array(args.holdout)
    holdout = deduplicate_cases(to_usable_cases(raw_holdout, require_answered=False), unique_questions=True)
    if len(holdout) <= args.validation_cases:
        raise ValueError(
            f"El holdout solo contiene {len(holdout)} casos utilizables; "
            f"se requieren más de {args.validation_cases}."
        )

    # La exclusión usa ID, pregunta y par pregunta/respuesta. Es una defensa
    # contra contaminación del benchmark, no una primitiva de búsqueda runtime.
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
    # Una pregunta puede tener varias respuestas conceptualmente válidas. Se
    # conservan como positivos distintos; NO_DUPLICATES impide que coincidan en
    # el mismo lote y se conviertan accidentalmente en negativos entre sí.
    train_candidates = deduplicate_cases(train_candidates, unique_questions=False)
    random.Random(args.seed).shuffle(train_candidates)
    qa_train = train_candidates[: args.max_train_cases]
    if len(qa_train) < min(5_000, args.max_train_cases):
        raise ValueError(f"Solo quedaron {len(qa_train)} pares QA de entrenamiento de calidad.")
    feedback_train = []
    if args.feedback.exists():
        feedback_train = [
            case
            for case in to_usable_cases(read_json_array(args.feedback), require_answered=True)
            if case.case_id not in holdout_ids
            and fold(case.question) not in holdout_questions
            and pair_signature(case) not in holdout_pairs
        ]
    corpus_train = load_corpus_training_cases(args.corpus_pack)
    random.Random(args.seed + 1).shuffle(corpus_train)
    corpus_train = corpus_train[: args.max_corpus_cases]
    train = deduplicate_cases([*qa_train, *corpus_train], unique_questions=False)
    # La repetición pondera feedback escaso dentro de un replay amplio. Sigue
    # siendo aprendizaje de pesos del Transformer; no crea aliases ni reglas
    # que puedan consultarse en runtime.
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
    random.Random(args.seed + 2).shuffle(train)

    holdout_order = list(holdout)
    random.Random(args.seed).shuffle(holdout_order)
    validation = holdout_order[: args.validation_cases]
    test = holdout_order[args.validation_cases :]

    model = SentenceTransformer(args.base_model, device="cuda" if torch.cuda.is_available() else "cpu")
    model.max_seq_length = 512
    model.prompts = {"query": QUERY_PREFIX, "passage": PASSAGE_PREFIX}
    model.default_prompt_name = None

    validation_evaluator = build_evaluator(validation, "validation", args.batch_size)
    base_validation_metrics = validation_evaluator(model, output_path=str(args.output / "base-validation"))
    primary_metric = select_mrr_metric(base_validation_metrics)

    train_dataset = Dataset.from_dict(
        {
            "query": [QUERY_PREFIX + case.question for case in train],
            "passage": [PASSAGE_PREFIX + case.answer for case in train],
        }
    )
    train_loss = MultipleNegativesRankingLoss(
        model,
        scale=20.0,
        directions=("query_to_doc", "doc_to_query"),
        partition_mode="joint",
    )
    training_args = SentenceTransformerTrainingArguments(
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
        batch_sampler=BatchSamplers.NO_DUPLICATES,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model=primary_metric,
        greater_is_better=True,
        logging_steps=25,
        report_to="none",
        run_name="ibmi-docs-e5-finetune",
        seed=args.seed,
        data_seed=args.seed,
        dataloader_num_workers=0,
        dataloader_pin_memory=torch.cuda.is_available(),
        save_safetensors=True,
    )
    trainer = SentenceTransformerTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        loss=train_loss,
        evaluator=validation_evaluator,
    )
    train_result = trainer.train()

    final_model_dir = args.output / "model"
    trainer.model.save_pretrained(str(final_model_dir))
    tuned_validation_metrics = validation_evaluator(
        trainer.model,
        output_path=str(args.output / "tuned-validation"),
    )

    # El conjunto de prueba se abre una sola vez, después de que validación ha
    # seleccionado el checkpoint. Sus métricas no participan en entrenamiento.
    test_evaluator = build_evaluator(test, "blind_test", args.batch_size)
    tuned_test_metrics = test_evaluator(trainer.model, output_path=str(args.output / "tuned-test"))

    # La línea base del test se calcula al final únicamente para cuantificar la
    # mejora; tampoco puede influir en la elección del modelo ya terminada.
    base_model = SentenceTransformer(args.base_model, device=trainer.model.device)
    base_model.max_seq_length = 512
    base_test_metrics = test_evaluator(base_model, output_path=str(args.output / "base-test"))
    del base_model

    report = {
        "schemaVersion": 1,
        "kind": "full-transformer-bi-encoder-finetune",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "baseModel": args.base_model,
        "modelDirectory": str(final_model_dir.resolve()),
        "modelSha256": directory_digest(final_model_dir),
        "device": str(trainer.model.device),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "seed": args.seed,
        "epochs": args.epochs,
        "batchSize": args.batch_size,
        "learningRate": args.learning_rate,
        "trainCount": len(train),
        "qaTrainCount": len(qa_train),
        "corpusTrainCount": len(corpus_train),
        "feedbackTrainCount": len(feedback_train),
        "feedbackRepetitions": max(1, args.feedback_repetitions),
        "validationCount": len(validation),
        "testCount": len(test),
        "trainSourceCounts": dict(Counter(case.source_id for case in train).most_common()),
        "holdoutPolicy": (
            "El fixture global completo se excluye del entrenamiento por ID, firma de pregunta "
            "y firma pregunta/respuesta; validación selecciona el checkpoint y test se abre al final."
        ),
        "corpusAdaptation": (
            "Títulos y secciones del corpus oficial se usan como positivos documentales; "
            "no se incorporan respuestas del fixture global."
        ),
        "loss": "MultipleNegativesRankingLoss simétrica query_to_doc + doc_to_query",
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


def configure_reproducibility(seed: int) -> None:
    """Fija la repetibilidad del experimento sin activar matching literal."""

    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True


def read_json_array(source: Path) -> list[dict[str, Any]]:
    payload = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise TypeError(f"{source} no contiene un arreglo JSON.")
    return payload


def load_corpus_training_cases(pack_dir: Path) -> list[QaCase]:
    """Convierte títulos y secciones reales del pack en pares de adaptación."""
    database = pack_dir / "ibmi-docs.sqlite"
    if not database.exists():
        raise FileNotFoundError(f"No existe el SQLite del corpus para adaptación: {database}")
    connection = sqlite3.connect(f"file:{database.resolve().as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT d.id, d.title, d.source_id, s.section_index, s.title, s.body
            FROM document_sections s
            JOIN documents d ON d.id = s.document_id
            ORDER BY d.id, s.section_index
            """
        ).fetchall()
    finally:
        connection.close()

    cases: list[QaCase] = []
    for document_id, document_title, source_id, section_index, section_title, body in rows:
        question = clean_text(section_title or document_title)
        answer = clean_text(f"{document_title}\n{body}")
        if len(question) < 8 or len(answer) < 24:
            continue
        cases.append(
            QaCase(
                case_id=f"corpus-{document_id}-{section_index}",
                question=question,
                answer=answer[:4_000],
                source_id=f"corpus-section:{source_id}",
            )
        )
    return deduplicate_cases(cases, unique_questions=False)


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
        # Se descartan extracciones que todavía son otra pregunta o una llamada
        # editorial, no una respuesta. Esto evita enseñar ruido al Transformer.
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
    unique: list[QaCase] = []
    seen_questions: set[str] = set()
    seen_pairs: set[str] = set()
    for case in cases:
        question_key = fold(case.question)
        pair_key = pair_signature(case)
        if (unique_questions and question_key in seen_questions) or pair_key in seen_pairs:
            continue
        seen_questions.add(question_key)
        seen_pairs.add(pair_key)
        unique.append(case)
    return unique


def build_evaluator(cases: list[QaCase], name: str, batch_size: int) -> InformationRetrievalEvaluator:
    queries = {case.case_id: QUERY_PREFIX + case.question for case in cases}
    corpus = {case.case_id: PASSAGE_PREFIX + case.answer for case in cases}
    answer_groups: dict[str, set[str]] = {}
    for case in cases:
        answer_groups.setdefault(fold(case.answer), set()).add(case.case_id)
    relevant_docs = {case.case_id: set(answer_groups[fold(case.answer)]) for case in cases}
    return InformationRetrievalEvaluator(
        queries=queries,
        corpus=corpus,
        relevant_docs=relevant_docs,
        mrr_at_k=[10, 100],
        ndcg_at_k=[10],
        accuracy_at_k=[1, 5, 10],
        precision_recall_at_k=[1, 5, 10],
        map_at_k=[100],
        show_progress_bar=True,
        batch_size=batch_size,
        name=name,
        write_csv=True,
        main_score_function="cosine",
    )


def select_mrr_metric(metrics: dict[str, float]) -> str:
    candidates = [key for key in metrics if key.endswith("cosine_mrr@10")]
    if len(candidates) != 1:
        raise ValueError(f"No se pudo identificar una única métrica MRR@10: {sorted(metrics)}")
    return candidates[0]


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def fold(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE)
    return re.sub(r"\s+", " ", normalized).strip()


def pair_signature(case: QaCase) -> str:
    return hashlib.sha256(f"{fold(case.question)}\n{fold(case.answer)}".encode("utf-8")).hexdigest()


def stable_id(question: str, answer: str) -> str:
    return "qa-" + hashlib.sha256(f"{question}\n{answer}".encode("utf-8")).hexdigest()[:24]


def looks_like_unanswered_prompt(answer: str) -> bool:
    folded = fold(answer)
    prompt_fragments = (
        "can you relate it",
        "what would you look for",
        "how would you assess",
        "what makes a good answer",
        "listen for",
        "look for",
    )
    return answer.rstrip().endswith("?") or any(fragment in folded for fragment in prompt_fragments)


def directory_digest(directory: Path) -> str:
    digest = hashlib.sha256()
    for source in sorted(path for path in directory.rglob("*") if path.is_file()):
        digest.update(source.relative_to(directory).as_posix().encode("utf-8"))
        with source.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
