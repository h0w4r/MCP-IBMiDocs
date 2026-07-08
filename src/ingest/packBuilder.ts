import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

interface DerivedDocumentPayload {
  doc: DocumentRecord;
  html: string;
  text: string;
}

interface DerivedReferenceBundleDefinition {
  id: string;
  title: string;
  description: string;
  category: string;
  concepts: string[];
  intents: string[];
  entries: Array<{ term: string; meaning: string }>;
}

export async function buildDataPack(options: BuildPackOptions): Promise<CorpusManifest> {
  const inputDir = path.resolve(options.inputDir);
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const manifests = await loadInputManifests(inputDir);
  const sourceDocuments = dedupeDocuments(manifests.flatMap((manifest) => manifest.documents.map(sanitizeDocumentForRuntime)));
  const derivedDocuments = await buildDerivedSemanticDocuments(inputDir, manifests);
  const allSourceDocuments = dedupeDocuments([...sourceDocuments, ...derivedDocuments.map((item) => item.doc)]);
  const documents = allSourceDocuments.map(withPortablePackPaths);
  const derivedById = new Map(derivedDocuments.map((item) => [item.doc.id, item]));
  const effectiveSources = [
    ...manifests.flatMap((manifest) => manifest.sources.map(sanitizeSourceForRuntime)),
    ...(derivedDocuments.length ? [buildDerivedSourceManifest(derivedDocuments.length)] : [])
  ];
  const effectiveManifests = derivedDocuments.length
    ? [
      ...manifests,
      {
        schemaVersion: 1 as const,
        corpusVersion: "derived-semantic-docs",
        generatedAt: nowIso(),
        description: "Documentos semánticos derivados de índices oficiales incluidos en el data pack.",
        sources: [buildDerivedSourceManifest(derivedDocuments.length)],
        documents: derivedDocuments.map((item) => item.doc),
        coverage: {}
      }
    ]
    : manifests;
  const merged: CorpusManifest = {
    schemaVersion: 1,
    corpusVersion: `ibmi-docs-pack-${new Date().toISOString().slice(0, 10)}`,
    generatedAt: nowIso(),
    description: "Data pack local completo para MCP IBM i Docs. Runtime independiente de RDi/Eclipse Help.",
    sources: effectiveSources,
    documents,
    coverage: buildCoverage(documents, effectiveManifests)
  };

  await copyDocumentFiles(manifests, inputDir, outDir, sourceDocuments, documents);
  await writeDerivedDocumentFiles(outDir, documents, derivedById);
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(merged, null, 2), "utf8");
  await buildSqlite(path.join(outDir, "ibmi-docs.sqlite"), outDir, documents, merged);
  return merged;
}

function buildDerivedSourceManifest(documentCount: number): SourceManifest {
  return {
    id: "derived-semantic-docs",
    kind: "manual-pack",
    name: "IBM i semantic retrieval bundles derived from official corpus",
    baseUrl: "ibmi-docs-derived://semantic-bundles",
    exportedAt: nowIso(),
    documentCount,
    failedCount: 0,
    notes: [
      "Documentos generados durante build desde textos oficiales ya incluidos en el corpus local.",
      "No consultan RDi/Eclipse Help ni endpoints externos en runtime.",
      "Su objetivo es mejorar recuperación semántica vectorial para agentes cuando la ayuda oficial agrupa comandos, opcodes, keywords o conceptos en índices largos."
    ]
  };
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

async function writeDerivedDocumentFiles(
  outDir: string,
  targetDocuments: DocumentRecord[],
  derivedById: Map<string, DerivedDocumentPayload>
): Promise<void> {
  for (const targetDoc of targetDocuments) {
    const derived = derivedById.get(targetDoc.id);
    if (!derived) continue;
    const rawTarget = resolveContainedPath(outDir, targetDoc.rawHtmlPath);
    const normalizedTarget = resolveContainedPath(outDir, targetDoc.normalizedTextPath);
    await fs.mkdir(path.dirname(rawTarget), { recursive: true });
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    await fs.writeFile(rawTarget, derived.html, "utf8");
    await fs.writeFile(normalizedTarget, derived.text, "utf8");
  }
}

async function buildDerivedSemanticDocuments(inputDir: string, manifests: CorpusManifest[]): Promise<DerivedDocumentPayload[]> {
  const commandFinder = await loadCommandFinderIndex(inputDir, manifests);
  const builtAt = nowIso();
  const commandGroups = commandFinder
    ? commandGroupDefinitions()
      .map((group) => buildCommandGroupDocument(group, parseCommandIndex(commandFinder.text), commandFinder, builtAt))
      .filter((item): item is DerivedDocumentPayload => Boolean(item))
    : [];
  const referenceBundles = await buildReferenceBundleDocuments(inputDir, manifests, builtAt);
  return [...commandGroups, ...referenceBundles];
}

async function loadCommandFinderIndex(inputDir: string, manifests: CorpusManifest[]): Promise<{ doc: DocumentRecord; text: string } | undefined> {
  const candidates = manifests
    .flatMap((manifest) => manifest.documents.map((doc) => ({ manifest, doc })))
    .filter(({ doc }) => /cl command finder|ibm i commands/i.test(doc.title))
    .sort((a, b) => {
      const aScore = /cl command finder/i.test(a.doc.title) ? 0 : 1;
      const bScore = /cl command finder/i.test(b.doc.title) ? 0 : 1;
      return aScore - bScore || a.doc.title.localeCompare(b.doc.title);
    });

  for (const { manifest, doc } of candidates) {
    const root = sourceRootForDocument(inputDir, doc, manifest);
    const normalizedPath = resolveContainedPath(root, doc.normalizedTextPath);
    try {
      const text = await fs.readFile(normalizedPath, "utf8");
      if (text.length > 1000) return { doc, text };
    } catch {
      // Si un índice candidato no está disponible, probamos el siguiente.
    }
  }
  return undefined;
}

function parseCommandIndex(text: string): Map<string, { command: string; description: string; raw: string }> {
  const commands = new Map<string, { command: string; description: string; raw: string }>();
  const pattern = /\b([A-Z][A-Z0-9]{2,11})\s+\(([^)\n]{3,160})\)\s+command\b/g;
  for (const match of text.matchAll(pattern)) {
    const command = (match[1] ?? "").trim().toUpperCase();
    const description = normalizeWhitespace(match[2] ?? "");
    if (!command || !description) continue;
    commands.set(command, { command, description, raw: normalizeWhitespace(match[0] ?? "") });
  }
  return commands;
}

async function buildReferenceBundleDocuments(
  inputDir: string,
  manifests: CorpusManifest[],
  collectedAt: string
): Promise<DerivedDocumentPayload[]> {
  const sourceTexts = await loadNormalizedSourceTexts(inputDir, manifests);
  return referenceBundleDefinitions()
    .map((bundle) => buildReferenceBundleDocument(bundle, sourceTexts, collectedAt))
    .filter((item): item is DerivedDocumentPayload => Boolean(item));
}

async function loadNormalizedSourceTexts(
  inputDir: string,
  manifests: CorpusManifest[]
): Promise<Array<{ doc: DocumentRecord; text: string }>> {
  const loaded: Array<{ doc: DocumentRecord; text: string }> = [];
  for (const manifest of manifests) {
    for (const doc of manifest.documents) {
      const root = sourceRootForDocument(inputDir, doc, manifest);
      const normalizedPath = resolveContainedPath(root, doc.normalizedTextPath);
      try {
        const text = await fs.readFile(normalizedPath, "utf8");
        loaded.push({ doc, text });
      } catch {
        // Algunos manifests históricos pueden apuntar a documentos auxiliares ausentes.
        // Se omiten para no romper el build de un pack válido por una referencia secundaria.
      }
    }
  }
  return loaded;
}

function referenceBundleDefinitions(): DerivedReferenceBundleDefinition[] {
  return [
    {
      id: "ile-rpg-operation-codes",
      title: "ILE RPG operation codes, indicators and string operations",
      description: "Tópico semántico derivado para recuperar opcodes RPG, indicadores y operaciones frecuentes cuando la consulta llega como pregunta natural.",
      category: "ile-rpg",
      concepts: [
        "RPG operation code", "RPG opcode", "fixed form RPG", "free form RPG",
        "indicator LR", "file positioning", "display file input output", "string concatenation",
        "variable length field", "program return"
      ],
      intents: [
        "What does EXFMT do in RPG?",
        "What is SETLL used for?",
        "How do I concatenate strings in RPG?",
        "What is the difference between RETURN and LR?",
        "What is VARYING in RPG?",
        "How does RPG position a file before reading?"
      ],
      entries: [
        { term: "SETLL", meaning: "Set Lower Limit; positions a file to a key or limit before subsequent read operations." },
        { term: "SETGT", meaning: "Set Greater Than; positions a keyed file after a key value." },
        { term: "CHAIN", meaning: "Random retrieval from a file by key or relative record number." },
        { term: "READE", meaning: "Read equal key records after file positioning." },
        { term: "READPE", meaning: "Read prior equal key records after file positioning." },
        { term: "EXFMT", meaning: "Write a display format and then read the same format, commonly used for interactive display files." },
        { term: "WRITE", meaning: "Writes a record or display format." },
        { term: "READ", meaning: "Reads the next record or input from a format." },
        { term: "CAT", meaning: "Legacy concatenate operation code for joining character strings." },
        { term: "*CAT", meaning: "CL/RPG-style concatenation operator used to concatenate strings." },
        { term: "RETURN", meaning: "Returns control from a program or procedure." },
        { term: "*INLR", meaning: "Last-record indicator commonly used by RPG programs to end and close resources." },
        { term: "SETON LR", meaning: "Legacy pattern for setting the LR indicator on." },
        { term: "VARYING", meaning: "Variable-length alphanumeric/graphic field support in RPG definitions." },
        { term: "%FOUND", meaning: "Built-in function used to test whether operations such as SETLL or CHAIN found a record." },
        { term: "%LEN", meaning: "Built-in function that returns current or maximum length, including varying-length fields." }
      ]
    },
    {
      id: "cl-commands-variables-messages",
      title: "CL commands, variables, labels, messages and database overrides",
      description: "Tópico semántico derivado para consultas CL sobre variables, comandos de mensajes, etiquetas, overrides y apertura lógica de archivos.",
      category: "cl-clle",
      concepts: [
        "CL command", "CL variable declaration", "CL logical variable", "CL decimal variable",
        "CL label", "program message", "user message", "database file override", "open query file"
      ],
      intents: [
        "What variable types are available in CL?",
        "How do I send a message from CL?",
        "What is a command label?",
        "What command is required before OPNQRYF?",
        "What does OVRDBF stand for?",
        "How do I concatenate strings in CL?"
      ],
      entries: [
        { term: "DCL", meaning: "Declares CL variables and their type, length and optional initial value." },
        { term: "TYPE(*CHAR)", meaning: "Character CL variable type." },
        { term: "TYPE(*DEC)", meaning: "Packed decimal CL variable type." },
        { term: "TYPE(*LGL)", meaning: "Logical CL variable type." },
        { term: "GOTO CMDLBL", meaning: "Transfers control to a command label inside a CL procedure or program." },
        { term: "CMDLBL", meaning: "Command label used as a target for GOTO or MONMSG handling." },
        { term: "SNDPGMMSG", meaning: "Sends a program message, including completion, diagnostic, escape or informational messages." },
        { term: "SNDUSRMSG", meaning: "Sends a message to a user or message queue." },
        { term: "SNDMSG", meaning: "Sends a simple message." },
        { term: "OVRDBF", meaning: "Override with Database File command; temporarily changes file attributes for a job or call level." },
        { term: "OPNQRYF", meaning: "Open Query File command for query-like access paths in CL-driven processing." },
        { term: "OVRDBF before OPNQRYF", meaning: "Common CL pattern: override/open scope before opening query file where required by the job flow." },
        { term: "*CAT", meaning: "Concatenates character operands in CL expressions." },
        { term: "*BCAT", meaning: "Concatenates strings with one blank separator." },
        { term: "*TCAT", meaning: "Concatenates strings after trimming trailing blanks." },
        { term: "QCMDEXC", meaning: "API used to execute CL command strings from programs." }
      ]
    },
    {
      id: "dds-display-subfile-keywords",
      title: "DDS display file and subfile keywords",
      description: "Tópico semántico derivado para recuperar keywords DDS de pantallas, subfiles, mensajes y redisplay.",
      category: "dds",
      concepts: [
        "DDS display file", "subfile control record", "subfile display", "restore display",
        "message subfile", "function key", "redisplay screen", "display format"
      ],
      intents: [
        "What keyword is used when a screen is redisplayed?",
        "What are the required keywords for a message subfile?",
        "How do function keys work in DDS?",
        "Which keyword controls subfile display?",
        "What does ERRMSG do in a display file?"
      ],
      entries: [
        { term: "RSTDSP", meaning: "Restore display keyword/parameter used to restore the display when returning to a screen." },
        { term: "USRRSTDSP", meaning: "User Restore Display keyword for display files." },
        { term: "SFLDSP", meaning: "Subfile display keyword." },
        { term: "SFLDSPCTL", meaning: "Subfile control display keyword." },
        { term: "SFLCTL", meaning: "Defines the subfile control record format." },
        { term: "SFLPAG", meaning: "Specifies records per subfile page." },
        { term: "SFLSIZ", meaning: "Specifies total subfile size." },
        { term: "SFLMSGKEY", meaning: "Message key keyword used with message subfiles." },
        { term: "SFLPGMQ", meaning: "Program message queue keyword used with message subfiles." },
        { term: "SFLMSGRCD", meaning: "Subfile message record keyword." },
        { term: "ERRMSG", meaning: "Displays an error message for a field or record condition." },
        { term: "ERRMSGID", meaning: "Displays an error message by message ID." },
        { term: "CFxx", meaning: "Command function key keyword." },
        { term: "CAxx", meaning: "Command attention key keyword." },
        { term: "INDARA", meaning: "Uses a separate indicator area for display or printer files." }
      ]
    },
    {
      id: "ile-modules-service-programs",
      title: "ILE modules, service programs, binding and signatures",
      description: "Tópico semántico derivado para consultas sobre módulos ILE, service programs, binding directories, exports y firmas.",
      category: "ile-rpg",
      concepts: [
        "ILE module", "service program", "binding directory", "binder language", "program signature",
        "module cannot be called directly", "procedure export", "activation group"
      ],
      intents: [
        "Can we call a module directly?",
        "What is a service program?",
        "What is a signature in a service program?",
        "How are modules bound into programs?",
        "How do binding directories help compilation?"
      ],
      entries: [
        { term: "MODULE", meaning: "Compiled object that is bound into a program or service program; it is not normally invoked as a standalone callable program." },
        { term: "CRTRPGMOD", meaning: "Creates an RPG module object." },
        { term: "CRTPGM", meaning: "Creates/binds a program from modules and service programs." },
        { term: "CRTSRVPGM", meaning: "Creates a service program from modules." },
        { term: "Service program", meaning: "ILE object containing callable procedures exported for reuse by programs or other service programs." },
        { term: "Binding directory", meaning: "Object listing modules and service programs to search during binding." },
        { term: "Binder language", meaning: "Defines exports and signature behavior for service programs." },
        { term: "Signature", meaning: "Compatibility token used by service programs to validate expected exports at bind/runtime." },
        { term: "EXPORT", meaning: "Makes a procedure or symbol available from a module/service program." },
        { term: "CALLP", meaning: "Calls a prototyped procedure, including procedures exported by service programs." },
        { term: "Activation group", meaning: "ILE runtime container controlling activation and resource lifetime." }
      ]
    },
    {
      id: "terminal-emulator-function-keys",
      title: "IBM i terminal emulation, keyboard maps and function keys",
      description: "Tópico semántico derivado para consultas sobre emuladores 5250/3270, teclas PF/F y mapas de teclado.",
      category: "administration",
      concepts: [
        "5250 emulator", "TN5250", "TN3270", "PF key", "F4 prompt", "keyboard map",
        "command keyboard", "display keyboard map"
      ],
      intents: [
        "Why does F4 or PF4 not prompt in my emulator?",
        "How do I map function keys for IBM i terminal access?",
        "Which commands manage keyboard maps?",
        "What is the difference between TN5250 and TN3270?"
      ],
      entries: [
        { term: "TN5250", meaning: "Terminal emulation protocol commonly used for IBM i 5250 sessions." },
        { term: "TN3270", meaning: "3270 terminal protocol; not the native 5250 protocol used by IBM i green-screen sessions." },
        { term: "PF4", meaning: "Program/function key often mapped to prompt/help behavior such as F4 in IBM i command entry." },
        { term: "F4", meaning: "Keyboard key commonly mapped to IBM i Prompt." },
        { term: "CMDKBD", meaning: "Command keyboard/map related support." },
        { term: "CHGKBDMAP", meaning: "Changes a keyboard map." },
        { term: "DSPKBDMAP", meaning: "Displays keyboard map information." },
        { term: "SETKBDMAP", meaning: "Sets keyboard map behavior where supported." },
        { term: "VT100", meaning: "Terminal type that can differ from 5250 expectations." }
      ]
    },
    {
      id: "rpg-language-evolution",
      title: "RPG language evolution and historical versions",
      description: "Tópico semántico derivado para consultas sobre RPG/400, RPG III, RPG IV, ILE RPG y formatos históricos.",
      category: "ile-rpg",
      concepts: [
        "RPG III", "RPG IV", "RPG/400", "ILE RPG", "fixed format RPG", "free form RPG",
        "historical RPG versions", "RPG language reference"
      ],
      intents: [
        "What are the earlier versions of RPG?",
        "What changed from RPG III to RPG IV?",
        "What is RPG/400?",
        "What is ILE RPG?"
      ],
      entries: [
        { term: "RPG III", meaning: "Earlier RPG language generation used before modern RPG IV/ILE RPG." },
        { term: "RPG/400", meaning: "AS/400-era RPG implementation." },
        { term: "RPG IV", meaning: "Modern RPG language generation associated with ILE RPG." },
        { term: "ILE RPG", meaning: "Integrated Language Environment RPG supporting modules, procedures and service programs." },
        { term: "Fixed form", meaning: "Column-sensitive RPG source format." },
        { term: "Free form", meaning: "Modern RPG source style with freer syntax." }
      ]
    }
  ];
}

function buildReferenceBundleDocument(
  bundle: DerivedReferenceBundleDefinition,
  sourceTexts: Array<{ doc: DocumentRecord; text: string }>,
  collectedAt: string
): DerivedDocumentPayload | undefined {
  const anchors = findBundleSourceAnchors(bundle, sourceTexts).slice(0, 10);
  if (anchors.length < 1) return undefined;

  const entryLines = bundle.entries.map((entry) => `- ${entry.term}: ${entry.meaning}`);
  const anchorLines = anchors.map((anchor) => `- ${anchor.doc.title} (${anchor.doc.id}) — señales: ${anchor.signals.join(", ")}`);
  const text = [
    bundle.title,
    "",
    "Descripción",
    bundle.description,
    "",
    "Intenciones cubiertas",
    ...bundle.intents.map((intent) => `- ${intent}`),
    "",
    "Conceptos semánticos",
    bundle.concepts.join(", "),
    "",
    "Entradas técnicas",
    ...entryLines,
    "",
    "Evidencia oficial relacionada encontrada en el corpus",
    ...anchorLines,
    "",
    "Fuente y trazabilidad",
    "Derivado automáticamente durante build desde documentos oficiales ya incluidos en el corpus local.",
    "Este documento no reemplaza a la documentación oficial; agrupa señales oficiales para mejorar recuperación vectorial multi-hop."
  ].join("\n");
  const id = `derived-reference-bundle-${bundle.id}`;
  const sha256 = sha256Hex(text);
  const html = [
    "<!doctype html>",
    "<html><head>",
    `<meta charset="utf-8"><title>${escapeHtml(bundle.title)}</title>`,
    "</head><body>",
    `<h1>${escapeHtml(bundle.title)}</h1>`,
    `<p>${escapeHtml(bundle.description)}</p>`,
    "<h2>Intenciones cubiertas</h2>",
    `<ul>${bundle.intents.map((intent) => `<li>${escapeHtml(intent)}</li>`).join("")}</ul>`,
    "<h2>Entradas técnicas</h2>",
    `<ul>${bundle.entries.map((entry) => `<li><strong>${escapeHtml(entry.term)}</strong>: ${escapeHtml(entry.meaning)}</li>`).join("")}</ul>`,
    "<h2>Evidencia oficial relacionada</h2>",
    `<ul>${anchors.map((anchor) => `<li>${escapeHtml(anchor.doc.title)} (${escapeHtml(anchor.doc.id)}): ${escapeHtml(anchor.signals.join(", "))}</li>`).join("")}</ul>`,
    "</body></html>"
  ].join("\n");

  return {
    html,
    text,
    doc: {
      id,
      sourceKind: "manual-pack",
      sourceId: "derived-semantic-docs",
      originalUrl: `ibmi-docs-derived://semantic-bundles/${bundle.id}`,
      canonicalUrl: `ibmi-docs-derived://semantic-bundles/${bundle.id}`,
      title: bundle.title,
      breadcrumbs: ["IBM i", "Derived semantic retrieval bundles", bundle.title],
      product: "IBM i",
      version: "RDi-local",
      language: "en",
      category: bundle.category,
      rawHtmlPath: "",
      normalizedTextPath: "",
      sha256,
      textLength: text.length,
      collectedAt,
      documentKind: "reference",
      canonicalTopicKey: `${bundle.category}:derived-reference-bundle-${bundle.id}`
    }
  };
}

function findBundleSourceAnchors(
  bundle: DerivedReferenceBundleDefinition,
  sourceTexts: Array<{ doc: DocumentRecord; text: string }>
): Array<{ doc: DocumentRecord; signals: string[]; score: number }> {
  const signals = [...bundle.entries.map((entry) => entry.term), ...bundle.concepts];
  const scored: Array<{ doc: DocumentRecord; signals: string[]; score: number }> = [];
  for (const source of sourceTexts) {
    const haystack = fold(`${source.doc.title}\n${source.doc.breadcrumbs.join(" > ")}\n${source.text.slice(0, 250000)}`);
    const matched = signals.filter((signal) => haystack.includes(fold(signal)));
    if (!matched.length) continue;
    const titleBonus = matched.some((signal) => fold(source.doc.title).includes(fold(signal))) ? 4 : 0;
    const categoryBonus = source.doc.category === bundle.category ? 3 : 0;
    scored.push({
      doc: source.doc,
      signals: [...new Set(matched)].slice(0, 8),
      score: matched.length + titleBonus + categoryBonus
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
}

function commandGroupDefinitions(): Array<{
  id: string;
  title: string;
  description: string;
  category: string;
  commands: string[];
  intents: string[];
  keywords: string[];
}> {
  return [
    {
      id: "journaling",
      title: "IBM i journaling commands",
      description: "Comandos de IBM i para crear journals y journal receivers, iniciar o finalizar journaling de archivos físicos, visualizar entradas, aplicar/remover cambios y recuperar entradas de journal.",
      category: "cl-clle",
      commands: [
        "APYJRNCHG", "APYJRNCHGX", "CHGJRN", "CHGJRNA", "CMPJRNIMG", "CRTJRN", "CRTJRNRCV", "DLTJRN", "DLTJRNRCV",
        "DSPJRN", "DSPJRNRCVA", "ENDJRN", "ENDJRNAP", "ENDJRNLIB", "ENDJRNOBJ", "ENDJRNPF", "RCVJRNE", "RMVJRNCHG",
        "RTVJRNE", "SNDJRNE", "STRJRN", "STRJRNAP", "STRJRNLIB", "STRJRNOBJ", "STRJRNPF", "WRKJRN", "WRKJRNA", "WRKJRNRCV"
      ],
      intents: [
        "What are the journaling commands?",
        "Which commands manage journal receivers and journal entries?",
        "How do I start or end journaling for a physical file?",
        "How do I display, receive, retrieve, apply or remove journaled changes?"
      ],
      keywords: ["journal", "journaling", "journal receiver", "journal entries", "physical file", "apply journaled changes", "remove journaled changes"]
    },
    {
      id: "job-scheduler",
      title: "IBM i job scheduler and scheduled job commands",
      description: "Comandos de IBM i para trabajar con job schedule entries, planificar trabajos, cambiar/remover entradas planificadas y revisar jobs sometidos o scheduler avanzado.",
      category: "cl-clle",
      commands: [
        "ADDJOBSCDE", "CHGJOBSCDE", "RMVJOBSCDE", "WRKJOBSCDE", "SBMJOB", "WRKSBMJOB", "DSPJOB", "WRKJOB", "DSPJOBLOG",
        "DSPHSTJS", "DSPJOBJS", "STRJS", "ENDJS", "HLDJOB", "RLSJOB", "CHGJOB"
      ],
      intents: [
        "How do I inspect scheduled jobs in IBM i?",
        "Which commands manage job schedule entries?",
        "How can I verify if one batch job runs before or after another?",
        "How do I submit or review scheduled/submitted jobs?"
      ],
      keywords: ["job schedule", "scheduled job", "scheduler", "batch", "submitted job", "schedule date", "schedule time", "WRKJOBSCDE"]
    },
    {
      id: "work-management",
      title: "IBM i work management and active job commands",
      description: "Comandos de IBM i para revisar trabajos activos, joblogs, jobs sometidos, colas de trabajo, subsistemas y atributos de ejecución.",
      category: "cl-clle",
      commands: [
        "WRKACTJOB", "WRKJOB", "DSPJOB", "DSPJOBLOG", "WRKJOBQ", "WRKSBMJOB", "SBMJOB", "CHGJOB", "ENDJOB", "HLDJOB",
        "RLSJOB", "WRKSBS", "DSPSBS", "WRKOUTQ", "DSPLOG"
      ],
      intents: [
        "How do I see active jobs?",
        "How do I inspect a joblog or submitted job?",
        "Which commands are used for IBM i work management?",
        "How do I check job queues, subsystems or job attributes?"
      ],
      keywords: ["active jobs", "joblog", "submitted jobs", "job queue", "subsystem", "work management", "WRKACTJOB"]
    },
    {
      id: "object-locks",
      title: "IBM i object and record lock commands",
      description: "Comandos de IBM i para ver locks de objetos, asignar/liberar objetos, revisar jobs propietarios y diagnosticar bloqueos operativos.",
      category: "cl-clle",
      commands: ["WRKOBJLCK", "ALCOBJ", "DLCOBJ", "WRKJOB", "DSPJOB", "DSPJOBLOG", "WRKACTJOB", "ENDJOB"],
      intents: [
        "How do I check object locks?",
        "How can I see which job owns a lock?",
        "Which commands help diagnose locked members, objects or records?",
        "How do I allocate or deallocate objects?"
      ],
      keywords: ["object locks", "record lock", "member lock", "lock state", "owner job", "WRKOBJLCK", "allocate object"]
    },
    {
      id: "security-authority",
      title: "IBM i security, user profile and object authority commands",
      description: "Comandos de IBM i para perfiles de usuario, autorizaciones de objeto, propietarios, permisos, listas de autorización y revisión de seguridad.",
      category: "cl-clle",
      commands: [
        "CRTUSRPRF", "CHGUSRPRF", "DSPUSRPRF", "DLTUSRPRF", "WRKUSRPRF", "EDTOBJAUT", "DSPOBJAUT", "GRTOBJAUT", "RVKOBJAUT",
        "CHGOBJOWN", "WRKAUTL", "CRTAUTL", "CHGAUTL", "DLTAUTL", "DSPAUTL"
      ],
      intents: [
        "How do I inspect or change object authority?",
        "Which commands manage IBM i user profiles?",
        "How do I grant or revoke object authority?",
        "How do group profiles and object ownership relate to security?"
      ],
      keywords: ["user profile", "group profile", "object authority", "grant authority", "revoke authority", "authorization list", "owner"]
    },
    {
      id: "database-file-dependencies",
      title: "IBM i database file, member and dependency commands",
      description: "Comandos de IBM i para inspeccionar archivos físicos/lógicos, miembros, referencias de programa, relaciones de base de datos y dependencias.",
      category: "cl-clle",
      commands: [
        "DSPFD", "DSPFFD", "WRKMBRPDM", "DSPDBR", "DSPPGMREF", "CRTPF", "CRTLF", "DSPPFM", "CPYF", "RUNQRY", "STRSQL",
        "OVRDBF", "OPNQRYF"
      ],
      intents: [
        "How do I list members of a file?",
        "How can I see what files a program uses?",
        "How do I inspect database relations or logical files?",
        "Which commands help inspect physical files, field descriptions and dependencies?",
        "What command is commonly used before OPNQRYF?",
        "What does OVRDBF stand for?"
      ],
      keywords: ["physical file", "logical file", "members", "program references", "database relations", "DSPFD", "DSPDBR", "DSPPGMREF", "OVRDBF", "OPNQRYF"]
    }
  ];
}

function buildCommandGroupDocument(
  group: ReturnType<typeof commandGroupDefinitions>[number],
  commandIndex: Map<string, { command: string; description: string; raw: string }>,
  source: { doc: DocumentRecord; text: string },
  collectedAt: string
): DerivedDocumentPayload | undefined {
  const entries = group.commands
    .map((command) => commandIndex.get(command))
    .filter((entry): entry is { command: string; description: string; raw: string } => Boolean(entry));
  if (entries.length < 3) return undefined;

  const commandLines = entries.map((entry) => `- ${entry.command}: ${entry.description}.`);
  const text = [
    group.title,
    "",
    "Descripción",
    group.description,
    "",
    "Intenciones cubiertas",
    ...group.intents.map((intent) => `- ${intent}`),
    "",
    "Comandos principales",
    ...commandLines,
    "",
    "Términos semánticos",
    group.keywords.join(", "),
    "",
    "Fuente y trazabilidad",
    `Derivado automáticamente durante build desde el tópico oficial incluido en el corpus: ${source.doc.title} (${source.doc.id}).`,
    `Fuente runtime sanitizada: ${source.doc.sourceKind}; categoría: ${source.doc.category}; versión: ${source.doc.version}.`,
    "Este documento no reemplaza a la documentación oficial; agrupa señales oficiales para mejorar recuperación vectorial multi-hop."
  ].join("\n");
  const sha256 = sha256Hex(text);
  const id = `derived-command-group-${group.id}`;
  const html = [
    "<!doctype html>",
    "<html><head>",
    `<meta charset="utf-8"><title>${escapeHtml(group.title)}</title>`,
    "</head><body>",
    `<h1>${escapeHtml(group.title)}</h1>`,
    `<p>${escapeHtml(group.description)}</p>`,
    "<h2>Intenciones cubiertas</h2>",
    `<ul>${group.intents.map((intent) => `<li>${escapeHtml(intent)}</li>`).join("")}</ul>`,
    "<h2>Comandos principales</h2>",
    `<ul>${entries.map((entry) => `<li><strong>${escapeHtml(entry.command)}</strong>: ${escapeHtml(entry.description)}.</li>`).join("")}</ul>`,
    "<h2>Fuente y trazabilidad</h2>",
    `<p>Derivado desde ${escapeHtml(source.doc.title)} (${escapeHtml(source.doc.id)}).</p>`,
    "</body></html>"
  ].join("\n");

  return {
    html,
    text,
    doc: {
      id,
      sourceKind: "manual-pack",
      sourceId: "derived-semantic-docs",
      originalUrl: `ibmi-docs-derived://command-groups/${group.id}`,
      canonicalUrl: `ibmi-docs-derived://command-groups/${group.id}`,
      title: group.title,
      breadcrumbs: ["IBM i", "Derived semantic command groups", group.title],
      product: "IBM i",
      version: "RDi-local",
      language: "en",
      category: group.category,
      rawHtmlPath: "",
      normalizedTextPath: "",
      sha256,
      textLength: text.length,
      collectedAt,
      documentKind: "reference",
      canonicalTopicKey: `${group.category}:derived-command-group-${group.id}`
    }
  };
}

function sourceRootForDocument(inputDir: string, doc: DocumentRecord, manifest: CorpusManifest): string {
  const source = manifest.sources.find((item) => item.id === doc.sourceId) ?? manifest.sources.find((item) => item.kind === doc.sourceKind);
  const kind = source?.kind ?? doc.sourceKind;
  if (kind === "rdi-local-export") return path.join(inputDir, "rdi-export");
  if (kind === "ibm-docs") return path.join(inputDir, "ibm-docs-cache");
  return inputDir;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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


