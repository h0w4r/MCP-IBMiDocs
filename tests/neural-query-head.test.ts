import { describe, expect, it } from "vitest";
import {
  applyNeuralQueryHead,
  queryHeadDiagnostics
} from "../src/repository/neuralQueryHead.js";

describe("cabeza neuronal query->corpus", () => {
  it("carga pesos verificados y conserva 768 dimensiones normalizadas", () => {
    const input = new Float32Array(768);
    input[0] = 1;
    const output = applyNeuralQueryHead(input);
    const norm = Math.sqrt(output.reduce((sum, value) => sum + (value * value), 0));

    expect(output).toHaveLength(768);
    expect(norm).toBeCloseTo(1, 5);
    expect(output[0]).not.toBe(1);
  });

  it("declara mejoras en validación y blind test contra el corpus completo", () => {
    const diagnostics = queryHeadDiagnostics() as {
      corpusDocumentCount: number;
      validation: { base: { mrr: number }; adapted: { mrr: number } };
      blindTest: { base: { mrr: number }; adapted: { mrr: number } };
      runtimePolicy: string;
    };

    expect(diagnostics.corpusDocumentCount).toBe(7027);
    expect(diagnostics.validation.adapted.mrr).toBeGreaterThan(diagnostics.validation.base.mrr);
    expect(diagnostics.blindTest.adapted.mrr).toBeGreaterThan(diagnostics.blindTest.base.mrr);
    expect(diagnostics.runtimePolicy).toBe("required-neural-query-to-corpus; no-legacy-fallback");
  });
});
