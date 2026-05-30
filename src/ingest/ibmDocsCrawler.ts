import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { CorpusManifest, DocumentRecord } from "../types.js";
import { ensureSafeFileName, nowIso, sha256, toPosixPath } from "../util/common.js";
import { extractDocumentContent, inferCategory, foldForSearch } from "../util/html.js";

interface SyncIbmOptions {
  outDir: string;
  versions?: string[];
  maxPagesPerVersion?: number;
  concurrency?: number;
}

interface IbmTocNode {
  label?: string;
  href?: string;
  topicId?: string;
  topics?: IbmTocNode[];
}

interface PlannedTopic {
  label: string;
  href: string;
  topicId: string;
  breadcrumbs: string[];
}

const DEFAULT_VERSIONS = ["7.3.0", "7.4.0", "7.5.0", "7.6.0"];
const IBM_DOCS_BASE = "https://www.ibm.com/docs";
const USER_AGENT = "ibmi-docs-mcp-builder/0.4 (+community documentation index)";

// Raíces técnicas orientadas a desarrolladores IBM i. Excluimos intencionalmente
// contenido de IDE, Eclipse, instalación de RDi o UI, porque el MCP final será
// consumido desde Codex/otros IDEs y no debe enseñar workflows propios de RDi.
const CORE_PATH_PREFIXES = [
  "ibm i > programming > control language > cl programming",
  "ibm i > programming > commands",
  "ibm i > programming > programming concepts",
  "ibm i > programming > dds",
  "ibm i > programming > ile languages > rpg",
  "ibm i > programming > ile languages > cobol",
  "ibm i > programming > apis",
  "ibm i > programming > messages",
  "ibm i > security > reference",
  "ibm i > database > reference > sql reference",
  "ibm i > database > reference > sql messages and codes",
  "ibm i > database > programming",
  "ibm i > database > performance and query optimization"
];

const CORE_TOPIC_PATTERNS = [
  /\b(command|commands|cl command|crt[a-z0-9]+|chg[a-z0-9]+|dsp[a-z0-9]+|wrk[a-z0-9]+|snd[a-z0-9-]+)\b/i,
  /\b(rpg|rpgle|ile rpg|operation code|built-in function|%[a-z][a-z0-9_-]+)\b/i,
  /\b(clle|control language|monmsg|sndpgmmsg|rtvjoba|crtbndcl)\b/i,
  /\b(dds|physical file|logical file|display file|printer file|keyword)\b/i,
  /\b(sqlrpgle|embedded sql|db2 for i|sql messages|sql codes|crt(sql)?rpgi)\b/i,
  /\b(rnf\d{4}|cpf\d{4}|mch\d{4}|message id|compiler message)\b/i
];

const IMPORTANT_TOPIC_IDS = new Set([
  "rpg-ile-reference",
  "rpg-ile-programmers-guide",
  "language-cl-programming",
  "programming-dds",
  "dds-keyword-finder",
  "dds-concepts",
  "reference-sql",
  "reference-sql-messages-codes",
  "commands-crtrpgmod-command",
  "command-description-crtrpgmod",
  "commands-crtbndrpg-command",
  "commands-crtsqlrpgi-command",
  "commands-crtbndcl-command",
  "commands-crtpf-command",
  "commands-crtlf-command",
  "commands-sndpgmmsg-command",
  "message-snd-msg-send-message-joblog",
  "operation-code-snd-msg-send-message-joblog",
  "built-in-function-msg-message",
  "built-in-function-target",
  "rpg-messages",
  "cl-command-finder",
  "object-using-crtrpgmod-command",
  "strategies-strategy-3-ile-application-using-crtrpgmod"
]);

const EXCLUDED_DOC_TERMS = [
  "rational developer for i",
  "rdi workbench",
  "eclipse workbench",
  "remote system explorer",
  "screen designer",
  "report designer",
  "application diagram",
  "integrated i debugger"
];

export async function syncIbmDocs(options: SyncIbmOptions): Promise<CorpusManifest> {
  const versions = options.versions?.length ? options.versions : DEFAULT_VERSIONS;
  const outDir = path.resolve(options.outDir);
  const rawDir = path.join(outDir, "raw");
  const normalizedDir = path.join(outDir, "normalized");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });

  const allDocuments: DocumentRecord[] = [];
  const failures: string[] = [];
  const tocStats: Record<string, unknown> = {};

  for (const version of versions) {
    const result = await crawlVersion(
      version,
      outDir,
      rawDir,
      normalizedDir,
      options.maxPagesPerVersion ?? 160,
      options.concurrency ?? 5,
      failures
    );
    allDocuments.push(...result.documents);
    tocStats[version] = result.stats;
  }

  const manifest: CorpusManifest = {
    schemaVersion: 1,
    corpusVersion: `ibm-docs-${new Date().toISOString().slice(0, 10)}`,
    generatedAt: nowIso(),
    description: "Snapshot complementario desde IBM Docs público para IBM i; no usa RDi ni endpoints locales.",
    sources: [
      {
        id: "ibm-docs-public",
        kind: "ibm-docs",
        name: "IBM Docs público - IBM i",
        baseUrl: "https://www.ibm.com/docs/en/i",
        exportedAt: nowIso(),
        documentCount: allDocuments.length,
        failedCount: failures.length,
        notes: [
          `Versiones objetivo: ${versions.join(", ")}`,
          "Contenido obtenido desde endpoints públicos de IBM Docs: /api/v1/toc y /api/v1/content.",
          "Selección enfocada en RPG/ILE RPG, CL/CLLE, DDS, SQL/Db2 for i y mensajes SQL.",
          ...failures.slice(0, 30)
        ]
      }
    ],
    documents: allDocuments.sort((a, b) => a.title.localeCompare(b.title)),
    coverage: summarizeCoverage(allDocuments, failures.length, tocStats)
  };

  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function crawlVersion(
  version: string,
  outDir: string,
  rawDir: string,
  normalizedDir: string,
  maxPages: number,
  concurrency: number,
  failures: string[]
): Promise<{ documents: DocumentRecord[]; stats: Record<string, unknown> }> {
  const toc = await fetchIbmToc(version, rawDir);
  const candidates = balanceDeveloperTopics(selectDeveloperTopics(toc), maxPages);
  const limit = pLimit(concurrency);

  const results = await Promise.all(
    candidates.map((topic) => limit(() => fetchIbmTopic(topic, version, outDir, rawDir, normalizedDir, failures)))
  );
  const documents = results.filter((doc): doc is DocumentRecord => Boolean(doc));
  return {
    documents,
    stats: {
      candidateTopics: candidates.length,
      persistedDocuments: documents.length,
      maxPages
    }
  };
}

async function fetchIbmToc(version: string, rawDir: string): Promise<IbmTocNode> {
  const tocUrl = `${IBM_DOCS_BASE}/api/v1/toc/i/${version}`;
  const text = await fetchTextWithRetry(tocUrl, `TOC IBM Docs ${version}`);

  // Guardamos el TOC bruto como evidencia de cobertura y reproducibilidad del snapshot.
  await fs.writeFile(path.join(rawDir, `toc-i-${version}.json`), text, "utf8");
  const parsed = JSON.parse(text) as { toc?: IbmTocNode };
  return parsed.toc ?? (parsed as IbmTocNode);
}

function selectDeveloperTopics(root: IbmTocNode): PlannedTopic[] {
  const selected: PlannedTopic[] = [];

  function walk(node: IbmTocNode, parentPath: string[], inheritedCoreScope: boolean): void {
    const label = cleanLabel(node.label);
    const breadcrumbs = [...parentPath, label].filter(Boolean);
    const pathText = foldForSearch(breadcrumbs.join(" > "));
    const topicId = String(node.topicId ?? "");
    const href = String(node.href ?? "").replace(/#.*$/, "");
    const ownCoreScope = isCoreDeveloperPath(pathText, topicId);
    const inScope = inheritedCoreScope || ownCoreScope || IMPORTANT_TOPIC_IDS.has(topicId);

    if (inScope && href && !isExcludedDoc(breadcrumbs, href, topicId)) {
      selected.push({ label, href, topicId, breadcrumbs });
    }

    for (const child of node.topics ?? []) {
      walk(child, breadcrumbs, inScope);
    }
  }

  walk(root, [], false);
  return dedupePlannedTopics(selected);
}

function isCoreDeveloperPath(pathText: string, topicId: string): boolean {
  if (IMPORTANT_TOPIC_IDS.has(topicId)) return true;
  const haystack = `${pathText} ${foldForSearch(topicId)}`;
  return CORE_PATH_PREFIXES.some((prefix) => pathText.startsWith(prefix))
    || CORE_TOPIC_PATTERNS.some((pattern) => pattern.test(haystack));
}

function isExcludedDoc(breadcrumbs: string[], href: string, topicId: string): boolean {
  const haystack = foldForSearch(`${breadcrumbs.join(" ")} ${href} ${topicId}`);
  return EXCLUDED_DOC_TERMS.some((term) => haystack.includes(term));
}

function dedupePlannedTopics(topics: PlannedTopic[]): PlannedTopic[] {
  const byKey = new Map<string, PlannedTopic>();
  for (const topic of topics) {
    const key = topic.href || topic.topicId;
    if (!byKey.has(key)) byKey.set(key, topic);
  }
  return [...byKey.values()];
}

function balanceDeveloperTopics(topics: PlannedTopic[], maxPages: number): PlannedTopic[] {
  if (topics.length <= maxPages) return topics;

  const selected = new Map<string, PlannedTopic>();
  const buckets = new Map<string, PlannedTopic[]>();
  const important = topics.filter((topic) => IMPORTANT_TOPIC_IDS.has(topic.topicId));

  for (const topic of important) {
    if (selected.size >= maxPages) return [...selected.values()];
    selected.set(topic.href || topic.topicId, topic);
  }

  for (const topic of topics) {
    const key = topic.href || topic.topicId;
    if (selected.has(key)) continue;
    const group = topicGroup(topic);
    const bucket = buckets.get(group) ?? [];
    bucket.push(topic);
    buckets.set(group, bucket);
  }

  // Round-robin por familia documental. Sin esto, el TOC de IBM Docs tiende a
  // capturar primero una rama entera (p. ej. SQL) y deja RPG/CL/DDS fuera del
  // snapshot pequeño. La mezcla es clave para agentes que responden consultas
  // variadas como CRTRPGMOD, CLLE o DDS PF.
  const groupOrder = ["ile-rpg", "cl-clle", "dds", "sql-db2-for-i", "mensajes-sql", "otros"];
  let madeProgress = true;
  while (selected.size < maxPages && madeProgress) {
    madeProgress = false;
    for (const group of groupOrder) {
      const bucket = buckets.get(group);
      const topic = bucket?.shift();
      if (!topic) continue;
      selected.set(topic.href || topic.topicId, topic);
      madeProgress = true;
      if (selected.size >= maxPages) break;
    }
  }

  return [...selected.values()];
}

function topicGroup(topic: PlannedTopic): string {
  const pathText = foldForSearch(topic.breadcrumbs.join(" > "));
  if (pathText.includes("programming > ile languages > rpg")) return "ile-rpg";
  if (pathText.includes("programming > control language > cl programming")) return "cl-clle";
  if (pathText.includes("programming > dds")) return "dds";
  if (pathText.includes("database > reference > sql messages and codes")) return "mensajes-sql";
  if (pathText.includes("database > reference > sql reference")) return "sql-db2-for-i";
  return "otros";
}

async function fetchIbmTopic(
  topic: PlannedTopic,
  version: string,
  outDir: string,
  rawDir: string,
  normalizedDir: string,
  failures: string[]
): Promise<DocumentRecord | null> {
  const candidateUrls = buildContentUrls(topic, version);
  let html = "";
  let contentUrl = "";
  let lastError = "";

  for (const url of candidateUrls) {
    try {
      const text = await fetchTextWithRetry(url, publicTopicUrl(topic, version), 2);
      if (looksLikeIbm404Shell(text)) {
        lastError = "IBM Docs devolvió shell 404";
        continue;
      }
      html = text;
      contentUrl = url;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!html) {
    failures.push(`${publicTopicUrl(topic, version)} :: ${lastError || "sin contenido"}`);
    return null;
  }

  const extracted = extractDocumentContent(html);
  const text = extracted.text;
  if (text.length < 120 || foldForSearch(extracted.title) === "ibm documentation") {
    failures.push(`${publicTopicUrl(topic, version)} :: contenido demasiado corto o shell de IBM Docs`);
    return null;
  }

  const digest = sha256(html);
  const id = stableDocumentId(version, topic, digest);
  const fileBase = ensureSafeFileName(`${id}-${extracted.title || topic.label || "ibm-doc"}`);
  const rawPath = path.join(rawDir, `${fileBase}.html`);
  const textPath = path.join(normalizedDir, `${fileBase}.txt`);
  await fs.writeFile(rawPath, html, "utf8");
  await fs.writeFile(textPath, text, "utf8");

  const title = extracted.title || topic.label || publicTopicUrl(topic, version);
  return {
    id,
    sourceKind: "ibm-docs",
    sourceId: "ibm-docs-public",
    originalUrl: contentUrl,
    canonicalUrl: publicTopicUrl(topic, version),
    title,
    breadcrumbs: topic.breadcrumbs.length ? topic.breadcrumbs : extracted.breadcrumbs,
    product: extracted.product || "IBM i",
    version: version.replace(/\.0$/, ""),
    language: extracted.language || "en-us",
    category: inferCategory({ title, path: topic.breadcrumbs, url: publicTopicUrl(topic, version), text }),
    rawHtmlPath: toPosixPath(path.relative(outDir, rawPath)),
    normalizedTextPath: toPosixPath(path.relative(outDir, textPath)),
    sha256: digest,
    textLength: text.length,
    collectedAt: nowIso()
  };
}

async function fetchTextWithRetry(url: string, label: string, attempts = 3): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`;
      } else {
        return response.text();
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error(`No se pudo leer ${label}: ${lastError || "sin respuesta"}`);
}

function buildContentUrls(topic: PlannedTopic, version: string): string[] {
  const urls: string[] = [];
  if (topic.href) {
    const hrefUrl = new URL(`${IBM_DOCS_BASE}/api/v1/content/${topic.href}`);
    hrefUrl.searchParams.set("parsebody", "true");
    hrefUrl.searchParams.set("lang", "en");
    urls.push(hrefUrl.toString());
  }
  if (topic.topicId) {
    const topicUrl = new URL(`${IBM_DOCS_BASE}/api/v1/content/i/${version}`);
    topicUrl.searchParams.set("topic", topic.topicId);
    topicUrl.searchParams.set("parsebody", "true");
    topicUrl.searchParams.set("lang", "en");
    urls.push(topicUrl.toString());
  }
  return [...new Set(urls)];
}

function publicTopicUrl(topic: PlannedTopic, version: string): string {
  if (topic.topicId) return `${IBM_DOCS_BASE}/en/i/${version}?topic=${encodeURIComponent(topic.topicId)}`;
  return `${IBM_DOCS_BASE}/en/i/${version}`;
}

function stableDocumentId(version: string, topic: PlannedTopic, digest: string): string {
  const naturalKey = ensureSafeFileName(topic.topicId || topic.href || "topic").toLowerCase();
  return `ibm-${version.replace(/\W/g, "")}-${naturalKey.slice(0, 72)}-${digest.slice(0, 8)}`;
}

function cleanLabel(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function looksLikeIbm404Shell(html: string): boolean {
  const haystack = html.slice(0, 2500).toLowerCase();
  return haystack.includes("<title>ibm documentation</title>") && haystack.includes("root_container");
}

function summarizeCoverage(documents: DocumentRecord[], failedCount: number, tocStats: Record<string, unknown>): Record<string, unknown> {
  const byCategory: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  const byDocumentKind: Record<string, number> = {};
  for (const doc of documents) {
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
    byVersion[doc.version] = (byVersion[doc.version] ?? 0) + 1;
    const kind = doc.textLength < 300 ? "stub" : /what'?s new|contents|index|overview/i.test(doc.title) ? "index" : "topic";
    byDocumentKind[kind] = (byDocumentKind[kind] ?? 0) + 1;
  }
  return { documentCount: documents.length, failedCount, byCategory, byVersion, byDocumentKind, tocStats };
}
