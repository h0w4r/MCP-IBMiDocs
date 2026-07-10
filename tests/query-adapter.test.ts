import { describe, expect, it } from "vitest";
import {
  adaptNeuralQueryVector,
  expandNeuralQueryVectors,
  neuralQueryAdapterDiagnostics
} from "../src/repository/neuralQueryAdapter.js";

describe("adaptador neuronal de consultas", () => {
  it("carga únicamente el artefacto MLP validado y conserva dimensiones", () => {
    const diagnostics = neuralQueryAdapterDiagnostics();
    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.manifest?.kind).toBe("residual-mlp-gelu");
    expect(diagnostics.manifest?.adaptedTestMetrics.mrr).toBeGreaterThan(
      diagnostics.manifest?.baseTestMetrics.mrr ?? 1
    );

    const input = new Float32Array(384);
    input[0] = 1;
    const adapted = adaptNeuralQueryVector(input);
    expect(adapted).toBeDefined();
    expect(adapted).toHaveLength(384);
    const norm = Math.sqrt([...adapted!].reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect([...adapted!]).not.toEqual([...input]);
  });

  it("mantiene simultáneamente la vista base y la aprendida", () => {
    const input = new Float32Array(384);
    input[3] = 1;
    const expanded = expandNeuralQueryVectors([input]);
    expect(expanded).toHaveLength(2);
    expect(expanded[0]).toBe(input);
    expect(expanded[1]).not.toEqual(input);
  });
});
