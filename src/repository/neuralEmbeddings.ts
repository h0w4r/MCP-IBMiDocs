import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";
import { applyNeuralQueryHead } from "./neuralQueryHead.js";

export const DEFAULT_EMBEDDING_MODEL_ID = "ibmi-docs/multilingual-e5-base-ibmi-v1";
export const DEFAULT_EMBEDDING_MODEL_DIRECTORY = "ibmi-e5-base-finetuned-v1";
export const DEFAULT_EMBEDDING_DTYPE = "q8";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export interface EmbeddingModelMarker {
  modelId: string;
  localPath: string;
  dtype: string;
  modelSha256: string;
  dimensions: number;
  cacheDir: string;
  installedAt: string;
  runtimePolicy: string;
  queryPrefix: string;
  passagePrefix: string;
}

export interface EmbeddingModelDiagnostics {
  modelId: string;
  modelPath: string;
  dtype: string;
  cacheDir: string;
  markerPath: string;
  markerExists: boolean;
  marker?: EmbeddingModelMarker;
  runtimePolicy: string;
}

export interface NeuralPassageInput {
  title?: string;
  body?: string;
  category?: string;
  language?: string;
  breadcrumbs?: string[];
  version?: string;
}

export interface EmbedTextOptions {
  localOnly?: boolean;
  modelId?: string;
  cacheDir?: string;
  kind?: "query" | "query-foundation" | "passage";
}

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline>>;

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
let extractorKey: string | undefined;

export function configuredEmbeddingModel(): string {
  const explicit = process.env.IBMI_DOCS_EMBEDDING_MODEL?.trim();
  if (explicit) return path.resolve(explicit);
  const marker = readEmbeddingModelMarker();
  if (marker?.localPath && fs.existsSync(marker.localPath)) return marker.localPath;
  const bundled = bundledEmbeddingModelCandidates().find((candidate) =>
    fs.existsSync(path.join(candidate, "onnx", "model_quantized.onnx"))
  );
  if (bundled) return bundled;
  return path.join(defaultModelCacheDir(), DEFAULT_EMBEDDING_MODEL_DIRECTORY);
}

export function configuredEmbeddingModelIdentity(): string {
  const explicit = process.env.IBMI_DOCS_EMBEDDING_MODEL_ID?.trim();
  if (explicit) return explicit;
  const marker = readEmbeddingModelMarker();
  return marker?.localPath && fs.existsSync(marker.localPath)
    ? marker.modelId
    : DEFAULT_EMBEDDING_MODEL_ID;
}

export function configuredEmbeddingDtype(): string {
  const explicit = process.env.IBMI_DOCS_EMBEDDING_DTYPE?.trim();
  if (explicit) return explicit;
  const marker = readEmbeddingModelMarker();
  return marker?.localPath && fs.existsSync(marker.localPath)
    ? marker.dtype
    : DEFAULT_EMBEDDING_DTYPE;
}

export function defaultModelCacheDir(): string {
  return process.env.IBMI_DOCS_MODEL_CACHE?.trim() || path.join(os.homedir(), ".ibmi-docs-mcp", "models");
}

export function embeddingModelMarkerPath(cacheDir = defaultModelCacheDir()): string {
  return path.join(cacheDir, "ibmi-docs-embedding-model.json");
}

export function readEmbeddingModelMarker(cacheDir = defaultModelCacheDir()): EmbeddingModelMarker | undefined {
  try {
    return JSON.parse(fs.readFileSync(embeddingModelMarkerPath(cacheDir), "utf8")) as EmbeddingModelMarker;
  } catch {
    return undefined;
  }
}

export function embeddingModelDiagnostics(): EmbeddingModelDiagnostics {
  const cacheDir = defaultModelCacheDir();
  const markerPath = embeddingModelMarkerPath(cacheDir);
  const marker = readEmbeddingModelMarker(cacheDir);
  return {
    modelId: configuredEmbeddingModelIdentity(),
    modelPath: configuredEmbeddingModel(),
    dtype: configuredEmbeddingDtype(),
    cacheDir,
    markerPath,
    markerExists: Boolean(marker),
    marker,
    runtimePolicy: "download-at-install-update; runtime-local-only"
  };
}

export function embeddingPrefixesForModel(modelId = configuredEmbeddingModelIdentity()): { queryPrefix: string; passagePrefix: string } {
  // La familia E5 fue entrenada con prefijos explícitos para recuperación
  // asimétrica query -> passage; omitirlos reduce calidad semántica.
  if (/\be5\b/i.test(modelId)) return { queryPrefix: "query: ", passagePrefix: "passage: " };
  return { queryPrefix: "", passagePrefix: "" };
}

export function semanticQueryText(query: string, modelId = configuredEmbeddingModelIdentity()): string {
  const { queryPrefix } = embeddingPrefixesForModel(modelId);
  return `${queryPrefix}${query.trim()}`;
}

export function semanticPassageText(input: NeuralPassageInput, modelId = configuredEmbeddingModelIdentity()): string {
  const { passagePrefix } = embeddingPrefixesForModel(modelId);
  const body = [
    input.title,
    input.breadcrumbs?.join(" > "),
    input.category,
    input.language,
    input.version,
    input.body
  ].filter(Boolean).join("\n");
  return `${passagePrefix}${body.trim()}`;
}

/**
 * Representa la identidad conceptual de un documento sin mezclar el cuerpo.
 * Esta faceta permite recuperar tópicos precisos por su ruta semántica aunque
 * un manual o catálogo extenso domine el embedding del contenido completo.
 */
export function semanticTitlePassageText(input: NeuralPassageInput, modelId = configuredEmbeddingModelIdentity()): string {
  return semanticPassageText({
    title: input.title,
    breadcrumbs: input.breadcrumbs,
    category: input.category,
    language: input.language,
    version: input.version
  }, modelId);
}

export async function embedTexts(texts: string[], options: EmbedTextOptions = {}): Promise<Float32Array[]> {
  const modelId = options.modelId ?? configuredEmbeddingModel();
  const cacheDir = options.cacheDir ?? defaultModelCacheDir();
  const localOnly = options.localOnly ?? true;
  const preparedTexts = texts.map((text) => text.trim()).filter(Boolean);
  if (!preparedTexts.length) return [];

  const extractor = await loadExtractor({ modelId, cacheDir, localOnly });
  const output = await (extractor as unknown as (input: string | string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] | number[] }>)(preparedTexts, { pooling: "mean", normalize: true });
  const list = output.tolist() as number[][] | number[];
  const rows = Array.isArray(list[0]) ? list as number[][] : [list as number[]];
  const vectors = rows.map((row) => Float32Array.from(row));
  // La ruta query es canónica y obligatoria: toda consulta se proyecta con la
  // cabeza neuronal entrenada contra el corpus real. No existe ruta paralela.
  return options.kind === "query"
    ? vectors.map((vector) => applyNeuralQueryHead(vector))
    : vectors;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function bufferToVector(value: Buffer | Uint8Array): Float32Array {
  const buffer = value instanceof Buffer ? value : Buffer.from(value);
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

async function loadExtractor(options: { modelId: string; cacheDir: string; localOnly: boolean }): Promise<FeatureExtractionPipeline> {
  const dtype = configuredEmbeddingDtype();
  const key = `${options.modelId}|${options.cacheDir}|${dtype}|${options.localOnly ? "local" : "remote"}`;
  if (extractorPromise && extractorKey === key) return extractorPromise;

  fs.mkdirSync(options.cacheDir, { recursive: true });
  env.cacheDir = options.cacheDir;
  env.allowRemoteModels = !options.localOnly;
  extractorKey = key;
  extractorPromise = pipeline("feature-extraction", options.modelId, {
    dtype,
    local_files_only: options.localOnly,
    // La arena de CPU retiene picos de memoria entre consultas largas; el MCP
    // prioriza una huella estable porque los modelos permanecen residentes.
    session_options: {
      enableCpuMemArena: false,
      enableMemPattern: false
    }
  } as never);
  return extractorPromise;
}

function bundledEmbeddingModelCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(process.cwd(), "models", DEFAULT_EMBEDDING_MODEL_DIRECTORY),
    path.resolve(moduleDir, "..", "..", "models", DEFAULT_EMBEDDING_MODEL_DIRECTORY),
    path.resolve(moduleDir, "..", "..", "..", "models", DEFAULT_EMBEDDING_MODEL_DIRECTORY)
  ];
}
