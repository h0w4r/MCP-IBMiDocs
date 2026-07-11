import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredEmbeddingModel,
  configuredEmbeddingModelIdentity,
  cosineSimilarity,
  embedTexts,
  semanticPassageText,
  semanticQueryText
} from "../src/repository/neuralEmbeddings.js";

describe("Transformer E5 afinado para IBM i", () => {
  it("resuelve únicamente el modelo ONNX afinado incluido en el proyecto", () => {
    const modelPath = configuredEmbeddingModel();
    expect(configuredEmbeddingModelIdentity()).toBe("ibmi-docs/multilingual-e5-base-ibmi-v1");
    expect(fs.existsSync(path.join(modelPath, "onnx", "model_quantized.onnx"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(modelPath, "model-manifest.json"), "utf8")) as {
      kind: string;
      dtype: string;
      training: { tunedBlindTestMrrAt10: number; baseBlindTestMrrAt10: number };
    };
    expect(manifest.kind).toBe("full-transformer-bi-encoder-finetune");
    expect(manifest.dtype).toBe("q8");
    expect(manifest.training.tunedBlindTestMrrAt10).toBeGreaterThan(manifest.training.baseBlindTestMrrAt10);
  });

  it("recupera por significado y conserva las 768 dimensiones", async () => {
    const vectors = await embedTexts([
      semanticQueryText("¿Cómo compilo un módulo RPGLE indicando el archivo fuente?"),
      semanticPassageText({ body: "CRTRPGMOD crea un módulo ILE RPG y SRCFILE identifica el archivo fuente." }),
      semanticPassageText({ body: "WRKACTJOB muestra los trabajos activos del sistema." })
    ], { localOnly: true });
    expect(vectors).toHaveLength(3);
    expect(vectors.every((vector) => vector.length === 768)).toBe(true);
    expect(cosineSimilarity(vectors[0], vectors[1])).toBeGreaterThan(
      cosineSimilarity(vectors[0], vectors[2]) + 0.15
    );
  }, 30_000);
});
