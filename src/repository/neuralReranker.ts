import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env
} from "@huggingface/transformers";
import { defaultModelCacheDir } from "./neuralEmbeddings.js";

export const DEFAULT_RERANKER_MODEL_ID = "ibmi-docs/mmarco-minilm-ibmi-reranker-v1";
export const DEFAULT_RERANKER_MODEL_DIRECTORY = "ibmi-reranker-finetuned-v1";
export const DEFAULT_RERANKER_DTYPE = "q8";

export interface NeuralRerankerMarker {
  modelId: string;
  localPath: string;
  dtype: string;
  modelSha256: string;
  cacheDir: string;
  installedAt: string;
  runtimePolicy: string;
}

export interface NeuralRerankerDiagnostics {
  modelId: string;
  modelPath: string;
  dtype: string;
  cacheDir: string;
  markerPath: string;
  markerExists: boolean;
  marker?: NeuralRerankerMarker;
  runtimePolicy: string;
}

export interface NeuralRerankInput {
  id: string;
  title: string;
  body: string;
  category?: string;
  version?: string;
  breadcrumbs?: string[];
}

export interface NeuralRerankedPassage extends NeuralRerankInput {
  relevanceLogit: number;
  relevanceProbability: number;
}

export interface RerankOptions {
  cacheDir?: string;
  dtype?: string;
  localOnly?: boolean;
  maxLength?: number;
  modelId?: string;
}

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type SequenceClassifier = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

let rerankerPromise: Promise<{ tokenizer: Tokenizer; model: SequenceClassifier }> | undefined;
let rerankerKey: string | undefined;

export function configuredRerankerModel(): string {
  const explicit = process.env.IBMI_DOCS_RERANKER_MODEL?.trim();
  if (explicit) return path.resolve(explicit);
  const marker = readRerankerMarker();
  if (marker?.localPath && fs.existsSync(marker.localPath)) return marker.localPath;
  const bundled = bundledRerankerModelCandidates().find((candidate) =>
    fs.existsSync(path.join(candidate, "onnx", "model_quantized.onnx"))
  );
  if (bundled) return bundled;
  return path.join(defaultModelCacheDir(), DEFAULT_RERANKER_MODEL_DIRECTORY);
}

export function configuredRerankerModelIdentity(): string {
  const explicit = process.env.IBMI_DOCS_RERANKER_MODEL_ID?.trim();
  if (explicit) return explicit;
  const marker = readRerankerMarker();
  return marker?.localPath && fs.existsSync(marker.localPath)
    ? marker.modelId
    : DEFAULT_RERANKER_MODEL_ID;
}

export function configuredRerankerDtype(): string {
  const explicit = process.env.IBMI_DOCS_RERANKER_DTYPE?.trim();
  if (explicit) return explicit;
  const marker = readRerankerMarker();
  return marker?.localPath && fs.existsSync(marker.localPath)
    ? marker.dtype
    : DEFAULT_RERANKER_DTYPE;
}

export function rerankerMarkerPath(cacheDir = defaultModelCacheDir()): string {
  return path.join(cacheDir, "ibmi-docs-reranker-model.json");
}

export function readRerankerMarker(cacheDir = defaultModelCacheDir()): NeuralRerankerMarker | undefined {
  try {
    return JSON.parse(fs.readFileSync(rerankerMarkerPath(cacheDir), "utf8")) as NeuralRerankerMarker;
  } catch {
    return undefined;
  }
}

export function rerankerDiagnostics(): NeuralRerankerDiagnostics {
  const cacheDir = defaultModelCacheDir();
  const markerPath = rerankerMarkerPath(cacheDir);
  const marker = readRerankerMarker(cacheDir);
  return {
    modelId: configuredRerankerModelIdentity(),
    modelPath: configuredRerankerModel(),
    dtype: configuredRerankerDtype(),
    cacheDir,
    markerPath,
    markerExists: Boolean(marker),
    marker,
    runtimePolicy: "download-at-install-update; runtime-local-only"
  };
}

function bundledRerankerModelCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(process.cwd(), "models", DEFAULT_RERANKER_MODEL_DIRECTORY),
    path.resolve(moduleDir, "..", "..", "models", DEFAULT_RERANKER_MODEL_DIRECTORY),
    path.resolve(moduleDir, "..", "..", "..", "models", DEFAULT_RERANKER_MODEL_DIRECTORY)
  ];
}

/**
 * Reordena pasajes mediante un cross-encoder multilingue. A diferencia del
 * embedding bi-encoder, el modelo lee pregunta y pasaje juntos, por lo que
 * puede distinguir coincidencias tematicas de respuestas realmente directas.
 */
export async function rerankPassages(
  question: string,
  passages: NeuralRerankInput[],
  options: RerankOptions = {}
): Promise<NeuralRerankedPassage[]> {
  const cleanQuestion = question.trim();
  const cleanPassages = passages.filter((passage) => passage.body.trim());
  if (!cleanQuestion || !cleanPassages.length) return [];

  const modelId = options.modelId ?? configuredRerankerModel();
  const dtype = options.dtype ?? configuredRerankerDtype();
  const cacheDir = options.cacheDir ?? defaultModelCacheDir();
  const localOnly = options.localOnly ?? true;
  // El modelo MiniLM admite hasta 512 tokens. Las páginas IBM i suelen situar
  // restricciones críticas después de la introducción y los metadatos; cortar
  // a 256 hacía invisibles frases como "read-only" aun estando en el pasaje.
  const maxLength = Math.max(64, Math.min(512, Math.trunc(options.maxLength ?? 128)));
  const { tokenizer, model } = await loadReranker({ modelId, dtype, cacheDir, localOnly });
  const questions = cleanPassages.map(() => cleanQuestion);
  const documents = cleanPassages.map(renderRerankerPassage);
  const modelInputs = tokenizer(questions, {
    text_pair: documents,
    padding: true,
    truncation: true,
    max_length: maxLength
  });
  const output = await (model as unknown as (inputs: unknown) => Promise<{ logits: { tolist: () => number[][] | number[] } }>)(modelInputs);
  const rawLogits = output.logits.tolist();
  const rows = Array.isArray(rawLogits[0])
    ? rawLogits as number[][]
    : (rawLogits as number[]).map((value) => [value]);
  return cleanPassages.map((passage, index) => {
    const relevanceLogit = Number(rows[index]?.[0] ?? Number.NEGATIVE_INFINITY);
    return {
      ...passage,
      relevanceLogit,
      relevanceProbability: sigmoid(relevanceLogit)
    };
  }).sort((left, right) => right.relevanceLogit - left.relevanceLogit);
}

function renderRerankerPassage(passage: NeuralRerankInput): string {
  // La ruta conceptual desambigua títulos breves como Time, Tables o Status.
  // El límite de secuencia deja después espacio suficiente para que el modelo
  // contraste también la definición del pasaje y no solo su taxonomía.
  return [
    passage.title,
    passage.breadcrumbs?.join(" > "),
    passage.category,
    passage.version ? `IBM i ${passage.version}` : "IBM i",
    passage.body
  ].filter(Boolean).join(". ");
}

async function loadReranker(options: {
  modelId: string;
  dtype: string;
  cacheDir: string;
  localOnly: boolean;
}): Promise<{ tokenizer: Tokenizer; model: SequenceClassifier }> {
  const key = `${options.modelId}|${options.dtype}|${options.cacheDir}|${options.localOnly ? "local" : "remote"}`;
  if (rerankerPromise && rerankerKey === key) return rerankerPromise;

  fs.mkdirSync(options.cacheDir, { recursive: true });
  env.cacheDir = options.cacheDir;
  env.allowRemoteModels = !options.localOnly;
  rerankerKey = key;
  rerankerPromise = Promise.all([
    AutoTokenizer.from_pretrained(options.modelId, { local_files_only: options.localOnly }),
    AutoModelForSequenceClassification.from_pretrained(options.modelId, {
      dtype: options.dtype,
      local_files_only: options.localOnly,
      // Evita que ONNX Runtime retenga el pico de activaciones del reranking
      // como arena permanente entre consultas del servidor MCP.
      session_options: {
        enableCpuMemArena: false,
        enableMemPattern: false
      }
    } as never)
  ]).then(([tokenizer, model]) => ({ tokenizer, model }));
  return rerankerPromise;
}

function sigmoid(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}
