import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CorpusManifest, DocumentRecord, SourceManifest } from "../types.js";
import { nowIso } from "../util/common.js";

interface BuildPackOptions {
  inputDir: string;
  outDir: string;
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
  if (doc.sourceKind !== "rdi-local-export") return doc;
  const provenanceUrl = `rdi-help-bootstrap://topic/${encodeURIComponent(doc.id)}`;
  return {
    ...doc,
    // La exportación desde Eclipse/RDi Help ocurre una sola vez durante build.
    // En el paquete runtime no dejamos URLs 127.0.0.1 para evitar que clientes
    // o modelos las interpreten como endpoint disponible o requisito.
    originalUrl: provenanceUrl,
    canonicalUrl: provenanceUrl
  };
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
  const byHash = new Map<string, DocumentRecord>();
  for (const doc of documents) {
    const key = doc.sha256 || doc.canonicalUrl;
    const existing = byHash.get(key);
    if (!existing || sourcePriority(doc.sourceKind) < sourcePriority(existing.sourceKind)) byHash.set(key, doc);
  }
  return [...byHash.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function sourcePriority(kind: string): number {
  if (kind === "rdi-local-export") return 0;
  if (kind === "ibm-docs") return 1;
  return 2;
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
    const root = manifest.sources[0]?.kind === "rdi-local-export" ? path.join(inputDir, "rdi-export") : path.join(inputDir, "ibm-docs-cache");
    for (const doc of manifest.documents) sourceRoots.set(doc.id, root);
  }

  const targetsById = new Map(targetDocuments.map((doc) => [doc.id, doc]));
  for (const sourceDoc of sourceDocuments) {
    const targetDoc = targetsById.get(sourceDoc.id);
    if (!targetDoc) continue;
    const root = sourceRoots.get(sourceDoc.id);
    if (!root) continue;
    const rawSource = path.join(root, sourceDoc.rawHtmlPath);
    const normalizedSource = path.join(root, sourceDoc.normalizedTextPath);
    const rawTarget = path.join(outDir, targetDoc.rawHtmlPath);
    const normalizedTarget = path.join(outDir, targetDoc.normalizedTextPath);
    await fs.mkdir(path.dirname(rawTarget), { recursive: true });
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    await fs.copyFile(rawSource, rawTarget).catch(() => undefined);
    await fs.copyFile(normalizedSource, normalizedTarget).catch(() => undefined);
  }
}

async function buildSqlite(dbPath: string, packRoot: string, documents: DocumentRecord[], manifest: CorpusManifest): Promise<void> {
  await fs.rm(dbPath, { force: true });
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
      collected_at TEXT NOT NULL
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      token_hint INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      title,
      body,
      document_id UNINDEXED,
      category UNINDEXED,
      version UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE INDEX idx_documents_category ON documents(category);
    CREATE INDEX idx_documents_version ON documents(version);
  `);

  const insertMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
  const insertDoc = db.prepare(`INSERT INTO documents(
    id, source_kind, source_id, original_url, canonical_url, title, breadcrumbs_json, product, version, language,
    category, raw_html_path, normalized_text_path, sha256, text_length, collected_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertChunk = db.prepare("INSERT INTO chunks(document_id, chunk_index, title, body, token_hint) VALUES (?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts(rowid, title, body, document_id, category, version) VALUES (?, ?, ?, ?, ?, ?)");

  const tx = db.transaction(() => {
    insertMeta.run("manifest", JSON.stringify(manifest));
    insertMeta.run("generated_at", manifest.generatedAt);
    for (const doc of documents) {
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
        doc.collectedAt
      );
      const textPath = path.join(packRoot, doc.normalizedTextPath);
      const text = readTextIfExists(textPath);
      const chunks = splitIntoChunks(text, 3200);
      chunks.forEach((chunk, index) => {
        const result = insertChunk.run(doc.id, index, doc.title, chunk, Math.ceil(chunk.length / 4));
        insertFts.run(result.lastInsertRowid, doc.title, chunk, doc.id, doc.category, doc.version);
      });
    }
  });
  tx();
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.close();
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
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
  const paragraphs = clean.split(/\n{2,}/);
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

function buildCoverage(documents: DocumentRecord[], manifests: CorpusManifest[]): Record<string, unknown> {
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  for (const doc of documents) {
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
    bySource[doc.sourceKind] = (bySource[doc.sourceKind] ?? 0) + 1;
    byVersion[doc.version] = (byVersion[doc.version] ?? 0) + 1;
  }
  return { documentCount: documents.length, sourceCount: manifests.length, byCategory, bySource, byVersion };
}


