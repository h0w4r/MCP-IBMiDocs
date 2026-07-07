import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { buildSemanticProfile } from "../repository/semanticVector.js";
import {
  configuredEmbeddingModel,
  DEFAULT_EMBEDDING_DIMENSIONS,
  embedTexts,
  embeddingPrefixesForModel,
  semanticPassageText,
  vectorToBuffer
} from "../repository/neuralEmbeddings.js";
import type { CorpusManifest, DocumentRecord, SourceManifest } from "../types.js";
import { nowIso } from "../util/common.js";
import { resolveContainedPath } from "../util/paths.js";

interface BuildPackOptions {
  inputDir: string;
  outDir: string;
}

interface PreparedChunk {
  body: string;
  tokenHint: number;
  vector: Float32Array;
  concepts: string[];
}

interface PreparedDocument {
  doc: DocumentRecord;
  sections: Array<{ kind: string; title: string; body: string; startLine: number; endLine: number }>;
  chunks: PreparedChunk[];
}

export async function buildDataPack(options: BuildPackOptions): Promise<CorpusManifest> {
  const inputDir = path.resolve(options.inputDir);
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const manifests = await loadInputManifests(inputDir);
  const sourceDocuments = dedupeDocuments(manifests.flatMap((manifest) => manifest.documents.map(sanitizeDocumentForRuntime)));
  const documents = sourceDocuments.map(withPortablePackPaths);
  const merged: CorpusManifest = {
    schemaVersion: 1,
    corpusVersion: `ibmi-docs-pack-${new Date().toISOString().slice(0, 10)}`,
    generatedAt: nowIso(),
    description: "Data pack local completo para MCP IBM i Docs. Runtime independiente de RDi/Eclipse Help.",
    sources: manifests.flatMap((manifest) => manifest.sources.map(sanitizeSourceForRuntime)),
    documents,
    coverage: buildCoverage(documents, manifests)
  };

  await copyDocumentFiles(manifests, inputDir, outDir, sourceDocuments, documents);
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(merged, null, 2), "utf8");
  await buildSqlite(path.join(outDir, "ibmi-docs.sqlite"), outDir, documents, merged);
  return merged;
}

function withPortablePackPaths(doc: DocumentRecord): DocumentRecord {
  const key = doc.sha256 || doc.id;
  const suffix = key.replace(/[^a-fA-F0-9]/g, "").slice(0, 24) || doc.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  // Los títulos de IBM pueden ser muy largos; usar rutas por hash evita errores
  // de checkout en Windows sin requerir core.longpaths para instalaciones normales.
  return {
    ...doc,
    rawHtmlPath: `raw/${suffix}.html`,
    normalizedTextPath: `normalized/${suffix}.txt`
  };
}

function sanitizeDocumentForRuntime(doc: DocumentRecord): DocumentRecord {
  const normalizedVersion = normalizeDocumentVersion(doc);
  const classified = {
    ...doc,
    version: normalizedVersion,
    documentKind: classifyDocumentKindForBuild(doc),
    canonicalTopicKey: canonicalTopicKeyForBuild(doc)
  };
  if (doc.sourceKind !== "rdi-local-export") return classified;
  const provenanceUrl = `rdi-help-bootstrap://topic/${encodeURIComponent(doc.id)}`;
  return {
    ...classified,
    // La exportación desde Eclipse/RDi Help ocurre una sola vez durante build.
    // En el paquete runtime no dejamos URLs 127.0.0.1 para evitar que clientes
    // o modelos las interpreten como endpoint disponible o requisito.
    originalUrl: provenanceUrl,
    canonicalUrl: provenanceUrl
  };
}

function normalizeDocumentVersion(doc: DocumentRecord): string {
  const values = [doc.version, doc.canonicalUrl, doc.originalUrl, doc.sourceId, doc.id].filter(Boolean).join(" ");
  const match = values.match(/7\.[3456](?:\.0)?/);
  if (match) return match[0].slice(0, 3);
  if (doc.sourceKind === "rdi-local-export") return "RDi-local";
  return doc.version || "RDi-local";
}

function sanitizeSourceForRuntime(source: SourceManifest): SourceManifest {
  if (source.kind !== "rdi-local-export") return source;
  return {
    ...source,
    baseUrl: "rdi-help-bootstrap://local-export",
    notes: [
      ...source.notes.filter((note) => !note.includes("127.0.0.1") && !note.toLowerCase().includes("localhost")),
      "Fuente temporal de bootstrap usada durante el desarrollo; no se consulta ni se requiere en runtime."
    ]
  };
}

async function loadInputManifests(inputDir: string): Promise<CorpusManifest[]> {
  const candidates = [
    path.join(inputDir, "rdi-export", "manifest.json"),
    path.join(inputDir, "ibm-docs-cache", "manifest.json")
  ];
  const manifests: CorpusManifest[] = [];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      manifests.push(JSON.parse(raw) as CorpusManifest);
    } catch {
      // Fuente opcional: si aún no existe, se omite sin inventar cobertura.
    }
  }
  if (!manifests.length) throw new Error(`No se encontraron manifest.json en ${candidates.join(", ")}`);
  return manifests;
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const byIdentity = new Map<string, DocumentRecord>();
  for (const doc of documents) {
    const key = buildDocumentDedupeKey(doc);
    const existing = byIdentity.get(key);
    if (!existing || sourcePriority(doc.sourceKind) < sourcePriority(existing.sourceKind)) byIdentity.set(key, doc);
  }
  return [...byIdentity.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function buildDocumentDedupeKey(doc: DocumentRecord): string {
  const canonical = doc.canonicalTopicKey ?? canonicalTopicKeyForBuild(doc);
  if (isUsefulCanonicalKey(canonical)) return `topic:${doc.version}:${doc.category}:${canonical}`;
  if (doc.canonicalUrl) return `url:${doc.version}:${doc.category}:${normalizeCanonicalUrlForDedupe(doc.canonicalUrl)}`;
  if (doc.sha256) return `sha:${doc.sha256}`;
  return `id:${doc.id}`;
}

function sourcePriority(kind: string): number {
  if (kind === "rdi-local-export") return 0;
  if (kind === "ibm-docs") return 1;
  return 2;
}

function isUsefulCanonicalKey(key: string | undefined): boolean {
  if (!key) return false;
  return !/:(topic|ibm|ile|sql|cobol|dds|rpg|cl)$/i.test(key);
}

function normalizeCanonicalUrlForDedupe(url: string): string {
  return url
    .replace(/#.*$/, "")
    .replace(/[?&]view=kc.*$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

async function copyDocumentFiles(
  manifests: CorpusManifest[],
  inputDir: string,
  outDir: string,
  sourceDocuments: DocumentRecord[],
  targetDocuments: DocumentRecord[]
): Promise<void> {
  const rawDir = path.join(outDir, "raw");
  const normalizedDir = path.join(outDir, "normalized");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });

  const sourceRoots = new Map<string, string>();
  for (const manifest of manifests) {
    for (const doc of manifest.documents) sourceRoots.set(doc.id, sourceRootForDocument(inputDir, doc, manifest));
  }

  const targetsById = new Map(targetDocuments.map((doc) => [doc.id, doc]));
  for (const sourceDoc of sourceDocuments) {
    const targetDoc = targetsById.get(sourceDoc.id);
    if (!targetDoc) continue;
    const root = sourceRoots.get(sourceDoc.id);
    if (!root) continue;
    const rawSource = resolveContainedPath(root, sourceDoc.rawHtmlPath);
    const normalizedSource = resolveContainedPath(root, sourceDoc.normalizedTextPath);
    const rawTarget = resolveContainedPath(outDir, targetDoc.rawHtmlPath);
    const normalizedTarget = resolveContainedPath(outDir, targetDoc.normalizedTextPath);
    if (!fsSync.existsSync(rawSource)) throw new Error(`No existe rawHtmlPath para ${sourceDoc.id}: ${sourceDoc.rawHtmlPath} en ${root}`);
    if (!fsSync.existsSync(normalizedSource)) throw new Error(`No existe normalizedTextPath para ${sourceDoc.id}: ${sourceDoc.normalizedTextPath} en ${root}`);
    await fs.mkdir(path.dirname(rawTarget), { recursive: true });
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    await fs.copyFile(rawSource, rawTarget);
    await fs.copyFile(normalizedSource, normalizedTarget);
  }
}

function sourceRootForDocument(inputDir: string, doc: DocumentRecord, manifest: CorpusManifest): string {
  const source = manifest.sources.find((item) => item.id === doc.sourceId) ?? manifest.sources.find((item) => item.kind === doc.sourceKind);
  const kind = source?.kind ?? doc.sourceKind;
  if (kind === "rdi-local-export") return path.join(inputDir, "rdi-export");
  if (kind === "ibm-docs") return path.join(inputDir, "ibm-docs-cache");
  return inputDir;
}

async function buildSqlite(dbPath: string, packRoot: string, documents: DocumentRecord[], manifest: CorpusManifest): Promise<void> {
  await fs.rm(dbPath, { force: true });
  const embeddingModel = configuredEmbeddingModel();
  const preparedDocuments = await prepareDocumentsForSqlite(packRoot, documents, embeddingModel);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      original_url TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      breadcrumbs_json TEXT NOT NULL,
      product TEXT NOT NULL,
      version TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      raw_html_path TEXT NOT NULL,
      normalized_text_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      text_length INTEGER NOT NULL,
      collected_at TEXT NOT NULL,
      document_kind TEXT NOT NULL DEFAULT 'topic',
      canonical_topic_key TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      token_hint INTEGER NOT NULL
    );
    CREATE TABLE document_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );
    CREATE TABLE chunk_vectors (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      concepts_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_documents_category ON documents(category);
    CREATE INDEX idx_documents_version ON documents(version);
    CREATE INDEX idx_documents_canonical_topic ON documents(canonical_topic_key, version, category);
    CREATE INDEX idx_sections_document ON document_sections(document_id, section_index);
    CREATE INDEX idx_chunk_vectors_document ON chunk_vectors(document_id);
  `);

  const insertMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
  const insertDoc = db.prepare(`INSERT INTO documents(
    id, source_kind, source_id, original_url, canonical_url, title, breadcrumbs_json, product, version, language,
    category, raw_html_path, normalized_text_path, sha256, text_length, collected_at, document_kind, canonical_topic_key
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertChunk = db.prepare("INSERT INTO chunks(document_id, chunk_index, title, body, token_hint) VALUES (?, ?, ?, ?, ?)");
  const insertVector = db.prepare("INSERT INTO chunk_vectors(chunk_id, document_id, dimensions, vector, concepts_json) VALUES (?, ?, ?, ?, ?)");
  const insertSection = db.prepare("INSERT INTO document_sections(document_id, section_index, kind, title, body, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)");

  const tx = db.transaction(() => {
    insertMeta.run("manifest", JSON.stringify(manifest));
    insertMeta.run("generated_at", manifest.generatedAt);
    insertMeta.run("embedding_provider", "transformers-js");
    insertMeta.run("embedding_model", embeddingModel);
    insertMeta.run("embedding_dimensions", String(preparedDocuments[0]?.chunks[0]?.vector.length ?? DEFAULT_EMBEDDING_DIMENSIONS));
    insertMeta.run("embedding_runtime_policy", "download-at-install-update; runtime-local-only");
    insertMeta.run("embedding_query_prefix", embeddingPrefixesForModel(embeddingModel).queryPrefix);
    insertMeta.run("embedding_passage_prefix", embeddingPrefixesForModel(embeddingModel).passagePrefix);
    for (const prepared of preparedDocuments) {
      const { doc } = prepared;
      insertDoc.run(
        doc.id,
        doc.sourceKind,
        doc.sourceId,
        doc.originalUrl,
        doc.canonicalUrl,
        doc.title,
        JSON.stringify(doc.breadcrumbs),
        doc.product,
        doc.version,
        doc.language,
        doc.category,
        doc.rawHtmlPath,
        doc.normalizedTextPath,
        doc.sha256,
        doc.textLength,
        doc.collectedAt,
        doc.documentKind ?? classifyDocumentKindForBuild(doc),
        doc.canonicalTopicKey ?? canonicalTopicKeyForBuild(doc)
      );
      prepared.sections.forEach((section, index) => {
        insertSection.run(doc.id, index, section.kind, section.title, section.body, section.startLine, section.endLine);
      });
      prepared.chunks.forEach((chunk, index) => {
        const result = insertChunk.run(doc.id, index, doc.title, chunk.body, chunk.tokenHint);
        insertVector.run(result.lastInsertRowid, doc.id, chunk.vector.length, vectorToBuffer(chunk.vector), JSON.stringify(chunk.concepts));
      });
    }
  });
  tx();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.close();
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
}

async function prepareDocumentsForSqlite(packRoot: string, documents: DocumentRecord[], embeddingModel: string): Promise<PreparedDocument[]> {
  const chunkInputs: Array<{ doc: DocumentRecord; body: string; tokenHint: number; concepts: string[]; text: string }> = [];
  const preparedShells = documents.map((doc) => {
    const textPath = path.join(packRoot, doc.normalizedTextPath);
    const text = readTextIfExists(textPath);
    const sections = extractDocumentSections(text);
    const chunkBodies = splitIntoChunks(text, 3200);
    for (const body of chunkBodies) {
      const input = {
        title: doc.title,
        body,
        category: doc.category,
        language: doc.language,
        breadcrumbs: doc.breadcrumbs,
        version: doc.version
      };
      chunkInputs.push({
        doc,
        body,
        tokenHint: Math.ceil(body.length / 4),
        concepts: buildSemanticProfile(input).concepts,
        text: semanticPassageText(input, embeddingModel)
      });
    }
    return { doc, sections, chunks: [] as PreparedChunk[] };
  });

  const vectors = await embedPassagesInBatches(chunkInputs.map((item) => item.text));
  const shellsById = new Map(preparedShells.map((item) => [item.doc.id, item]));
  chunkInputs.forEach((chunk, index) => {
    const shell = shellsById.get(chunk.doc.id);
    if (!shell) return;
    shell.chunks.push({
      body: chunk.body,
      tokenHint: chunk.tokenHint,
      vector: vectors[index] ?? new Float32Array(DEFAULT_EMBEDDING_DIMENSIONS),
      concepts: chunk.concepts
    });
  });
  return preparedShells;
}

async function embedPassagesInBatches(texts: string[]): Promise<Float32Array[]> {
  const batchSize = Number(process.env.IBMI_DOCS_EMBEDDING_BATCH_SIZE ?? 64);
  const vectors: Float32Array[] = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    vectors.push(...await embedTexts(batch, { localOnly: false, kind: "passage" }));
    if (index === 0 || vectors.length % (batchSize * 10) === 0 || vectors.length >= texts.length) {
      console.error(`[ibmi-docs] Embeddings del pack: ${vectors.length}/${texts.length}`);
    }
  }
  return vectors;
}

function readTextIfExists(filePath: string): string {
  try {
    return fsSync.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  const clean = text.trim();
  if (!clean) return [""];
  const paragraphs = splitIntoStructuralBlocks(clean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > maxChars && current) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = [current, paragraph].filter(Boolean).join("\n\n");
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function splitIntoStructuralBlocks(text: string): string[] {
  const lines = text.split(/\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    // Muchas páginas IBM llegan como texto plano: detectamos títulos/secciones
    // cortas para que el motor semántico vectorial conserve contexto por apartado
    // sin mezclar secciones grandes que degradan la similitud conceptual.
    const looksLikeHeading =
      trimmed.length <= 120 &&
      (/(command|keyword|example|syntax|messages?|reference|guide|concepts?|programming)$/i.test(trimmed) ||
        /^[A-Z0-9_/%*()[\] .,-]{4,}$/.test(trimmed));
    if (looksLikeHeading && current.length > 0) flush();
    current.push(trimmed);
  }
  flush();
  return blocks.length ? blocks : [text];
}

function extractDocumentSections(text: string): Array<{ kind: string; title: string; body: string; startLine: number; endLine: number }> {
  const lines = text.split(/\r?\n/);
  const headings: Array<{ index: number; title: string; kind: string }> = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 140) return;
    const kind = detectSectionKind(trimmed);
    const looksHeading = kind !== "generic" || (/^[A-Z0-9_/%*()[\] .,:;-]{4,}$/.test(trimmed) && index > 0);
    if (looksHeading) headings.push({ index, title: trimmed, kind });
  });
  if (!headings.length) return [{ kind: "description", title: "Contenido", body: text.trim(), startLine: 1, endLine: lines.length }];
  return headings.map((heading, index) => {
    const next = headings[index + 1]?.index ?? lines.length;
    return {
      kind: heading.kind,
      title: heading.title,
      body: lines.slice(heading.index + 1, next).join("\n").trim() || heading.title,
      startLine: heading.index + 1,
      endLine: next
    };
  }).filter((section) => section.body).slice(0, 80);
}

function detectSectionKind(title: string): string {
  if (/syntax|free-form|fixed-form|formato|sintaxis/i.test(title)) return "syntax";
  if (/parameter|operand|factor|par[aá]metro/i.test(title)) return "parameters";
  if (/description|usage|purpose|descripci[oó]n/i.test(title)) return "description";
  if (/example|ejemplo|sample/i.test(title)) return "examples";
  if (/restriction|restricci[oó]n/i.test(title)) return "restrictions";
  if (/note|consideration|consideraci[oó]n/i.test(title)) return "notes";
  if (/message|mensaje|rnf|sql\d/i.test(title)) return "messages";
  if (/recovery|recover|cause|response|acci[oó]n/i.test(title)) return "recovery";
  if (/related|see also|referencia|api/i.test(title)) return "related";
  return "generic";
}

function buildCoverage(documents: DocumentRecord[], manifests: CorpusManifest[]): Record<string, unknown> {
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  const byDocumentKind: Record<string, number> = {};
  const canonicalCounts: Record<string, number> = {};
  const versionAnomalies: Array<{ id: string; version: string }> = [];
  const allowedVersions = new Set(["7.3", "7.4", "7.5", "7.6", "RDi-local"]);
  for (const doc of documents) {
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
    bySource[doc.sourceKind] = (bySource[doc.sourceKind] ?? 0) + 1;
    byVersion[doc.version] = (byVersion[doc.version] ?? 0) + 1;
    byDocumentKind[doc.documentKind ?? classifyDocumentKindForBuild(doc)] = (byDocumentKind[doc.documentKind ?? classifyDocumentKindForBuild(doc)] ?? 0) + 1;
    const canonical = doc.canonicalTopicKey ?? canonicalTopicKeyForBuild(doc);
    canonicalCounts[`${doc.version}:${doc.category}:${canonical}`] = (canonicalCounts[`${doc.version}:${doc.category}:${canonical}`] ?? 0) + 1;
    if (!allowedVersions.has(doc.version)) versionAnomalies.push({ id: doc.id, version: doc.version });
  }
  const duplicateCanonicalCount = Object.values(canonicalCounts).filter((count) => count > 1).length;
  return {
    documentCount: documents.length,
    sourceCount: manifests.length,
    byCategory,
    bySource,
    byVersion,
    byDocumentKind,
    quality: {
      allowedVersions: [...allowedVersions],
      versionAnomalies: versionAnomalies.slice(0, 50),
      versionAnomalyCount: versionAnomalies.length,
      duplicateCanonicalCount
    }
  };
}

function classifyDocumentKindForBuild(doc: DocumentRecord): NonNullable<DocumentRecord["documentKind"]> {
  const title = foldBuild(doc.title);
  const breadcrumbs = foldBuild(doc.breadcrumbs.join(" "));
  const haystack = `${title} ${breadcrumbs}`;
  if (doc.textLength > 0 && doc.textLength < 300) return "stub";
  if (/^(ibm rational developer|ibm i documentation|welcome|home)$/.test(title)) return "landing";
  if (/\b(what'?s new|contents|table of contents|appendix|appendixes|index|overview)\b/.test(haystack)) return "index";
  if (/\b(reference|programmer'?s guide|language reference|messages and codes|keyword finder)\b/.test(title)) return "reference";
  return "topic";
}

function canonicalTopicKeyForBuild(doc: DocumentRecord): string {
  const technical = extractCanonicalTechnicalTokenForBuild(doc);
  const bif = doc.title.match(/%[A-Z][A-Z0-9_-]+/i)?.[0]?.toLowerCase();
  const title = foldBuild(doc.title)
    .replace(/\b(description of the|using the|command|keyword|operation code|built-in function|send a message to the joblog)\b/g, " ")
    .replace(/[()%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${doc.category}:${bif ?? technical ?? title ?? "topic"}`;
}

const BUILD_COMMAND_PREFIXES = [
  "add", "alw", "ap", "call", "chg", "chk", "clr", "cpy", "crt", "dcl", "dlt", "dmp", "dsp", "ed", "end", "go", "grt",
  "hold", "mon", "ovr", "prt", "rcv", "rel", "rmv", "rnm", "rst", "rtv", "run", "sav", "sbm", "snd", "str", "tfr", "wrk"
];
const BUILD_COMMAND_PATTERN = new RegExp(`^(${BUILD_COMMAND_PREFIXES.join("|")})[a-z0-9]{1,}$`, "i");
const GENERIC_UPPERCASE_TERMS = new Set(["API", "CL", "COBOL", "DDS", "IBM", "ILE", "JCL", "RDI", "RPG", "SQL", "XML", "JSON", "HTML", "PDF", "PF", "LF"]);

function extractCanonicalTechnicalTokenForBuild(doc: DocumentRecord): string | undefined {
  const title = doc.title.trim();
  const haystack = `${doc.title} ${doc.breadcrumbs.join(" ")} ${doc.category}`;
  const message = haystack.match(/\b(RNF\d{4}|CPF\d{4}|MCH\d{4}|SQL\d{4,5})\b/i)?.[1];
  if (message) return message.toLowerCase();
  const opcode = title.match(/\b[A-Z]{2,}-[A-Z0-9-]+\b/)?.[0];
  if (opcode) return opcode.toLowerCase();

  const commandContext = /\b(command|commands|description of the .* command|using the .* command)\b/i.test(haystack);
  const candidates = [...haystack.matchAll(/\b[A-Z][A-Z0-9]{1,11}\b/g)].map((match) => match[0]);
  for (const candidate of candidates) {
    if (GENERIC_UPPERCASE_TERMS.has(candidate)) continue;
    if (BUILD_COMMAND_PATTERN.test(candidate) && commandContext) return candidate.toLowerCase();
  }
  return undefined;
}

function foldBuild(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}


