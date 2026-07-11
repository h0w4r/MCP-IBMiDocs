import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import pLimit from "p-limit";
import type { CorpusManifest, DocumentRecord, SourceManifest } from "../src/types.js";
import { extractDocumentContent } from "../src/util/html.js";
import { ensureSafeFileName, nowIso, sha256, toPosixPath } from "../src/util/common.js";
import { fetchTextWithTimeout } from "../src/util/fetch.js";

interface Options {
  sourceIndex: string;
  outDir: string;
  versions: string[];
  concurrency: number;
  limit?: number;
}

interface CommandReference {
  fileName: string;
  label: string;
}

const USER_AGENT = "ibmi-docs-mcp-builder/1.0 (+community documentation index)";
const HTTP_TIMEOUT_MS = Number(process.env.IBMI_DOCS_HTTP_TIMEOUT_MS ?? 45_000);
const HTTP_MAX_BYTES = Number(process.env.IBMI_DOCS_HTTP_MAX_BYTES ?? 25 * 1024 * 1024);

/**
 * Amplía el snapshot de construcción con la ayuda pública completa de comandos.
 * El índice archivado procede del bootstrap RDi, pero todas las páginas se
 * descargan de IBM Docs público y el script nunca contacta el endpoint RDi.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const references = (await readCommandReferences(options.sourceIndex)).slice(0, options.limit);
  if (!references.length) throw new Error(`El índice no contiene enlaces de comandos: ${options.sourceIndex}`);
  console.error(`[IBM command bootstrap] comandos=${references.length}; versiones=${options.versions.join(",")}; concurrencia=${options.concurrency}`);

  const outDir = path.resolve(options.outDir);
  const rawDir = path.join(outDir, "raw");
  const normalizedDir = path.join(outDir, "normalized");
  const manifestPath = path.join(outDir, "manifest.json");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });

  const existing = await readManifest(manifestPath);
  const documentsByKey = new Map(existing.documents.map((document) => [documentKey(document), document]));
  const failures: string[] = [];
  let downloaded = 0;
  let reused = 0;
  const limiter = pLimit(options.concurrency);

  for (const version of options.versions) {
    const tasks = references.map((reference) => limiter(async () => {
      const planned = plannedDocument(reference, version, outDir, rawDir, normalizedDir);
      const previous = documentsByKey.get(planned.key);
      if (previous && await documentFilesExist(outDir, previous)) {
        reused += 1;
        return previous;
      }

      try {
        const html = await fetchWithRetry(planned.contentUrl, 3);
        const extracted = extractDocumentContent(html);
        if (extracted.text.length < 120) {
          throw new Error(`contenido insuficiente (${extracted.text.length} caracteres)`);
        }
        await fs.writeFile(planned.rawPath, html, "utf8");
        await fs.writeFile(planned.normalizedPath, extracted.text, "utf8");
        downloaded += 1;
        if (downloaded % 100 === 0) {
          console.error(`[IBM command bootstrap] descargadas=${downloaded}; reutilizadas=${reused}; fallos=${failures.length}`);
        }
        return toDocumentRecord(planned, reference, extracted, html, outDir);
      } catch (error) {
        failures.push(`${version}/${reference.fileName}: ${error instanceof Error ? error.message : String(error)}`);
        return previous;
      }
    }));

    const results = await Promise.all(tasks);
    for (const document of results) {
      if (document) documentsByKey.set(documentKey(document), document);
    }
  }

  const sourceId = "ibm-docs-public-command-reference";
  const source: SourceManifest = {
    id: sourceId,
    kind: "ibm-docs",
    name: "IBM Docs público - referencia completa de comandos IBM i",
    baseUrl: "https://www.ibm.com/docs/en/ssw_ibm_i_76/cl/",
    exportedAt: nowIso(),
    documentCount: [...documentsByKey.values()].filter((document) => document.sourceId === sourceId).length,
    failedCount: failures.length,
    notes: [
      `Versiones descargadas: ${options.versions.join(", ")}`,
      `Comandos descubiertos desde el índice archivado: ${references.length}`,
      "El endpoint RDi no se consulta: el índice archivado solo aporta las rutas y el contenido procede de IBM Docs público.",
      ...failures.slice(0, 50)
    ]
  };
  const sources = [...existing.sources.filter((item) => item.id !== sourceId), source];
  const documents = [...documentsByKey.values()].sort((left, right) => left.title.localeCompare(right.title)
    || left.version.localeCompare(right.version));
  const manifest: CorpusManifest = {
    ...existing,
    generatedAt: nowIso(),
    corpusVersion: `ibm-docs-${new Date().toISOString().slice(0, 10)}`,
    sources,
    documents,
    coverage: {
      ...(existing.coverage ?? {}),
      commandReference: {
        discoveredCommands: references.length,
        requestedVersions: options.versions,
        documents: source.documentCount,
        downloaded,
        reused,
        failures: failures.length
      }
    }
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.error(`Bootstrap IBM command reference completado: ${source.documentCount} documentos; ${failures.length} fallos.`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sourceIndex: path.resolve("data", "rdi-export", "raw", "rdi-716647a8da9beaca-CL-command-finder.html"),
    outDir: path.resolve("data", "ibm-docs-cache"),
    versions: ["7.6.0"],
    concurrency: 5
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--source-index" && next) {
      options.sourceIndex = path.resolve(next);
      index += 1;
    } else if (arg === "--out" && next) {
      options.outDir = path.resolve(next);
      index += 1;
    } else if (arg === "--versions" && next) {
      options.versions = next.split(",").map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--concurrency" && next) {
      options.concurrency = clamp(Number(next), 1, 12, 5);
      index += 1;
    } else if (arg === "--limit" && next) {
      options.limit = clamp(Number(next), 1, 100_000, 100_000);
      index += 1;
    }
  }
  return options;
}

async function readCommandReferences(indexPath: string): Promise<CommandReference[]> {
  const html = await fs.readFile(indexPath, "utf8");
  const $ = load(html);
  const byFile = new Map<string, CommandReference>();
  $("a[href]").each((_, element) => {
    const href = String($(element).attr("href") ?? "").trim();
    const match = href.match(/^\.\.\/cl\/([a-z0-9_.-]+\.html?)$/i);
    if (!match) return;
    const fileName = match[1].toLocaleLowerCase();
    const label = $(element).text().replace(/\s+/g, " ").trim();
    if (!byFile.has(fileName)) byFile.set(fileName, { fileName, label });
  });
  return [...byFile.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function plannedDocument(
  reference: CommandReference,
  version: string,
  outDir: string,
  rawDir: string,
  normalizedDir: string
): {
  id: string;
  key: string;
  contentUrl: string;
  canonicalUrl: string;
  rawPath: string;
  normalizedPath: string;
  version: string;
} {
  // IBM publica 7.6.0 bajo el identificador de producto ssw_ibm_i_76.
  const versionToken = version.split(".").slice(0, 2).join("");
  const productToken = versionToken;
  const commandKey = reference.fileName.replace(/\.html?$/i, "");
  const id = `ibm-${productToken}-cl-command-${ensureSafeFileName(commandKey).toLocaleLowerCase()}`;
  const fileBase = ensureSafeFileName(`${id}-${reference.label || commandKey}`);
  return {
    id,
    key: `${version.replace(/\.0$/, "")}|${reference.fileName}`,
    contentUrl: `https://www.ibm.com/docs/api/v1/content/ssw_ibm_i_${versionToken}/cl/${reference.fileName}?parsebody=true&lang=en`,
    canonicalUrl: `https://www.ibm.com/docs/en/ssw_ibm_i_${versionToken}/cl/${reference.fileName}`,
    rawPath: path.join(rawDir, `${fileBase}.html`),
    normalizedPath: path.join(normalizedDir, `${fileBase}.txt`),
    version: version.replace(/\.0$/, "")
  };
}

function toDocumentRecord(
  planned: ReturnType<typeof plannedDocument>,
  reference: CommandReference,
  extracted: ReturnType<typeof extractDocumentContent>,
  html: string,
  outDir: string
): DocumentRecord {
  const title = extracted.title || reference.label || reference.fileName;
  return {
    id: planned.id,
    sourceKind: "ibm-docs",
    sourceId: "ibm-docs-public-command-reference",
    originalUrl: planned.contentUrl,
    canonicalUrl: planned.canonicalUrl,
    title,
    breadcrumbs: ["IBM i", "Programming", "Control language", "Command reference", title],
    product: "IBM i",
    version: planned.version,
    language: extracted.language || "en-us",
    category: "cl-clle",
    rawHtmlPath: toPosixPath(path.relative(outDir, planned.rawPath)),
    normalizedTextPath: toPosixPath(path.relative(outDir, planned.normalizedPath)),
    sha256: sha256(html),
    textLength: extracted.text.length,
    collectedAt: nowIso()
  };
}

function documentKey(document: DocumentRecord): string {
  // Solo la referencia de comandos tiene una clave natural version+archivo.
  // Los tópicos normales de IBM Docs suelen compartir pathname y distinguirse
  // por ?topic=..., por lo que reducirlos al basename colapsaría documentos.
  if (document.sourceId === "ibm-docs-public-command-reference") {
    const fileName = path.basename(new URL(document.canonicalUrl, "https://www.ibm.com").pathname).toLocaleLowerCase();
    return `${document.version}|${fileName}`;
  }
  return `document:${document.id}`;
}

async function documentFilesExist(outDir: string, document: DocumentRecord): Promise<boolean> {
  try {
    await Promise.all([
      fs.access(path.join(outDir, document.rawHtmlPath)),
      fs.access(path.join(outDir, document.normalizedTextPath))
    ]);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(manifestPath: string): Promise<CorpusManifest> {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8")) as CorpusManifest;
  } catch {
    return {
      schemaVersion: 1,
      corpusVersion: `ibm-docs-${new Date().toISOString().slice(0, 10)}`,
      generatedAt: nowIso(),
      description: "Snapshot complementario desde IBM Docs público para IBM i.",
      sources: [],
      documents: [],
      coverage: {}
    };
  }
}

async function fetchWithRetry(url: string, attempts: number): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchTextWithTimeout(url, {
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: HTTP_TIMEOUT_MS,
        maxBytes: HTTP_MAX_BYTES
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw new Error(lastError || "sin respuesta");
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}

await main();
