import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { hasPack } from "../util/paths.js";

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

export async function installDataPack(options: InstallDataPackOptions): Promise<{ outDir: string; source: string }> {
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const source = await materializeSource(options.from);

  // Si la fuente ya es un directorio de pack, copiamos tal cual; si es tgz/tar, extraemos en el destino.
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    if (!hasPack(source)) throw new Error(`El directorio fuente no parece un data pack válido: ${source}`);
    await fs.cp(source, outDir, { recursive: true, force: true });
  } else {
    await tar.x({ file: source, cwd: outDir, gzip: source.endsWith(".tgz") || source.endsWith(".gz") });
  }

  if (!hasPack(outDir)) throw new Error(`La instalación terminó, pero ${outDir} no contiene manifest.json e ibmi-docs.sqlite.`);
  return { outDir, source };
}

export async function installLatestDataPack(options: InstallLatestDataPackOptions): Promise<{ outDir: string; source: string; latestUrl: string }> {
  const latestUrl = options.url ?? process.env.IBMI_DOCS_PACK_LATEST_URL ?? DEFAULT_PACK_RELEASE_URL;
  const result = await installDataPack({ from: latestUrl, outDir: options.outDir });
  return { ...result, latestUrl };
}

export async function archiveDataPack(options: ArchiveDataPackOptions): Promise<{ outFile: string }> {
  const packDir = path.resolve(options.packDir);
  if (!hasPack(packDir)) throw new Error(`No se puede archivar un pack inválido: ${packDir}`);
  const outFile = path.resolve(options.outFile);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await tar.c({ gzip: true, cwd: packDir, file: outFile }, ["."]);
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
    const raw = await fs.readFile(manifestFile, "utf8");
    if (/127\.0\.0\.1|localhost|52070/i.test(raw)) issues.push("El manifest contiene referencias loopback/RDi temporales no aptas para runtime.");
    const manifest = JSON.parse(raw) as { corpusVersion?: string; generatedAt?: string; documents?: unknown[] };
    corpusVersion = manifest.corpusVersion;
    generatedAt = manifest.generatedAt;
    documents = manifest.documents?.length ?? 0;
    if (!documents) issues.push("El manifest no contiene documentos.");
    for (const doc of manifest.documents ?? []) {
      for (const key of ["rawHtmlPath", "normalizedTextPath"] as const) {
        const relative = String((doc as any)[key] ?? "");
        if (!relative) {
          issues.push(`Documento sin ${key}: ${(doc as any).id ?? "(sin id)"}`);
          continue;
        }
        if (!fsSync.existsSync(path.join(resolved, relative))) issues.push(`Archivo faltante para ${(doc as any).id ?? "(sin id)"}: ${relative}`);
      }
    }
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
    if (/127\.0\.0\.1|localhost|52070/i.test(raw)) issues.push("No incluyas endpoints locales/RDi en contribuciones redistribuibles.");
    const manifest = JSON.parse(raw) as { documents?: Array<{ id?: string; title?: string; rawHtmlPath?: string; normalizedTextPath?: string; sha256?: string }> };
    const ids = new Set<string>();
    for (const doc of manifest.documents ?? []) {
      if (!doc.id || !doc.title) issues.push(`Documento incompleto: ${JSON.stringify(doc).slice(0, 120)}`);
      if (doc.id && ids.has(doc.id)) issues.push(`ID duplicado: ${doc.id}`);
      if (doc.id) ids.add(doc.id);
      for (const key of ["rawHtmlPath", "normalizedTextPath"] as const) {
        const value = doc[key];
        if (value && !fsSync.existsSync(path.join(resolved, value))) issues.push(`Archivo faltante para ${doc.id}: ${value}`);
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

async function materializeSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`No se pudo descargar ${source}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-docs-pack-")), path.basename(new URL(source).pathname) || "pack.tgz");
    await fs.writeFile(file, buffer);
    return file;
  }
  const local = path.resolve(source);
  if (!fsSync.existsSync(local)) throw new Error(`No existe la fuente de data pack: ${local}`);
  return local;
}
