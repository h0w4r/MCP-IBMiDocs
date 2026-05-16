import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type { CorpusManifest, DocumentRecord, TocNodeRecord } from "../types.js";
import { ensureSafeFileName, nowIso, sha256, toPosixPath, unique } from "../util/common.js";
import { extractDocumentContent, inferCategory } from "../util/html.js";

interface ExportRdiOptions {
  baseUrl: string;
  outDir: string;
  maxTopics?: number;
  concurrency?: number;
}

interface XmlNode {
  id?: string;
  title?: string;
  href?: string;
  image?: string;
  is_leaf?: string | boolean;
  node?: XmlNode | XmlNode[];
}

const DEFAULT_TOC_ROOTS = ["/com.ibm.iseries.xd.ref.doc/ref_map.xml"];

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", allowBooleanAttributes: true });

export async function exportRdiHelp(options: ExportRdiOptions): Promise<CorpusManifest> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const outDir = path.resolve(options.outDir);
  const rawDir = path.join(outDir, "raw");
  const normalizedDir = path.join(outDir, "normalized");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });

  const tocNodes = await discoverRdiToc(baseUrl, options.maxTopics ?? 30000);
  const hrefs = unique(tocNodes.map((node) => node.href).filter((href) => href.includes("../topic/") && !href.includes("../nav/")));
  const limit = pLimit(options.concurrency ?? 8);
  const documents: DocumentRecord[] = [];
  const failures: string[] = [];
  const seenCanonical = new Set<string>();

  await Promise.all(
    hrefs.map((href) =>
      limit(async () => {
        const canonicalPath = normalizeRdiTopicPath(href);
        if (!canonicalPath || seenCanonical.has(canonicalPath)) return;
        seenCanonical.add(canonicalPath);
        const topicUrl = `${baseUrl}/topic/${canonicalPath}`;
        const tocNode = tocNodes.find((node) => normalizeRdiTopicPath(node.href) === canonicalPath);
        try {
          const html = await fetchText(topicUrl);
          const extracted = extractDocumentContent(html);
          if (!extracted.text || isExcludedRdiTopic(tocNode, extracted, canonicalPath)) return;
          const digest = sha256(html);
          const id = `rdi-${digest.slice(0, 16)}`;
          const fileBase = ensureSafeFileName(`${id}-${extracted.title || tocNode?.title || "topic"}`);
          const rawPath = path.join(rawDir, `${fileBase}.html`);
          const textPath = path.join(normalizedDir, `${fileBase}.txt`);
          await fs.writeFile(rawPath, html, "utf8");
          await fs.writeFile(textPath, extracted.text, "utf8");
          documents.push({
            id,
            sourceKind: "rdi-local-export",
            sourceId: "rdi-help-bootstrap",
            originalUrl: topicUrl,
            canonicalUrl: `rdi-help:${canonicalPath}`,
            title: extracted.title || tocNode?.title || canonicalPath,
            breadcrumbs: tocNode?.path?.length ? tocNode.path : extracted.breadcrumbs,
            product: extracted.product || "IBM i",
            version: extracted.version || "RDi-local",
            language: extracted.language || "en-us",
            category: inferCategory({ title: extracted.title || tocNode?.title || "", path: tocNode?.path, url: canonicalPath, text: extracted.text }),
            rawHtmlPath: toPosixPath(path.relative(outDir, rawPath)),
            normalizedTextPath: toPosixPath(path.relative(outDir, textPath)),
            sha256: digest,
            textLength: extracted.text.length,
            collectedAt: nowIso()
          });
        } catch (error) {
          failures.push(`${topicUrl} :: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    )
  );

  const manifest: CorpusManifest = {
    schemaVersion: 1,
    corpusVersion: `rdi-bootstrap-${new Date().toISOString().slice(0, 10)}`,
    generatedAt: nowIso(),
    description: "Snapshot exportado desde Eclipse/RDi Help local solo durante la construcción del corpus; no es una dependencia runtime.",
    sources: [
      {
        id: "rdi-help-bootstrap",
        kind: "rdi-local-export",
        name: "RDi/Eclipse Help local bootstrap",
        baseUrl,
        exportedAt: nowIso(),
        documentCount: documents.length,
        failedCount: failures.length,
        notes: [
          "Fuente temporal de desarrollo: no usar en runtime, instalación ni sync del MCP público.",
          `TOC nodes descubiertos: ${tocNodes.length}`,
          ...failures.slice(0, 25)
        ]
      }
    ],
    documents: documents.sort((a, b) => a.title.localeCompare(b.title)),
    coverage: summarizeCoverage(documents, failures.length)
  };

  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function discoverRdiToc(baseUrl: string, maxNodes: number): Promise<TocNodeRecord[]> {
  const rootXml = await fetchXml(`${baseUrl}/advanced/tocfragment`);
  const roots = nodesFromTree(rootXml).filter((node) => DEFAULT_TOC_ROOTS.includes(node.id ?? ""));
  const discovered = new Map<string, TocNodeRecord>();
  const queue: Array<{ tocId: string; pathId?: string; lineage: string[] }> = roots.map((root) => ({ tocId: root.id ?? "", lineage: [root.title ?? "IBM i programming resources"] }));
  const requested = new Set<string>();

  while (queue.length && discovered.size < maxNodes) {
    const item = queue.shift()!;
    const key = `${item.tocId}::${item.pathId ?? ""}`;
    if (requested.has(key)) continue;
    requested.add(key);
    const url = `${baseUrl}/advanced/tocfragment?toc=${encodeURIComponent(item.tocId)}${item.pathId ? `&path=${encodeURIComponent(item.pathId)}` : ""}`;
    const parsed = await fetchXml(url);
    const rootNodes = nodesFromTree(parsed);
    for (const root of rootNodes) {
      collectNodes(root, item.tocId, [], discovered, queue);
    }
  }

  return [...discovered.values()];
}

function collectNodes(node: XmlNode, tocId: string, parentPath: string[], out: Map<string, TocNodeRecord>, queue: Array<{ tocId: string; pathId?: string; lineage: string[] }>): void {
  const title = String(node.title ?? "").trim();
  const id = String(node.id ?? "").trim();
  const href = String(node.href ?? "").trim();
  const pathParts = [...parentPath, title].filter(Boolean);
  const isLeaf = node.is_leaf === true || node.is_leaf === "true";
  if (id || href) {
    const key = `${tocId}::${id || href}`;
    out.set(key, { id, title, href, path: pathParts, tocId, isLeaf });
  }
  if (id && !isLeaf && !id.startsWith("/") && /^[0-9_]+$/.test(id)) {
    queue.push({ tocId, pathId: id, lineage: pathParts });
  }
  for (const child of asArray(node.node)) collectNodes(child, tocId, pathParts, out, queue);
}

function nodesFromTree(parsed: unknown): XmlNode[] {
  const tree = parsed as { tree_data?: { node?: XmlNode | XmlNode[] } };
  return asArray(tree.tree_data?.node);
}

function normalizeRdiTopicPath(href: string): string {
  const topicIndex = href.indexOf("../topic/");
  if (topicIndex < 0) return "";
  let topic = href.slice(topicIndex + "../topic/".length);
  topic = topic.replace(/^\.\.\//, "");
  topic = topic.split("#")[0] ?? topic;
  topic = topic.split("?")[0] ?? topic;
  return topic.replace(/^\/+/, "");
}

function isExcludedRdiTopic(tocNode: TocNodeRecord | undefined, extracted: { title: string; breadcrumbs: string[]; text: string }, canonicalPath: string): boolean {
  const haystack = `${canonicalPath} ${tocNode?.path.join(" ") ?? ""} ${extracted.title} ${extracted.breadcrumbs.join(" ")}`.toLowerCase();
  // Se conserva documentación de programación IBM i; se descarta UI/IDE/Eclipse genérico.
  if (haystack.includes("eclipseinfo") || haystack.includes("org.eclipse")) return true;
  if (haystack.includes("install") && !haystack.includes("compiler")) return true;
  if (haystack.includes("workbench") && !haystack.includes("rpg") && !haystack.includes("ibm i")) return true;
  return extracted.text.trim().length < 80;
}

async function fetchXml(url: string): Promise<unknown> {
  const text = await fetchText(url);
  return xmlParser.parse(text);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "ibmi-docs-mcp-builder/0.1" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function summarizeCoverage(documents: DocumentRecord[], failedCount: number): Record<string, unknown> {
  const byCategory: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  for (const doc of documents) {
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
    byVersion[doc.version] = (byVersion[doc.version] ?? 0) + 1;
  }
  return { documentCount: documents.length, failedCount, byCategory, byVersion };
}
