import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_QUERY_HEAD_DIRECTORY = "ibmi-neural-query-head-v1";
export const DEFAULT_QUERY_HEAD_ID = "ibmi-docs/e5-query-to-corpus-head-v1";

interface QueryHeadManifest {
  schemaVersion: number;
  kind: string;
  dimensions: number;
  hiddenDimensions: number;
  alpha: number;
  weightsSha256: string;
  trainCount: number;
  corpusDocumentCount: number;
  baseValidationMetrics: Record<string, number>;
  adaptedValidationMetrics: Record<string, number>;
  baseTestMetrics: Record<string, number>;
  adaptedTestMetrics: Record<string, number>;
}

interface QueryHeadMarker {
  modelId: string;
  localPath: string;
  weightsSha256: string;
  installedAt: string;
  runtimePolicy: string;
}

interface LoadedQueryHead {
  directory: string;
  manifest: QueryHeadManifest;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: Float32Array;
}

let loadedHead: LoadedQueryHead | undefined;

/**
 * Proyecta la salida del Transformer E5 al espacio de documentos IBM i.
 * La cabeza se entrenó contra todos los vectores del data pack: no contiene
 * diccionarios, categorías, aliases, regex ni ramas por términos concretos.
 */
export function applyNeuralQueryHead(vector: Float32Array): Float32Array {
  const head = loadQueryHead();
  const { dimensions, hiddenDimensions, alpha } = head.manifest;
  if (vector.length !== dimensions) {
    throw new Error(
      `La cabeza neuronal requiere ${dimensions} dimensiones y recibió ${vector.length}.`
    );
  }

  const hidden = new Float32Array(hiddenDimensions);
  for (let output = 0; output < hiddenDimensions; output += 1) {
    let value = head.b1[output] ?? 0;
    for (let input = 0; input < dimensions; input += 1) {
      value += vector[input] * head.w1[(input * hiddenDimensions) + output];
    }
    hidden[output] = gelu(value);
  }

  const projected = new Float32Array(dimensions);
  let normSquared = 0;
  for (let output = 0; output < dimensions; output += 1) {
    let learned = head.b2[output] ?? 0;
    for (let input = 0; input < hiddenDimensions; input += 1) {
      learned += hidden[input] * head.w2[(input * dimensions) + output];
    }
    const value = ((1 - alpha) * vector[output]) + (alpha * learned);
    projected[output] = value;
    normSquared += value * value;
  }

  const norm = Math.sqrt(normSquared);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error("La cabeza neuronal produjo un vector no normalizable.");
  }
  for (let index = 0; index < projected.length; index += 1) {
    projected[index] /= norm;
  }
  return projected;
}

export function queryHeadDiagnostics(): Record<string, unknown> {
  const head = loadQueryHead();
  return {
    modelId: DEFAULT_QUERY_HEAD_ID,
    modelPath: head.directory,
    kind: head.manifest.kind,
    dimensions: head.manifest.dimensions,
    hiddenDimensions: head.manifest.hiddenDimensions,
    alpha: head.manifest.alpha,
    weightsSha256: head.manifest.weightsSha256,
    trainCount: head.manifest.trainCount,
    corpusDocumentCount: head.manifest.corpusDocumentCount,
    validation: {
      base: head.manifest.baseValidationMetrics,
      adapted: head.manifest.adaptedValidationMetrics
    },
    blindTest: {
      base: head.manifest.baseTestMetrics,
      adapted: head.manifest.adaptedTestMetrics
    },
    runtimePolicy: "required-neural-query-to-corpus; no-legacy-fallback"
  };
}

export function configuredQueryHeadDirectory(): string {
  const explicit = process.env.IBMI_DOCS_QUERY_HEAD?.trim();
  if (explicit) return path.resolve(explicit);
  const marker = readMarker();
  if (marker?.localPath && fs.existsSync(marker.localPath)) return marker.localPath;
  const bundled = bundledCandidates().find((candidate) =>
    fs.existsSync(path.join(candidate, "neural-query-head.f32"))
  );
  if (bundled) return bundled;
  return path.join(defaultCacheDir(), DEFAULT_QUERY_HEAD_DIRECTORY);
}

function loadQueryHead(): LoadedQueryHead {
  const directory = configuredQueryHeadDirectory();
  if (loadedHead?.directory === directory) return loadedHead;
  const manifestPath = path.join(directory, "model-manifest.json");
  const weightsPath = path.join(directory, "neural-query-head.f32");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(weightsPath)) {
    throw new Error(
      `No está instalada la cabeza neuronal query->corpus en ${directory}. Ejecuta npm install o node postinstall.cjs.`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as QueryHeadManifest;
  const weightsBuffer = fs.readFileSync(weightsPath);
  const actualSha = crypto.createHash("sha256").update(weightsBuffer).digest("hex");
  if (actualSha !== manifest.weightsSha256) {
    throw new Error(`Hash inválido para la cabeza neuronal IBM i: ${actualSha}.`);
  }

  const dimensions = Number(manifest.dimensions);
  const hiddenDimensions = Number(manifest.hiddenDimensions);
  const expectedFloats = (dimensions * hiddenDimensions)
    + hiddenDimensions
    + (hiddenDimensions * dimensions)
    + dimensions;
  if (weightsBuffer.byteLength !== expectedFloats * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `Pesos incompletos para la cabeza neuronal: ${weightsBuffer.byteLength} bytes.`
    );
  }
  const allWeights = new Float32Array(
    weightsBuffer.buffer,
    weightsBuffer.byteOffset,
    expectedFloats
  );
  let offset = 0;
  const take = (length: number): Float32Array => {
    const output = Float32Array.from(allWeights.subarray(offset, offset + length));
    offset += length;
    return output;
  };
  loadedHead = {
    directory,
    manifest,
    w1: take(dimensions * hiddenDimensions),
    b1: take(hiddenDimensions),
    w2: take(hiddenDimensions * dimensions),
    b2: take(dimensions)
  };
  return loadedHead;
}

function gelu(value: number): number {
  const coefficient = Math.sqrt(2 / Math.PI);
  return 0.5 * value * (1 + Math.tanh(coefficient * (value + (0.044715 * value ** 3))));
}

function defaultCacheDir(): string {
  return process.env.IBMI_DOCS_MODEL_CACHE?.trim()
    || path.join(os.homedir(), ".ibmi-docs-mcp", "models");
}

function markerPath(): string {
  return path.join(defaultCacheDir(), "ibmi-docs-query-head.json");
}

function readMarker(): QueryHeadMarker | undefined {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), "utf8")) as QueryHeadMarker;
  } catch {
    return undefined;
  }
}

function bundledCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(process.cwd(), "models", DEFAULT_QUERY_HEAD_DIRECTORY),
    path.resolve(moduleDir, "..", "..", "models", DEFAULT_QUERY_HEAD_DIRECTORY),
    path.resolve(moduleDir, "..", "..", "..", "models", DEFAULT_QUERY_HEAD_DIRECTORY)
  ];
}
