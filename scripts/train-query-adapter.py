"""Entrena una cabeza MLP contrastiva sobre embeddings E5 congelados."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


SEED = 20260710
ROOT = Path(__file__).resolve().parents[1] / ".tmp" / "query-adapter-training"
META = json.loads((ROOT / "metadata.json").read_text(encoding="utf-8"))
DIM = int(META["dimensions"])
HIDDEN = 512
torch.manual_seed(SEED)
np.random.seed(SEED)


def load_matrix(name: str, count: int) -> np.ndarray:
    return np.fromfile(ROOT / name, dtype=np.float32).reshape(count, DIM)


def normalize_numpy(matrix: np.ndarray) -> np.ndarray:
    return matrix / np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-12)


def retrieval_metrics(queries: torch.Tensor, answers: torch.Tensor) -> dict[str, float]:
    with torch.no_grad():
        scores = queries @ answers.T
        order = torch.argsort(scores, dim=1, descending=True)
        target = torch.arange(scores.shape[0])[:, None]
        ranks = torch.argmax((order == target).to(torch.int64), dim=1) + 1
        return {
            "top1": float((ranks == 1).float().mean()),
            "top5": float((ranks <= 5).float().mean()),
            "top10": float((ranks <= 10).float().mean()),
            "mrr": float((1.0 / ranks.float()).mean()),
            "medianRank": float(ranks.float().median()),
        }


class QueryAdapter(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.fc1 = nn.Linear(DIM, HIDDEN)
        self.fc2 = nn.Linear(HIDDEN, DIM)
        self.alpha_logit = nn.Parameter(torch.tensor(0.0))
        # Iniciar cerca de identidad estabiliza el aprendizaje contrastivo.
        nn.init.xavier_uniform_(self.fc1.weight, gain=0.5)
        nn.init.zeros_(self.fc1.bias)
        nn.init.zeros_(self.fc2.weight)
        nn.init.zeros_(self.fc2.bias)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        learned = self.fc2(functional.gelu(self.fc1(value), approximate="tanh"))
        alpha = torch.sigmoid(self.alpha_logit)
        return functional.normalize((1.0 - alpha) * value + alpha * learned, dim=1)


train_count = int(META["trainCount"])
holdout_count = int(META["holdoutCount"])
train_q = torch.from_numpy(normalize_numpy(load_matrix("train-queries.f32", train_count)))
train_a = torch.from_numpy(normalize_numpy(load_matrix("train-answers.f32", train_count)))
holdout_q = torch.from_numpy(normalize_numpy(load_matrix("holdout-queries.f32", holdout_count)))
holdout_a = torch.from_numpy(normalize_numpy(load_matrix("holdout-answers.f32", holdout_count)))

permutation = torch.randperm(holdout_count, generator=torch.Generator().manual_seed(SEED))
validation_indices = permutation[:200]
test_indices = permutation[200:]
validation_q, validation_a = holdout_q[validation_indices], holdout_a[validation_indices]
test_q, test_a = holdout_q[test_indices], holdout_a[test_indices]

model = QueryAdapter()
optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
loader = DataLoader(TensorDataset(train_q, train_a), batch_size=256, shuffle=True, generator=torch.Generator().manual_seed(SEED))
best_state = None
best_validation = -math.inf
best_epoch = 0
patience = 0

for epoch in range(1, 41):
    model.train()
    running_loss = 0.0
    for query_batch, answer_batch in loader:
        optimizer.zero_grad(set_to_none=True)
        projected = model(query_batch)
        logits = projected @ answer_batch.T / 0.05
        labels = torch.arange(logits.shape[0])
        # La pérdida simétrica evita que varias preguntas colapsen en una sola
        # región semántica frecuente del dominio.
        loss = 0.5 * (
            functional.cross_entropy(logits, labels)
            + functional.cross_entropy(logits.T, labels)
        )
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        running_loss += float(loss)
    model.eval()
    validation_metrics = retrieval_metrics(model(validation_q), validation_a)
    print(json.dumps({"epoch": epoch, "loss": running_loss / len(loader), "validation": validation_metrics, "alpha": float(torch.sigmoid(model.alpha_logit))}))
    if validation_metrics["mrr"] > best_validation + 1e-4:
        best_validation = validation_metrics["mrr"]
        best_epoch = epoch
        best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
        patience = 0
    else:
        patience += 1
        if patience >= 6:
            break

assert best_state is not None
model.load_state_dict(best_state)
model.eval()
base_validation = retrieval_metrics(validation_q, validation_a)
base_test = retrieval_metrics(test_q, test_a)
adapted_validation = retrieval_metrics(model(validation_q), validation_a)
adapted_test = retrieval_metrics(model(test_q), test_a)

with torch.no_grad():
    arrays = [
        model.fc1.weight.T.contiguous().numpy().astype(np.float32),
        model.fc1.bias.numpy().astype(np.float32),
        model.fc2.weight.T.contiguous().numpy().astype(np.float32),
        model.fc2.bias.numpy().astype(np.float32),
    ]
    with (ROOT / "semantic-query-adapter-mlp.f32").open("wb") as output:
        for array in arrays:
            array.tofile(output)

manifest = {
    "schemaVersion": 2,
    "kind": "residual-mlp-gelu",
    "generatedAt": META["generatedAt"],
    "dimensions": DIM,
    "hiddenDimensions": HIDDEN,
    "trainCount": train_count,
    "validationCount": int(validation_indices.shape[0]),
    "testCount": int(test_indices.shape[0]),
    "seed": SEED,
    "bestEpoch": best_epoch,
    "alpha": float(torch.sigmoid(model.alpha_logit)),
    "baseValidationMetrics": base_validation,
    "adaptedValidationMetrics": adapted_validation,
    "baseTestMetrics": base_test,
    "adaptedTestMetrics": adapted_test,
    "holdoutPolicy": "Todo el fixture global se excluyó del entrenamiento; 200 casos se usaron para validación y 557 solo para prueba final.",
}
(ROOT / "semantic-query-adapter-mlp.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
