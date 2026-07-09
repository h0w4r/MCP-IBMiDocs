import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { installDataPack, verifyDataPack } from "../src/pack/dataPack.js";
import { resolvePackDir } from "../src/util/paths.js";
import type { CorpusManifest, DocumentRecord } from "../src/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function sampleDocument(id: string): DocumentRecord {
  return {
    id,
    sourceKind: "manual-pack",
    sourceId: "test",
    originalUrl: `https://example.test/${id}`,
    canonicalUrl: `https://example.test/${id}`,
    title: `Documento ${id}`,
    breadcrumbs: ["IBM i", "Testing"],
    product: "IBM i",
    version: "7.6",
    language: "en-us",
    category: "ibm-i-general",
    rawHtmlPath: "raw/doc.html",
    normalizedTextPath: "normalized/doc.txt",
    sha256: "abc",
    textLength: 42,
    collectedAt: new Date(0).toISOString()
  };
}

async function createValidPack(root: string, id = "doc-1"): Promise<CorpusManifest> {
  const doc = sampleDocument(id);
  const manifest: CorpusManifest = {
    schemaVersion: 1,
    corpusVersion: `test-${id}`,
    generatedAt: new Date(0).toISOString(),
    description: "Pack mínimo para pruebas.",
    sources: [{
      id: "test",
      kind: "manual-pack",
      name: "Test",
      baseUrl: "https://example.test",
      exportedAt: new Date(0).toISOString(),
      documentCount: 1,
      failedCount: 0,
      notes: []
    }],
    documents: [doc],
    coverage: { documentCount: 1 }
  };
  await fs.mkdir(path.join(root, "raw"), { recursive: true });
  await fs.mkdir(path.join(root, "normalized"), { recursive: true });
  await fs.writeFile(path.join(root, doc.rawHtmlPath), "<h1>Documento</h1>", "utf8");
  await fs.writeFile(path.join(root, doc.normalizedTextPath), "Documento de prueba", "utf8");
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const db = new Database(path.join(root, "ibmi-docs.sqlite"));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT, chunk_index INTEGER, title TEXT, body TEXT, token_hint INTEGER);
    CREATE TABLE chunk_vectors (chunk_id INTEGER PRIMARY KEY, document_id TEXT, dimensions INTEGER, vector BLOB);
    CREATE TABLE document_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT, section_index INTEGER, kind TEXT, title TEXT, body TEXT, start_line INTEGER, end_line INTEGER);
    INSERT INTO meta(key, value) VALUES ('manifest', '${JSON.stringify(manifest).replace(/'/g, "''")}');
    INSERT INTO documents(id) VALUES ('${id}');
  `);
  db.close();
  return manifest;
}

describe("resolución e integridad de data packs", () => {
  it("distingue --pack explícito y rechaza rutas forzadas inválidas", async () => {
    const pack = await tempDir("ibmi-pack-valid-");
    await fs.writeFile(path.join(pack, "manifest.json"), "{}", "utf8");
    await fs.writeFile(path.join(pack, "ibmi-docs.sqlite"), "", "utf8");

    const resolution = resolvePackDir(import.meta.url, pack);
    expect(resolution.source).toBe("explicit");
    expect(resolution.packDir).toBe(path.resolve(pack));

    const invalid = await tempDir("ibmi-pack-invalid-");
    expect(() => resolvePackDir(import.meta.url, invalid)).toThrow(/ruta explícita --pack inválida|Faltan/i);
  });

  it("detecta SQLite corrupto y rutas de manifest fuera del pack", async () => {
    const corrupt = await tempDir("ibmi-pack-corrupt-");
    await fs.mkdir(path.join(corrupt, "raw"), { recursive: true });
    await fs.mkdir(path.join(corrupt, "normalized"), { recursive: true });
    const doc = { ...sampleDocument("escape"), rawHtmlPath: "../escape.html" };
    await fs.writeFile(path.join(corrupt, "normalized", "doc.txt"), "texto", "utf8");
    await fs.writeFile(path.join(corrupt, "manifest.json"), JSON.stringify({
      corpusVersion: "bad",
      generatedAt: new Date(0).toISOString(),
      documents: [doc]
    }), "utf8");
    await fs.writeFile(path.join(corrupt, "ibmi-docs.sqlite"), "", "utf8");

    const result = await verifyDataPack(corrupt);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toMatch(/Ruta inválida|SQLite inválido|SQLite sin tabla/i);
  });

  it("instala de forma atómica y elimina residuos del pack anterior", async () => {
    const sourceA = await tempDir("ibmi-pack-a-");
    const sourceB = await tempDir("ibmi-pack-b-");
    const targetParent = await tempDir("ibmi-pack-target-");
    const target = path.join(targetParent, "pack");
    await createValidPack(sourceA, "doc-a");
    await createValidPack(sourceB, "doc-b");

    await installDataPack({ from: sourceA, outDir: target });
    await fs.writeFile(path.join(target, "raw", "stale.html"), "stale", "utf8");
    expect(fsSync.existsSync(path.join(target, "raw", "stale.html"))).toBe(true);

    await installDataPack({ from: sourceB, outDir: target });
    const verification = await verifyDataPack(target);
    expect(verification.ok).toBe(true);
    expect(verification.corpusVersion).toBe("test-doc-b");
    expect(fsSync.existsSync(path.join(target, "raw", "stale.html"))).toBe(false);
  });
});
