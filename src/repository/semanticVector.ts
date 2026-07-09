import type { SearchHit } from "../types.js";

export const SEMANTIC_VECTOR_DIMENSIONS = 384;

export interface SemanticVectorInput {
  title?: string;
  body?: string;
  category?: string;
  language?: string;
  breadcrumbs?: string[];
  version?: string;
}

export interface SemanticProfile {
  concepts: string[];
  intentHints: string[];
}

/** Compatibilidad estructural: el runtime público usa embeddings Transformers.js. */
export function buildSemanticProfile(_input: SemanticVectorInput | string): SemanticProfile {
  return { concepts: [], intentHints: [] };
}

/** Compatibilidad estructural: el ranking público no usa este vector. */
export function buildSemanticVector(_input: SemanticVectorInput | string): Float32Array {
  return new Float32Array(SEMANTIC_VECTOR_DIMENSIONS);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function bufferToVector(value: Buffer | Uint8Array): Float32Array {
  const buffer = value instanceof Buffer ? value : Buffer.from(value);
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

export function semanticInputText(input: SemanticVectorInput): string {
  return [input.title, input.breadcrumbs?.join(" > "), input.category, input.language, input.body].filter(Boolean).join("\n");
}

export function explainSemanticMatch(_hit: Pick<SearchHit, "title" | "category" | "breadcrumbs" | "snippet">, _query: string): string[] {
  return [];
}
