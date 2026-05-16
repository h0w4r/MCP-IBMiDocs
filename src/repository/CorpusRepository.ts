import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CorpusManifest, ReadResult, SearchHit, SearchOptions } from "../types.js";
import { clamp } from "../util/common.js";

export class CorpusRepository {
  private readonly db: Database.Database;
  readonly packDir: string;

  constructor(packDir = path.resolve("data", "pack")) {
    this.packDir = packDir;
    const dbPath = path.join(packDir, "ibmi-docs.sqlite");
    if (!fs.existsSync(dbPath)) {
      throw new Error(`No existe el índice local ${dbPath}. Ejecuta build-pack o instala un data pack.`);
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  manifest(): CorpusManifest {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("manifest") as { value: string } | undefined;
    if (!row) throw new Error("Manifest no encontrado dentro del SQLite.");
    return JSON.parse(row.value) as CorpusManifest;
  }

  diagnostics(): Record<string, unknown> {
    const manifest = this.manifest();
    const counts = this.db.prepare("SELECT COUNT(*) AS documents FROM documents").get() as { documents: number };
    const chunks = this.db.prepare("SELECT COUNT(*) AS chunks FROM chunks").get() as { chunks: number };
    return {
      corpusVersion: manifest.corpusVersion,
      generatedAt: manifest.generatedAt,
      sources: manifest.sources.map((source) => ({ id: source.id, kind: source.kind, documents: source.documentCount, exportedAt: source.exportedAt })),
      coverage: manifest.coverage,
      documents: counts.documents,
      chunks: chunks.chunks,
      runtimeDependency: "Sin RDi, sin Eclipse Help, sin endpoint local de RDi"
    };
  }

  search(options: SearchOptions): SearchHit[] {
    const limit = clamp(options.limit, 8, 1, 50);
    const fts = toFtsQuery(options.query);
    if (!fts) return [];
    const filters: string[] = [];
    const params: Record<string, string | number> = { fts, limit };
    if (options.version) {
      filters.push("d.version = @version");
      params.version = options.version;
    }
    if (options.category) {
      filters.push("d.category = @category");
      params.category = options.category;
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const sql = `
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url,
             d.breadcrumbs_json, c.body, bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH @fts ${where}
      ORDER BY rank ASC
      LIMIT @limit
    `;
    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      snippet: makeSnippet(String(row.body), options.query, 520),
      score: Math.round(Math.abs(Number(row.rank ?? 0)) * 100000) / 100000,
      sourceKind: String(row.source_kind) as SearchHit["sourceKind"],
      sourceId: String(row.source_id),
      version: String(row.version),
      category: String(row.category),
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: JSON.parse(String(row.breadcrumbs_json || "[]")) as string[]
    }));
  }

  read(id: string): ReadResult | null {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const textPath = path.join(this.packDir, String(row.normalized_text_path));
    const content = fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8") : "";
    return {
      id: String(row.id),
      title: String(row.title),
      snippet: makeSnippet(content, "", 520),
      score: 1,
      sourceKind: String(row.source_kind) as ReadResult["sourceKind"],
      sourceId: String(row.source_id),
      version: String(row.version),
      category: String(row.category),
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: JSON.parse(String(row.breadcrumbs_json || "[]")) as string[],
      content,
      textLength: Number(row.text_length),
      sha256: String(row.sha256)
    };
  }
}

export function toFtsQuery(query: string): string {
  const tokens = query
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}_#$@.\/+-]{2,}/gu)
    ?.slice(0, 12) ?? [];
  const expanded = expandIbmiTerms(tokens);
  return [...new Set(expanded)].map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
}

function expandIbmiTerms(tokens: string[]): string[] {
  const synonyms: Record<string, string[]> = {
    crtrpgmod: ["create", "module", "ile", "rpg", "rpgle"],
    crtbndrpg: ["create", "bound", "program", "ile", "rpg"],
    sqlrpgle: ["sql", "rpg", "embedded"],
    clle: ["cl", "control", "language", "ile"],
    dspf: ["display", "file", "dds"],
    pf: ["physical", "file", "dds"],
    lf: ["logical", "file", "dds"]
  };
  return tokens.flatMap((token) => [token, ...(synonyms[token] ?? [])]);
}

function makeSnippet(text: string, query: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const needle = query.split(/\s+/).find((part) => part.length > 2)?.toLowerCase() ?? "";
  const index = needle ? clean.toLowerCase().indexOf(needle) : -1;
  const start = Math.max(0, index > 0 ? index - Math.floor(maxChars / 3) : 0);
  const end = Math.min(clean.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}
