import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import Database from "better-sqlite3";
import { downloadFileWithTimeout } from "../util/fetch.js";
import { hasPack, resolveContainedExistingPath, resolveContainedPath } from "../util/paths.js";

export interface InstallDataPackOptions {
  from: string;
  outDir: string;
}

export interface InstallLatestDataPackOptions {
  outDir: string;
  url?: string;
}

export interface ArchiveDataPackOptions {
  packDir: string;
  outFile: string;
}

export interface DataPackInfo {
  packDir: string;
  ok: boolean;
  corpusVersion?: string;
  documents?: number;
  generatedAt?: string;
  issues: string[];
}

export const DEFAULT_PACK_RELEASE_URL =
  "https://github.com/h0w4r/MCP-IBMiDocs/releases/latest/download/ibmi-docs-pack.tgz";

const DEFAULT_PACK_DOWNLOAD_TIMEOUT_MS = positiveEnvironmentNumber("IBMI_DOCS_PACK_DOWNLOAD_TIMEOUT_MS", 60_000);
const DEFAULT_PACK_DOWNLOAD_MAX_BYTES = positiveEnvironmentNumber("IBMI_DOCS_PACK_DOWNLOAD_MAX_BYTES", 1024 * 1024 * 1024);
const REQUIRED_SQLITE_TABLES = ["meta", "documents", "chunks", "chunk_vectors", "document_vectors", "document_sections"];

interface MaterializedSource {
  path: string;
  cleanup: () => Promise<void>;
}

function positiveEnvironmentNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function installDataPack(options: InstallDataPackOptions): Promise<{ outDir: string; source: string }> {
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const materialized = await materializeSource(options.from);
  const source = materialized.path;
  const tempDir = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}-install-`));

  try {
    // Si la fuente ya es un directorio de pack, copiamos al temporal; si es tgz/tar,
    // extraemos al temporal. El destino real se reemplaza solo después de verificar.
    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      const sourceInfo = await verifyDataPack(source);
      if (!sourceInfo.ok) throw new Error(`El directorio fuente no parece un data pack válido: ${source}: ${sourceInfo.issues.join("; ")}`);
      await fs.cp(source, tempDir, { recursive: true, force: true });
    } else {
      await extractArchiveSafely(source, tempDir);
    }

    const installedInfo = await verifyDataPack(tempDir);
    if (!installedInfo.ok) {
      throw new Error(`El data pack descargado/extractado no es válido: ${installedInfo.issues.join("; ")}`);
    }

    await replaceDirectoryAtomically(tempDir, outDir);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    await materialized.cleanup();
  }

  return { outDir, source: options.from };
}

export async function installLatestDataPack(options: InstallLatestDataPackOptions): Promise<{ outDir: string; source: string; latestUrl: string }> {
  const latestUrl = options.url ?? process.env.IBMI_DOCS_PACK_LATEST_URL ?? DEFAULT_PACK_RELEASE_URL;
  const result = await installDataPack({ from: latestUrl, outDir: options.outDir });
  return { ...result, latestUrl };
}

export async function archiveDataPack(options: ArchiveDataPackOptions): Promise<{ outFile: string }> {
  const packDir = path.resolve(options.packDir);
  const info = await verifyDataPack(packDir);
  if (!info.ok) throw new Error(`No se puede archivar un pack inválido: ${packDir}: ${info.issues.join("; ")}`);
  const outFile = path.resolve(options.outFile);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await tar.c({
    gzip: true,
    cwd: packDir,
    file: outFile,
    // El release descargable lleva SQLite ya materializado; omitir sus
    // fragmentos evita duplicar cientos de MB dentro del mismo archivo.
    filter: (entryPath) => !/(^|\/)ibmi-docs\.sqlite\.part-\d+$/.test(entryPath)
      && !entryPath.endsWith("ibmi-docs.sqlite.parts.json")
  }, ["."]);
  return { outFile };
}

export async function verifyDataPack(packDir: string): Promise<DataPackInfo> {
  const resolved = path.resolve(packDir);
  const issues: string[] = [];
  const manifestFile = path.join(resolved, "manifest.json");
  const sqliteFile = path.join(resolved, "ibmi-docs.sqlite");
  if (!fsSync.existsSync(manifestFile)) issues.push("Falta manifest.json");
  if (!fsSync.existsSync(sqliteFile)) issues.push("Falta ibmi-docs.sqlite");
  let corpusVersion: string | undefined;
  let generatedAt: string | undefined;
  let documents: number | undefined;
  if (fsSync.existsSync(manifestFile)) {
    try {
      const raw = await fs.readFile(manifestFile, "utf8");
      const manifest = JSON.parse(raw) as { corpusVersion?: string; generatedAt?: string; documents?: unknown[] };
      if (containsLoopbackEndpoint(manifest)) {
        issues.push("El manifest contiene referencias loopback/RDi temporales no aptas para runtime.");
      }
      corpusVersion = manifest.corpusVersion;
      generatedAt = manifest.generatedAt;
      documents = manifest.documents?.length ?? 0;
      if (!documents) issues.push("El manifest no contiene documentos.");
      for (const doc of manifest.documents ?? []) {
        // El HTML original es un artefacto de trazabilidad del repositorio y
        // de los data packs de archivo. El runtime npm necesita SQLite y texto
        // normalizado; por ello solo este último es obligatorio al verificar
        // una instalación final.
        for (const key of ["normalizedTextPath"] as const) {
          const relative = String((doc as any)[key] ?? "");
          if (!relative) {
            issues.push(`Documento sin ${key}: ${(doc as any).id ?? "(sin id)"}`);
            continue;
          }
          try {
            resolveContainedExistingPath(resolved, relative);
          } catch (error) {
            issues.push(`Ruta inválida para ${(doc as any).id ?? "(sin id)"} (${key}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } catch (error) {
      issues.push(`No se pudo leer/parsear manifest.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (fsSync.existsSync(sqliteFile)) {
    validateSqlitePack(resolved, sqliteFile, documents, issues);
  }
  return { packDir: resolved, ok: issues.length === 0, corpusVersion, documents, generatedAt, issues };
}

export async function listCandidatePacks(rootDir: string): Promise<DataPackInfo[]> {
  const root = path.resolve(rootDir);
  if (!fsSync.existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  if (hasPack(root)) dirs.unshift(root);
  const uniqueDirs = [...new Set(dirs)];
  return Promise.all(uniqueDirs.map((dir) => verifyDataPack(dir)));
}

export async function lintContribution(inputDir: string): Promise<{ ok: boolean; inputDir: string; issues: string[]; hints: string[] }> {
  const resolved = path.resolve(inputDir);
  const issues: string[] = [];
  const hints: string[] = [];
  const manifestFile = path.join(resolved, "manifest.json");
  if (!fsSync.existsSync(manifestFile)) {
    issues.push("Falta manifest.json en la raíz de la contribución.");
  } else {
    const raw = await fs.readFile(manifestFile, "utf8");
    const manifest = JSON.parse(raw) as { documents?: Array<{ id?: string; title?: string; rawHtmlPath?: string; normalizedTextPath?: string; sha256?: string }> };
    if (containsLoopbackEndpoint(manifest)) {
      issues.push("No incluyas endpoints locales/RDi en contribuciones redistribuibles.");
    }
    const ids = new Set<string>();
    for (const doc of manifest.documents ?? []) {
      if (!doc.id || !doc.title) issues.push(`Documento incompleto: ${JSON.stringify(doc).slice(0, 120)}`);
      if (doc.id && ids.has(doc.id)) issues.push(`ID duplicado: ${doc.id}`);
      if (doc.id) ids.add(doc.id);
      for (const key of ["rawHtmlPath", "normalizedTextPath"] as const) {
        const value = doc[key];
        if (value) {
          try {
            const file = resolveContainedPath(resolved, value);
            if (!fsSync.existsSync(file)) issues.push(`Archivo faltante para ${doc.id}: ${value}`);
          } catch (error) {
            issues.push(`Ruta inválida para ${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (!doc.sha256) hints.push(`Considera incluir sha256 para ${doc.id ?? doc.title}.`);
    }
    if ((manifest.documents ?? []).length < 1) issues.push("La contribución no contiene documentos.");
  }
  return {
    ok: issues.length === 0,
    inputDir: resolved,
    issues,
    hints: [...new Set([
      ...hints,
      "Incluye raw HTML, texto normalizado, metadatos, hashes y licencia/procedencia clara.",
      "No agregues contenido exclusivo de RDi/Eclipse UI si no aporta a IBM i runtime/desarrollo."
    ])]
  };
}

/**
 * Revisa únicamente propiedades que representan URLs o endpoints. Buscar el
 * puerto en el JSON serializado completo producía falsos positivos cuando un
 * hash o nombre de archivo contenía casualmente la secuencia 52070.
 */
function containsLoopbackEndpoint(value: unknown, key = ""): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsLoopbackEndpoint(item, key));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsLoopbackEndpoint(childValue, childKey)
    );
  }
  if (typeof value !== "string" || !/(?:url|endpoint)$/i.test(key)) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return /(?:^|\/)localhost(?::\d+)?(?:\/|$)|127\.0\.0\.1(?::\d+)?|\[?::1\]?(?::\d+)?/i.test(value);
  }
}

async function materializeSource(source: string): Promise<MaterializedSource> {
  if (/^https?:\/\//i.test(source)) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-docs-pack-"));
    const file = path.join(tempRoot, path.basename(new URL(source).pathname) || "pack.tgz");
    try {
      const { contentType } = await downloadFileWithTimeout(source, file, {
        timeoutMs: DEFAULT_PACK_DOWNLOAD_TIMEOUT_MS,
        maxBytes: DEFAULT_PACK_DOWNLOAD_MAX_BYTES
      });
      if (!isLikelyArchiveDownload(source, contentType)) {
        throw new Error(`La URL no parece entregar un archivo tar/tgz válido: content-type=${contentType || "n/a"}`);
      }
      return { path: file, cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }) };
    } catch (error) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }
  const local = path.resolve(source);
  if (!fsSync.existsSync(local)) throw new Error(`No existe la fuente de data pack: ${local}`);
  return { path: local, cleanup: async () => undefined };
}

function validateSqlitePack(packDir: string, sqliteFile: string, manifestDocuments: number | undefined, issues: string[]): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(sqliteFile, { readonly: true, fileMustExist: true });
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity.toLowerCase() !== "ok") issues.push(`SQLite integrity_check falló: ${integrity}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of REQUIRED_SQLITE_TABLES) {
      if (!tables.has(table)) issues.push(`SQLite sin tabla requerida: ${table}`);
    }
    if (tables.has("documents")) {
      const row = db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number };
      if (manifestDocuments !== undefined && manifestDocuments !== row.count) {
        issues.push(`Conteo inconsistente: manifest=${manifestDocuments}, sqlite.documents=${row.count}`);
      }
      const documentPaths = db.prepare("SELECT id, normalized_text_path FROM documents").all() as Array<{ id: string; normalized_text_path: string }>;
      for (const document of documentPaths) {
        try {
          resolveContainedExistingPath(packDir, String(document.normalized_text_path ?? ""));
        } catch (error) {
          issues.push(`Ruta normalizada inválida en SQLite para ${document.id}: ${error instanceof Error ? error.message : String(error)}`);
          if (issues.length >= 100) break;
        }
      }
    }
    if (tables.has("chunks") && tables.has("chunk_vectors")) {
      const chunks = Number((db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count);
      const vectors = Number((db.prepare("SELECT COUNT(*) AS count FROM chunk_vectors").get() as { count: number }).count);
      if (chunks !== vectors) issues.push(`Cobertura vectorial incompleta: chunks=${chunks}, chunk_vectors=${vectors}`);
    }
    if (tables.has("documents") && tables.has("document_vectors")) {
      const documentCount = Number((db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count);
      const vectorCount = Number((db.prepare("SELECT COUNT(*) AS count FROM document_vectors").get() as { count: number }).count);
      if (documentCount !== vectorCount) issues.push(`Cobertura vectorial de documentos incompleta: documents=${documentCount}, document_vectors=${vectorCount}`);
    }
    if (tables.has("meta")) {
      const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get("manifest") as { value: string } | undefined;
      if (!meta?.value) issues.push("SQLite meta no contiene manifest.");
      else JSON.parse(meta.value);
    }
  } catch (error) {
    issues.push(`SQLite inválido: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db?.close();
  }
}

async function extractArchiveSafely(source: string, outDir: string): Promise<void> {
  await tar.x({
    file: source,
    cwd: outDir,
    gzip: source.endsWith(".tgz") || source.endsWith(".gz"),
    filter: (entryPath, entry) => {
      if (!isSafeArchivePath(entryPath)) throw new Error(`Entrada insegura en archivo tar: ${entryPath}`);
      const entryType = String((entry as { type?: string }).type ?? "");
      if (entryType === "SymbolicLink" || entryType === "Link") throw new Error(`Links no permitidos en data pack: ${entryPath}`);
      return true;
    }
  });
}

function isSafeArchivePath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, "/");
  if (!normalized || normalized === ".") return true;
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return false;
  const clean = path.posix.normalize(normalized);
  return clean !== ".." && !clean.startsWith("../") && !clean.includes("/../");
}

async function replaceDirectoryAtomically(sourceDir: string, targetDir: string): Promise<void> {
  let backupDir: string | undefined;
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  if (fsSync.existsSync(targetDir)) {
    backupDir = await fs.mkdtemp(path.join(path.dirname(targetDir), `.${path.basename(targetDir)}-backup-`));
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.rename(targetDir, backupDir);
  }
  try {
    await fs.rename(sourceDir, targetDir);
  } catch (error) {
    if (backupDir && !fsSync.existsSync(targetDir) && fsSync.existsSync(backupDir)) {
      await fs.rename(backupDir, targetDir);
    }
    throw error;
  }
  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch((error) => {
      console.warn(`Data pack instalado, pero no se pudo limpiar el backup ${backupDir}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function isLikelyArchiveDownload(source: string, contentType: string): boolean {
  if (/\.(tgz|tar|tar\.gz|gz)$/i.test(new URL(source).pathname)) return true;
  return /gzip|tar|octet-stream|x-gtar|x-tar/i.test(contentType);
}
