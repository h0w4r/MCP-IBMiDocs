import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import type { SemanticVectorInput } from "./semanticVector.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

export interface EmbeddingModelMarker {
  modelId: string;
  dimensions: number;
  cacheDir: string;
  installedAt: string;
  runtimePolicy: string;
  queryPrefix: string;
  passagePrefix: string;
}

export interface EmbeddingModelDiagnostics {
  modelId: string;
  cacheDir: string;
  markerPath: string;
  markerExists: boolean;
  marker?: EmbeddingModelMarker;
  runtimePolicy: string;
}

export interface EmbedTextOptions {
  localOnly?: boolean;
  modelId?: string;
  cacheDir?: string;
  kind?: "query" | "passage";
}

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline>>;

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
let extractorKey: string | undefined;

export function configuredEmbeddingModel(): string {
  return process.env.IBMI_DOCS_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
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
    modelId: configuredEmbeddingModel(),
    cacheDir,
    markerPath,
    markerExists: Boolean(marker),
    marker,
    runtimePolicy: "download-at-install-update; runtime-local-only"
  };
}

export function embeddingPrefixesForModel(modelId = configuredEmbeddingModel()): { queryPrefix: string; passagePrefix: string } {
  // La familia E5 fue entrenada con prefijos explícitos para recuperación
  // asimétrica query -> passage; omitirlos reduce calidad semántica.
  if (/\be5\b/i.test(modelId)) return { queryPrefix: "query: ", passagePrefix: "passage: " };
  return { queryPrefix: "", passagePrefix: "" };
}

export function semanticQueryText(query: string, modelId = configuredEmbeddingModel()): string {
  const { queryPrefix } = embeddingPrefixesForModel(modelId);
  return `${queryPrefix}${expandSemanticQueryText(query.trim())}`;
}

export function semanticPassageText(input: SemanticVectorInput, modelId = configuredEmbeddingModel()): string {
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

function expandSemanticQueryText(query: string): string {
  const expansions = semanticQueryExpansions(query);
  if (!expansions.length) return query;
  // Las expansiones no son un fallback léxico ni reemplazan la consulta original:
  // solo agregan equivalentes documentales para que el transformer reciba el
  // significado IBM i esperado cuando el usuario escribe términos compactos,
  // abreviados o con variaciones típicas de entrevistas/operación diaria.
  return `${query}\nIBM i semantic equivalents: ${expansions.join("; ")}`;
}

function semanticQueryExpansions(query: string): string[] {
  const folded = query.toLowerCase();
  const expansions = new Set<string>();
  const add = (pattern: RegExp, expansion: string): void => {
    if (pattern.test(folded)) expansions.add(expansion);
  };

  add(/\bphysical\s*file\b|\bphysicalfile\b|\bphysic\s*file\b|\bpf\b/, "physical file PF DDS database file");
  add(/\blogical\s*file\b|\blogicalfile\b|\blf\b/, "logical file LF DDS database relation");
  add(/\bdisplay\s*file\b|\bdisplayfile\b|\bdspf\b/, "display file DSPF DDS workstation file");
  add(/\bsource\s*physical\s*file\b|\bsourcephysicalfile\b/, "source physical file source members IBM i");
  add(/\brecord\s*formats?\b|\brecordformats?\b/, "record format database file format DSPFD DSPFFD DSPDBR");
  add(/\bfield\s*length\b|\bfieldlength\b|change.*length.*field|length.*field/, "change field length physical file CHGPF DDS source recompile");
  add(/\bjob\s*log\b|\bjoblog\b/, "job log IBM i messages DSPJOBLOG WRKJOBLOG");
  add(/\bjob\s*queue\b|\bjobq\b/, "job queue JOBQ subsystem submitted jobs");
  add(/\bprint\s*queue\b|\bprintq\b|\boutq\b/, "output queue print queue spooled files");
  add(/\bdata\s*area\b|\bdataarea\b|\blda\b|\*lda\b/, "data area local data area LDA CL variable");
  add(/\bmessage\s*queue\b|\bmsgq\b/, "message queue IBM i messages CL");
  add(/\bsub\s*file\b|\bsubfile\b|\bsfl\b/, "subfile DDS display file SFL SFLCTL SFLDSP SFLPAG SFLSIZ");

  return [...expansions];
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
  return rows.map((row) => Float32Array.from(row));
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
  const key = `${options.modelId}|${options.cacheDir}|${options.localOnly ? "local" : "remote"}`;
  if (extractorPromise && extractorKey === key) return extractorPromise;

  fs.mkdirSync(options.cacheDir, { recursive: true });
  env.cacheDir = options.cacheDir;
  env.allowRemoteModels = !options.localOnly;
  extractorKey = key;
  extractorPromise = pipeline("feature-extraction", options.modelId);
  return extractorPromise;
}
