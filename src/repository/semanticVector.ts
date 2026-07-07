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

const CONCEPT_RULES: Array<{ concept: string; weight: number; patterns: RegExp[]; related?: string[] }> = [
  { concept: "ibmi.rpgle.create-module", weight: 12, patterns: [/\bcrtrpgmod\b|create\s+rpg\s+module|rpg\s+module/i], related: ["ibmi.compile.rpgle", "ibmi.ile-rpg", "ibmi.command"] },
  { concept: "ibmi.sqlrpgle.compile-program", weight: 11, patterns: [/\bcrtsqlrpgi\b|create\s+sql\s+rpg|sql\s+rpg\s+program|sqlrpgle\s+compile/i], related: ["ibmi.compile.sqlrpgle", "ibmi.sql.embedded", "ibmi.ile-rpg"] },
  { concept: "ibmi.rpg.opcode.message", weight: 12, patterns: [/\bsnd-msg\b|send\s+a\s+message\s+to\s+the\s+joblog|message[- ]type|%\s*(msg|target)\b/i], related: ["ibmi.rpg.opcode", "ibmi.joblog.message", "ibmi.ile-rpg"] },
  { concept: "ibmi.dds.physical-file.definition", weight: 11, patterns: [/\bdds\b.*\b(pf|physical\s+file|archivo\s+f[ií]sico)\b|defining\s+a\s+physical\s+file|physical\s+file\s+using\s+dds/i], related: ["ibmi.dds.file", "ibmi.datatype"] },
  { concept: "ibmi.dds.unique-keyword", weight: 10, patterns: [/\bdds\b.*\bunique\b|\bunique\b.*\bdds\b|\bunique\b.*\b(physical|logical)\b|unique\s+\(unique\)\s+keyword|unique\s+keyword.*physical.*logical/i], related: ["ibmi.dds.file", "ibmi.dds.physical-file.definition"] },
  { concept: "ibmi.sql.embedded.copy-include", weight: 11, patterns: [/\/\s*(copy|include)\b|copy\s+include|using\s+\/copy.*\/include.*embedded\s+sql|source\s+files\s+with\s+embedded\s+sql/i], related: ["ibmi.sql.embedded", "ibmi.ile-rpg"] },
  { concept: "ibmi.cl.job.submit", weight: 11, patterns: [/\bsbmjob\b|submit\s+job|submitted\s+job/i], related: ["ibmi.cl.command", "ibmi.work-management"] },
  { concept: "ibmi.cl.job.attributes", weight: 11, patterns: [/\brtvjoba\b|retrieve\s+job\s+attributes|job\s+attributes/i], related: ["ibmi.cl.command", "ibmi.work-management"] },
  { concept: "ibmi.cl.job.active", weight: 10, patterns: [/\bwrkactjob\b|work\s+with\s+active\s+jobs|active\s+jobs?|trabajos?\s+activos?/i], related: ["ibmi.cl.command", "ibmi.work-management"] },
  { concept: "ibmi.cl.object-locks", weight: 10, patterns: [/\bwrkobjlck\b|work\s+with\s+object\s+locks?|object\s+locks?|bloqueos?/i], related: ["ibmi.cl.command", "ibmi.object-locks"] },
  { concept: "ibmi.library-list.initial", weight: 10, patterns: [/library\s+list|initial\s+library|loaded\s+first.*login|login.*librar|lista\s+de\s+bibliotecas|biblioteca\s+inicial/i], related: ["ibmi.work-management", "ibmi.cl.command"] },
  { concept: "ibmi.file-members.discovery", weight: 10, patterns: [/members?\s+of\s+(?:a\s+)?file|file\s+members?|source\s+members?|miembros?\s+de\s+(?:un\s+)?archivo|listar\s+miembros?|all\s+members/i], related: ["ibmi.cl.command", "ibmi.dds.file"] },
  { concept: "ibmi.cl.batch-debug", weight: 11, patterns: [/debug.*batch|batch.*debug|depur.*batch|submitted\s+job.*debug|\bstrsrvjob\b|\bstrdbg\b|\bwrksbmjob\b|service\s+job/i], related: ["ibmi.cl.job.submit", "ibmi.work-management", "ibmi.cl.command"] },
  { concept: "ibmi.seu.line-commands", weight: 10, patterns: [/\bseu\b|source\s+entry\s+utility|line\s+commands?|copy.*delete.*insert.*move|source\s+lines?/i], related: ["ibmi.source-editing"] },
  { concept: "ibmi.rpg.record-lock-status", weight: 10, patterns: [/record[-\s]+lock|locked\s+record|registro\s+bloquead|%status|%error|\b1218\b|\bchain\b.*\bread\b|\bread\b.*\bchain\b/i], related: ["ibmi.object-locks", "ibmi.ile-rpg"] },
  { concept: "ibmi.rpg.datetime", weight: 7, patterns: [/%\s*(time|date|timestamp)\b/i, /time\s+data\s+type/i, /date[- ]time|timestamp/i, /\b(timfmt|datfmt)\b/i, /hora|fecha|horario/i], related: ["ibmi.rpg.bif", "ibmi.datatype.time"] },
  { concept: "ibmi.rpg.time-format.iso", weight: 7, patterns: [/\*iso0?|iso0|\*hms|hhmmss|time[- ]format/i], related: ["ibmi.rpg.datetime", "ibmi.datatype.time"] },
  { concept: "ibmi.rpg.packed-decimal", weight: 7, patterns: [/%\s*dec\b/i, /packed\s+decimal/i, /decimal\s+empaquetad/i, /\bpacket\b/i, /num[eé]ric|numeric/i], related: ["ibmi.rpg.conversion", "ibmi.datatype.numeric"] },
  { concept: "ibmi.rpg.conversion", weight: 6, patterns: [/convert|conversion|conversi[oó]n|obtener|representar/i, /date,?\s*time\s*or\s*timestamp\s*expression/i], related: ["ibmi.rpg.datetime", "ibmi.rpg.packed-decimal"] },
  { concept: "ibmi.rpg.bif", weight: 5, patterns: [/%\s*[a-z][a-z0-9_-]+/i, /built[- ]in\s+function/i, /funci[oó]n\s+integrada/i], related: ["ibmi.ile-rpg"] },
  { concept: "ibmi.sql.embedded", weight: 6, patterns: [/sqlrpgle|exec\s+sql|embedded\s+sql|sql\s+embebido|precompil/i], related: ["ibmi.sql.control", "ibmi.ile-rpg"] },
  { concept: "ibmi.sql.control", weight: 6, patterns: [/set\s+option|commit|rollback|insert|update|select|delete|merge|open|fetch|close/i], related: ["ibmi.sql.embedded"] },
  { concept: "ibmi.sql.diagnostics", weight: 6, patterns: [/sqlcode|sqlstate|diagnostic|diagn[oó]stic/i], related: ["ibmi.sql.embedded", "ibmi.sql.control"] },
  { concept: "ibmi.compile.sqlrpgle", weight: 5, patterns: [/crtsqlrpgi|rpgg?ppopt|compile|compil|precompiler/i], related: ["ibmi.sql.embedded"] },
  { concept: "ibmi.ile-rpg", weight: 4, patterns: [/rpgle|ile\s+rpg|free[- ]form|rpg\s+free/i], related: ["ibmi.rpg.bif"] },
  { concept: "ibmi.cl.command", weight: 5, patterns: [/\b(dsp|wrk|crt|chg|snd|rtv|mon|sbm|call)[a-z0-9]{2,}\b/i, /control\s+language|\bclle\b/i], related: ["ibmi.command"] },
  { concept: "ibmi.dds.file", weight: 5, patterns: [/\bdds\b|physical\s+file|logical\s+file|archivo\s+f[ií]sico|archivo\s+l[oó]gico|\bpf\b|\blf\b/i], related: ["ibmi.datatype"] },
  { concept: "ibmi.work-management", weight: 5, patterns: [/wrkactjob|wrkjob|dspjob|joblog|active\s+jobs?|trabajos?\s+activos?/i], related: ["ibmi.command"] },
  { concept: "ibmi.object-locks", weight: 5, patterns: [/wrkobjlck|object\s+locks?|bloqueos?|locks?/i], related: ["ibmi.work-management"] },
  { concept: "ibmi.message.rnf", weight: 5, patterns: [/rnf\d{4}|rpg\s+messages?|compiler\s+messages?/i], related: ["ibmi.compile"] },
  { concept: "ibmi.message.runtime", weight: 5, patterns: [/(cpf|mch)\d{4}|joblog|second\s+level|segundo\s+nivel/i], related: ["ibmi.work-management"] }
];

const CATEGORY_CONCEPTS: Record<string, string[]> = {
  "ile-rpg": ["ibmi.ile-rpg", "ibmi.rpg.bif"],
  "sql-db2-for-i": ["ibmi.sql.embedded", "ibmi.sql.control"],
  "cl-clle": ["ibmi.cl.command", "ibmi.command"],
  dds: ["ibmi.dds.file", "ibmi.datatype"],
  "mensajes-rnf": ["ibmi.message.rnf", "ibmi.compile"],
  "ile-cobol": ["ibmi.cobol"]
};

const STOPWORDS = new Set([
  "a", "an", "and", "as", "de", "del", "el", "en", "for", "in", "la", "las", "los", "of", "on", "or", "the", "to", "un", "una", "with",
  "que", "para", "por", "con", "sin", "como", "necesito", "validar", "confirmar", "buenas", "practicas", "uso", "usar", "hacer"
]);

export function buildSemanticProfile(input: SemanticVectorInput | string): SemanticProfile {
  const text = typeof input === "string" ? input : semanticInputText(input);
  const concepts = new Set<string>();
  const intentHints = new Set<string>();
  for (const rule of CONCEPT_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(text))) continue;
    concepts.add(rule.concept);
    for (const related of rule.related ?? []) concepts.add(related);
  }
  if (typeof input !== "string" && input.category) {
    for (const concept of CATEGORY_CONCEPTS[input.category] ?? []) concepts.add(concept);
  }
  if ([...concepts].some((concept) => concept.includes("datetime") || concept.includes("packed-decimal"))) intentHints.add("date_time_conversion");
  if ([...concepts].some((concept) => concept.startsWith("ibmi.sql"))) intentHints.add("embedded_sql_or_db2");
  if ([...concepts].some((concept) => concept.includes("work-management") || concept.includes("object-locks"))) intentHints.add("administration");
  if ([...concepts].some((concept) => concept.includes("batch-debug"))) intentHints.add("batch_debug");
  if ([...concepts].some((concept) => concept.includes("library-list") || concept.includes("file-members") || concept.includes("source-editing"))) intentHints.add("guided_discovery");
  if ([...concepts].some((concept) => concept.includes("message"))) intentHints.add("message_diagnostic");
  return { concepts: [...concepts].sort(), intentHints: [...intentHints].sort() };
}

export function buildSemanticVector(input: SemanticVectorInput | string): Float32Array {
  const vector = new Float32Array(SEMANTIC_VECTOR_DIMENSIONS);
  if (typeof input === "string") {
    addProfileFeatures(vector, buildSemanticProfile(input), 2.2);
    addPhraseFeatures(vector, input, 0.45);
    normalizeVector(vector);
    return vector;
  }

  const headerProfile = buildSemanticProfile({
    title: input.title,
    category: input.category,
    language: input.language,
    breadcrumbs: input.breadcrumbs,
    body: ""
  });
  const bodyProfile = buildSemanticProfile(input.body ?? "");
  addProfileFeatures(vector, headerProfile, 2.7);
  addProfileFeatures(vector, bodyProfile, 0.55);

  if (input.category) addFeature(vector, `category:${input.category}`, 4);
  if (input.language) addFeature(vector, `language:${input.language.toLowerCase()}`, 3);
  for (const breadcrumb of input.breadcrumbs ?? []) addPhraseFeatures(vector, breadcrumb, 2.4);
  if (input.title) addPhraseFeatures(vector, input.title, 6.5);

  addPhraseFeatures(vector, input.body ?? "", 0.22);
  normalizeVector(vector);
  return vector;
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

export function explainSemanticMatch(hit: Pick<SearchHit, "title" | "category" | "breadcrumbs" | "snippet">, query: string): string[] {
  const queryProfile = buildSemanticProfile(query);
  const hitProfile = buildSemanticProfile({ title: hit.title, category: hit.category, breadcrumbs: hit.breadcrumbs, body: hit.snippet });
  const shared = hitProfile.concepts.filter((concept) => queryProfile.concepts.includes(concept));
  return [
    ...(shared.length ? [`conceptos compartidos: ${shared.slice(0, 6).join(", ")}`] : []),
    ...(hitProfile.concepts.length ? [`conceptos del documento: ${hitProfile.concepts.slice(0, 6).join(", ")}`] : []),
    ...(queryProfile.intentHints.length ? [`intención semántica: ${queryProfile.intentHints.join(", ")}`] : [])
  ].slice(0, 6);
}

function addPhraseFeatures(vector: Float32Array, text: string, weight: number): void {
  const terms = semanticTerms(text);
  for (const term of terms) addFeature(vector, `term:${term}`, weight);
  for (let i = 0; i < terms.length - 1; i += 1) addFeature(vector, `bigram:${terms[i]}_${terms[i + 1]}`, weight * 1.35);
  for (let i = 0; i < terms.length - 2; i += 1) addFeature(vector, `trigram:${terms[i]}_${terms[i + 1]}_${terms[i + 2]}`, weight * 1.55);
}

function addProfileFeatures(vector: Float32Array, profile: SemanticProfile, multiplier: number): void {
  for (const concept of profile.concepts) {
    const configuredWeight = CONCEPT_RULES.find((rule) => rule.concept === concept)?.weight ?? 8;
    addFeature(vector, `concept:${concept}`, configuredWeight * multiplier);
  }
  for (const hint of profile.intentHints) addFeature(vector, `intent:${hint}`, 12 * multiplier);
}

function semanticTerms(text: string): string[] {
  const normalized = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[%*#@$]/g, " ");
  return normalized.match(/[\p{L}\p{N}_+-]{2,}/gu)?.filter((term) => !STOPWORDS.has(term)).slice(0, 240) ?? [];
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const index = hash % vector.length;
  const sign = (hash & 0x80000000) === 0 ? 1 : -1;
  vector[index] += sign * weight;
}

function normalizeVector(vector: Float32Array): void {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
