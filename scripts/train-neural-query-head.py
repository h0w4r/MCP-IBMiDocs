"""Entrena una cabeza neuronal query->passage sobre embeddings E5 IBM i."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as functional
from sentence_transformers import SentenceTransformer
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SEED = 20260710
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "


@dataclass(frozen=True)
class QaCase:
    """Par semántico apto para entrenamiento o evaluación."""

    case_id: str
    question: str
    answer: str
    source_id: str


@dataclass(frozen=True)
class GroundedCase:
    """Pregunta enlazada neuronalmente con un documento real del corpus."""

    case: QaCase
    document_index: int
    grounding_score: float


class NeuralQueryHead(nn.Module):
    """MLP residual que transforma intención de consulta en espacio documental."""

    def __init__(self, dimensions: int, hidden_dimensions: int) -> None:
        super().__init__()
        self.fc1 = nn.Linear(dimensions, hidden_dimensions)
        self.fc2 = nn.Linear(hidden_dimensions, dimensions)
        self.alpha_logit = nn.Parameter(torch.tensor(-1.0))
        # La segunda capa parte en cero: el primer paso es identidad y el
        # entrenamiento solo conserva desplazamientos útiles para el holdout.
        nn.init.xavier_uniform_(self.fc1.weight, gain=0.5)
        nn.init.zeros_(self.fc1.bias)
        nn.init.zeros_(self.fc2.weight)
        nn.init.zeros_(self.fc2.bias)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        learned = self.fc2(functional.gelu(self.fc1(value), approximate="tanh"))
        alpha = torch.sigmoid(self.alpha_logit)
        return functional.normalize((1.0 - alpha) * value + alpha * learned, dim=1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Entrena la cabeza neuronal de consultas IBM i sin reglas ni clases manuales."
    )
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
    )
    parser.add_argument(
        "--embedding-model",
        type=Path,
        default=ROOT / ".tmp/embedding-finetune-base-v1/model",
    )
    parser.add_argument(
        "--corpus-pack",
        type=Path,
        default=ROOT / "data/pack",
        help="Data pack cuyos vectores documentales gobiernan el objetivo end-to-end.",
    )
    parser.add_argument(
        "--min-grounding-score",
        type=float,
        default=0.40,
        help="Similitud neuronal minima entre la respuesta esperada y su documento objetivo.",
    )
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp/neural-query-head-v1")
    parser.add_argument("--max-train-cases", type=int, default=8_000)
    parser.add_argument("--feedback-repetitions", type=int, default=50)
    parser.add_argument("--validation-cases", type=int, default=300)
    parser.add_argument("--hidden-dimensions", type=int, default=512)
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=2e-3)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)

    raw_holdout = read_json_array(args.holdout)
    holdout = deduplicate_cases(to_usable_cases(raw_holdout), unique_questions=True)
    if len(holdout) <= args.validation_cases:
        raise ValueError(
            f"El holdout tiene {len(holdout)} casos; se requieren más de {args.validation_cases}."
        )

    holdout_ids = {case.case_id for case in holdout}
    holdout_questions = {fold(case.question) for case in holdout}
    holdout_pairs = {pair_signature(case) for case in holdout}
    train = [
        case
        for case in deduplicate_cases(to_usable_cases(read_json_array(args.dataset)), unique_questions=False)
        if case.case_id not in holdout_ids
        and fold(case.question) not in holdout_questions
        and pair_signature(case) not in holdout_pairs
    ]
    random.Random(args.seed).shuffle(train)
    train = train[: args.max_train_cases]
    if len(train) < min(5_000, args.max_train_cases):
        raise ValueError(f"Solo quedaron {len(train)} casos QA de entrenamiento utilizables.")

    feedback = []
    if args.feedback.exists():
        feedback = [
            case
            for case in deduplicate_cases(to_usable_cases(read_json_array(args.feedback)), unique_questions=False)
            if case.case_id not in holdout_ids
            and fold(case.question) not in holdout_questions
            and pair_signature(case) not in holdout_pairs
        ]
    replay = list(train)
    for repetition in range(max(1, args.feedback_repetitions)):
        replay.extend(
            QaCase(
                case_id=f"{case.case_id}#feedback-{repetition}",
                question=case.question,
                answer=case.answer,
                source_id=case.source_id,
            )
            for case in feedback
        )
    random.Random(args.seed + 1).shuffle(replay)

    holdout_order = list(holdout)
    random.Random(args.seed).shuffle(holdout_order)
    validation = holdout_order[: args.validation_cases]
    test = holdout_order[args.validation_cases :]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    embedding_model = SentenceTransformer(str(args.embedding_model), device=device)
    embedding_model.max_seq_length = 512
    document_ids, document_titles, document_vectors = load_document_vectors(args.corpus_pack)
    train_queries, train_answers = encode_cases(embedding_model, replay, args.batch_size)
    validation_queries, validation_answers = encode_cases(embedding_model, validation, args.batch_size)
    test_queries, test_answers = encode_cases(embedding_model, test, args.batch_size)
    del embedding_model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    grounded_train = ground_cases(replay, train_answers, document_vectors, args.min_grounding_score)
    grounded_validation = ground_cases(
        validation, validation_answers, document_vectors, args.min_grounding_score
    )
    grounded_test = ground_cases(test, test_answers, document_vectors, args.min_grounding_score)
    if len(grounded_train) < min(4_000, len(replay)):
        raise ValueError(
            f"Solo {len(grounded_train)} casos de entrenamiento quedaron anclados al corpus."
        )
    if len(grounded_validation) < 200 or len(grounded_test) < 200:
        raise ValueError(
            "El holdout no conserva suficientes casos anclados para una evaluacion fiable."
        )

    replay_index = {id(case): index for index, case in enumerate(replay)}
    validation_index = {id(case): index for index, case in enumerate(validation)}
    test_index = {id(case): index for index, case in enumerate(test)}
    train_positions = [replay_index[id(item.case)] for item in grounded_train]
    train_queries = train_queries[train_positions]
    validation_queries = validation_queries[
        [validation_index[id(item.case)] for item in grounded_validation]
    ]
    test_queries = test_queries[[test_index[id(item.case)] for item in grounded_test]]
    train_indices = torch.tensor(
        [item.document_index for item in grounded_train], dtype=torch.long
    )
    validation_indices = torch.tensor(
        [item.document_index for item in grounded_validation], dtype=torch.long
    )
    test_indices = torch.tensor(
        [item.document_index for item in grounded_test], dtype=torch.long
    )

    dimensions = int(train_queries.shape[1])
    model = NeuralQueryHead(dimensions, args.hidden_dimensions).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate,
        weight_decay=1e-4,
    )
    loader = DataLoader(
        TensorDataset(train_queries, train_indices),
        batch_size=args.batch_size,
        shuffle=True,
        generator=torch.Generator().manual_seed(args.seed),
    )
    validation_queries_device = validation_queries.to(device)
    validation_indices_device = validation_indices.to(device)
    document_vectors_device = document_vectors.to(device)

    base_validation = corpus_retrieval_metrics(
        validation_queries_device, document_vectors_device, validation_indices_device
    )
    best_state: dict[str, torch.Tensor] | None = None
    best_validation = -math.inf
    best_epoch = 0
    patience = 0
    history: list[dict[str, Any]] = []

    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        for query_batch, target_batch in loader:
            query_batch = query_batch.to(device, non_blocking=True)
            target_batch = target_batch.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            projected = model(query_batch)
            # Cada pregunta compite contra todos los documentos del data pack.
            # El objetivo procede de la respuesta ground-truth proyectada por
            # E5, no de aliases, regex, categorías o términos codificados.
            logits = projected @ document_vectors_device.T / 0.035
            loss = functional.cross_entropy(logits, target_batch)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            running_loss += float(loss.detach().cpu())

        model.eval()
        validation_metrics = corpus_retrieval_metrics(
            model(validation_queries_device),
            document_vectors_device,
            validation_indices_device,
        )
        epoch_result = {
            "epoch": epoch,
            "loss": running_loss / max(1, len(loader)),
            "validation": validation_metrics,
            "alpha": float(torch.sigmoid(model.alpha_logit).detach().cpu()),
        }
        history.append(epoch_result)
        print(json.dumps(epoch_result), flush=True)
        if validation_metrics["mrr"] > best_validation + 1e-4:
            best_validation = validation_metrics["mrr"]
            best_epoch = epoch
            best_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
            patience = 0
        else:
            patience += 1
            if patience >= 7:
                break

    if best_state is None:
        raise RuntimeError("El entrenamiento no produjo un checkpoint válido.")
    model.load_state_dict(best_state)
    model.to(device).eval()

    test_queries_device = test_queries.to(device)
    test_indices_device = test_indices.to(device)
    adapted_validation = corpus_retrieval_metrics(
        model(validation_queries_device), document_vectors_device, validation_indices_device
    )
    base_test = corpus_retrieval_metrics(
        test_queries_device, document_vectors_device, test_indices_device
    )
    adapted_test = corpus_retrieval_metrics(
        model(test_queries_device), document_vectors_device, test_indices_device
    )

    weights_path = args.output / "neural-query-head.f32"
    save_weights(model, weights_path)
    manifest = {
        "schemaVersion": 1,
        "kind": "transformer-residual-mlp-gelu",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "embeddingModel": str(args.embedding_model),
        "dimensions": dimensions,
        "hiddenDimensions": args.hidden_dimensions,
        "trainCount": len(grounded_train),
        "qaTrainCount": len(train),
        "feedbackTrainCount": len(feedback),
        "feedbackRepetitions": max(1, args.feedback_repetitions),
        "validationCount": len(validation),
        "testCount": len(test),
        "groundedValidationCount": len(grounded_validation),
        "groundedTestCount": len(grounded_test),
        "corpusDocumentCount": len(document_ids),
        "corpusPack": str(args.corpus_pack),
        "minGroundingScore": args.min_grounding_score,
        "seed": args.seed,
        "bestEpoch": best_epoch,
        "alpha": float(torch.sigmoid(model.alpha_logit).detach().cpu()),
        "weightsSha256": sha256(weights_path),
        "baseValidationMetrics": base_validation,
        "adaptedValidationMetrics": adapted_validation,
        "baseTestMetrics": base_test,
        "adaptedTestMetrics": adapted_test,
        "trainSourceCounts": dict(Counter(case.source_id for case in replay).most_common()),
        "holdoutPolicy": (
            "El fixture global completo queda excluido por ID, firma de pregunta y firma QA; "
            "validación selecciona el checkpoint y test se abre una sola vez al final."
        ),
        "runtimePolicy": (
            "La salida del Transformer E5 atraviesa esta MLP residual como ruta canónica; "
            "no existen aliases, clases, regex ni decisiones léxicas."
        ),
        "trainingObjective": (
            "Cada consulta compite contra todos los vectores documentales del data pack; "
            "la respuesta esperada selecciona el objetivo mediante similitud E5 passage-document."
        ),
        "groundingExamples": [
            {
                "caseId": item.case.case_id,
                "documentId": document_ids[item.document_index],
                "documentTitle": document_titles[item.document_index],
                "score": item.grounding_score,
            }
            for item in grounded_train[-min(25, len(grounded_train)) :]
        ],
        "history": history,
    }
    (args.output / "model-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def encode_cases(
    model: SentenceTransformer,
    cases: list[QaCase],
    batch_size: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Codifica preguntas y respuestas con prefijos E5 asimétricos."""

    queries = model.encode(
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
    return torch.from_numpy(queries.astype(np.float32)), torch.from_numpy(answers.astype(np.float32))


def retrieval_metrics(queries: torch.Tensor, answers: torch.Tensor) -> dict[str, float]:
    """Evalúa equivalencia conceptual por ranking, no por igualdad textual."""

    with torch.no_grad():
        scores = queries @ answers.T
        order = torch.argsort(scores, dim=1, descending=True)
        target = torch.arange(scores.shape[0], device=scores.device)[:, None]
        ranks = torch.argmax((order == target).to(torch.int64), dim=1) + 1
        return {
            "top1": float((ranks == 1).float().mean().cpu()),
            "top5": float((ranks <= 5).float().mean().cpu()),
            "top10": float((ranks <= 10).float().mean().cpu()),
            "mrr": float((1.0 / ranks.float()).mean().cpu()),
            "medianRank": float(ranks.float().median().cpu()),
        }


def corpus_retrieval_metrics(
    queries: torch.Tensor,
    documents: torch.Tensor,
    target_indices: torch.Tensor,
) -> dict[str, float]:
    """Mide el ranking real contra todos los documentos instalados."""

    with torch.no_grad():
        scores = queries @ documents.T
        order = torch.argsort(scores, dim=1, descending=True)
        ranks = torch.argmax(
            (order == target_indices[:, None]).to(torch.int64), dim=1
        ) + 1
        return {
            "top1": float((ranks == 1).float().mean().cpu()),
            "top5": float((ranks <= 5).float().mean().cpu()),
            "top10": float((ranks <= 10).float().mean().cpu()),
            "top50": float((ranks <= 50).float().mean().cpu()),
            "mrr": float((1.0 / ranks.float()).mean().cpu()),
            "medianRank": float(ranks.float().median().cpu()),
        }


def load_document_vectors(pack_dir: Path) -> tuple[list[str], list[str], torch.Tensor]:
    """Carga el índice documental completo usado por el runtime público."""

    database = pack_dir / "ibmi-docs.sqlite"
    if not database.exists():
        raise FileNotFoundError(f"No existe el data pack {database}.")
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            """
            SELECT d.id, d.title, dv.vector
            FROM documents d
            JOIN document_vectors dv ON dv.document_id = d.id
            ORDER BY d.id
            """
        ).fetchall()
    document_ids = [str(row[0]) for row in rows]
    document_titles = [str(row[1]) for row in rows]
    vectors = np.vstack(
        [np.frombuffer(row[2], dtype="<f4").copy() for row in rows]
    ).astype(np.float32)
    return document_ids, document_titles, torch.from_numpy(vectors)


def ground_cases(
    cases: list[QaCase],
    answer_vectors: torch.Tensor,
    document_vectors: torch.Tensor,
    minimum_score: float,
) -> list[GroundedCase]:
    """Vincula respuestas conceptuales con documentos mediante E5, sin texto exacto."""

    grounded: list[GroundedCase] = []
    for start in range(0, len(cases), 512):
        batch = answer_vectors[start : start + 512]
        scores = batch @ document_vectors.T
        best_scores, best_indices = torch.max(scores, dim=1)
        for offset, (score, document_index) in enumerate(
            zip(best_scores.tolist(), best_indices.tolist())
        ):
            if score < minimum_score:
                continue
            grounded.append(
                GroundedCase(
                    case=cases[start + offset],
                    document_index=int(document_index),
                    grounding_score=float(score),
                )
            )
    return grounded


def save_weights(model: NeuralQueryHead, output: Path) -> None:
    """Guarda matrices contiguas en el orden consumido por TypeScript."""

    model = model.cpu().eval()
    with torch.no_grad(), output.open("wb") as stream:
        arrays = [
            model.fc1.weight.T.contiguous().numpy().astype("<f4"),
            model.fc1.bias.contiguous().numpy().astype("<f4"),
            model.fc2.weight.T.contiguous().numpy().astype("<f4"),
            model.fc2.bias.contiguous().numpy().astype("<f4"),
        ]
        for array in arrays:
            array.tofile(stream)


def read_json_array(source: Path) -> list[dict[str, Any]]:
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"{source} no contiene un array JSON.")
    return [item for item in value if isinstance(item, dict)]


def to_usable_cases(records: list[dict[str, Any]]) -> list[QaCase]:
    cases: list[QaCase] = []
    for record in records:
        if record.get("evaluationEligible") is False:
            continue
        extraction = record.get("extraction") if isinstance(record.get("extraction"), dict) else {}
        quality = str(extraction.get("extractionQuality") or "answered")
        if quality not in {"answered", "multiple-choice"}:
            continue
        question = clean_text(record.get("question"))
        answer = clean_text(record.get("expectedAnswerSummary"))
        if len(question) < 8 or len(answer) < 24 or looks_like_unanswered_prompt(answer):
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
    seen_ids: set[str] = set()
    seen_pairs: set[str] = set()
    seen_questions: set[str] = set()
    output: list[QaCase] = []
    for case in cases:
        question_key = fold(case.question)
        pair_key = pair_signature(case)
        if case.case_id in seen_ids or pair_key in seen_pairs:
            continue
        if unique_questions and question_key in seen_questions:
            continue
        seen_ids.add(case.case_id)
        seen_pairs.add(pair_key)
        seen_questions.add(question_key)
        output.append(case)
    return output


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def fold(value: str) -> str:
    return clean_text(value).casefold()


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


def sha256(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


if __name__ == "__main__":
    main()
