import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-candidate-cache-"));
  temporaryRoots.push(root);
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({
    corpusVersion: "cache-test",
    generatedAt: "2026-01-01T00:00:00.000Z"
  }), "utf8");
  return root;
}

function createCandidateDatabase(file: string, title: string): void {
  const vector = Buffer.from(Float32Array.of(1).buffer);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT, source_kind TEXT, source_id TEXT,
      version TEXT, category TEXT, canonical_url TEXT, text_length INTEGER,
      breadcrumbs_json TEXT, document_kind TEXT, canonical_topic_key TEXT,
      normalized_text_path TEXT, sha256 TEXT, language TEXT, product TEXT
    );
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id TEXT, chunk_index INTEGER, body TEXT);
    CREATE TABLE chunk_vectors (chunk_id INTEGER PRIMARY KEY, vector BLOB);
    CREATE TABLE document_vectors (document_id TEXT PRIMARY KEY, vector BLOB);
    INSERT INTO meta(key, value) VALUES ('generated_at', '2026-01-01T00:00:00.000Z');
  `);
  db.prepare(`
    INSERT INTO documents VALUES (
      'doc-1', ?, 'manual-pack', 'test', '7.6', 'ile-rpg', 'https://example.test/doc-1',
      4, '[]', 'topic', 'ile-rpg:test', 'normalized/doc.txt', 'hash', 'en', 'IBM i'
    )
  `).run(title);
  db.prepare("INSERT INTO chunks VALUES (1, 'doc-1', 0, 'body')").run();
  db.prepare("INSERT INTO chunk_vectors VALUES (1, ?)").run(vector);
  db.prepare("INSERT INTO document_vectors VALUES ('doc-1', ?)").run(vector);
  db.close();
}

function readPrivateCandidates(repo: CorpusRepository): Array<{ title: string }> {
  return (repo as unknown as { getNeuralCandidates: () => Array<{ title: string }> }).getNeuralCandidates();
}

describe("invalidación de candidateCache", () => {
  it("detecta un SQLite reemplazado aunque conserve tamaño y mtime", async () => {
    const root = await tempDir();
    const database = path.join(root, "ibmi-docs.sqlite");
    const replacement = path.join(root, "ibmi-docs.sqlite.new");
    createCandidateDatabase(database, "AAAA");

    const firstRepo = new CorpusRepository(root);
    expect(readPrivateCandidates(firstRepo)[0]?.title).toBe("AAAA");
    firstRepo.close();

    const originalStat = await fs.stat(database);
    createCandidateDatabase(replacement, "BBBB");
    expect((await fs.stat(replacement)).size).toBe(originalStat.size);
    await fs.rm(database);
    await fs.rename(replacement, database);
    await fs.utimes(database, originalStat.atime, originalStat.mtime);

    const secondRepo = new CorpusRepository(root);
    expect(readPrivateCandidates(secondRepo)[0]?.title).toBe("BBBB");
    secondRepo.close();
  });
});
