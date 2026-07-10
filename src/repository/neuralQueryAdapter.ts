import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NeuralQueryAdapterManifest {
  schemaVersion: number;
  kind: "residual-mlp-gelu";
  generatedAt: string;
  dimensions: number;
  hiddenDimensions: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  seed: number;
  bestEpoch: number;
  alpha: number;
  baseValidationMetrics: Record<string, number>;
  adaptedValidationMetrics: Record<string, number>;
  baseTestMetrics: Record<string, number>;
  adaptedTestMetrics: Record<string, number>;
  holdoutPolicy: string;
}

export interface NeuralQueryAdapterDiagnostics {
  enabled: boolean;
  manifestPath?: string;
  weightsPath?: string;
  manifest?: NeuralQueryAdapterManifest;
  reason?: string;
}

interface LoadedAdapter {
  manifest: NeuralQueryAdapterManifest;
  weights: Float32Array;
  manifestPath: string;
  weightsPath: string;
}

let adapterCache: LoadedAdapter | null | undefined;

/**
 * Proyecta un embedding de consulta hacia la forma semántica aprendida desde
 * pares pregunta/respuesta IBM i. La mezcla residual conserva conocimiento
 * general del modelo base y evita reemplazarlo por una transformación rígida.
 */
export function adaptNeuralQueryVector(vector: Float32Array): Float32Array | undefined {
  const adapter = loadAdapter();
  if (!adapter || vector.length !== adapter.manifest.dimensions) return undefined;
  const dimensions = adapter.manifest.dimensions;
  const hiddenDimensions = adapter.manifest.hiddenDimensions;
  const hidden = new Float32Array(hiddenDimensions);
  const firstBiasOffset = dimensions * hiddenDimensions;
  const secondWeightsOffset = firstBiasOffset + hiddenDimensions;
  const secondBiasOffset = secondWeightsOffset + hiddenDimensions * dimensions;
  for (let output = 0; output < hiddenDimensions; output += 1) {
    let sum = adapter.weights[firstBiasOffset + output];
    for (let source = 0; source < dimensions; source += 1) {
      sum += vector[source] * adapter.weights[source * hiddenDimensions + output];
    }
    hidden[output] = gelu(sum);
  }
  const learned = new Float32Array(dimensions);
  for (let output = 0; output < dimensions; output += 1) {
    let sum = adapter.weights[secondBiasOffset + output];
    for (let source = 0; source < hiddenDimensions; source += 1) {
      sum += hidden[source] * adapter.weights[secondWeightsOffset + source * dimensions + output];
    }
    learned[output] = sum;
  }
  const alpha = Math.max(0, Math.min(1, adapter.manifest.alpha));
  for (let index = 0; index < dimensions; index += 1) {
    learned[index] = (1 - alpha) * vector[index] + alpha * learned[index];
  }
  normalizeInPlace(learned);
  return learned;
}

/**
 * Conserva simultáneamente la vista base y la vista adaptada. Así una mejora
 * aprendida no puede borrar por completo una señal útil del Transformer base.
 */
export function expandNeuralQueryVectors(vectors: Float32Array[]): Float32Array[] {
  const expanded: Float32Array[] = [];
  for (const vector of vectors) {
    expanded.push(vector);
    const adapted = adaptNeuralQueryVector(vector);
    if (adapted) expanded.push(adapted);
  }
  return expanded;
}

export function neuralQueryAdapterDiagnostics(): NeuralQueryAdapterDiagnostics {
  const adapter = loadAdapter();
  if (!adapter) {
    return {
      enabled: false,
      reason: process.env.IBMI_DOCS_DISABLE_QUERY_ADAPTER === "1"
        ? "Deshabilitado mediante IBMI_DOCS_DISABLE_QUERY_ADAPTER=1."
        : "No se encontró un adaptador neuronal compatible."
    };
  }
  return {
    enabled: true,
    manifestPath: adapter.manifestPath,
    weightsPath: adapter.weightsPath,
    manifest: adapter.manifest
  };
}

function loadAdapter(): LoadedAdapter | undefined {
  if (process.env.IBMI_DOCS_DISABLE_QUERY_ADAPTER === "1") return undefined;
  if (adapterCache !== undefined) return adapterCache ?? undefined;
  for (const manifestPath of adapterManifestCandidates()) {
    const weightsPath = manifestPath.replace(/\.json$/i, ".f32");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(weightsPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as NeuralQueryAdapterManifest;
      const bytes = fs.readFileSync(weightsPath);
      const expectedFloats = manifest.dimensions * manifest.hiddenDimensions
        + manifest.hiddenDimensions
        + manifest.hiddenDimensions * manifest.dimensions
        + manifest.dimensions;
      const expectedBytes = expectedFloats * Float32Array.BYTES_PER_ELEMENT;
      if (manifest.schemaVersion !== 2 || manifest.kind !== "residual-mlp-gelu"
        || !Number.isInteger(manifest.dimensions) || manifest.dimensions <= 0
        || !Number.isInteger(manifest.hiddenDimensions) || manifest.hiddenDimensions <= 0
        || bytes.byteLength !== expectedBytes) continue;
      const weights = Float32Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
      adapterCache = { manifest, weights, manifestPath, weightsPath };
      return adapterCache;
    } catch {
      // Se prueba la siguiente ubicación; nunca se activa un adaptador corrupto.
    }
  }
  adapterCache = null;
  return undefined;
}

function adapterManifestCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.IBMI_DOCS_QUERY_ADAPTER?.trim(),
    path.resolve(process.cwd(), "models", "semantic-query-adapter.json"),
    path.resolve(moduleDir, "..", "..", "models", "semantic-query-adapter.json"),
    path.resolve(moduleDir, "..", "..", "..", "models", "semantic-query-adapter.json")
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function normalizeInPlace(vector: Float32Array): void {
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
}

function gelu(value: number): number {
  // Misma aproximación tanh usada por torch.nn.functional.gelu durante el entrenamiento.
  const coefficient = Math.sqrt(2 / Math.PI);
  return 0.5 * value * (1 + Math.tanh(coefficient * (value + 0.044715 * value ** 3)));
}
