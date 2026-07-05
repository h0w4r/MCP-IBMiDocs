import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveContainedPath } from "../util/paths.js";
import { appendTraceEvent, buildTraceReport, defaultTraceFile, isTraceEnabled } from "./trace/traceStore.js";
import type {
  AssistCoverage,
  AssistOptions,
  AssistRetrievalAxis,
  AssistRetrievalPlan,
  AssistResult,
  AssistTaskPlan,
  AnswerCitation,
  AnswerOptions,
  AnswerResult,
  CategoryDiagnostics,
  CodeValidationFinding,
  CodeValidationOptions,
  CodeValidationResult,
  CompareVersionsOptions,
  CompileGuidance,
  CompileGuidanceOptions,
  ContextOptions,
  ContextPackage,
  ContextReadSummary,
  CorpusManifest,
  DocsIntent,
  ExplainMessageOptions,
  DocsRecipe,
  MessageExplanation,
  NextToolRecommendation,
  PackDiagnostics,
  QualityReport,
  QueryReport,
  QueryReportOptions,
  ReadResult,
  RankingExplanation,
  RankingExplanationOptions,
  RelatedDocuments,
  RelatedOptions,
  ResolveOptions,
  ResolveResult,
  SearchHit,
  SearchOptions,
  TraceEvent,
  TraceReport,
  TopicSection,
  TopicTaxonomy,
  VersionComparison,
  WorkflowPolicy,
  WorkflowStage
} from "../types.js";
import { clamp } from "../util/common.js";

const SUPPORTED_VERSIONS = ["7.3", "7.4", "7.5", "7.6", "RDi-local"];
const FTS_STOPWORDS = new Set(["a", "an", "and", "as", "de", "del", "el", "en", "for", "in", "la", "las", "los", "of", "on", "or", "the", "to", "un", "una", "with"]);
const DEFAULT_VERSIONS = ["7.3", "7.4", "7.5", "7.6"];
const IBM_I_COMMAND_PREFIXES = [
  "add", "alw", "ap", "call", "chg", "chk", "clr", "cpy", "crt", "dcl", "dlt", "dmp", "dsp", "ed", "end", "go", "grt",
  "hold", "mon", "ovr", "prt", "rcv", "rel", "rmv", "rnm", "rst", "rtv", "run", "sav", "sbm", "snd", "str", "tfr",
  "wrk"
];
const IBM_I_COMMAND_PREFIX_PATTERN = new RegExp(`^(${IBM_I_COMMAND_PREFIXES.join("|")})[a-z0-9]{1,}$`, "i");
const IBM_I_COMMAND_TOKEN_PATTERN = new RegExp(`\\b(${IBM_I_COMMAND_PREFIXES.join("|")})[a-z0-9]{1,}\\b`, "i");
const IBM_I_COMMAND_FALSE_POSITIVES = new Set([
  // Alias descriptivo de MONMSG; no debe convertirse en el comando ficticio MONITOR.
  "monitor",
  "monitoring",
  "relevante",
  "relevantes",
  "relacionado",
  "relacionados",
  "relacionada",
  "relacionadas"
]);
const IBM_I_COMMAND_ALIASES: Record<string, string[]> = {
  dspfd: ["display file description", "database files and device files"],
  monmsg: ["monitor message", "monitor message command"],
  rtvjoba: ["retrieve job attributes", "retrieve job attributes command", "job attributes"],
  sbmjob: ["submit job", "submit job command", "submitted job"],
  sndpgmmsg: ["send program message", "send program message command"],
  wrkactjob: ["work with active jobs", "active jobs", "debugging a job that is running"],
  wrkobjlck: ["work with object locks", "object locks", "displaying the lock states for objects"],
  dspjob: ["display job", "job parameter", "display job command"],
  wrkjob: ["work with job", "job parameter", "work with job command"],
  wrkjoblog: ["work with job logs", "displaying a job log", "job log"],
  dspjoblog: ["display job log", "displaying a job log", "job log"],
  wrkmbrpdm: ["work with members using pdm", "work with members", "rational development studio commands"]
};

// Expansiones semánticas locales: no dependen de embeddings externos ni red.
// Funcionan como una capa de "recall" para prompts naturales de agentes.
const SEMANTIC_EXPANSIONS: Array<{ pattern: RegExp; queries: string[]; signals: string[] }> = [
  {
    pattern: /sql\s*(embebido|embedded)|sqlrpgle|exec\s+sql|precompil/i,
    queries: ["CRTSQLRPGI command", "SQLRPGLE embedded SQL RPG", "RPGPPOPT SQL precompiler", "Using /COPY /INCLUDE in Source Files with Embedded SQL"],
    signals: ["sqlrpgle", "embedded-sql", "precompiler"]
  },
  {
    pattern: /\b(joblog|mensaje|message|snd-msg|%msg|%target|qmhsndpm)\b/i,
    queries: ["SND-MSG Send a Message to the Joblog", "%MSG built-in function", "%TARGET built-in function", "QMHSNDPM API"],
    signals: ["joblog-message", "rpg-message-operation"]
  },
  {
    pattern: /\brnf\d{4}\b|rpg messages?|listado de compilaci[oó]n/i,
    queries: ["RPG Messages", "RNF compiler messages", "ILE RPG Compiler Reference"],
    signals: ["rnf-message"]
  },
  {
    pattern: /\bdds\b|\bpf\b|\blf\b|physical file|logical file|archivo f[ií]sico|archivo l[oó]gico/i,
    queries: ["Defining a physical file using DDS", "DDS for physical and logical files", "DDS keywords physical logical files", "CRTPF command"],
    signals: ["dds", "database-file"]
  },
  {
    pattern: /\bclle\b|control language|monmsg|sndpgmmsg|rtvjoba|crtbndcl/i,
    queries: ["CL programs and procedures", "CRTBNDCL command", "MONMSG command", "SNDPGMMSG command", "CL command coding examples"],
    signals: ["clle", "control-language"]
  },
  {
    pattern: /\brpgle\b|ile rpg|crtrpgmod|crtbndrpg|free[- ]form/i,
    queries: ["ILE RPG Reference", "CRTRPGMOD Command", "CRTBNDRPG Command", "ILE RPG free form"],
    signals: ["rpgle", "ile-rpg"]
  },
  {
    pattern: /wrkactjob|wrkobjlck|dspjob\b|wrkjob\b|wrkjoblog|dspjoblog|trabajos?\s+activos?|active\s+jobs?|bloqueos?|locks?|object\s+locks?|job\s+locks?/i,
    queries: [
      "WRKACTJOB Work with Active Jobs",
      "Debugging a job that is running WRKACTJOB",
      "WRKOBJLCK Work with Object Locks",
      "Displaying the lock states for objects WRKOBJLCK",
      "DSPJOB Display Job",
      "WRKJOB Work with Job",
      "JOB parameter DSPJOB WRKJOB"
    ],
    signals: ["ibm-i-administration", "work-management", "object-locks"]
  }
];

const RECIPES: DocsRecipe[] = [
  {
    id: "diagnosticar-rnf",
    title: "Diagnosticar un RNF de compilación",
    prompt: "Explícame RNF0004, posibles causas y pasos de recuperación para un fuente RPGLE.",
    tools: ["ibmi_docs_resolve", "ibmi_docs_explain_message", "ibmi_docs_read"],
    expectedOutcome: "Resumen del mensaje, evidencia documental y checklist de recuperación."
  },
  {
    id: "crear-sqlrpgle",
    title: "Crear o revisar SQLRPGLE",
    prompt: "Necesito un programa SQLRPGLE con EXEC SQL y /COPY; dime comandos y opciones de compilación.",
    tools: ["ibmi_docs_resolve", "ibmi_docs_compile_guidance", "ibmi_docs_validate_code_context"],
    expectedOutcome: "Guía con CRTSQLRPGI, RPGPPOPT, COMMIT, DBGVIEW y evidencia trazable."
  },
  {
    id: "comparar-versiones",
    title: "Comparar documentación entre releases",
    prompt: "Compara CRTRPGMOD entre IBM i 7.3 y 7.6.",
    tools: ["ibmi_docs_resolve", "ibmi_docs_compare_versions", "ibmi_docs_read"],
    expectedOutcome: "Disponibilidad, diferencias estructurales y citas por versión."
  },
  {
    id: "dds-pf",
    title: "Diseñar DDS para archivo físico",
    prompt: "Dame guía oficial para definir un PF con DDS y keywords comunes.",
    tools: ["ibmi_docs_resolve", "ibmi_docs_answer", "ibmi_docs_read"],
    expectedOutcome: "Tópicos de DDS/PF, keywords y lectura completa sugerida."
  },
  {
    id: "explicar-opcode",
    title: "Entender un opcode RPG moderno",
    prompt: "Explica SND-MSG, %MSG y %TARGET con sintaxis y notas.",
    tools: ["ibmi_docs_resolve", "ibmi_docs_answer", "ibmi_docs_sections"],
    expectedOutcome: "Sintaxis, operandos, notas y referencias como QMHSNDPM."
  }
];

interface AssistRetrievalExecution {
  plan: AssistRetrievalPlan;
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  citations: AnswerCitation[];
  workflow: WorkflowStage[];
  warnings: string[];
}

type LanguagePreset = {
  language: string;
  category?: string;
  signals: RegExp[];
  queries: string[];
  compileCommands: string[];
  relatedCommands: string[];
  optionsToReview: string[];
  pitfalls: string[];
};

const LANGUAGE_PRESETS: LanguagePreset[] = [
  {
    language: "SQLRPGLE",
    category: "sql-db2-for-i",
    signals: [/sqlrpgle/i, /embedded\s+sql/i, /exec\s+sql/i, /crtsqlrpgi/i],
    queries: ["CRTSQLRPGI command", "SQLRPGLE embedded SQL RPG", "Using /COPY /INCLUDE in Source Files with Embedded SQL", "RPGPPOPT SQL precompiler"],
    compileCommands: ["CRTSQLRPGI"],
    relatedCommands: ["CRTRPGMOD", "CRTPGM", "CRTBNDRPG"],
    optionsToReview: ["RPGPPOPT", "COMMIT", "DBGVIEW", "OBJTYPE", "OPTION"],
    pitfalls: [
      "Si el fuente usa /COPY o /INCLUDE, revisar RPGPPOPT porque el precompilador SQL los trata de forma específica.",
      "Validar COMMIT y nombrado SQL antes de compilar con CRTSQLRPGI.",
      "Usar DBGVIEW adecuado si se requiere depuración de código generado por precompilador."
    ]
  },
  {
    language: "RPGLE",
    category: "ile-rpg",
    signals: [/rpgle/i, /ile\s+rpg/i, /crtrpgmod/i, /crtbndrpg/i],
    queries: ["ILE RPG free form", "CRTRPGMOD Command", "CRTBNDRPG Command", "RPG compiler messages RNF"],
    compileCommands: ["CRTRPGMOD", "CRTBNDRPG"],
    relatedCommands: ["CRTPGM", "CRTSRVPGM"],
    optionsToReview: ["DBGVIEW", "OPTION", "BNDDIR", "TGTRLS"],
    pitfalls: ["Elegir entre módulo ILE y programa bound según estrategia de despliegue.", "Revisar RNFxxxx del listado de compilación antes de asumir error de runtime."]
  },
  {
    language: "CLLE",
    category: "cl-clle",
    signals: [/clle/i, /control\s+language/i, /crtbndcl/i],
    queries: ["CLLE Control language", "CRTBNDCL command", "MONMSG command", "CL program variables"],
    compileCommands: ["CRTBNDCL", "CRTCLPGM"],
    relatedCommands: ["CALL", "MONMSG", "SNDPGMMSG"],
    optionsToReview: ["DBGVIEW", "TGTRLS", "REPLACE"],
    pitfalls: ["Agregar MONMSG con alcance correcto para no esconder fallos reales.", "Declarar variables CL con tipos y longitudes compatibles con parámetros llamados."]
  },
  {
    language: "DDS",
    category: "dds",
    signals: [/\bdds\b/i, /physical\s+file/i, /logical\s+file/i, /\bpf\b/i, /\blf\b/i, /crtp[ f]/i],
    queries: ["DDS for physical and logical files", "DDS syntax for a physical file", "UNIQUE keyword physical logical files", "CRTPF command"],
    compileCommands: ["CRTPF", "CRTLF", "CRTDSPF", "CRTPRTF"],
    relatedCommands: ["CHGPF", "CHGLF", "DSPFD"],
    optionsToReview: ["SRCFILE", "SRCMBR", "OPTION", "MAXMBRS"],
    pitfalls: ["Distinguir PF, LF, DSPF y PRTF antes de elegir comando de creación.", "Para claves duplicadas revisar UNIQUE, FIFO, LIFO y FCFO según semántica esperada."]
  },
  {
    language: "COBOL",
    category: "ile-cobol",
    signals: [/cobol/i],
    queries: ["ILE COBOL Programmer's Guide", "CRTBNDCBL command"],
    compileCommands: ["CRTBNDCBL", "CRTCBLMOD"],
    relatedCommands: ["CRTPGM"],
    optionsToReview: ["DBGVIEW", "OPTION"],
    pitfalls: ["Verificar diferencias entre OPM e ILE COBOL antes de compilar."]
  }
];

const WORKFLOW_POLICIES: Record<DocsIntent, WorkflowPolicy> = {
  explain_topic: {
    intent: "explain_topic",
    preferredTools: [],
    requiredEvidence: ["respuesta extractiva", "lectura completa de los tópicos principales", "citas auditables"],
    defaultLimit: 6,
    description: "Consulta explicativa general: responder con citas y leer los tópicos principales antes de concluir."
  },
  multi_intent: {
    intent: "multi_intent",
    preferredTools: [],
    requiredEvidence: ["evidencia por cada intención detectada", "advertencias si una familia técnica no tiene ID exacto", "lectura de los tópicos principales"],
    defaultLimit: 8,
    description: "Consulta mixta: separar comandos, mensajes, compilación o versiones y advertir si algún eje no queda cubierto por evidencia."
  },
  syntax_lookup: {
    intent: "syntax_lookup",
    preferredTools: [],
    requiredEvidence: ["tópico exacto", "secciones de sintaxis/parámetros/ejemplos", "lectura completa"],
    defaultLimit: 6,
    description: "Consulta de sintaxis, comandos, opcodes o BIFs: resolver el tópico exacto y extraer secciones relevantes."
  },
  compile_guidance: {
    intent: "compile_guidance",
    preferredTools: [],
    requiredEvidence: ["comandos de compilación", "opciones/pitfalls", "evidencia por lenguaje"],
    defaultLimit: 8,
    description: "Guía de compilación/desarrollo: combinar contexto por lenguaje con comandos y opciones documentadas."
  },
  message_diagnostic: {
    intent: "message_diagnostic",
    preferredTools: [],
    requiredEvidence: ["mensaje exacto o familia", "checklist de recuperación", "lectura del tópico de mensajes"],
    defaultLimit: 6,
    description: "Diagnóstico RNF/SQL/CPF/MCH: explicar familia, evidencia y recuperación."
  },
  code_review: {
    intent: "code_review",
    preferredTools: [],
    requiredEvidence: ["señales detectadas en código", "hallazgos", "documentos relacionados"],
    defaultLimit: 8,
    description: "Revisión documental de código IBM i: detectar señales y contrastarlas con documentación."
  },
  version_question: {
    intent: "version_question",
    preferredTools: [],
    requiredEvidence: ["comparación por release", "deltas estructurales", "citas por versión"],
    defaultLimit: 5,
    description: "Pregunta entre versiones IBM i: buscar cada release y comparar cobertura/estructura."
  },
  ranking_debug: {
    intent: "ranking_debug",
    preferredTools: [],
    requiredEvidence: ["razones de ranking", "query FTS", "expansiones semánticas"],
    defaultLimit: 5,
    description: "Depuración de búsqueda/ranking: explicar por qué ganó cada resultado."
  },
  search_discovery: {
    intent: "search_discovery",
    preferredTools: [],
    requiredEvidence: ["candidatos de búsqueda", "IDs auditables", "evidencia resumida"],
    defaultLimit: 8,
    description: "Exploración amplia: descubrir documentos candidatos y entregar evidencia resumida trazable."
  }
};

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
    try {
      return JSON.parse(row.value) as CorpusManifest;
    } catch (error) {
      throw new Error(`Manifest inválido dentro del SQLite: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const started = Date.now();
    const limit = clamp(options.limit, 8, 1, 50);
    const semantic = buildSemanticExpansion(options.query);
    const ftsInputs = options.mode === "fts" ? [options.query] : [...new Set([options.query, ...semantic.queries])];
    const exactTerms = [...new Set([...extractExactTechnicalTerms(options.query), ...semantic.signals.filter((signal) => isCommandOrOpcodeTerm(signal))])];
    const filters: string[] = [];
    const baseParams: Record<string, string | number> = { limit: Math.max(limit * 16, 80) };
    if (options.version) {
      filters.push("d.version = @version");
      baseParams.version = normalizeVersionInput(options.version);
    }
    if (options.category) {
      filters.push("d.category = @category");
      baseParams.category = options.category;
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const sql = `
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url, d.text_length,
             d.breadcrumbs_json, c.body, c.chunk_index, bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH @fts ${where}
      ORDER BY rank ASC
      LIMIT @limit
    `;
    const stmt = this.db.prepare(sql);
    const rows: Array<Record<string, unknown>> = [];
    for (const input of ftsInputs) {
      const fts = toFtsQuery(input);
      if (!fts) continue;
      // MATCH sigue parametrizado; las expansiones solo cambian el recall, no concatenan SQL.
      try {
        rows.push(...(stmt.all({ ...baseParams, fts }) as Array<Record<string, unknown>>));
      } catch (error) {
        // Un FTS malformado o una base parcialmente corrupta no debe tumbar el
        // workflow completo si otras expansiones todavía pueden aportar recall.
        rows.push(...[]);
      }
    }
    const exactRows = this.findExactTechnicalRows(exactTerms, options);
    rows.push(...exactRows);
    if (options.category && !options.strictCategory && exactTerms.length && !exactRows.length) {
      rows.push(...this.findExactTechnicalRows(exactTerms, { ...options, category: undefined }).map((row) => ({ ...row, requested_category_fallback: 1 })));
    }
    if (options.version && exactTerms.length && !exactRows.length) {
      // Si la versión pedida no tiene un tópico exacto, agregamos candidatos
      // canónicos de otras fuentes/versiones como fallback explícito. Esto evita
      // que una página "What's New" o un comando no relacionado gane solo por
      // compartir palabras genéricas como RPG/message/command.
      rows.push(...this.findExactTechnicalRows(exactTerms, { ...options, version: undefined }).map((row) => ({ ...row, requested_version_fallback: 1 })));
    }
    const bestByDocument = new Map<string, SearchHit>();
    for (const row of rows) {
      const body = String(row.body ?? "");
      const hit = rowToHit(row, options.query);
      hit.documentKind = classifyDocumentKind(hit, body);
      hit.canonicalTopicKey = canonicalTopicKey(hit);
      hit.taxonomy = classifyTaxonomy(hit, body);
      hit.semanticScore = semanticScore(hit, options.query, semantic);
      hit.requestedVersionFallback = Boolean(row.requested_version_fallback);
      hit.requestedCategoryFallback = Boolean(row.requested_category_fallback);
      hit.matchReasons = buildMatchReasons(hit, body, options.query, semantic);
      hit.relevanceWarnings = buildRelevanceWarnings(hit, body, options);
      if (row.requested_category_fallback) {
        hit.score += 0;
        hit.matchReasons.push(`fallback exacto fuera de la categoría solicitada ${options.category}`);
        hit.relevanceWarnings.push(`No se encontró tópico exacto en categoría ${options.category}; este resultado es fallback desde ${hit.category}.`);
      }
      hit.score = scoreHit(hit, body, Number(row.rank ?? 0), options, Number(row.chunk_index ?? 0)) + hit.semanticScore;
      hit.score += documentKindScoreAdjustment(hit);
      if (hit.requestedVersionFallback) {
        hit.score += 22;
        hit.matchReasons.push(`fallback exacto fuera de la versión solicitada ${normalizeVersionInput(options.version ?? "")}`);
        hit.relevanceWarnings.push(`No se encontró tópico canónico exacto en IBM i ${normalizeVersionInput(options.version ?? "")}; este resultado es fallback desde ${hit.version}.`);
      }
      if (hit.relevanceWarnings.some((warning) => warning.includes("sin términos exactos"))) hit.score -= 85;
      applyNextToolRecommendation(hit, options);
      if (options.includeSections) hit.sectionsPreview = extractTopicSections(body).slice(0, 4);
      if ((options.autoRead || shouldAutoReadSearchHit(hit, options)) && hit.score >= 50) {
        const read = this.read(hit.id);
        if (read) {
          hit.autoReadApplied = true;
          hit.fullContent = read.content;
          hit.sectionsPreview = read.sections?.slice(0, 6);
        }
      }
      const existing = bestByDocument.get(hit.id);
      if (!existing || hit.score > existing.score) bestByDocument.set(hit.id, hit);
    }
    const sortedResults = [...bestByDocument.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const rankedResults = sortedResults.some((hit) => hit.documentKind !== "stub" && hit.documentKind !== "landing")
      ? sortedResults.filter((hit) => hit.documentKind !== "stub" && hit.documentKind !== "landing")
      : sortedResults;
    const guardedResults = exactTerms.length
      ? rankedResults.filter((hit) => hit.score >= 0 && !(hit.relevanceWarnings ?? []).some((warning) => warning.includes("Resultado penalizado")))
      : rankedResults;
    let results = (exactTerms.length ? guardedResults : rankedResults).slice(0, limit);
    if (!results.length && options.category && exactTerms.length && !options.strictCategory) {
      results = this.search({ ...options, category: undefined, limit }).map((hit) => ({
        ...hit,
        requestedCategoryFallback: true,
        matchReasons: [...(hit.matchReasons ?? []), `fallback exacto fuera de la categoría solicitada ${options.category}`],
        relevanceWarnings: [...(hit.relevanceWarnings ?? []), `No se encontró tópico exacto en categoría ${options.category}; este resultado es fallback desde ${hit.category}.`]
      }));
    }
    if (!results.length) {
      results = this.messageFamilyFallbackResults(options, limit);
    }
    results = this.commandFallbackResults(results, options, limit);
    this.recordTrace("ibmi_docs_search", started, {
      query: options.query,
      resultCount: results.length,
      topResultId: results[0]?.id,
      topResultTitle: results[0]?.title,
      autoReadApplied: results.some((hit) => hit.autoReadApplied),
      followedReadCandidateIds: results.slice(0, 3).map((hit) => hit.id)
    });
    return results;
  }

  private messageFamilyFallbackResults(options: SearchOptions, limit: number): SearchHit[] {
    const messageId = extractMessageId(options.query);
    if (!messageId) return [];
    const fallbackQuery = messageFamilyFallbackQuery(messageId);
    if (!fallbackQuery) return [];
    const candidateLimit = clamp(limit * 8, 24, limit, 80);
    return this.search({
      ...options,
      query: fallbackQuery,
      category: undefined,
      strictCategory: false,
      limit: candidateLimit,
      mode: options.mode ?? "hybrid"
    }).filter((hit) => !hit.synthetic)
      .map((hit) => ({
        ...hit,
        score: messageFamilyFallbackScore(hit),
        messageFamilyFallback: true,
        matchReasons: [
          ...(hit.matchReasons ?? []),
          `fallback documental por familia ${messageId.match(/^[A-Z]+/)?.[0] ?? "MESSAGE"} para ${messageId}`
        ],
        relevanceWarnings: [
          ...(hit.relevanceWarnings ?? []),
          `No se encontró entrada exacta para ${messageId}; este resultado es evidencia de familia/manejo de mensajes, no descripción exacta del ID.`
        ]
      }))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  private commandFallbackResults(results: SearchHit[], options: SearchOptions, limit: number): SearchHit[] {
    const command = extractCommandQueryTerm(options.query);
    if (!command || options.strictCategory) return results;
    const foldedCommand = fold(command);
    if (results.some((hit) => isExactCommandTitle(hit.title, foldedCommand))) return results;
    const needles = commandFallbackNeedles(foldedCommand);
    const candidate = [...results]
      .filter((hit) => {
        const haystack = fold(`${hit.title} ${hit.snippet} ${hit.breadcrumbs.join(" ")}`);
        return needles.some((needle) => haystack.includes(needle));
      })
      .sort((a, b) => commandFallbackPriority(b, foldedCommand) - commandFallbackPriority(a, foldedCommand))[0];
    if (!candidate) return results;
    const synthetic: SearchHit = {
      ...candidate,
      title: `${command.toUpperCase()} command (entrada desde ${candidate.title})`,
      snippet: makeSnippet(candidate.snippet || candidate.title, command, 520),
      score: Math.round((candidate.score + 28) * 100000) / 100000,
      synthetic: true,
      canonicalTopicKey: `${candidate.category}:${foldedCommand}`,
      taxonomy: { kind: "command", label: "Comando IBM i", confidence: 0.72, signals: ["synthetic-command-index"] },
      matchReasons: [
        `entrada sintética para comando exacto: ${foldedCommand}`,
        ...(candidate.matchReasons ?? []).slice(0, 4)
      ],
      relevanceWarnings: [
        ...(candidate.relevanceWarnings ?? []),
        `Entrada generada desde un índice/tópico relacionado porque el corpus no contiene una página canónica separada para ${command.toUpperCase()}.`
      ],
      nextRecommendedTool: "ibmi_docs_read",
      nextRecommendedReason: "Lee el tópico fuente para revisar el contexto donde aparece el comando; el corpus todavía no tiene página canónica granular para este comando.",
      nextRecommendedArguments: { id: candidate.id, then: "ibmi_docs_sections", focus: ["syntax", "parameters", "examples", "notes"] },
      workflowHints: [
        "Entrada sintética de comando: úsala como pista de navegación, no como descripción exhaustiva.",
        "Siguiente paso recomendado: ibmi_docs_read sobre el ID fuente."
      ]
    };
    return [synthetic, ...results.filter((hit) => hit.id !== candidate.id)].slice(0, limit);
  }

  read(id: string): ReadResult | null {
    const started = Date.now();
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      this.recordTrace("ibmi_docs_read", started, { id, resultCount: 0 });
      return null;
    }
    const textPath = path.join(this.packDir, String(row.normalized_text_path));
    const content = fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8") : "";
    const sections = extractTopicSections(content);
    const result: ReadResult = {
      id: String(row.id),
      title: String(row.title),
      snippet: makeSnippet(content, "", 520),
      score: 1,
      sourceKind: String(row.source_kind) as ReadResult["sourceKind"],
      sourceId: String(row.source_id),
      version: String(row.version),
      category: String(row.category),
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: safeJsonArray(String(row.breadcrumbs_json || "[]")),
      content,
      textLength: Number(row.text_length),
      sha256: String(row.sha256),
      sections
    };
    result.documentKind = classifyDocumentKind(result, content);
    result.canonicalTopicKey = canonicalTopicKey(result);
    result.taxonomy = classifyTaxonomy(result, content);
    result.sectionsPreview = sections.slice(0, 6);
    this.recordTrace("ibmi_docs_read", started, { id, topResultId: result.id, topResultTitle: result.title, resultCount: 1 });
    return result;
  }

  sections(id: string): { topic: ReadResult | null; sections: TopicSection[] } {
    const started = Date.now();
    const topic = this.read(id);
    const sections = topic?.sections ?? [];
    this.recordTrace("ibmi_docs_sections", started, { id, topResultId: topic?.id, topResultTitle: topic?.title, resultCount: sections.length });
    return { topic, sections };
  }

  answer(options: AnswerOptions): AnswerResult {
    const started = Date.now();
    const limit = clamp(options.limit, 5, 1, 10);
    const preset = resolvePreset(options.language ?? options.question);
    const hits = this.search({
      query: options.question,
      version: options.version,
      category: options.category ?? preset?.category,
      limit,
      mode: "hybrid",
      includeSections: true
    });
    const evidenceHits = selectAnswerEvidence(hits, options.question);
    const reads = evidenceHits.slice(0, Math.min(3, evidenceHits.length)).map((hit) => this.read(hit.id)).filter((value): value is ReadResult => Boolean(value));
    const citations: AnswerCitation[] = reads.map((read) => ({
      id: read.id,
      title: read.title,
      version: read.version,
      sourceKind: read.sourceKind,
      canonicalUrl: read.canonicalUrl,
      section: pickBestSection(read.sections ?? [], options.question)?.title
    }));
    const compile = options.includeCompileCommands && (preset || options.language)
      ? this.compileGuidance({ language: options.language ?? preset?.language ?? "RPGLE", version: options.version, limit: 5 })
      : undefined;
    const warnings: string[] = [];
    if (!hits.length) warnings.push("No se encontró evidencia documental suficiente; evita afirmar detalles no sustentados.");
    if (hits.length && !evidenceHits.length) warnings.push("Se encontraron candidatos, pero ninguno supera los guardrails de relevancia exacta; evita responder con documentos no relacionados.");
    if (hits.some((hit) => hit.requestedVersionFallback)) warnings.push("Se usó al menos un fallback fuera de la versión solicitada porque no hubo tópico canónico exacto en esa versión.");
    for (const warning of hits.flatMap((hit) => hit.relevanceWarnings ?? []).slice(0, 4)) warnings.push(warning);
    if (hits.length && hits[0].score < 20) warnings.push("La evidencia existe, pero el score principal es bajo; conviene leer los tópicos antes de responder con seguridad.");

    const exactTerms = extractExactTechnicalTerms(options.question);
    const result: AnswerResult = {
      question: options.question,
      answer: buildExtractiveAnswer(options, reads, compile),
      confidence: evidenceHits[0]?.score >= 60 && !warnings.length ? "alta" : evidenceHits.length >= 2 ? "media" : "baja",
      citations,
      evidence: (evidenceHits.length || exactTerms.length ? evidenceHits : hits).map(sanitizeContextHit),
      warnings,
      suggestedTools: []
    };
    this.recordTrace("ibmi_docs_answer", started, {
      query: options.question,
      resultCount: hits.length,
      topResultId: hits[0]?.id,
      topResultTitle: hits[0]?.title
    });
    return result;
  }

  explainRanking(options: RankingExplanationOptions): RankingExplanation {
    const started = Date.now();
    const top = clamp(options.top ?? options.limit, 5, 1, 20);
    const semantic = buildSemanticExpansion(options.query);
    const hits = this.search({ ...options, limit: top, mode: options.mode ?? "hybrid", includeSections: true });
    const result: RankingExplanation = {
      query: options.query,
      ftsQuery: toFtsQuery(options.query),
      semanticQueries: semantic.queries,
      exactTerms: extractExactTechnicalTerms(options.query),
      results: hits.map((hit) => ({
        hit: sanitizeContextHit(hit),
        reasons: hit.matchReasons ?? [],
        taxonomy: hit.taxonomy ?? classifyTaxonomy(hit, hit.snippet),
        semanticScore: hit.semanticScore ?? 0,
        documentKind: hit.documentKind,
        canonicalTopicKey: hit.canonicalTopicKey,
        relevanceWarnings: hit.relevanceWarnings ?? []
      }))
    };
    this.recordTrace("ibmi_docs_explain_ranking", started, {
      query: options.query,
      resultCount: hits.length,
      topResultId: hits[0]?.id,
      topResultTitle: hits[0]?.title
    });
    return result;
  }

  context(options: ContextOptions): ContextPackage {
    const started = Date.now();
    const preset = resolvePreset(options.language ?? options.task);
    const detectedSignals = detectSignals(options.task, options.language, preset);
    const queries = buildContextQueries(options.task, preset);
    const limit = clamp(options.limit, 8, 1, 20);
    const retrievalLimit = clamp(Math.max(limit * 3, 16), 16, 1, 50);
    const appliedWorkflow: WorkflowStage[] = [];
    const hits = this.searchMany(queries, {
      category: preset?.category,
      version: options.version,
      limit: retrievalLimit,
      includeSections: true
    });
    appliedWorkflow.push({
      tool: "ibmi_docs_search",
      reason: "Descubrir evidencia contextual y consultas técnicas exactas derivadas de la tarea.",
      status: "executed",
      evidenceIds: hits.slice(0, 5).map((hit) => hit.id),
      outputSummary: `${hits.length} candidato(s); top=${hits[0]?.title ?? "sin resultado"}`
    });

    const evidenceForRead = selectContextReadEvidence(hits, options.task);
    const readPairs = evidenceForRead
      .slice(0, Math.min(6, evidenceForRead.length))
      .map((hit) => ({ hit, read: this.read(hit.id) }))
      .filter((value): value is { hit: SearchHit; read: ReadResult } => Boolean(value.read));
    const rawReads = readPairs.map((pair) => pair.read);
    appliedWorkflow.push({
      tool: "ibmi_docs_read",
      reason: "Materializar texto normalizado de los tópicos principales dentro del propio paquete contextual.",
      status: rawReads.length ? "executed" : "skipped",
      evidenceIds: rawReads.map((read) => read.id),
      outputSummary: rawReads.length ? `${rawReads.length} tópico(s) leídos.` : "Sin tópico legible."
    });

    const sectionTopics = readPairs.map(({ hit, read }) => ({
      id: read.id,
      title: contextDisplayTitle(read, hit),
      sections: selectFocusedSections(read.sections ?? [], options.task, 6)
    }));
    appliedWorkflow.push({
      tool: "ibmi_docs_sections",
      reason: "Adjuntar secciones útiles de sintaxis, parámetros, ejemplos, notas, mensajes y recovery sin pedir otra llamada al agente.",
      status: sectionTopics.some((topic) => topic.sections.length) ? "executed" : "skipped",
      evidenceIds: sectionTopics.map((topic) => topic.id),
      outputSummary: `${sectionTopics.reduce((total, topic) => total + topic.sections.length, 0)} sección(es) enfocadas.`
    });

    const reads = readPairs.map(({ hit, read }) => toContextReadSummary(read, options.task, hit));
    const safeHits = hits.map(sanitizeContextHit);
    const citations: AnswerCitation[] = readPairs.map(({ hit, read }) => ({
      id: read.id,
      title: contextDisplayTitle(read, hit),
      version: read.version,
      sourceKind: read.sourceKind,
      canonicalUrl: read.canonicalUrl,
      section: pickBestSection(read.sections ?? [], options.task)?.title
    }));
    const actionItems = buildContextActionItems(options, preset, reads, sectionTopics);
    const warnings = [
      ...(!hits.length ? ["No se encontró evidencia documental suficiente; evita inventar detalles fuera del corpus."] : []),
      ...(hits.some((hit) => hit.requestedVersionFallback) ? ["Se usó fallback fuera de la versión solicitada para al menos un tópico."] : []),
      ...hits.flatMap((hit) => hit.relevanceWarnings ?? []).slice(0, 5)
    ];
    const result: ContextPackage = {
      task: options.task,
      intent: {
        language: preset?.language ?? normalizeLanguage(options.language) ?? "IBM i",
        category: preset?.category,
        detectedSignals,
        queries
      },
      answer: buildContextAnswer({
        task: options.task,
        language: preset?.language ?? normalizeLanguage(options.language) ?? "IBM i",
        detectedSignals,
        compileCommands: preset?.compileCommands ?? [],
        optionsToReview: preset?.optionsToReview ?? [],
        pitfalls: preset?.pitfalls ?? [],
        reads,
        sections: sectionTopics,
        actionItems,
        warnings
      }),
      appliedWorkflow,
      recommendedDocs: safeHits.slice(0, limit),
      compileCommands: preset?.compileCommands ?? [],
      optionsToReview: preset?.optionsToReview ?? [],
      pitfalls: preset?.pitfalls ?? [],
      actionItems,
      versionNotes: buildVersionNotes(hits),
      evidence: safeHits,
      reads,
      sections: sectionTopics,
      citations,
      warnings
    };
    this.recordTrace("ibmi_docs_context", started, {
      query: options.task,
      resultCount: hits.length,
      topResultId: hits[0]?.id,
      topResultTitle: hits[0]?.title
    });
    return result;
  }

  assist(options: AssistOptions): AssistResult {
    const started = Date.now();
    const depth = options.depth ?? "standard";
    const defaultLimit = depth === "deep" ? 8 : depth === "concise" ? 4 : 6;
    const limit = clamp(options.limit, defaultLimit, 1, 12);
    const preset = resolvePreset(options.language ?? options.question ?? options.code);

    const resolved = this.resolve({
      question: options.question,
      language: options.language,
      version: options.version,
      category: options.category,
      code: options.code,
      includeExamples: options.includeExamples ?? depth !== "concise",
      includeCompileCommands: options.includeCompileCommands ?? depth !== "concise",
      limit
    });

    // Assist es la herramienta "one-shot": aunque resolve ya orqueste, materializamos
    // contexto enfocado para que el cliente no tenga que decidir otra tool manualmente.
    const context = resolved.context ?? this.context({
      task: options.question,
      language: options.language ?? preset?.language,
      version: options.version,
      limit
    });
    const agenticRetrieval = this.runAssistRetrievalPlan({
      options,
      resolved,
      context,
      depth,
      limit,
      preset
    });

    const evidence = mergeSearchEvidence([
      resolved.evidence,
      context.evidence,
      resolved.compileGuidance?.evidence ?? [],
      resolved.messageExplanation?.evidence ?? [],
      resolved.versionComparison?.evidence ?? [],
      resolved.codeValidation?.evidence ?? [],
      agenticRetrieval.evidence
    ]).map(sanitizeContextHit);
    const reads = mergeContextReads([
      context.reads,
      resolved.reads.map((read) => toContextReadSummary(read, options.question)),
      agenticRetrieval.reads
    ]);
    const sections = mergeSectionTopics([
      context.sections,
      resolved.sections.map((topic) => ({
        id: topic.id,
        title: topic.title,
        sections: selectFocusedSections(topic.sections, options.question, depth === "deep" ? 8 : 5)
      })),
      agenticRetrieval.sections
    ]);
    const citations = mergeCitations([context.citations, resolved.citations, agenticRetrieval.citations]);
    const baseWarnings = [...new Set([...resolved.warnings, ...context.warnings, ...agenticRetrieval.warnings])];
    const rawCoverage = buildAssistCoverage({
      question: options.question,
      evidence,
      reads,
      sections,
      confidence: resolved.confidence,
      warnings: baseWarnings
    });
    const taskPlan = buildAssistTaskPlan({ options, resolved, context, coverage: rawCoverage, retrievalAxes: agenticRetrieval.plan.axes });
    const responseMaterial = filterAssistResponseMaterial({
      taskPlan,
      question: options.question,
      evidence,
      reads,
      sections,
      citations
    });
    const coverage = usesTaskScopedMaterial(taskPlan)
      ? buildAssistCoverage({
        question: options.question,
        evidence: responseMaterial.evidence,
        reads: responseMaterial.reads,
        sections: responseMaterial.sections,
        confidence: resolved.confidence,
        warnings: baseWarnings
      })
      : rawCoverage;
    agenticRetrieval.plan.coverageGaps = [...new Set([
      ...agenticRetrieval.plan.coverageGaps,
      ...rawCoverage.missingTechnicalTerms,
      ...coverage.missingTechnicalTerms
    ])];
    const warnings = [...new Set([...baseWarnings, ...coverage.warnings])];
    const executiveSummary = buildAssistExecutiveSummary({ options, resolved, context, coverage, taskPlan });
    const specificFindings = buildAssistSpecificFindings({
      question: options.question,
      reads: responseMaterial.reads,
      sections: responseMaterial.sections,
      evidence: responseMaterial.evidence,
      depth
    });
    const implementationSteps = buildAssistImplementationSteps({ options, resolved, context, coverage, taskPlan, depth });
    const validationChecklist = buildAssistValidationChecklist({ options, resolved, context, coverage, taskPlan, depth });
    const answer = buildAssistAnswer({
      options,
      intent: resolved.intent,
      confidence: coverage.status === "thin" ? "baja" : resolved.confidence,
      taskPlan,
      executiveSummary,
      specificFindings,
      implementationSteps,
      validationChecklist,
      coverage,
      citations: responseMaterial.citations,
      warnings,
      depth
    });

    const result: AssistResult = {
      question: options.question,
      intent: resolved.intent,
      confidence: coverage.status === "thin" ? "baja" : resolved.confidence,
      taskPlan,
      answer,
      executiveSummary,
      specificFindings,
      implementationSteps,
      validationChecklist,
      coverage,
      retrievalPlan: agenticRetrieval.plan,
      workflow: mergeWorkflowStages([agenticRetrieval.workflow, resolved.stages]),
      evidence: responseMaterial.evidence,
      reads: responseMaterial.reads,
      sections: responseMaterial.sections,
      citations: responseMaterial.citations,
      warnings
    };
    this.recordTrace("ibmi_docs_assist", started, {
      query: options.question,
      intent: resolved.intent,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  private runAssistRetrievalPlan(input: {
    options: AssistOptions;
    resolved: ResolveResult;
    context: ContextPackage;
    depth: AssistOptions["depth"];
    limit: number;
    preset?: LanguagePreset;
  }): AssistRetrievalExecution {
    const { options, resolved, context, depth, limit, preset } = input;
    const axes = buildAssistRetrievalAxes(options, resolved, context);
    const initialQueries = buildAssistInitialQueries(options, preset, axes);
    const hasAdministrationAxis = axes.has("administration");
    const maxSearchHops = hasAdministrationAxis ? (depth === "deep" ? 13 : depth === "concise" ? 7 : 10) : depth === "deep" ? 7 : depth === "concise" ? 4 : 6;
    const hopLimit = hasAdministrationAxis ? Math.max(Math.min(limit, depth === "deep" ? 8 : 6), 5) : depth === "deep" ? 5 : Math.max(Math.min(limit, 5), 3);
    const readLimit = hasAdministrationAxis && depth === "deep" ? 2 : 1;
    const sectionLimit = depth === "deep" ? 8 : 5;

    const hops: AssistRetrievalPlan["hops"] = [];
    const evidence: SearchHit[] = [];
    const reads: ContextReadSummary[] = [];
    const sections: Array<{ id: string; title: string; sections: TopicSection[] }> = [];
    const citations: AnswerCitation[] = [];
    const warnings: string[] = [];
    const workflow: WorkflowStage[] = [{
      tool: "ibmi_docs_agentic_plan",
      reason: "Planificar recuperación multi-hop dentro del MCP para no delegar llamadas adicionales al agente cliente.",
      status: "executed",
      outputSummary: `ejes=${[...axes].join(", ")}; consultas iniciales=${initialQueries.length}`
    }];
    const executedQueries = new Set<string>();

    const materializeHits = (axis: AssistRetrievalAxis, query: string, hits: SearchHit[]): {
      readCount: number;
      sectionCount: number;
      evidenceIds: string[];
    } => {
      let readCount = 0;
      let sectionCount = 0;
      const selectedHits = selectContextReadEvidence(hits, `${options.question} ${query}`).slice(0, readLimit);
      for (const hit of selectedHits) {
        const read = this.read(hit.id);
        if (!read) continue;
        readCount += 1;
        const task = `${options.question} ${query}`;
        const focusedSections = selectFocusedSections(read.sections ?? [], task, sectionLimit);
        sectionCount += focusedSections.length;
        reads.push(toContextReadSummary(read, task, hit));
        sections.push({
          id: read.id,
          title: contextDisplayTitle(read, hit),
          sections: focusedSections
        });
        citations.push(readToCitation(read, contextDisplayTitle(read, hit), focusedSections[0]?.title));
      }
      return { readCount, sectionCount, evidenceIds: hits.map((hit) => hit.id) };
    };

    const executeSearchHop = (axis: AssistRetrievalAxis, query: string, reason: string): void => {
      const normalizedQuery = query.trim();
      const queryKey = `${axis}:${fold(normalizedQuery)}`;
      if (!normalizedQuery || executedQueries.has(queryKey) || hops.length >= maxSearchHops) return;
      executedQueries.add(queryKey);
      const category = buildAssistSearchCategory(axis, normalizedQuery, options, preset);
      const version = axis === "message" || axis === "administration" ? undefined : options.version;
      const hits = this.search({
        query: normalizedQuery,
        category,
        version,
        limit: hopLimit,
        mode: "hybrid",
        autoRead: false,
        includeSections: true
      }).map(sanitizeContextHit);
      evidence.push(...hits);
      const materialized = materializeHits(axis, normalizedQuery, hits);
      const hopWarnings = [
        ...(hits.length ? [] : [`Sin resultados documentales para '${normalizedQuery}'.`]),
        ...hits.flatMap((hit) => hit.relevanceWarnings ?? []).slice(0, 4)
      ];
      hops.push({
        axis,
        query: normalizedQuery,
        reason,
        status: "executed",
        resultCount: hits.length,
        readCount: materialized.readCount,
        sectionCount: materialized.sectionCount,
        evidenceIds: materialized.evidenceIds.slice(0, 8),
        warnings: [...new Set(hopWarnings)]
      });
    };

    for (const query of initialQueries) {
      const axis = inferAssistAxisForQuery(query, axes);
      executeSearchHop(axis, query, `Consulta inicial generada para el eje ${axis}.`);
    }

    if (axes.has("compile")) {
      const language = normalizeLanguage(options.language ?? options.question) ?? preset?.language ?? "RPGLE";
      const compileGuidance = resolved.compileGuidance ?? this.compileGuidance({
        language,
        version: options.version,
        usesEmbeddedSql: /exec\s+sql|sqlrpgle|embedded\s+sql/i.test([options.question, options.code].filter(Boolean).join("\n")),
        usesCopybook: /\/\s*(copy|include)\b|copybook/i.test([options.question, options.code].filter(Boolean).join("\n")),
        limit
      });
      evidence.push(...compileGuidance.evidence);
      workflow.push({
        tool: "ibmi_docs_compile_guidance",
        reason: "La intención incluye compilación/construcción; se recuperan comandos, opciones y pitfalls dentro de assist.",
        status: "executed",
        evidenceIds: compileGuidance.evidence.map((hit) => hit.id).slice(0, 8),
        outputSummary: `comandos=${compileGuidance.recommendedCommands.join(", ") || "n/a"}; opciones=${compileGuidance.optionsToReview.join(", ") || "n/a"}`
      });
      for (const query of buildAssistCompileFollowUpQueries(options, compileGuidance)) {
        executeSearchHop("compile", query, "Follow-up de compilación derivado de lenguaje/opciones detectadas.");
      }
    }

    const messageId = extractMessageId([options.question, options.code].filter(Boolean).join("\n"));
    if (messageId) {
      const messageExplanation = resolved.messageExplanation ?? this.explainMessage({ messageId, limit });
      evidence.push(...messageExplanation.evidence);
      warnings.push(...(messageExplanation.warnings ?? []));
      workflow.push({
        tool: "ibmi_docs_explain_message",
        reason: "La consulta contiene un mensaje IBM i; se genera diagnóstico/recovery sin pedir otra llamada al agente.",
        status: "executed",
        evidenceIds: messageExplanation.evidence.map((hit) => hit.id).slice(0, 8),
        outputSummary: messageExplanation.summary
      });
      executeSearchHop("message", messageId, "Follow-up de mensaje exacto o familia de mensajes.");
    }

    if (options.code?.trim()) {
      const codeValidation = resolved.codeValidation ?? this.validateCodeContext({
        code: options.code,
        language: options.language ?? preset?.language ?? "IBM i",
        limit
      });
      evidence.push(...codeValidation.evidence);
      workflow.push({
        tool: "ibmi_docs_validate_code_context",
        reason: "La petición incluye código; se contrastan señales del fuente contra documentación recuperada.",
        status: "executed",
        evidenceIds: codeValidation.evidence.map((hit) => hit.id).slice(0, 8),
        outputSummary: `hallazgos=${codeValidation.findings.length}`
      });
    }

    if (axes.has("version")) {
      const versions = extractVersions(options.question);
      if (versions.length >= 2) {
        const comparison = resolved.versionComparison ?? this.compareVersions({
          query: options.question,
          versions,
          category: options.category,
          limit
        });
        evidence.push(...comparison.evidence);
        workflow.push({
          tool: "ibmi_docs_compare_versions",
          reason: "La consulta menciona releases; se compara disponibilidad por versión dentro de assist.",
          status: "executed",
          evidenceIds: comparison.evidence.map((hit) => hit.id).slice(0, 8),
          outputSummary: `${comparison.versions.length} versión(es) comparadas`
        });
      }
    }

    const interimCoverage = buildAssistCoverage({
      question: options.question,
      evidence: mergeSearchEvidence([resolved.evidence, context.evidence, evidence]).map(sanitizeContextHit),
      reads: mergeContextReads([context.reads, resolved.reads.map((read) => toContextReadSummary(read, options.question)), reads]),
      sections: mergeSectionTopics([
        context.sections,
        resolved.sections.map((topic) => ({
          id: topic.id,
          title: topic.title,
          sections: selectFocusedSections(topic.sections, options.question, sectionLimit)
        })),
        sections
      ]),
      confidence: resolved.confidence,
      warnings: [...resolved.warnings, ...context.warnings, ...warnings]
    });
    const followUpQueries = buildAssistGapFollowUpQueries(options, interimCoverage, axes)
      .filter((query) => !initialQueries.some((initialQuery) => fold(initialQuery) === fold(query)))
      .slice(0, depth === "deep" ? 6 : 3);
    if (followUpQueries.length) axes.add("gap-followup");
    for (const query of followUpQueries) {
      executeSearchHop("gap-followup", query, "Follow-up automático generado por gap de cobertura o término sin evidencia fuerte.");
    }

    if (hops.length) {
      workflow.push({
        tool: "ibmi_docs_search",
        reason: "Ejecutar búsquedas híbridas por ejes de intención, términos exactos y gaps detectados.",
        status: "executed",
        evidenceIds: hops.flatMap((hop) => hop.evidenceIds).slice(0, 12),
        outputSummary: `${hops.length} hop(s) de búsqueda ejecutados.`
      });
    }
    if (reads.length) {
      workflow.push({
        tool: "ibmi_docs_read",
        reason: "Materializar contenido completo de los tópicos candidatos fuertes dentro de assist.",
        status: "executed",
        evidenceIds: reads.map((read) => read.id).slice(0, 12),
        outputSummary: `${reads.length} lectura(s) completas materializadas.`
      });
    }
    const sectionCount = sections.reduce((total, topic) => total + topic.sections.length, 0);
    if (sectionCount) {
      workflow.push({
        tool: "ibmi_docs_sections",
        reason: "Extraer secciones enfocadas de sintaxis, parámetros, ejemplos, mensajes y recovery.",
        status: "executed",
        evidenceIds: sections.map((topic) => topic.id).slice(0, 12),
        outputSummary: `${sectionCount} sección(es) enfocadas.`
      });
    }

    const uniqueAxes = [...axes];
    const plan: AssistRetrievalPlan = {
      strategy: uniqueAxes.length > 1 || hops.length > 1 || followUpQueries.length > 0 ? "multi-hop" : "single-pass",
      axes: uniqueAxes,
      initialQueries,
      followUpQueries,
      hops,
      coverageGaps: interimCoverage.missingTechnicalTerms
    };

    return {
      plan,
      evidence: mergeSearchEvidence([evidence]).map(sanitizeContextHit),
      reads: mergeContextReads([reads]),
      sections: mergeSectionTopics([sections]),
      citations: mergeCitations([citations]),
      workflow,
      warnings: [...new Set([
        ...warnings,
        ...hops.flatMap((hop) => hop.warnings),
        ...(followUpQueries.length ? [`Se ejecutaron ${followUpQueries.length} follow-up(s) automáticos por gaps de cobertura.`] : [])
      ])]
    };
  }

  compileGuidance(options: CompileGuidanceOptions): CompileGuidance {
    const started = Date.now();
    const preset = resolvePreset(options.language) ?? LANGUAGE_PRESETS[1];
    const queries = [
      ...preset.queries,
      options.usesEmbeddedSql ? "CRTSQLRPGI command embedded SQL RPG" : "",
      options.usesCopybook ? "Using /COPY /INCLUDE in Source Files with Embedded SQL" : "",
      ...preset.compileCommands.map((command) => `${command} command`)
    ].filter(Boolean);
    const category = options.usesEmbeddedSql ? "sql-db2-for-i" : preset.category;
    let evidence = this.searchMany(queries, { category, version: options.version, limit: options.limit ?? 8 });
    const recommendedCommands = options.usesEmbeddedSql || preset.language === "SQLRPGLE" ? ["CRTSQLRPGI"] : preset.compileCommands;
    if (preset.language === "SQLRPGLE" || options.usesEmbeddedSql) {
      const commandEvidence = this.search({ query: "CRTSQLRPGI command", category: "sql-db2-for-i", version: options.version, limit: 4 });
      evidence = prioritizeCompileEvidence([...commandEvidence, ...evidence], "SQLRPGLE", options.limit ?? 8);
    }
    const optionsToReview = [...new Set([...preset.optionsToReview, ...(options.usesCopybook ? ["RPGPPOPT"] : []), ...(options.usesEmbeddedSql ? ["COMMIT"] : [])])];
    const result: CompileGuidance = {
      language: preset.language,
      target: options.target ?? "program",
      recommendedCommands,
      relatedCommands: preset.relatedCommands,
      optionsToReview,
      pitfalls: preset.pitfalls,
      evidence: evidence.map(sanitizeContextHit)
    };
    this.recordTrace("ibmi_docs_compile_guidance", started, {
      query: `${preset.language} ${options.target ?? "program"}`,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  explainMessage(options: ExplainMessageOptions): MessageExplanation {
    const started = Date.now();
    const messageId = options.messageId.trim().toUpperCase();
    const family = messageId.match(/^[A-Z]+/)?.[0] ?? "MESSAGE";
    const category = family === "RNF"
      ? "mensajes-rnf"
      : family === "SQL"
        ? "sql-db2-for-i"
        : family === "CPF"
          ? "mensajes-cpf"
          : family === "MCH"
            ? "mensajes-mch"
            : "ibm-i-general";
    const searchCategory = family === "RNF" || family === "SQL" ? category : undefined;
    const evidence = this.search({ query: messageId, category: searchCategory, limit: options.limit ?? 6 })
      .filter((hit) => isMessageEvidenceHit(hit, messageId, family));
    const exactMatch = evidence.some((hit) => messageHitContainsExactId(hit, messageId));
    const coverageStatus: MessageExplanation["coverageStatus"] = exactMatch ? "exact" : evidence.length ? "family" : "unsupported";
    const warnings = [
      ...(!exactMatch && evidence.length ? [`No se encontró una entrada exacta para ${messageId}; se entrega evidencia documental de familia/manejo de mensajes.`] : []),
      ...(!evidence.length ? [`No hay evidencia documental en el corpus para ${messageId}.`] : [])
    ];
    const result: MessageExplanation = {
      messageId,
      family,
      category,
      summary: exactMatch
        ? `Se encontró evidencia documental exacta para ${messageId} en ${evidence[0].title}.`
        : evidence.length
          ? `No se encontró entrada exacta para ${messageId}; se adjunta evidencia de familia/manejo de mensajes en ${evidence[0].title}.`
          : `No se encontró una entrada exacta para ${messageId}; revisar listado de compilación o joblog completo.`,
      recoveryChecklist: [
        "Confirmar el mensaje exacto, severidad y texto de segundo nivel en el listado/joblog.",
        "Corregir primero mensajes anteriores que puedan provocar errores derivados.",
        "Recompilar y validar que el mensaje desaparezca o cambie de severidad.",
        "Si aplica, contrastar opciones de compilación y miembros /COPY o /INCLUDE referenciados."
      ],
      evidence: evidence.map(sanitizeContextHit),
      exactMatch,
      coverageStatus,
      warnings
    };
    this.recordTrace("ibmi_docs_explain_message", started, {
      query: messageId,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  categories(): CategoryDiagnostics {
    const byCategory = queryCounts(this.db, "category");
    for (const virtualCategory of ["mensajes-cpf", "mensajes-mch"]) {
      byCategory[virtualCategory] ??= 0;
    }
    const byVersion = queryCounts(this.db, "version");
    const bySource = queryCounts(this.db, "source_kind");
    return {
      categories: Object.keys(byCategory).sort(),
      versions: Object.keys(byVersion).sort(naturalVersionSort),
      sources: Object.keys(bySource).sort(),
      byCategory,
      byVersion,
      bySource
    };
  }

  packDiagnostics(): PackDiagnostics {
    const manifest = this.manifest();
    const documents = this.db.prepare("SELECT COUNT(*) AS documents FROM documents").get() as { documents: number };
    const chunks = this.db.prepare("SELECT COUNT(*) AS chunks FROM chunks").get() as { chunks: number };
    const rows = this.db.prepare("SELECT id, raw_html_path, normalized_text_path, version FROM documents").all() as Array<Record<string, unknown>>;
    let missingFiles = 0;
    let checkedFiles = 0;
    const longPaths: string[] = [];
    const anomalies: string[] = [];
    for (const row of rows) {
      const version = String(row.version);
      if (!SUPPORTED_VERSIONS.includes(version)) anomalies.push(`Versión no normalizada ${version} en ${String(row.id)}`);
      for (const key of ["raw_html_path", "normalized_text_path"] as const) {
        let file = "";
        try {
          file = resolveContainedPath(this.packDir, String(row[key]));
        } catch (error) {
          anomalies.push(`Ruta inválida para ${String(row.id)} (${key}): ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        checkedFiles += 1;
        if (!fs.existsSync(file)) missingFiles += 1;
        if (path.relative(this.packDir, file).length > 180) longPaths.push(path.relative(this.packDir, file));
      }
    }
    return {
      ok: missingFiles === 0 && longPaths.length === 0 && anomalies.length === 0,
      packDir: this.packDir,
      corpusVersion: manifest.corpusVersion,
      documents: documents.documents,
      chunks: chunks.chunks,
      missingFiles,
      checkedFiles,
      longPaths: longPaths.slice(0, 25),
      anomalies: anomalies.slice(0, 25),
      runtimeDependency: "Sin RDi, sin Eclipse Help, sin endpoint local de RDi"
    };
  }

  qualityReport(): QualityReport {
    const manifest = this.manifest();
    const pack = this.packDiagnostics();
    const coverage = this.categories();
    const shortDocuments = this.db.prepare(`
      SELECT id, title, text_length AS textLength, category, version
      FROM documents
      WHERE text_length < 300
      ORDER BY text_length ASC, title ASC
      LIMIT 40
    `).all() as QualityReport["shortDocuments"];
    const duplicateTitles = this.db.prepare(`
      SELECT title, COUNT(*) AS count, GROUP_CONCAT(DISTINCT version) AS versions
      FROM documents
      GROUP BY lower(title)
      HAVING COUNT(*) > 1
      ORDER BY count DESC, title ASC
      LIMIT 40
    `).all().map((row: any) => ({
      title: String(row.title),
      count: Number(row.count),
      versions: String(row.versions ?? "").split(",").filter(Boolean).sort(naturalVersionSort)
    }));
    const duplicateTitlesSameVersion = this.db.prepare(`
      SELECT title, version, COUNT(*) AS count, GROUP_CONCAT(DISTINCT category) AS categories
      FROM documents
      GROUP BY lower(title), version
      HAVING COUNT(*) > 1
      ORDER BY count DESC, title ASC
      LIMIT 40
    `).all().map((row: any) => ({
      title: String(row.title),
      version: String(row.version),
      count: Number(row.count),
      categories: String(row.categories ?? "").split(",").filter(Boolean).sort()
    }));
    const duplicateTitlesCrossVersionExpected = duplicateTitles.filter((item) => item.versions.length > 1);
    const canonicalColumnSql = hasColumn(this.db, "documents", "canonical_topic_key") ? "canonical_topic_key" : "'' AS canonical_topic_key";
    const docRows = this.db.prepare(`
      SELECT id, title, category, version, text_length AS textLength, breadcrumbs_json, ${canonicalColumnSql}
      FROM documents
    `).all() as Array<Record<string, unknown>>;
    const documentKinds = Object.fromEntries(["topic", "reference", "index", "landing", "stub"].map((kind) => [kind, 0])) as QualityReport["documentKinds"];
    const duplicateCanonicalMap = new Map<string, { canonicalTopicKey: string; count: number; titles: Set<string>; versions: Set<string> }>();
    for (const row of docRows) {
      const hit: SearchHit = {
        id: String(row.id),
        title: String(row.title),
        snippet: "",
        score: 0,
        sourceKind: "manual-pack",
        sourceId: "",
        version: String(row.version),
        category: String(row.category),
        canonicalUrl: "",
        breadcrumbs: safeJsonArray(String(row.breadcrumbs_json || "[]")),
        textLength: Number(row.textLength ?? 0)
      };
      const kind = classifyDocumentKind(hit, "") ?? "topic";
      documentKinds[kind] += 1;
      const key = String(row.canonical_topic_key ?? "") || canonicalTopicKey(hit);
      const bucketKey = `${hit.version}:${hit.category}:${key}`;
      const bucket = duplicateCanonicalMap.get(bucketKey) ?? { canonicalTopicKey: key, count: 0, titles: new Set<string>(), versions: new Set<string>() };
      bucket.count += 1;
      bucket.titles.add(hit.title);
      bucket.versions.add(hit.version);
      duplicateCanonicalMap.set(bucketKey, bucket);
    }
    const duplicateCanonicalTopics = [...duplicateCanonicalMap.values()]
      .filter((item) => item.count > 1)
      .map((item) => ({
        canonicalTopicKey: item.canonicalTopicKey,
        count: item.count,
        titles: [...item.titles].sort().slice(0, 8),
        versions: [...item.versions].sort(naturalVersionSort)
      }))
      .sort((a, b) => b.count - a.count || a.canonicalTopicKey.localeCompare(b.canonicalTopicKey))
      .slice(0, 40);
    const sparseCategories = Object.entries(coverage.byCategory)
      .filter(([, count]) => count < 50)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.count - b.count);
    const criticalSparseCategories = sparseCategories.filter((item) => ["cl-clle", "ile-rpg", "dds", "sql-db2-for-i", "mensajes-rnf"].includes(item.category));
    const worstDuplicateCount = duplicateCanonicalTopics[0]?.count ?? 0;
    return {
      ok: pack.ok && shortDocuments.length < 100 && documentKinds.stub < 100 && criticalSparseCategories.length === 0 && worstDuplicateCount < 100 && duplicateTitlesSameVersion.every((item) => item.count < 20),
      generatedAt: new Date().toISOString(),
      corpusVersion: manifest.corpusVersion,
      documents: pack.documents,
      chunks: pack.chunks,
      coverage,
      shortDocuments,
      duplicateTitles,
      duplicateTitlesSameVersion,
      duplicateTitlesCrossVersionExpected,
      duplicateCanonicalTopics,
      documentKinds,
      sparseCategories,
      benchmarkHints: [
        "Agregar golden queries para comandos CRT*, DSP*, WRK*, opcodes RPG, BIFs %, DDS keywords y mensajes RNF/SQL.",
        "Revisar tópicos cortos: pueden ser redirecciones, páginas índice o contenido incompleto.",
        "Usar ibmi_docs_explain_ranking cuando un resultado parezca inesperado."
      ],
      recommendations: [
        "Mantener al menos una query dorada por categoría y por familia técnica.",
        "Publicar data packs como release assets y validarlos con pack:validate antes de anunciarlos.",
        "Evitar dependencias runtime a RDi, Eclipse Help o endpoints loopback."
      ]
    };
  }

  recipes(): DocsRecipe[] {
    return RECIPES;
  }

  reportQuery(options: QueryReportOptions): QueryReport {
    const started = Date.now();
    const results = this.search({ ...options, limit: options.limit ?? 8, mode: options.mode ?? "hybrid", includeSections: true });
    const ranking = this.explainRanking({ ...options, top: Math.min(options.limit ?? 8, 12), mode: options.mode ?? "hybrid" });
    const exactTerms = extractExactTechnicalTerms(options.query);
    const warnings = [
      ...results.flatMap((hit) => hit.relevanceWarnings ?? []),
      ...(results[0]?.requestedVersionFallback ? [`El top result usa fallback desde ${results[0].version} para una consulta versionada.`] : []),
      ...(!results.length ? ["Sin resultados para la consulta."] : [])
    ];
    const pass = Boolean(results.length)
      && (!options.expectedTitle || results.some((hit) => hit.title.toLowerCase().includes(options.expectedTitle!.toLowerCase())))
      && (!options.expectedId || results.some((hit) => hit.id === options.expectedId))
      && !results[0]?.relevanceWarnings?.some((warning) => warning.includes("sin términos exactos"));
    const report: QueryReport = {
      generatedAt: new Date().toISOString(),
      query: options.query,
      options,
      diagnostics: {
        topResultTitle: results[0]?.title,
        topResultId: results[0]?.id,
        exactTerms,
        ftsQuery: toFtsQuery(options.query),
        pass,
        warnings: [...new Set(warnings)].slice(0, 12)
      },
      results,
      ranking,
      issueMarkdown: ""
    };
    report.issueMarkdown = renderQueryIssueMarkdown(report);
    this.recordTrace("ibmi_docs_report_query", started, {
      query: options.query,
      resultCount: results.length,
      topResultId: results[0]?.id,
      topResultTitle: results[0]?.title
    });
    return report;
  }

  workflowPolicy(intent: DocsIntent): WorkflowPolicy {
    return WORKFLOW_POLICIES[intent];
  }

  resolve(options: ResolveOptions): ResolveResult {
    const started = Date.now();
    const intent = classifyResolveIntent(options);
    const policy = WORKFLOW_POLICIES[intent];
    const limit = clamp(options.limit, policy.defaultLimit, 1, 12);
    const stages: WorkflowStage[] = [];
    const evidenceById = new Map<string, SearchHit>();
    const addEvidence = (hits: SearchHit[] | undefined): void => {
      for (const hit of hits ?? []) {
        const existing = evidenceById.get(hit.id);
        if (!existing || hit.score > existing.score) evidenceById.set(hit.id, hit);
      }
    };
    const addStage = (stage: WorkflowStage): void => {
      stages.push(stage);
    };

    const searchHits = this.search({
      query: options.question,
      version: options.version,
      category: options.category,
      limit,
      mode: "hybrid",
      autoRead: intent === "syntax_lookup" || isLikelyIbmCommandQuery(options.question),
      includeSections: true
    });
    addEvidence(searchHits);
    addStage({
      tool: "ibmi_docs_search",
      reason: "Descubrir candidatos y anclar la consulta a documentos concretos del corpus local.",
      status: "executed",
      evidenceIds: searchHits.slice(0, 5).map((hit) => hit.id),
      outputSummary: `${searchHits.length} candidato(s); top=${searchHits[0]?.title ?? "sin resultado"}`
    });

    const readLimit = intent === "ranking_debug" ? 1 : Math.min(3, searchHits.length);
    const reads = searchHits.slice(0, readLimit).map((hit) => this.read(hit.id)).filter((value): value is ReadResult => Boolean(value));
    addStage({
      tool: "ibmi_docs_read",
      reason: "Leer texto completo de los tópicos principales; search solo no basta para responder.",
      status: reads.length ? "executed" : "skipped",
      evidenceIds: reads.map((read) => read.id),
      outputSummary: reads.length ? `${reads.length} tópico(s) leídos.` : "Sin tópico legible."
    });

    const sectionTopics = reads.map((read) => ({ id: read.id, title: read.title, sections: read.sections ?? [] }));
    addStage({
      tool: "ibmi_docs_sections",
      reason: "Extraer secciones de sintaxis, parámetros, ejemplos, notas y recovery cuando existan.",
      status: sectionTopics.some((topic) => topic.sections.length) ? "executed" : "skipped",
      evidenceIds: sectionTopics.map((topic) => topic.id),
      outputSummary: `${sectionTopics.reduce((total, topic) => total + topic.sections.length, 0)} sección(es) detectadas.`
    });

    const messageId = extractMessageId(options.question);
    const versions = extractVersions(options.question);
    const preset = resolvePreset(options.language ?? options.question ?? options.code);
    const intentAxes = detectIntentAxes([options.question, options.language, options.code].filter(Boolean).join("\n"));

    // En guía de compilación el resumen final se arma desde context + compileGuidance;
    // ejecutar answer además duplica búsquedas/lecturas y vuelve el workflow innecesariamente pesado.
    const answerResult = intent !== "ranking_debug" && intent !== "compile_guidance" && intent !== "message_diagnostic"
      ? this.answer({
          question: options.question,
          language: options.language,
          version: options.version,
          category: options.category,
          includeExamples: options.includeExamples,
          includeCompileCommands: options.includeCompileCommands || intent === "code_review",
          limit
        })
      : undefined;
    if (answerResult) {
      addEvidence(answerResult.evidence);
      addStage({
        tool: "ibmi_docs_answer",
        reason: "Construir respuesta extractiva con citas y advertencias.",
        status: "executed",
        evidenceIds: answerResult.citations.map((citation) => citation.id),
        outputSummary: `confianza=${answerResult.confidence}; citas=${answerResult.citations.length}`
      });
    }

    const shouldBuildCompileAxis = intent === "compile_guidance" || intent === "code_review" || (intent === "multi_intent" && intentAxes.has("compile"));

    const context = shouldBuildCompileAxis
      ? this.context({ task: options.question, language: options.language ?? preset?.language, version: options.version, limit })
      : undefined;
    if (context) {
      addEvidence(context.evidence);
      addStage({
        tool: "ibmi_docs_context",
        reason: "Empaquetar contexto por lenguaje, señales y comandos relevantes.",
        status: "executed",
        evidenceIds: context.evidence.slice(0, 5).map((hit) => hit.id),
        outputSummary: `lenguaje=${context.intent.language}; comandos=${context.compileCommands.join(", ") || "n/a"}`
      });
    }

    const compileGuidance = shouldBuildCompileAxis
      ? this.compileGuidance({
          language: options.language ?? preset?.language ?? "RPGLE",
          version: options.version,
          usesEmbeddedSql: /exec\s+sql|sqlrpgle|crtsqlrpgi/i.test([options.question, options.code].filter(Boolean).join("\n")),
          usesCopybook: /\/\s*(copy|include)\b/i.test([options.question, options.code].filter(Boolean).join("\n")),
          limit
        })
      : undefined;
    if (compileGuidance) {
      addEvidence(compileGuidance.evidence);
      addStage({
        tool: "ibmi_docs_compile_guidance",
        reason: "Resolver comandos/opciones de compilación desde documentación local.",
        status: "executed",
        evidenceIds: compileGuidance.evidence.slice(0, 5).map((hit) => hit.id),
        outputSummary: `comandos=${compileGuidance.recommendedCommands.join(", ")}`
      });
    }

    const messageExplanation = (intent === "message_diagnostic" || intent === "multi_intent") && messageId
      ? this.explainMessage({ messageId, limit })
      : undefined;
    if (messageExplanation) {
      addEvidence(messageExplanation.evidence);
      addStage({
        tool: "ibmi_docs_explain_message",
        reason: "Diagnosticar mensaje/familia y checklist de recuperación.",
        status: "executed",
        evidenceIds: messageExplanation.evidence.slice(0, 5).map((hit) => hit.id),
        outputSummary: `${messageExplanation.messageId}: ${messageExplanation.summary}`
      });
    }

    const versionComparison = intent === "version_question"
      ? this.compareVersions({ query: options.question, versions: versions.length ? versions : DEFAULT_VERSIONS, category: options.category, limit: Math.min(limit, 5) })
      : undefined;
    if (versionComparison) {
      addEvidence(versionComparison.evidence);
      addStage({
        tool: "ibmi_docs_compare_versions",
        reason: "Comparar disponibilidad y estructura entre releases IBM i.",
        status: "executed",
        evidenceIds: versionComparison.evidence.slice(0, 5).map((hit) => hit.id),
        outputSummary: `${versionComparison.versions.filter((entry) => entry.found).length}/${versionComparison.versions.length} versiones con evidencia.`
      });
    }

    const rankingExplanation = intent === "ranking_debug"
      ? this.explainRanking({ query: options.question, version: options.version, category: options.category, top: Math.min(limit, 8) })
      : undefined;
    if (rankingExplanation) {
      addEvidence(rankingExplanation.results.map((item) => item.hit));
      addStage({
        tool: "ibmi_docs_explain_ranking",
        reason: "Explicar ranking, expansiones semánticas y razones de match.",
        status: "executed",
        evidenceIds: rankingExplanation.results.slice(0, 5).map((item) => item.hit.id),
        outputSummary: `${rankingExplanation.results.length} resultado(s) explicado(s).`
      });
    }

    const codeValidation = intent === "code_review" && options.code
      ? this.validateCodeContext({ language: options.language ?? preset?.language ?? "RPGLE", code: options.code, limit })
      : undefined;
    if (codeValidation) {
      addEvidence(codeValidation.evidence);
      addStage({
        tool: "ibmi_docs_validate_code_context",
        reason: "Detectar señales del código y mapearlas a evidencia documental.",
        status: "executed",
        evidenceIds: codeValidation.evidence.slice(0, 5).map((hit) => hit.id),
        outputSummary: `${codeValidation.findings.length} hallazgo(s); señales=${codeValidation.detectedSignals.join(", ") || "n/a"}`
      });
    }

    const related = reads[0] ? this.related(reads[0].id, { limit: Math.min(limit, 6) }) : undefined;
    if (related) {
      addEvidence(related.equivalentVersions);
      addEvidence(related.related);
      addStage({
        tool: "ibmi_docs_related",
        reason: "Agregar equivalentes por versión y documentos relacionados para navegación posterior.",
        status: "executed",
        evidenceIds: [...related.equivalentVersions, ...related.related].slice(0, 5).map((hit) => hit.id),
        outputSummary: `${related.equivalentVersions.length} equivalente(s), ${related.related.length} relacionado(s).`
      });
    }

    const evidence = [...evidenceById.values()]
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .map(sanitizeContextHit);
    const requiredEvidenceWarnings = buildRequiredEvidenceWarnings({
      intent,
      messageExplanation,
      compileGuidance,
      versionComparison,
      evidence
    });
    const warnings = [
      ...(answerResult?.warnings ?? []),
      ...requiredEvidenceWarnings,
      ...mixedIntentWarnings(intent, intentAxes, messageId),
      ...(!evidence.length ? ["No se encontró evidencia documental suficiente; no inventar detalles fuera del corpus."] : []),
      ...(intent === "search_discovery" ? ["Esta resolución es exploratoria: la evidencia se entrega resumida y los IDs quedan como trazabilidad de auditoría."] : [])
    ];
    const suggestedTools: string[] = [];

    const result: ResolveResult = {
      question: options.question,
      intent,
      policy,
      answer: buildResolvedAnswer({
        options,
        intent,
        policy,
        answerResult,
        reads,
        sections: sectionTopics,
        context,
        compileGuidance,
        messageExplanation,
        versionComparison,
        rankingExplanation,
        codeValidation,
        related
      }),
      confidence: computeResolveConfidence({ intent, evidence, answerResult, messageExplanation, compileGuidance, versionComparison, warnings }),
      stages,
      evidence,
      reads,
      sections: sectionTopics,
      citations: answerResult?.citations ?? reads.map((read) => ({
        id: read.id,
        title: read.title,
        version: read.version,
        sourceKind: read.sourceKind,
        canonicalUrl: read.canonicalUrl,
        section: pickBestSection(read.sections ?? [], options.question)?.title
      })),
      answerResult,
      context,
      compileGuidance,
      messageExplanation,
      versionComparison,
      rankingExplanation,
      codeValidation,
      related,
      suggestedTools,
      warnings
    };
    this.recordTrace("ibmi_docs_resolve", started, {
      query: options.question,
      intent,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  traceReport(limit = 30): TraceReport {
    return buildTraceReport(this.traceFile(), clamp(limit, 30, 1, 200));
  }

  related(id: string, options: RelatedOptions = {}): RelatedDocuments {
    const started = Date.now();
    const topic = this.read(id);
    if (!topic) {
      this.recordTrace("ibmi_docs_related", started, { id, resultCount: 0 });
      return { topic: null, equivalentVersions: [], related: [] };
    }
    const equivalentVersions = this.findEquivalentVersions(topic).filter((hit) => hit.id !== id).map(sanitizeContextHit);
    const relatedQuery = [topic.title, topic.breadcrumbs.slice(-3).join(" ")].filter(Boolean).join(" ");
    const related = this.search({ query: relatedQuery, category: topic.category, limit: options.limit ?? 8 }).filter((hit) => hit.id !== id).map(sanitizeContextHit);
    const result = { topic, equivalentVersions, related };
    this.recordTrace("ibmi_docs_related", started, {
      id,
      query: relatedQuery,
      resultCount: equivalentVersions.length + related.length,
      topResultId: topic.id,
      topResultTitle: topic.title
    });
    return result;
  }

  compareVersions(options: CompareVersionsOptions): VersionComparison {
    const started = Date.now();
    const versions = (options.versions?.length ? options.versions : DEFAULT_VERSIONS).map((version) => normalizeVersionInput(version));
    const evidence: SearchHit[] = [];
    const entries = versions.map((version) => {
      const result = this.search({ query: options.query, version, category: options.category, limit: options.limit ?? 5 })[0];
      if (result) evidence.push(result);
      const read = result ? this.read(result.id) : null;
      const sections = read?.sections ?? [];
      return {
        version,
        found: Boolean(result),
        result: result ? sanitizeContextHit(result) : undefined,
        notes: result ? [
          `Encontrado: ${result.title} (${result.sourceKind})`,
          `Longitud normalizada: ${read?.textLength ?? result.textLength ?? 0} caracteres.`,
          `Secciones detectadas: ${sections.map((section) => section.kind).filter(unique).slice(0, 8).join(", ") || "n/a"}.`
        ] : ["No se encontró tópico equivalente para esta versión."],
        structural: {
          textLength: read?.textLength ?? result?.textLength ?? 0,
          sectionKinds: sections.map((section) => section.kind).filter(unique),
          sha256: read?.sha256
        }
      };
    });
    const baseline = entries.find((entry) => entry.found && (entry as any).structural.textLength > 0) as any;
    if (baseline) {
      for (const entry of entries as any[]) {
        if (!entry.found || entry === baseline) continue;
        const delta = entry.structural.textLength - baseline.structural.textLength;
        const missing = baseline.structural.sectionKinds.filter((kind: string) => !entry.structural.sectionKinds.includes(kind));
        entry.notes.push(`Delta vs ${baseline.version}: ${delta >= 0 ? "+" : ""}${delta} caracteres.`);
        if (missing.length) entry.notes.push(`Secciones presentes en baseline y ausentes aquí: ${missing.join(", ")}.`);
      }
    }
    const result: VersionComparison = { query: options.query, versions: entries, evidence: evidence.map(sanitizeContextHit) };
    this.recordTrace("ibmi_docs_compare_versions", started, {
      query: options.query,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  validateCodeContext(options: CodeValidationOptions): CodeValidationResult {
    const started = Date.now();
    const preset = resolvePreset(options.language) ?? resolvePreset(options.code);
    const detectedSignals = detectSignals(options.code, options.language, preset);
    const queries = [options.language, ...detectedSignals, ...(preset?.queries ?? [])].filter(Boolean);
    const evidence = this.searchMany(queries, { category: preset?.category, limit: options.limit ?? 8 });
    const findings: CodeValidationFinding[] = [];
    if (/exec\s+sql/i.test(options.code) && preset?.language !== "SQLRPGLE") {
      findings.push({
        severity: "warning",
        title: "SQL embebido detectado",
        detail: "El código contiene EXEC SQL; validar si debe compilarse con CRTSQLRPGI en lugar de solo CRTRPGMOD/CRTBNDRPG.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/\/\s*(copy|include)\b/i.test(options.code)) {
      findings.push({
        severity: "info",
        title: "Directivas /COPY o /INCLUDE detectadas",
        detail: "Contrastar el tratamiento de /COPY e /INCLUDE con el precompilador SQL y revisar RPGPPOPT si es SQLRPGLE.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/\*inlr\s*=\s*\*on/i.test(options.code)) {
      findings.push({
        severity: "info",
        title: "Finalización RPG detectada",
        detail: "Se detectó *INLR = *ON; validar que el ciclo de vida del programa sea el deseado para el caso de uso.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/monmsg/i.test(options.code)) {
      findings.push({
        severity: /monmsg\s+msgid\s*\(\s*cpf0000\s*\)/i.test(options.code) ? "warning" : "info",
        title: "MONMSG detectado en CL",
        detail: /cpf0000/i.test(options.code)
          ? "Se detectó MONMSG con CPF0000; revisar alcance para no ocultar errores no esperados y confirmar recuperación por mensaje específico."
          : "Se detectó MONMSG; validar que el mensaje cubierto y el alcance del manejador sean intencionales.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/sbmjob/i.test(options.code)) {
      findings.push({
        severity: "info",
        title: "SBMJOB detectado",
        detail: "Revisar JOB, JOBQ, USER, CURLIB/INLLIBL y el contexto de ejecución del trabajo sometido.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/sndpgmmsg/i.test(options.code)) {
      findings.push({
        severity: /cpf9898/i.test(options.code) ? "warning" : "info",
        title: "SNDPGMMSG detectado",
        detail: "Validar MSGID, MSGF, MSGDTA y cola destino. Si se usa CPF9898, confirmar texto de sustitución y severidad esperada.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/rtvjoba/i.test(options.code)) {
      findings.push({
        severity: "info",
        title: "RTVJOBA detectado",
        detail: "Validar variables receptoras y atributos de trabajo recuperados antes de usarlos en decisiones de flujo.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (/\bcall\s+pgm\s*\(/i.test(options.code)) {
      findings.push({
        severity: "info",
        title: "CALL PGM detectado",
        detail: "Revisar compatibilidad de parámetros CL con la firma del programa llamado y manejo de escape messages.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    if (!findings.length) {
      findings.push({
        severity: "info",
        title: "Sin señales críticas automáticas",
        detail: "No se detectaron patrones problemáticos básicos; revisar evidencia documental recomendada para el lenguaje.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    const result: CodeValidationResult = {
      language: preset?.language ?? normalizeLanguage(options.language) ?? options.language,
      detectedSignals,
      findings,
      evidence: evidence.map(sanitizeContextHit)
    };
    this.recordTrace("ibmi_docs_validate_code_context", started, {
      query: options.language,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  private traceFile(): string {
    return defaultTraceFile();
  }

  private recordTrace(tool: string, started: number, event: Omit<TraceEvent, "timestamp" | "tool" | "durationMs">): void {
    if (!isTraceEnabled()) return;
    appendTraceEvent(this.traceFile(), {
      timestamp: new Date().toISOString(),
      tool,
      durationMs: Date.now() - started,
      ...event
    });
  }

  private searchMany(queries: string[], options: Omit<SearchOptions, "query">): SearchHit[] {
    const limit = clamp(options.limit, 8, 1, 50);
    const byId = new Map<string, SearchHit>();
    for (const query of queries) {
      const hits = this.search({ ...options, query, limit });
      for (const hit of hits) {
        const existing = byId.get(hit.id);
        if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  private findEquivalentVersions(topic: SearchHit): SearchHit[] {
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url, d.text_length,
             d.breadcrumbs_json, c.body, c.chunk_index, 0 AS rank
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
      WHERE lower(d.title) = lower(@title)
      ORDER BY d.version
      LIMIT 20
    `).all({ title: topic.title }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...rowToHit(row, topic.title), score: 5 }));
  }

  private findExactTechnicalRows(terms: string[], options: SearchOptions): Array<Record<string, unknown>> {
    if (!terms.length) return [];
    const rows: Array<Record<string, unknown>> = [];
    const filters: string[] = [];
    const baseParams: Record<string, string> = {};
    if (options.version) {
      filters.push("d.version = @version");
      baseParams.version = normalizeVersionInput(options.version);
    }
    if (options.category) {
      filters.push("d.category = @category");
      baseParams.category = options.category;
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url, d.text_length,
             d.breadcrumbs_json, c.body, c.chunk_index, 9999 AS rank
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
      WHERE (
        lower(d.title) LIKE @like ESCAPE '\\'
        OR lower(d.breadcrumbs_json) LIKE @like ESCAPE '\\'
      ) ${where}
      ORDER BY
        CASE
          WHEN lower(d.title) LIKE @titlePrefix ESCAPE '\\' THEN 0
          WHEN lower(d.title) LIKE @like ESCAPE '\\' THEN 1
          WHEN lower(d.breadcrumbs_json) LIKE @like ESCAPE '\\' THEN 2
          ELSE 3
        END,
        d.title ASC
      LIMIT 30
    `);
    for (const term of terms.slice(0, 6)) {
      rows.push(...(stmt.all({ ...baseParams, like: likePattern(term), titlePrefix: `${escapeLike(term)}%` }) as Array<Record<string, unknown>>));
    }
    return rows;
  }
}

export function toFtsQuery(query: string): string {
  const tokens = tokenize(query).slice(0, 16);
  const expanded = expandIbmiTerms(tokens);
  // Cada token se escapa y se consulta como frase para evitar inyección FTS; todo entra por parámetro preparado.
  const safeTokens = expanded.flatMap(toFtsSafeTokens).slice(0, 48);
  return [...new Set(safeTokens)].map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
}

function toFtsSafeTokens(token: string): string[] {
  return token
    .replace(/^%+/, "")
    .split(/[^\p{L}\p{N}_]+/gu)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !FTS_STOPWORDS.has(part));
}

function expandIbmiTerms(tokens: string[]): string[] {
  const synonyms: Record<string, string[]> = {
    crtrpgmod: ["create", "module", "ile", "rpg", "rpgle"],
    crtbndrpg: ["create", "bound", "program", "ile", "rpg"],
    crtsqlrpgi: ["sql", "rpg", "embedded", "precompiler", "sqlrpgle"],
    sqlrpgle: ["sql", "rpg", "embedded", "crtsqlrpgi"],
    rpgle: ["rpg", "ile", "crtrpgmod", "crtbndrpg"],
    clle: ["cl", "control", "language", "ile", "crtbndcl"],
    dspf: ["display", "file", "dds"],
    pf: ["physical", "file", "dds"],
    lf: ["logical", "file", "dds"],
    rnf0004: ["rnf", "rpg", "messages"],
    unique: ["unique", "keyword", "physical", "logical", "files"]
  };
  return tokens.flatMap((token) => [token, ...(synonyms[token] ?? [])]);
}

function rowToHit(row: Record<string, unknown>, query: string): SearchHit {
  const id = String(row.id);
  const hit: SearchHit = {
    id,
    title: String(row.title),
    snippet: makeSnippet(String(row.body ?? ""), query, 520),
    score: 0,
    sourceKind: String(row.source_kind) as SearchHit["sourceKind"],
    sourceId: String(row.source_id),
    version: String(row.version),
    category: String(row.category),
    canonicalUrl: String(row.canonical_url),
    breadcrumbs: safeJsonArray(String(row.breadcrumbs_json || "[]")),
    textLength: Number(row.text_length ?? 0),
    readHint: `Para obtener la ayuda completa llama ibmi_docs_read con id="${id}".`
  };
  hit.documentKind = classifyDocumentKind(hit, String(row.body ?? ""));
  hit.canonicalTopicKey = canonicalTopicKey(hit);
  return hit;
}

function classifyDocumentKind(hit: Pick<SearchHit, "title" | "breadcrumbs" | "textLength" | "category">, body: string): SearchHit["documentKind"] {
  const title = fold(hit.title);
  const breadcrumbs = fold(hit.breadcrumbs?.join(" ") ?? "");
  const haystack = `${title} ${breadcrumbs}`;
  const textLength = hit.textLength ?? body.length;
  if (textLength > 0 && textLength < 300) return "stub";
  if (/^(ibm rational developer|ibm i documentation|welcome|home)$/.test(title)) return "landing";
  if (/^[a-z0-9]{3,12}\s+command$/.test(title) || /^description of the .+ command$/.test(title)) return "reference";
  if (/\b(snd-msg|chain|reade|readp|monitor|on-error)\b/.test(title) && /\b(operation|opcode)\b/.test(haystack)) return "reference";
  if (/^%[a-z][a-z0-9_-]+/.test(title) && /built-in function/.test(haystack)) return "reference";
  if (/\b(what'?s new|contents|table of contents|appendix|appendixes|index|overview)\b/.test(haystack)) return "index";
  if (/\b(reference|programmer'?s guide|language reference|messages and codes|keyword finder)\b/.test(title)) return "reference";
  return "topic";
}

function canonicalTopicKey(hit: Pick<SearchHit, "title" | "category" | "breadcrumbs">): string {
  const title = fold(hit.title)
    .replace(/\b(description of the|using the|command|keyword|operation code|built-in function|send a message to the joblog)\b/g, " ")
    .replace(/[()%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const technical = extractExactTechnicalTerms(hit.title)[0] ?? extractPrimaryTechnicalTerm(hit.title);
  const category = fold(hit.category ?? "general").replace(/[^a-z0-9]+/g, "-");
  const breadcrumbTail = fold(hit.breadcrumbs?.slice(-2).join(" ") ?? "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const base = technical ? technical.replace(/[^a-z0-9%_-]+/g, "-") : title.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return [category, base || breadcrumbTail || "topic"].filter(Boolean).join(":");
}

function documentKindScoreAdjustment(hit: SearchHit): number {
  switch (hit.documentKind) {
    case "topic":
      return 8;
    case "reference":
      return 2;
    case "index":
      return -18;
    case "landing":
      return -45;
    case "stub":
      return -35;
    default:
      return 0;
  }
}

function buildRelevanceWarnings(hit: SearchHit, body: string, options: SearchOptions): string[] {
  const warnings: string[] = [];
  const exactTerms = extractExactTechnicalTerms(options.query);
  const haystack = fold([hit.title, hit.breadcrumbs.join(" "), body.slice(0, 4000)].join(" "));
  if (exactTerms.length && !exactTerms.some((term) => haystack.includes(fold(term)))) {
    warnings.push(`Resultado penalizado: sin términos exactos (${exactTerms.join(", ")}) en título, ruta ni contenido principal.`);
  }
  const messageTerms = exactTerms.filter(isMessageIdTerm);
  if (messageTerms.length && !isMessageEvidenceHit(hit, messageTerms[0])) {
    warnings.push(`Resultado penalizado: ${messageTerms.join(", ")} aparece fuera de una fuente/categoría de mensajes IBM i.`);
  }
  if (hit.documentKind === "stub") warnings.push("Documento clasificado como stub/corto; úsalo solo como pista, no como evidencia principal.");
  if (hit.documentKind === "index") warnings.push("Documento clasificado como índice/novedades; puede mencionar el término sin ser el tópico canónico.");
  return [...new Set(warnings)];
}

function selectAnswerEvidence(hits: SearchHit[], query: string): SearchHit[] {
  const exactTerms = extractExactTechnicalTerms(query);
  const filtered = hits.filter((hit) => {
    if (hit.documentKind === "stub" || hit.documentKind === "landing") return false;
    if (!exactTerms.length) return true;
    return !(hit.relevanceWarnings ?? []).some((warning) => warning.includes("Resultado penalizado"));
  });
  if (exactTerms.length) return filtered;
  // Si solo hay índices, conservamos el mejor índice antes que devolver nada,
  // pero la respuesta quedará con advertencias y confianza baja/media.
  return filtered.length ? filtered : hits.filter((hit) => hit.documentKind !== "landing").slice(0, 1);
}

function buildContextQueries(task: string, preset?: LanguagePreset): string[] {
  const exactTerms = extractExactTechnicalTerms(task);
  const technicalQueries = exactTerms.flatMap((term) => {
    if (isMessageIdTerm(term)) return [term.toUpperCase()];
    if (IBM_I_COMMAND_PREFIX_PATTERN.test(term)) {
      const aliases = IBM_I_COMMAND_ALIASES[fold(term)] ?? [];
      return [
        term.toUpperCase(),
        `${term.toUpperCase()} command`,
        ...aliases,
        ...aliases.map((alias) => `${alias} ${term.toUpperCase()}`)
      ];
    }
    if (term.startsWith("%")) return [`${term.toUpperCase()} built-in function`, term.toUpperCase()];
    if (term.includes("-")) return [term.toUpperCase()];
    return [term];
  });
  const familyQueries = [
    ...(/\bCPF\b/i.test(task) && !/\bCPF\d{4}\b/i.test(task) ? ["CPF messages", "MONMSG command CPF"] : []),
    ...(/\bMCH\b/i.test(task) && !/\bMCH\d{4}\b/i.test(task) ? ["MCH messages", "MONMSG command MCH"] : []),
    ...(/\bRNF\b/i.test(task) && !/\bRNF\d{4}\b/i.test(task) ? ["RPG Messages RNF"] : [])
  ];
  return [...new Set([
    task,
    ...technicalQueries,
    ...familyQueries,
    ...(preset?.queries ?? []),
    ...(preset?.compileCommands.map((command) => `${command} command`) ?? [])
  ].filter(Boolean))].slice(0, 18);
}

function isAdministrationQuery(haystack: string): boolean {
  return /wrkactjob|wrkobjlck|dspjob\b|wrkjob\b|wrkjoblog|dspjoblog|wrkjobq|sbmjob|jobq|trabajos?\s+activos?|active\s+jobs?|running\s+job|bloqueos?|locks?|object\s+locks?|job\s+locks?|subsystem|subsistema|joblog/i.test(haystack);
}

function isDb2CatalogQuery(haystack: string): boolean {
  return /syscolumns|systables|sysindexes|qsys2\.|cat[aá]logo|catalog|metadata|metadatos|columnas?|tablas?|vistas?\s+de\s+cat[aá]logo/i.test(haystack);
}

function buildAdministrationQueries(haystack: string): string[] {
  const queries: string[] = [];
  const wantsActiveJobs = /wrkactjob|trabajos?\s+activos?|active\s+jobs?|running\s+job/i.test(haystack);
  const wantsLocks = /wrkobjlck|bloqueos?|locks?|object\s+locks?|job\s+locks?/i.test(haystack);
  const wantsJob = /dspjob\b|wrkjob\b|job\s+parameter|display\s+job|work\s+with\s+job/i.test(haystack);
  if (wantsActiveJobs || isAdministrationQuery(haystack)) {
    queries.push("WRKACTJOB Work with Active Jobs");
    queries.push("Debugging a job that is running WRKACTJOB");
    queries.push("active jobs WRKACTJOB command");
  }
  if (wantsLocks || isAdministrationQuery(haystack)) {
    queries.push("WRKOBJLCK Work with Object Locks");
    queries.push("Displaying the lock states for objects WRKOBJLCK");
    queries.push("object locks WRKOBJLCK command");
  }
  if (wantsJob || isAdministrationQuery(haystack)) {
    queries.push("DSPJOB Display Job");
    queries.push("WRKJOB Work with Job");
    queries.push("JOB parameter DSPJOB WRKJOB");
    queries.push("Displaying a job log DSPJOBLOG WRKJOBLOG");
  }
  return [...new Set(queries)];
}

function buildDb2CatalogQueries(haystack: string): string[] {
  const queries = ["Db2 for i catalog views", "QSYS2 catalog views", "SYSCOLUMNS catalog view", "SYSTABLES catalog view"];
  if (/columnas?|syscolumns/i.test(haystack)) queries.unshift("QSYS2 SYSCOLUMNS column metadata");
  if (/tablas?|systables/i.test(haystack)) queries.unshift("QSYS2 SYSTABLES table metadata");
  return [...new Set(queries)];
}

function buildAssistRetrievalAxes(options: AssistOptions, resolved: ResolveResult, context: ContextPackage): Set<AssistRetrievalAxis> {
  const haystack = [options.question, options.language, options.code, context.intent.detectedSignals.join(" ")].filter(Boolean).join("\n");
  const detected = detectIntentAxes(haystack);
  const axes = new Set<AssistRetrievalAxis>(["primary"]);
  if (detected.has("syntax") || detected.has("command") || extractExactTechnicalTerms(haystack).length) axes.add("syntax");
  if (detected.has("compile") || resolved.compileGuidance || /crt(sqlrpgi|rpgmod|bndrpg|bndcl|pf|lf)|RPGPPOPT|DBGVIEW|copybook|\/\s*(copy|include)\b/i.test(haystack)) axes.add("compile");
  if (detected.has("message") || resolved.messageExplanation) axes.add("message");
  if (detected.has("version") || resolved.versionComparison) axes.add("version");
  if (options.code?.trim() || resolved.codeValidation) axes.add("code");
  if (isAdministrationQuery(haystack)) axes.add("administration");
  if (isDb2CatalogQuery(haystack)) axes.add("database");
  if (resolved.related) axes.add("related");
  return axes;
}

function buildAssistInitialQueries(options: AssistOptions, preset: LanguagePreset | undefined, axes: Set<AssistRetrievalAxis>): string[] {
  const haystack = [options.question, options.language, options.code].filter(Boolean).join("\n");
  const technicalTerms = extractAssistTechnicalTerms(haystack);
  const exactTerms = extractExactTechnicalTerms(haystack);
  const messageId = extractMessageId(haystack);
  const queries: string[] = [];
  if (messageId) {
    queries.push(messageId);
    queries.push(`${messageId.slice(0, 3)} messages`);
  }
  if (axes.has("administration")) {
    queries.push(...buildAdministrationQueries(haystack));
  }
  if (axes.has("compile")) {
    const language = normalizeLanguage(options.language ?? options.question) ?? preset?.language;
    if (language) queries.push(`${language} compile options`);
    if (/sqlrpgle|exec\s+sql|embedded\s+sql/i.test(haystack) || language === "SQLRPGLE") {
      queries.push("CRTSQLRPGI command");
      queries.push("RPGPPOPT SQLRPGLE /COPY /INCLUDE");
      queries.push("Using /COPY /INCLUDE in Source Files with Embedded SQL");
    }
    for (const command of preset?.compileCommands ?? []) queries.push(`${command} command`);
  }
  if (axes.has("syntax")) {
    for (const term of exactTerms) {
      const upper = term.toUpperCase();
      if (isMessageIdTerm(term)) continue;
      if (IBM_I_COMMAND_PREFIX_PATTERN.test(term)) {
        queries.push(`${upper} command`);
        queries.push(`${upper} command parameters`);
        queries.push(`${upper} syntax`);
        for (const alias of IBM_I_COMMAND_ALIASES[fold(term)] ?? []) queries.push(alias);
        continue;
      }
      if (term.startsWith("%")) {
        queries.push(`${upper} built-in function`);
        continue;
      }
      queries.push(upper);
    }
  }
  if (axes.has("database")) {
    queries.push(...buildDb2CatalogQueries(haystack));
  }
  for (const term of technicalTerms) {
    if (!queries.some((query) => fold(query).includes(fold(term)))) queries.push(term);
  }
  queries.push(options.question);
  if (axes.has("version")) {
    const versions = extractVersions(options.question);
    if (versions.length >= 2) queries.push(`${options.question} ${versions.join(" ")}`);
  }
  queries.push(...buildContextQueries(options.question, preset));
  return [...new Map(queries.filter(Boolean).map((query) => [fold(query), query.trim()])).values()].slice(0, 22);
}

function inferAssistAxisForQuery(query: string, axes: Set<AssistRetrievalAxis>): AssistRetrievalAxis {
  if (isAdministrationQuery(query)) return "administration";
  if (isDb2CatalogQuery(query)) return "database";
  if (/\b(RNF\d{4}|SQL\d{4,5}|CPF\d{4}|MCH\d{4}|RNF|CPF|MCH|SQLCODE|SQLSTATE)\b/i.test(query)) return "message";
  if (/compil|compile|crt(sqlrpgi|rpgmod|bndcl|bndrpg|pf|lf)|RPGPPOPT|DBGVIEW|COMMIT|\/\s*(copy|include)\b|copybook|sqlrpgle|embedded\s+sql/i.test(query)) return "compile";
  if (/(7\.[3456]).*(7\.[3456])|compar|release|versi[oó]n/i.test(query)) return "version";
  if (/sintaxis|syntax|par[aá]metro|parameter|operand|opcode|operation code|%[a-z][a-z0-9_-]+|\b[A-Z]{2,}-[A-Z]{2,}\b/i.test(query)) return "syntax";
  if (axes.has("syntax") && extractExactTechnicalTerms(query).length) return "syntax";
  return "primary";
}

function buildAssistSearchCategory(axis: AssistRetrievalAxis, query: string, options: AssistOptions, preset?: LanguagePreset): string | undefined {
  if (options.category && axis !== "message") return options.category;
  if (axis === "message") {
    const messageId = extractMessageId(query);
    if (!messageId) return undefined;
    if (messageId.startsWith("SQL")) return "sql-db2-for-i";
    if (messageId.startsWith("RNF")) return "mensajes-rnf";
    return undefined;
  }
  if (axis === "compile" && /sqlrpgle|exec\s+sql|crt(sqlrpgi)|RPGPPOPT|embedded\s+sql/i.test([query, options.language, options.question].filter(Boolean).join(" "))) return "sql-db2-for-i";
  if (axis === "administration") return "cl-clle";
  if (axis === "database") return "sql-db2-for-i";
  if (axis === "syntax" && /dds|crtp[fl]|physical file|logical file/i.test([query, options.language].filter(Boolean).join(" "))) return "dds";
  return preset?.category;
}

function buildAssistCompileFollowUpQueries(options: AssistOptions, guidance: CompileGuidance): string[] {
  const haystack = [options.question, options.language, options.code].filter(Boolean).join("\n");
  const queries = [
    ...guidance.recommendedCommands.map((command) => `${command} command`),
    ...guidance.optionsToReview.map((option) => `${option} compile option`),
    ...(/\/\s*(copy|include)\b|copybook/i.test(haystack) ? ["Using /COPY /INCLUDE in Source Files with Embedded SQL", "RPGPPOPT SQLRPGLE /COPY /INCLUDE"] : []),
    ...(/exec\s+sql|sqlrpgle|embedded\s+sql/i.test(haystack) ? ["SQLRPGLE embedded SQL RPG", "CRTSQLRPGI command parameters"] : [])
  ];
  return [...new Map(queries.filter(Boolean).map((query) => [fold(query), query])).values()].slice(0, 8);
}

function buildAssistGapFollowUpQueries(options: AssistOptions, coverage: AssistCoverage, axes: Set<AssistRetrievalAxis>): string[] {
  const queries: string[] = [];
  for (const term of coverage.missingTechnicalTerms) {
    const folded = fold(term);
    if (isMessageIdTerm(folded)) {
      queries.push(term.toUpperCase());
      queries.push(`${term.slice(0, 3).toUpperCase()} messages`);
      continue;
    }
    if (term.startsWith("%")) {
      queries.push(`${term.toUpperCase()} built-in function`);
      queries.push(`${term.toUpperCase()} examples`);
      continue;
    }
    if (IBM_I_COMMAND_PREFIX_PATTERN.test(folded)) {
      queries.push(`${term.toUpperCase()} command`);
      queries.push(`${term.toUpperCase()} command parameters`);
      queries.push(`${term.toUpperCase()} syntax`);
      for (const alias of IBM_I_COMMAND_ALIASES[folded] ?? []) queries.push(alias);
      continue;
    }
    queries.push(term.toUpperCase());
    queries.push(`${term.toUpperCase()} IBM i`);
    if (axes.has("compile")) queries.push(`${term.toUpperCase()} compile option`);
  }
  if (coverage.warnings.some((warning) => /sintaxis|par[aá]metros|secci[oó]n fuerte/i.test(warning))) {
    for (const term of coverage.matchedTechnicalTerms) {
      queries.push(`${term} syntax`);
      queries.push(`${term} parameters`);
    }
  }
  return [...new Map(queries.filter(Boolean).map((query) => [fold(query), query.trim()])).values()].slice(0, 12);
}

function readToCitation(read: ReadResult, title: string, section?: string): AnswerCitation {
  return {
    id: read.id,
    title,
    version: read.version,
    sourceKind: read.sourceKind,
    canonicalUrl: read.canonicalUrl,
    section
  };
}

function selectContextReadEvidence(hits: SearchHit[], task: string): SearchHit[] {
  const exactTerms = extractExactTechnicalTerms(task).map(fold);
  const candidates = selectAnswerEvidence(hits, task).length ? selectAnswerEvidence(hits, task) : hits;
  return [...candidates]
    .sort((a, b) => contextEvidenceScore(b, exactTerms) - contextEvidenceScore(a, exactTerms) || b.score - a.score || a.title.localeCompare(b.title));
}

function contextEvidenceScore(hit: SearchHit, exactTerms: string[]): number {
  const haystack = fold([hit.title, hit.snippet, hit.breadcrumbs.join(" "), hit.canonicalTopicKey ?? ""].join(" "));
  let score = hit.score;
  for (const term of exactTerms) {
    if (fold(hit.title).includes(term)) score += 70;
    else if (haystack.includes(term)) score += 35;
  }
  if (hit.synthetic) score += 20;
  if (hit.documentKind === "topic" || hit.documentKind === "reference") score += 12;
  if (hit.documentKind === "index") score -= 15;
  if ((hit.relevanceWarnings ?? []).some((warning) => warning.includes("sin términos exactos"))) score -= 40;
  return score;
}

function sanitizeContextHit(hit: SearchHit): SearchHit {
  const {
    readHint: _readHint,
    nextRecommendedTool: _nextRecommendedTool,
    nextRecommendedReason: _nextRecommendedReason,
    nextRecommendedArguments: _nextRecommendedArguments,
    workflowHints: _workflowHints,
    fullContent: _fullContent,
    autoReadApplied: _autoReadApplied,
    sectionsPreview: _sectionsPreview,
    ...safeHit
  } = hit;
  return safeHit;
}

function filterAssistResponseMaterial(input: {
  taskPlan: AssistTaskPlan;
  question: string;
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  citations: AnswerCitation[];
}): {
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  citations: AnswerCitation[];
} {
  const isRelevant = (text: string): boolean => isRelevantForTaskPlan(input.taskPlan, text);
  const evidence = input.evidence.filter((hit) => isRelevant([hit.title, hit.snippet, hit.breadcrumbs.join(" "), hit.category, hit.canonicalTopicKey ?? ""].join(" ")));
  const reads = input.reads.filter((read) => isRelevant([
    read.title,
    read.category,
    read.excerpt,
    read.focusedSections.map((section) => `${section.kind} ${section.title} ${section.content}`).join(" ")
  ].join(" ")));
  const sections = input.sections
    .map((topic) => {
      const topicRelevant = isRelevant(`${topic.title} ${topic.id}`);
      const topicSections = topic.sections.filter((section) => topicRelevant || isRelevant(`${section.kind} ${section.title} ${section.content}`));
      return { ...topic, sections: topicSections };
    })
    .filter((topic) => topic.sections.length > 0 || isRelevant(`${topic.title} ${topic.id}`));
  const citations = input.citations.filter((citation) => isRelevant([
    citation.title,
    citation.section ?? "",
    citation.sourceKind,
    citation.version,
    citation.canonicalUrl ?? ""
  ].join(" ")));

  // Para familias generales no filtramos. Para familias especializadas, si el filtro queda vacío,
  // devolvemos el material original para evitar una respuesta sin evidencia; el coverage/warnings
  // seguirá avisando. En los casos maduros esperados el filtro debe conservar material suficiente.
  if (usesTaskScopedMaterial(input.taskPlan) && (evidence.length || reads.length || sections.length || citations.length)) {
    return { evidence, reads, sections, citations };
  }
  return input;
}

function usesTaskScopedMaterial(taskPlan: AssistTaskPlan): boolean {
  return ["work_management", "object_lock_analysis", "db2_catalog_query", "design_dds_file", "design_display_or_report", "create_program"].includes(taskPlan.family);
}

function isRelevantForTaskPlan(taskPlan: AssistTaskPlan, text: string): boolean {
  if (!usesTaskScopedMaterial(taskPlan)) return true;
  const haystack = fold(text);
  switch (taskPlan.family) {
    case "work_management":
      return /wrkactjob|work with active jobs|active jobs|active job|wrkobjlck|work with object locks|object locks|lock state|locks?|dspjob|display job|wrkjob|work with job|job log|joblog|job parameter|request processor|call stack|debugging a job|qualified job|strsrvjob|strdbg|subsystem|job queue/.test(haystack);
    case "object_lock_analysis":
      return /wrkobjlck|work with object locks|object locks|lock state|locks?|object|member|library|wrkjob|work with job|job log|joblog|active job/.test(haystack);
    case "db2_catalog_query":
      return /db2|qsys2|syscolumns|systables|sysindexes|catalog|cat[aá]logo|metadata|metadatos|column|table|view|sql/.test(haystack);
    case "design_dds_file":
      return /dds|physical file|logical file|archivo fisico|archivo logico|\bpf\b|\blf\b|crtp[fl]|unique|key|clave|record format|field/.test(haystack);
    case "design_display_or_report":
      return /dds|display file|printer file|dspf|prtf|subfile|pantalla|reporte|spool|indicator|indicador|record format/.test(haystack);
    case "create_program":
      return /rpgle|sqlrpgle|clle|cobol|ile rpg|program|programa|module|modulo|crtrpgmod|crtbndrpg|crtsqlrpgi|crtbndcl|compile|compil/.test(haystack);
    default:
      return true;
  }
}

function contextDisplayTitle(read: ReadResult, hit?: SearchHit): string {
  if (hit?.synthetic && hit.title !== read.title) return `${hit.title} / fuente: ${read.title}`;
  return hit?.title ?? read.title;
}

function toContextReadSummary(read: ReadResult, task: string, hit?: SearchHit): ContextReadSummary {
  const focusedSections = selectFocusedSections(read.sections ?? [], task, 5);
  return {
    id: read.id,
    title: contextDisplayTitle(read, hit),
    version: read.version,
    category: read.category,
    sourceKind: read.sourceKind,
    canonicalUrl: read.canonicalUrl,
    documentKind: read.documentKind,
    canonicalTopicKey: read.canonicalTopicKey,
    taxonomy: read.taxonomy,
    textLength: read.textLength,
    excerpt: makeSnippet(read.content, task, 1400),
    focusedSections
  };
}

function selectFocusedSections(sections: TopicSection[], task: string, limit: number): TopicSection[] {
  if (!sections.length) return [];
  const queryTokens = tokenize(task).filter((token) => token.length > 2).map(fold);
  const scored = sections.map((section, index) => {
    const haystack = fold(`${section.title} ${section.content}`);
    const tokenScore = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    const kindScore = section.kind === "syntax" ? 9
      : section.kind === "parameters" ? 8
        : section.kind === "examples" ? 7
          : section.kind === "description" ? 6
            : ["notes", "messages", "recovery", "restrictions"].includes(section.kind) ? 5
              : 1;
    return { section, index, score: tokenScore + kindScore };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map(({ section }) => ({
    ...section,
    content: makeSnippet(section.content, task, 1200)
  }));
}

function buildContextActionItems(
  options: ContextOptions,
  preset: LanguagePreset | undefined,
  reads: ContextReadSummary[],
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>
): string[] {
  const haystack = [options.task, options.language].filter(Boolean).join(" ");
  const items = new Set<string>();
  if (preset?.compileCommands.length) items.add(`Compilar/revisar con ${preset.compileCommands.join(" o ")} según el tipo de objeto y release objetivo.`);
  if (/rtvjoba/i.test(haystack)) items.add("Para RTVJOBA, validar variables CL receptoras y atributos de trabajo requeridos antes de modificar el fuente.");
  if (/monmsg/i.test(haystack)) items.add("Para MONMSG, confirmar el alcance exacto del manejador y evitar capturar CPF0000/MCH0000 si ocultaría fallos reales.");
  if (/\b(CPF|MCH|RNF|SQL)\d{0,5}\b/i.test(haystack)) items.add("Tratar los mensajes por ID/familia: documentar recuperación esperada y no asumir causa raíz sin evidencia del joblog/listado.");
  for (const section of sections.flatMap((topic) => topic.sections)) {
    if (section.kind === "syntax") items.add(`Usar la sección de sintaxis detectada (${section.title}) como base para ajustar formato y orden de parámetros.`);
    if (section.kind === "parameters") items.add(`Cruzar parámetros contra la sección detectada (${section.title}) antes de cambiar nombres, tipos o longitudes.`);
    if (section.kind === "examples") items.add(`Tomar ejemplos documentales (${section.title}) como patrón, adaptando bibliotecas/objetos al ambiente real.`);
  }
  if (!items.size && reads.length) items.add("Aplicar la evidencia leída en el orden de prioridad mostrado y mantener trazabilidad por ID de documento.");
  if (!items.size) items.add("No hay evidencia suficiente; acotar la tarea con comando, mensaje, lenguaje o versión antes de afirmar detalles técnicos.");
  return [...items].slice(0, 8);
}

function buildContextAnswer(input: {
  task: string;
  language: string;
  detectedSignals: string[];
  compileCommands: string[];
  optionsToReview: string[];
  pitfalls: string[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  actionItems: string[];
  warnings: string[];
}): string {
  const lines: string[] = [
    `Contexto documental autocontenido para ${input.language}: ${input.task}`,
    `Señales detectadas: ${input.detectedSignals.join(", ") || "sin señales específicas"}.`
  ];
  if (input.compileCommands.length) lines.push(`Comandos de compilación/build relevantes: ${input.compileCommands.join(", ")}.`);
  if (input.optionsToReview.length) lines.push(`Opciones a revisar: ${input.optionsToReview.join(", ")}.`);
  if (input.pitfalls.length) {
    lines.push("Riesgos técnicos documentales:");
    lines.push(...input.pitfalls.slice(0, 4).map((pitfall) => `- ${pitfall}`));
  }
  if (input.reads.length) {
    lines.push("", "Evidencia ya leída y resumida:");
    for (const read of input.reads) {
      lines.push(`- ${read.title} [${read.version}/${read.category}] (${read.id})`);
      lines.push(`  Extracto: ${read.excerpt}`);
      const focused = read.focusedSections.slice(0, 3);
      if (focused.length) {
        lines.push("  Sintaxis/parámetros/secciones útiles:");
        for (const section of focused) lines.push(`  - [${section.kind}] ${section.title}: ${section.content}`);
      }
    }
  } else {
    lines.push("", "No se pudo leer evidencia suficiente en el corpus local para esta tarea.");
  }
  lines.push("", "Acciones técnicas sugeridas para resolver la tarea:");
  lines.push(...input.actionItems.map((item) => `- ${item}`));
  if (input.warnings.length) {
    lines.push("", "Advertencias de cobertura:");
    lines.push(...[...new Set(input.warnings)].slice(0, 5).map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

function scoreHit(hit: SearchHit, body: string, rank: number, options: SearchOptions, chunkIndex: number): number {
  const queryTokens = tokenize(options.query);
  const exactTerms = extractExactTechnicalTerms(options.query);
  const title = fold(hit.title);
  const breadcrumbs = fold(hit.breadcrumbs.join(" "));
  const bodyFold = fold(body.slice(0, 2000));
  let score = 100 / (1 + Math.abs(rank));
  if (options.category && hit.category === options.category) score += 8;
  if (options.version && hit.version === normalizeVersionInput(options.version)) score += 5;
  if (chunkIndex === 0) score += 0.5;
  for (const token of queryTokens) {
    if (title.includes(token)) score += 7;
    if (breadcrumbs.includes(token)) score += 2;
    if (bodyFold.includes(token)) score += 0.5;
  }
  const queryFold = fold(options.query);
  if (title === queryFold) score += 30;
  if (title.includes(queryFold)) score += 18;
  if (/^[a-z]{2,}\d{0,4}$/i.test(options.query.trim()) && title.includes(fold(options.query))) score += 20;
  if (/\bdds\b|\bpf\b|physical file/i.test(options.query)) {
    if (/physical file|physical and logical files|dds syntax/i.test(hit.title)) score += 18;
    if (/defining a physical file using dds/i.test(hit.title)) score += 16;
    if (/logical files only/i.test(hit.title) && !/\bpfile\b/i.test(options.query)) score -= 10;
    if (/c\/c\+\+|runtime library/i.test(hit.title)) score -= 20;
  }
  if (/unique/i.test(options.query) && /^unique\b/i.test(hit.title)) score += 25;
  if (/rnf\d{4}/i.test(options.query) && /rpg messages/i.test(hit.title)) score += 25;
  if (/crtrpgmod/i.test(options.query) && /crtrpgmod command/i.test(hit.title)) score += 25;
  if (/crtrpgmod/i.test(options.query) && /^crtrpgmod command$/i.test(hit.title.trim())) score += 30;
  if (/copy|include|sqlrpgle|embedded sql/i.test(options.query) && /copy.*include|embedded sql/i.test(hit.title)) score += 15;
  if (/\bsqlrpgle\b|embedded sql|crt(sql)?rpgi|precompiler/i.test(options.query)) {
    if (/crtsqlrpgi|embedded sql|sql\s*rpg|precompiler|rpgppopt/i.test(`${hit.title} ${hit.breadcrumbs.join(" ")}`)) score += 45;
    if (/sysindexstat|sys.*stat|catalog tables|catalog views/i.test(hit.title)) score -= 70;
    if (hit.category === "mensajes-rnf" && !/rnf\d{4}/i.test(options.query)) score -= 45;
  }
  const commandTerm = extractCommandQueryTerm(options.query);
  if (commandTerm) {
    const foldedCommand = fold(commandTerm);
    if (title.includes(foldedCommand)) score += 45;
    if (breadcrumbs.includes(foldedCommand)) score += 16;
    if (!title.includes(foldedCommand) && bodyFold.includes(foldedCommand)) score += 5;
    if (/cl command finder|ibm i commands|alphabetic list of cl commands/i.test(`${hit.title} ${hit.breadcrumbs.join(" ")}`)) score += 12;
  }
  if (exactTerms.length) {
    const hitPrimaryTerm = extractPrimaryTechnicalTerm(hit.title);
    const matchedInTitle = exactTerms.some((term) => title.includes(term));
    const matchedInBreadcrumbs = exactTerms.some((term) => breadcrumbs.includes(term));
    const matchedInBody = exactTerms.some((term) => bodyFold.includes(term));
    if (matchedInTitle) score += 55;
    if (matchedInBreadcrumbs) score += 14;
    if (matchedInBody) score += 8;
    if (!matchedInTitle && !matchedInBreadcrumbs && !matchedInBody) score -= 45;
    if (hitPrimaryTerm && !exactTerms.includes(hitPrimaryTerm) && exactTerms.some(isCommandOrOpcodeTerm)) score -= 35;
  }
  if (isLikelyIbmCommandQuery(options.query) && /\b(command|description of the .+ command)\b/i.test(hit.title)) {
    if (/^description of the .+ command$/i.test(hit.title.trim())) score -= 6;
    if (/^[A-Z0-9]{3,12} Command$/i.test(hit.title.trim())) score += 18;
  }
  return Math.round(score * 100000) / 100000;
}

function makeSnippet(text: string, query: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const needles = tokenize(query).filter((part) => part.length > 2);
  const lower = clean.toLowerCase();
  const index = needles.map((needle) => lower.indexOf(needle)).filter((value) => value >= 0).sort((a, b) => a - b)[0] ?? -1;
  const start = Math.max(0, index > 0 ? index - Math.floor(maxChars / 3) : 0);
  const end = Math.min(clean.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

function buildSemanticExpansion(query: string): { queries: string[]; signals: string[] } {
  const queries: string[] = [];
  const signals: string[] = [];
  for (const expansion of SEMANTIC_EXPANSIONS) {
    if (!expansion.pattern.test(query)) continue;
    queries.push(...expansion.queries);
    signals.push(...expansion.signals);
  }
  const preset = resolvePreset(query);
  if (preset) {
    queries.push(...preset.queries, ...preset.compileCommands.map((command) => `${command} command`));
    signals.push(preset.language.toLowerCase());
  }
  return {
    queries: [...new Set(queries)].slice(0, 12),
    signals: [...new Set(signals)].slice(0, 20)
  };
}

function semanticScore(hit: SearchHit, query: string, semantic: { queries: string[]; signals: string[] }): number {
  const haystack = fold([hit.title, hit.category, hit.breadcrumbs.join(" "), hit.snippet].join(" "));
  let score = 0;
  for (const signal of semantic.signals) {
    const folded = fold(signal);
    if (haystack.includes(folded)) score += 6;
  }
  const queryTaxonomy = classifyTaxonomy({ ...hit, title: query, category: hit.category, breadcrumbs: [] }, query);
  const hitTaxonomy = hit.taxonomy ?? classifyTaxonomy(hit, hit.snippet);
  if (queryTaxonomy.kind !== "general" && queryTaxonomy.kind === hitTaxonomy.kind) score += 12;
  return score;
}

function buildMatchReasons(hit: SearchHit, body: string, query: string, semantic: { queries: string[]; signals: string[] }): string[] {
  const reasons: string[] = [];
  const title = fold(hit.title);
  const bodyFold = fold(body);
  const exactTerms = extractExactTechnicalTerms(query);
  for (const term of exactTerms) {
    if (title.includes(term)) reasons.push(`match exacto en título: ${term}`);
    else if (bodyFold.includes(term)) reasons.push(`match exacto en contenido: ${term}`);
  }
  if (semantic.queries.length) reasons.push(`expansión semántica local: ${semantic.queries.slice(0, 3).join(" | ")}`);
  if (hit.taxonomy) reasons.push(`taxonomía: ${hit.taxonomy.kind} (${hit.taxonomy.signals.slice(0, 3).join(", ") || "sin señales"})`);
  if (hit.version !== "RDi-local") reasons.push(`documento versionado IBM i ${hit.version}`);
  return [...new Set(reasons)].slice(0, 8);
}

function classifyTaxonomy(hit: Pick<SearchHit, "title" | "category" | "breadcrumbs">, content: string): TopicTaxonomy {
  const title = fold(hit.title);
  const category = fold(hit.category ?? "");
  const breadcrumbs = fold(hit.breadcrumbs?.join(" ") ?? "");
  const body = fold(content.slice(0, 1200));
  const haystack = [title, category, breadcrumbs, body].join(" ");
  const make = (kind: TopicTaxonomy["kind"], label: string, signals: string[], confidence = 0.63, relatedKinds?: TopicTaxonomy["relatedKinds"]): TopicTaxonomy => ({
    kind,
    label,
    confidence: Math.min(1, confidence),
    signals: [...new Set(signals)],
    ...(relatedKinds?.length ? { relatedKinds: [...new Set(relatedKinds)] } : {})
  });

  if (/\bsnd-msg\b/.test(title)) return make("rpg-opcode", "Operation code RPG", ["title opcode", "snd-msg"], 0.9, /%[a-z]/.test(haystack) ? ["rpg-bif"] : undefined);
  if (/^%[a-z][a-z0-9_-]+/.test(title)) return make("rpg-bif", "Built-in function RPG", ["title percent-bif"], 0.9);
  if (category === "cl-clle" && (IBM_I_COMMAND_TOKEN_PATTERN.test(title) || /\bcommand\b/.test(title) || IBM_I_COMMAND_TOKEN_PATTERN.test(breadcrumbs))) {
    return make("command", "Comando IBM i", ["cl category", "command"], 0.82);
  }
  if (/\b(rnf\d{4}|sql\d{4,5}|cpf\d{4}|mch\d{4})\b/.test(haystack) || /messages and codes|message descriptions|rpg messages|sql messages|system messages/.test(`${title} ${breadcrumbs}`)) {
    const signals = [
      ...(/\brnf\d{4}\b/.test(haystack) ? ["RNF"] : []),
      ...(/\bsql\d{4,5}\b/.test(haystack) ? ["SQL message"] : []),
      ...(/\bcpf\d{4}\b/.test(haystack) ? ["CPF"] : []),
      ...(/\bmch\d{4}\b/.test(haystack) ? ["MCH"] : []),
      ...(/message/.test(`${title} ${breadcrumbs}`) ? ["message"] : [])
    ];
    return make("message", "Mensaje IBM i/RNF/SQL", signals.length ? signals : ["message"], 0.72);
  }
  if (category === "sql-db2-for-i" && (/\bsqlrpgle\b|embedded sql|exec sql|db2 for i|precompiler|rpgppopt/.test(haystack) || /\bselect\b|\bcommit\b|\bcursor\b/.test(haystack))) {
    return make("sql", "Db2 for i / SQL", ["sql"], 0.74);
  }
  if (/\b(chain|reade|readp|monitor|on-error)\b/.test(title) || /\boperation codes?\b/.test(`${title} ${breadcrumbs}`)) {
    return make("rpg-opcode", "Operation code RPG", ["rpg opcode"], 0.68);
  }
  if (IBM_I_COMMAND_TOKEN_PATTERN.test(haystack) || /\bcommand\b/.test(`${title} ${breadcrumbs}`)) return make("command", "Comando IBM i", ["command prefix"], 0.68);
  if (/%[a-z][a-z0-9_-]+/.test(haystack) || /built-in function/.test(haystack)) return make("rpg-bif", "Built-in function RPG", ["percent-bif"], 0.63);
  if (/\bdds\b|\bphysical file\b|\blogical file\b|\bkeyword\b/.test(haystack) || /\b(unique|reffld|edtcde|dspatr)\b/.test(haystack)) return make("dds-keyword", "DDS/keyword", ["dds keyword"], 0.63);
  if (/\bsqlrpgle\b|embedded sql|exec sql|db2 for i/.test(haystack) || /\bselect\b|\bcommit\b|\bcursor\b/.test(haystack)) return make("sql", "Db2 for i / SQL", ["sql"], 0.63);
  if (/\bq[a-z0-9]{6,}\b/.test(haystack) || /\bapi\b/.test(haystack)) return make("api", "API IBM i", ["api"], 0.63);
  if (/ile rpg|cl programs|cobol|control language/.test(haystack)) return make("language-guide", "Guía de lenguaje", ["language guide"], 0.63);
  return { kind: "general", label: "General IBM i", confidence: 0.2, signals: [] };
}

function extractTopicSections(content: string): TopicSection[] {
  const normalizedContent = normalizeLineEndings(content);
  const lines = normalizedContent.split("\n");
  const headingIndexes: Array<{ index: number; title: string; kind: TopicSection["kind"] }> = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 140) return;
    const kind = detectSectionKind(trimmed);
    const looksHeading = kind !== "generic" || (/^[A-Z0-9_/%*()[\] .,:;-]{4,}$/.test(trimmed) && index > 0);
    if (looksHeading) headingIndexes.push({ index, title: trimmed, kind });
  });
  if (!headingIndexes.length) {
    return augmentCommandSections(normalizedContent, [{ kind: "description", title: "Contenido", content: normalizedContent.trim(), startLine: 1, endLine: lines.length }]);
  }
  const sections: TopicSection[] = [];
  for (let i = 0; i < headingIndexes.length; i += 1) {
    const current = headingIndexes[i];
    const next = headingIndexes[i + 1]?.index ?? lines.length;
    const sectionContent = lines.slice(current.index + 1, next).join("\n").trim();
    if (!sectionContent && current.kind === "generic") continue;
    sections.push({
      kind: current.kind,
      title: current.title,
      content: sectionContent || current.title,
      startLine: current.index + 1,
      endLine: next
    });
  }
  return augmentCommandSections(normalizedContent, sections).slice(0, 80);
}

function normalizeLineEndings(content: string): string {
  // GitHub Actions en Windows puede convertir el corpus versionado a CRLF; normalizamos
  // antes de aplicar regex de documentación para que la extracción sea cross-platform.
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function augmentCommandSections(content: string, sections: TopicSection[]): TopicSection[] {
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => /\b[A-Z0-9]{3,12}\s+Command\b/.test(line))?.trim() ?? "";
  const command = title.match(/\b([A-Z0-9]{3,12})\s+Command\b/)?.[1];
  if (!command) return sections;
  const synthetic: TopicSection[] = [];
  const normalizedSections = normalizeCommandSectionTitles(sections, command);
  const description = content.match(/Last Updated:[^\n]*\n\n([\s\S]{40,700}?)(?:\nJob:|\n[A-Z0-9]{3,12}[A-Z0-9]+?\()/i)?.[1]?.trim();
  if (description && !normalizedSections.some((section) => section.kind === "description" && /descrip|description|contenido/i.test(section.title))) {
    synthetic.push({ kind: "description", title: `Descripción de ${command}`, content: description, startLine: 1, endLine: Math.min(lines.length, 8) });
  }
  const syntaxSource = selectCommandSyntaxSource(content, normalizedSections, command);
  if (syntaxSource && !normalizedSections.some((section) => section.kind === "syntax" && fold(section.content).includes(fold(command)))) {
    synthetic.push({ kind: "syntax", title: `Sintaxis de ${command}`, content: normalizeCommandSyntax(syntaxSource, command), startLine: 1, endLine: Math.min(lines.length, 25) });
  }
  const parameters = extractCommandParameters(syntaxSource ?? "", command);
  if (parameters && !normalizedSections.some((section) => section.kind === "parameters")) {
    synthetic.push({ kind: "parameters", title: `Parámetros detectados de ${command}`, content: parameters, startLine: 1, endLine: Math.min(lines.length, 25) });
  }
  const notes = extractCommandNotes(content, command);
  if (notes && !normalizedSections.some((section) => section.kind === "notes")) {
    synthetic.push({ kind: "notes", title: `Notas de ${command}`, content: notes, startLine: 1, endLine: Math.min(lines.length, 40) });
  }
  return [...synthetic, ...normalizedSections];
}

function normalizeCommandSectionTitles(sections: TopicSection[], command: string): TopicSection[] {
  return sections.map((section) => {
    if (section.kind !== "syntax" || !fold(section.content).includes(fold(command))) return section;
    // IBM Docs a veces pierde el encabezado real y convierte una frase de la descripción en "título".
    // Si ya detectamos que la sección contiene el comando, exponemos un nombre estable para agentes MCP.
    return {
      ...section,
      title: /^sintaxis|^syntax/i.test(section.title) ? section.title : `Sintaxis de ${command}`,
      content: normalizeCommandSyntax(section.content, command)
    };
  });
}

function selectCommandSyntaxSource(content: string, sections: TopicSection[], command: string): string | undefined {
  const sourceFromContent = extractCommandSyntaxSource(content, command);
  if (sourceFromContent && sourceFromContent.includes("(")) return sourceFromContent;
  // Si el primer match fue solo el título "CRTRPGMOD Command", reutilizamos la sección syntax ya detectada.
  return sections.find((section) => section.kind === "syntax" && fold(section.content).includes(fold(command)))?.content;
}

function extractCommandSyntaxSource(content: string, command: string): string | undefined {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`(${escaped}[A-Z0-9_/*().,'\\-\\s]+?)(?:\\n\\n|OPTION Details|Notes:)`, "i"));
  return match?.[1]?.trim();
}

function normalizeCommandSyntax(syntax: string, command: string): string {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return syntax
    .replace(new RegExp(`^${escaped}`, "i"), command)
    .replace(/([A-Z][A-Z0-9]{2,})(\()/g, "\n$1$2")
    .replace(/\)(?=[A-Z][A-Z0-9]{2,}\()/g, ")\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractCommandParameters(syntax: string, command: string): string {
  const normalized = normalizeCommandSyntax(syntax, command);
  const params = [...new Set((normalized.match(/\b[A-Z][A-Z0-9]{2,}\(/g) ?? [])
    .map((item) => item.slice(0, -1).replace(new RegExp(`^${command}`, "i"), ""))
    .filter((item) => item && item !== command && item.length <= 12))];
  return params.map((param) => `- ${param}`).join("\n");
}

function extractCommandNotes(content: string, command: string): string {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const notes = content.match(/Notes:\s*([\s\S]{10,700}?)(?:\n\n[A-Z][A-Z0-9 ]{3,}:|\n\n[A-Z][A-Za-z ]{3,}:|$)/i)?.[1]?.trim();
  const optionDetails = content.match(new RegExp(`OPTION Details([\\s\\S]{10,700}?)(?:\\n\\n|$)`, "i"))?.[1]?.trim();
  return [
    notes ? `Notes:\n${notes.replace(new RegExp(escaped, "gi"), command)}` : "",
    optionDetails ? `OPTION Details:\n${normalizeCommandSyntax(optionDetails, command)}` : ""
  ].filter(Boolean).join("\n\n");
}

function detectSectionKind(title: string): TopicSection["kind"] {
  if (/syntax|free-form|fixed-form|formato|sintaxis/i.test(title)) return "syntax";
  if (/parameter|operand|factor|par[aá]metro/i.test(title)) return "parameters";
  if (/description|usage|purpose|descripci[oó]n/i.test(title)) return "description";
  if (/example|ejemplo|sample/i.test(title)) return "examples";
  if (/note|restriction|consideration|restricci[oó]n|consideraci[oó]n/i.test(title)) return /restriction|restricci/i.test(title) ? "restrictions" : "notes";
  if (/message|mensaje|rnf|sql\d/i.test(title)) return "messages";
  if (/recovery|recover|cause|response|acci[oó]n/i.test(title)) return "recovery";
  if (/related|see also|referencia|api/i.test(title)) return "related";
  return "generic";
}

function pickBestSection(sections: TopicSection[], query: string): TopicSection | undefined {
  const queryFold = fold(query);
  return [...sections]
    .map((section) => ({
      section,
      score: tokenize(queryFold).reduce((sum, token) => sum + (fold(`${section.title} ${section.content}`).includes(token) ? 1 : 0), 0)
        + (section.kind === "syntax" && /syntax|sintaxis|formato/i.test(query) ? 5 : 0)
        + (section.kind === "examples" && /example|ejemplo/i.test(query) ? 5 : 0)
    }))
    .sort((a, b) => b.score - a.score)[0]?.section;
}

function buildExtractiveAnswer(options: AnswerOptions, reads: ReadResult[], compile?: CompileGuidance): string {
  if (!reads.length) {
    return [
      "No encontré evidencia suficiente en el corpus local para responder con seguridad.",
      "La consulta puede ampliarse con nombre de comando, mensaje RNF/SQL, lenguaje o versión IBM i; esta respuesta no inventa detalles fuera del corpus."
    ].join("\n");
  }
  const lines: string[] = [`Respuesta basada en ${reads.length} tópico(s) del corpus local:`];
  for (const read of reads) {
    const section = pickBestSection(read.sections ?? [], options.question) ?? read.sections?.find((item) => item.kind === "description") ?? read.sections?.[0];
    lines.push("", `- ${read.title} [${read.version}/${read.category}]`);
    lines.push(`  ${makeSnippet(section?.content ?? read.content, options.question, options.includeExamples ? 900 : 520)}`);
    if (options.includeExamples) {
      const example = read.sections?.find((item) => item.kind === "examples");
      if (example) lines.push(`  Ejemplo/documentación relacionada: ${makeSnippet(example.content, options.question, 500)}`);
    }
  }
  if (compile) {
    lines.push("", "Comandos/opciones sugeridas por contexto:");
    lines.push(`- Comandos: ${compile.recommendedCommands.join(", ") || "n/a"}`);
    lines.push(`- Opciones a revisar: ${compile.optionsToReview.join(", ") || "n/a"}`);
  }
  lines.push("", "Citas: los IDs devueltos en structuredContent identifican la evidencia ya leída y sirven para auditoría del texto completo.");
  return lines.join("\n");
}

function buildResolvedAnswer(input: {
  options: ResolveOptions;
  intent: DocsIntent;
  policy: WorkflowPolicy;
  answerResult?: AnswerResult;
  reads: ReadResult[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  context?: ContextPackage;
  compileGuidance?: CompileGuidance;
  messageExplanation?: MessageExplanation;
  versionComparison?: VersionComparison;
  rankingExplanation?: RankingExplanation;
  codeValidation?: CodeValidationResult;
  related?: RelatedDocuments;
}): string {
  const lines: string[] = [
    `Resolución documental IBM i para: ${input.options.question}`,
    `Intención detectada: ${input.intent}`,
    `Política aplicada: ${input.policy.description}`,
    ""
  ];
  if (input.answerResult?.answer) {
    lines.push("Respuesta base:", input.answerResult.answer, "");
  }
  if (input.messageExplanation) {
    lines.push("Diagnóstico de mensaje:", input.messageExplanation.summary);
    lines.push("Checklist:", ...input.messageExplanation.recoveryChecklist.map((item) => `- ${item}`), "");
  }
  if (input.compileGuidance) {
    lines.push("Guía de compilación:");
    lines.push(`- Lenguaje: ${input.compileGuidance.language}`);
    lines.push(`- Comandos recomendados: ${input.compileGuidance.recommendedCommands.join(", ") || "n/a"}`);
    lines.push(`- Opciones a revisar: ${input.compileGuidance.optionsToReview.join(", ") || "n/a"}`);
    lines.push(...input.compileGuidance.pitfalls.slice(0, 4).map((pitfall) => `- Pitfall: ${pitfall}`), "");
  }
  if (input.context) {
    lines.push("Contexto detectado:");
    lines.push(`- Lenguaje/categoría: ${input.context.intent.language}${input.context.intent.category ? ` / ${input.context.intent.category}` : ""}`);
    lines.push(`- Señales: ${input.context.intent.detectedSignals.join(", ") || "sin señales específicas"}`, "");
  }
  if (input.versionComparison) {
    lines.push("Comparación por versión:");
    for (const entry of input.versionComparison.versions) {
      lines.push(`- ${entry.version}: ${entry.found ? entry.result?.title ?? "encontrado" : "sin evidencia"}; ${entry.notes.join(" ")}`);
    }
    lines.push("");
  }
  if (input.rankingExplanation) {
    lines.push("Ranking explicado:");
    lines.push(`- FTS: ${input.rankingExplanation.ftsQuery || "n/a"}`);
    lines.push(`- Expansiones: ${input.rankingExplanation.semanticQueries.join(" | ") || "sin expansiones"}`);
    for (const item of input.rankingExplanation.results.slice(0, 5)) {
      lines.push(`- ${item.hit.title}: ${item.reasons.join("; ") || "sin razones adicionales"}`);
    }
    lines.push("");
  }
  if (input.codeValidation) {
    lines.push("Validación de código:");
    for (const finding of input.codeValidation.findings) {
      lines.push(`- [${finding.severity}] ${finding.title}: ${finding.detail}`);
    }
    lines.push("");
  }
  const relevantSections = input.sections
    .flatMap((topic) => topic.sections.map((section) => ({ topic, section })))
    .filter(({ section }) => ["syntax", "parameters", "examples", "notes", "restrictions", "messages", "recovery"].includes(section.kind))
    .slice(0, 8);
  if (relevantSections.length) {
    lines.push("Secciones útiles detectadas:");
    for (const { topic, section } of relevantSections) {
      lines.push(`- ${topic.title} > ${section.title} (${section.kind})`);
    }
    lines.push("");
  }
  if (input.related) {
    lines.push(`Navegación relacionada: ${input.related.equivalentVersions.length} equivalente(s) por versión y ${input.related.related.length} documento(s) relacionado(s).`, "");
  }
  if (input.reads.length) {
    lines.push("Lecturas completas usadas:", ...input.reads.map((read) => `- ${read.id}: ${read.title} (${read.version}, ${read.textLength} caracteres)`), "");
  }
  lines.push("Evidencia materializada: las lecturas, secciones y citas relevantes ya se incluyen en structuredContent; los IDs quedan como trazabilidad para auditoría, no como tarea pendiente para el agente.");
  return lines.join("\n");
}

function mergeSearchEvidence(groups: SearchHit[][]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const hit of groups.flat()) {
    const existing = byId.get(hit.id);
    if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function mergeContextReads(groups: ContextReadSummary[][]): ContextReadSummary[] {
  const byId = new Map<string, ContextReadSummary>();
  for (const read of groups.flat()) {
    const existing = byId.get(read.id);
    if (!existing || read.focusedSections.length > existing.focusedSections.length) byId.set(read.id, read);
  }
  return [...byId.values()];
}

function mergeSectionTopics(groups: Array<Array<{ id: string; title: string; sections: TopicSection[] }>>): Array<{ id: string; title: string; sections: TopicSection[] }> {
  const byId = new Map<string, { id: string; title: string; sections: TopicSection[] }>();
  for (const topic of groups.flat()) {
    const existing = byId.get(topic.id);
    if (!existing) {
      byId.set(topic.id, { ...topic, sections: [...topic.sections] });
      continue;
    }
    existing.sections = mergeTopicSections(existing.sections, topic.sections);
  }
  return [...byId.values()];
}

function mergeTopicSections(left: TopicSection[], right: TopicSection[]): TopicSection[] {
  const seen = new Set<string>();
  const result: TopicSection[] = [];
  for (const section of [...left, ...right]) {
    const key = `${section.kind}:${section.title}:${section.startLine}:${section.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(section);
  }
  return result;
}

function mergeCitations(groups: AnswerCitation[][]): AnswerCitation[] {
  const byKey = new Map<string, AnswerCitation>();
  for (const citation of groups.flat()) {
    byKey.set(`${citation.id}:${citation.section ?? ""}`, citation);
  }
  return [...byKey.values()];
}

function mergeWorkflowStages(groups: WorkflowStage[][]): WorkflowStage[] {
  const seen = new Set<string>();
  const stages: WorkflowStage[] = [];
  for (const stage of groups.flat()) {
    const key = `${stage.tool}:${stage.reason}:${stage.outputSummary ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stages.push(stage);
  }
  return stages;
}

function buildAssistCoverage(input: {
  question: string;
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  confidence: "alta" | "media" | "baja";
  warnings: string[];
}): AssistCoverage {
  const technicalTerms = extractAssistTechnicalTerms(input.question);
  const searchable = fold([
    ...input.evidence.flatMap((hit) => [hit.title, hit.snippet, hit.breadcrumbs.join(" "), hit.canonicalTopicKey ?? ""]),
    ...input.reads.flatMap((read) => [read.title, read.excerpt, read.focusedSections.map((section) => `${section.title} ${section.content}`).join(" ")]),
    ...input.sections.flatMap((topic) => [topic.title, topic.sections.map((section) => `${section.title} ${section.content}`).join(" ")])
  ].join(" "));
  const matchedTechnicalTerms = technicalTerms.filter((term) => searchable.includes(fold(term)));
  const missingTechnicalTerms = technicalTerms.filter((term) => !matchedTechnicalTerms.includes(term));
  const primaryTechnicalTerms = technicalTerms.filter((term) => !isAssistMessageFamilyTerm(term));
  const matchedPrimaryTerms = primaryTechnicalTerms.filter((term) => matchedTechnicalTerms.includes(term));
  const weakSectionTerms = matchedPrimaryTerms.filter((term) => !hasFocusedSectionForTerm(input.sections, term));
  const evidenceCount = input.evidence.length;
  const readCount = input.reads.length;
  const sectionCount = input.sections.reduce((total, topic) => total + topic.sections.length, 0);
  const coverageWarnings = [
    ...(missingTechnicalTerms.length ? [`No se encontró evidencia textual específica para: ${missingTechnicalTerms.join(", ")}.`] : []),
    ...(weakSectionTerms.length ? [`La evidencia para ${weakSectionTerms.join(", ")} existe, pero no trae una sección fuerte de sintaxis/parámetros; tratarla como referencia parcial.`] : []),
    ...(evidenceCount === 0 ? ["No hay resultados documentales utilizables para la consulta."] : []),
    ...(readCount === 0 ? ["No se pudo materializar lectura completa de tópicos para la consulta."] : []),
    ...(sectionCount === 0 ? ["No se detectaron secciones enfocadas de sintaxis/parámetros/ejemplos/recovery."] : [])
  ];
  const status: AssistCoverage["status"] = evidenceCount === 0
    || readCount === 0
    || (primaryTechnicalTerms.length > 0 && matchedPrimaryTerms.length === 0)
    ? "thin"
    : missingTechnicalTerms.length || weakSectionTerms.length || sectionCount === 0 || input.confidence === "baja" || input.warnings.length
      ? "partial"
      : "complete";
  const summary = status === "complete"
    ? "Cobertura completa para la consulta: hay evidencia, lecturas y secciones enfocadas suficientes."
    : status === "partial"
      ? "Cobertura parcial: hay evidencia útil, pero algún término, release o eje técnico no quedó completamente cubierto."
      : "Cobertura débil: no hay evidencia suficientemente específica para responder sin riesgo de inventar detalles.";
  return {
    status,
    summary,
    evidenceCount,
    readCount,
    sectionCount,
    matchedTechnicalTerms,
    missingTechnicalTerms,
    warnings: [...new Set(coverageWarnings)]
  };
}

function hasFocusedSectionForTerm(sections: Array<{ id: string; title: string; sections: TopicSection[] }>, term: string): boolean {
  const foldedTerm = fold(term);
  const isCommand = IBM_I_COMMAND_PREFIX_PATTERN.test(term);
  return sections.some((topic) => topic.sections.some((section) => {
    const sectionText = fold(`${topic.title} ${section.title} ${section.content}`);
    if (!sectionText.includes(foldedTerm)) return false;
    if (["syntax", "parameters", "examples"].includes(section.kind)) return true;
    // Muchos comandos operativos exportados desde la ayuda RDi aparecen en notas,
    // secciones genéricas o temas procedurales sin una página canónica "Command".
    // Si la sección menciona el comando exacto, cuenta como evidencia fuerte para
    // evitar falsos huecos de cobertura por forma documental, no por falta real.
    return isCommand && ["description", "notes", "generic", "related"].includes(section.kind);
  }));
}

function extractAssistTechnicalTerms(question: string): string[] {
  const exact = extractExactTechnicalTerms(question).map((term) => term.toUpperCase());
  const uppercase = question.match(/\b[A-Z%][A-Z0-9_%/-]{2,}\b/g) ?? [];
  return [...new Set([...exact, ...uppercase]
    .map((term) => term.replace(/[.,;:()[\]{}]+$/g, "").trim().toUpperCase())
    .filter((term) => term.length >= 3 || term.startsWith("%"))
    .filter((term) => !isAssistGenericTerm(term)))];
}

function isAssistGenericTerm(term: string): boolean {
  return new Set(["IBM", "IBMI", "AS400", "ILE", "CL", "CLLE", "RPG", "RPGLE", "SQLRPGLE", "DDS", "COBOL", "JOB", "JOBLOG", "APLICA", "APLICAN"]).has(term);
}

function isAssistMessageFamilyTerm(term: string): boolean {
  return /^(CPF|MCH|RNF|SQL)$/.test(term);
}

function buildAssistTaskPlan(input: {
  options: AssistOptions;
  resolved: ResolveResult;
  context: ContextPackage;
  coverage: AssistCoverage;
  retrievalAxes: AssistRetrievalAxis[];
}): AssistTaskPlan {
  const haystack = [input.options.question, input.options.language, input.options.code, input.context.intent.detectedSignals.join(" ")].filter(Boolean).join("\n");
  const language = normalizeLanguage(input.options.language ?? input.options.question ?? input.options.code) ?? input.context.intent.language;
  const axes = new Set<AssistRetrievalAxis>(input.retrievalAxes);
  const hasCompile = axes.has("compile") || input.resolved.compileGuidance?.recommendedCommands.length;
  const hasSyntax = axes.has("syntax");
  const programLanguage = /^(RPGLE|SQLRPGLE|CLLE|COBOL)$/i.test(language ?? "");
  const explicitProgramCreation = /crear|create|generar|implementar|nuevo|programa|m[oó]dulo|module/i.test(haystack)
    && /rpgle|sqlrpgle|rpg|clle|cobol|programa|m[oó]dulo/i.test(haystack);
  const explicitDdsDesign = /(?:diseñ|design|model|defin|crear|create|generar).{0,80}(?:dds|archivo\s+f[ií]sico|physical\s+file|\bpf\b|archivo\s+l[oó]gico|logical\s+file|\blf\b|clave|key|unique)|\bdds\b/i.test(haystack);
  const ddsCanOwnTask = language === "DDS" || (explicitDdsDesign && !(programLanguage && explicitProgramCreation));
  const explicitCompileFix = /(corr(e|i)g|fix|bug|falla|fallo|rnf\d{4}|error\s+(?:de\s+)?compilaci[oó]n|compile\s+error|compilation\s+error|listado\s+de\s+compilaci[oó]n)/i.test(haystack)
    && /compil|compile|rnf\d{4}/i.test(haystack)
    && !explicitProgramCreation;
  const explicitRuntimeFix = /(corr(e|i)g|fix|bug|falla|fallo|runtime|joblog|cpf\d{4}|mch\d{4})/i.test(haystack)
    && !/compil|compile|rnf\d{4}/i.test(haystack)
    && !explicitProgramCreation;

  let family: AssistTaskPlan["family"] = "general_explanation";
  if (input.options.code?.trim()) family = "code_review";
  if (explicitProgramCreation) family = "create_program";
  if (explicitCompileFix) family = "fix_compile_error";
  if (explicitRuntimeFix) family = "fix_runtime_error";
  if (ddsCanOwnTask) family = "design_dds_file";
  if (/dspf|display\s+file|pantalla|subfile|reporte|printer\s+file|prtf/i.test(haystack)) family = "design_display_or_report";
  if (isAdministrationQuery(haystack) && /lock|bloqueo|wrkobjlck|object\s+locks?/i.test(haystack) && !/wrkactjob|trabajos?\s+activos?|active\s+jobs?/i.test(haystack)) family = "object_lock_analysis";
  if (isAdministrationQuery(haystack)) family = "work_management";
  if (isDb2CatalogQuery(haystack)) family = "db2_catalog_query";
  if (input.resolved.intent === "message_diagnostic") family = "message_diagnostic";
  if (input.resolved.intent === "version_question") family = "version_check";
  if (input.resolved.intent === "syntax_lookup" && /^general_explanation$/.test(family)) family = "command_lookup";

  if (family === "work_management" || family === "object_lock_analysis") axes.add("administration");
  if (family === "db2_catalog_query") axes.add("database");
  if (hasCompile || family === "create_program" || family === "design_dds_file") axes.add("compile");
  if (hasSyntax || family !== "general_explanation") axes.add("syntax");

  const requiredEvidence = requiredEvidenceForTaskFamily(family, language);
  return {
    family,
    summary: taskFamilySummary(family),
    primaryLanguage: language === "IBM i" ? undefined : language,
    requiredEvidence,
    retrievalAxes: [...axes],
    responseTemplate: responseTemplateForTaskFamily(family),
    minimumCoverage: family === "general_explanation" ? "exploratory" : family === "command_lookup" ? "moderate" : "strong"
  };
}

function requiredEvidenceForTaskFamily(family: AssistTaskPlan["family"], language?: string): string[] {
  const byFamily: Record<AssistTaskPlan["family"], string[]> = {
    create_program: [`Guía de lenguaje ${language ?? "IBM i"}`, "comando de compilación aplicable", "opciones/pitfalls", "validación posterior"],
    fix_compile_error: ["mensaje/listado de compilación", "comando de compilación", "opciones relevantes", "recovery checklist"],
    fix_runtime_error: ["joblog o mensaje CPF/MCH", "comando/contexto de ejecución", "recovery checklist", "validación positiva/negativa"],
    code_review: ["señales del código", "tópicos de lenguaje", "comandos/opciones si aplica", "hallazgos documentados"],
    design_dds_file: ["sintaxis DDS", "keywords PF/LF", "comando CRTPF/CRTLF", "validaciones de claves/registros"],
    design_display_or_report: ["sintaxis DDS DSPF/PRTF", "keywords de pantalla/reporte", "comando de creación", "validación visual/spool"],
    command_lookup: ["tópico o sección del comando", "parámetros/sintaxis", "ejemplo o nota", "cita auditable"],
    work_management: ["WRKACTJOB/DSPJOB/WRKJOB cuando aplique", "JOB parameter", "joblog", "acciones de validación operativa"],
    object_lock_analysis: ["WRKOBJLCK", "lock states", "objeto/miembro", "trabajo propietario del lock"],
    db2_catalog_query: ["vistas de catálogo Db2 for i", "columnas/tablas relevantes", "limitaciones de consulta", "validación SQL"],
    message_diagnostic: ["mensaje exacto o familia", "causa/recovery", "evidencia de mensajes", "validación en joblog/listado"],
    version_check: ["evidencia por release", "diferencias", "fallbacks declarados", "citas comparables"],
    general_explanation: ["evidencia principal", "lectura materializada", "citas", "advertencias de cobertura"]
  };
  return byFamily[family];
}

function taskFamilySummary(family: AssistTaskPlan["family"]): string {
  const labels: Record<AssistTaskPlan["family"], string> = {
    create_program: "Crear o modificar un programa/fuente IBM i con guía documental y validación.",
    fix_compile_error: "Corregir error de compilación con evidencia de mensajes, opciones y comando de compilación.",
    fix_runtime_error: "Corregir fallo runtime apoyándose en joblog, mensajes y contexto de ejecución.",
    code_review: "Revisar código contra documentación IBM i y devolver hallazgos accionables.",
    design_dds_file: "Diseñar archivo DDS PF/LF con sintaxis, keywords y comando de creación.",
    design_display_or_report: "Diseñar display/printer file o reporte con DDS y validación visual/spool.",
    command_lookup: "Resolver comando/tópico IBM i con sintaxis, parámetros y citas.",
    work_management: "Resolver administración de trabajos, joblogs, jobs activos y navegación operacional.",
    object_lock_analysis: "Diagnosticar locks de objetos/miembros y trabajos propietarios.",
    db2_catalog_query: "Guiar consulta de catálogo Db2 for i con vistas y columnas verificables.",
    message_diagnostic: "Diagnosticar mensaje IBM i con causa/recovery y cobertura.",
    version_check: "Comparar disponibilidad o cambios entre releases IBM i.",
    general_explanation: "Explicar tópico IBM i con evidencia y advertencias."
  };
  return labels[family];
}

function responseTemplateForTaskFamily(family: AssistTaskPlan["family"]): string {
  const templates: Record<AssistTaskPlan["family"], string> = {
    create_program: "implementation-plan",
    fix_compile_error: "compile-fix-runbook",
    fix_runtime_error: "runtime-fix-runbook",
    code_review: "code-review-findings",
    design_dds_file: "dds-file-plan",
    design_display_or_report: "display-report-plan",
    command_lookup: "command-reference",
    work_management: "work-management-runbook",
    object_lock_analysis: "object-lock-runbook",
    db2_catalog_query: "db2-catalog-guidance",
    message_diagnostic: "message-diagnostic",
    version_check: "version-comparison",
    general_explanation: "documented-explanation"
  };
  return templates[family];
}

function buildAssistExecutiveSummary(input: {
  options: AssistOptions;
  resolved: ResolveResult;
  context: ContextPackage;
  coverage: AssistCoverage;
  taskPlan: AssistTaskPlan;
}): string[] {
  if (input.coverage.status === "thin") {
    return [
      "No hay base documental suficiente para responder con precisión; el MCP evita fabricar sintaxis, parámetros o comportamiento no sustentado.",
      `Intención detectada: ${input.resolved.intent}; confianza: baja; cobertura: ${input.coverage.status}.`,
      input.coverage.missingTechnicalTerms.length ? `Términos sin evidencia: ${input.coverage.missingTechnicalTerms.join(", ")}.` : "La consulta no ancló términos técnicos recuperables en el corpus."
    ];
  }
  const signals = input.context.intent.detectedSignals.join(", ") || "sin señales específicas";
  const matched = input.coverage.matchedTechnicalTerms.join(", ") || "términos generales de IBM i";
  return [
    `Plan detectado: ${input.taskPlan.summary}`,
    `La consulta se resolvió como ${input.resolved.intent} con confianza ${input.resolved.confidence}.`,
    `Lenguaje/categoría detectados: ${input.context.intent.language}${input.context.intent.category ? ` / ${input.context.intent.category}` : ""}; señales: ${signals}.`,
    `Evidencia materializada: ${input.coverage.evidenceCount} resultado(s), ${input.coverage.readCount} lectura(s), ${input.coverage.sectionCount} sección(es); términos cubiertos: ${matched}.`
  ];
}

function buildAssistSpecificFindings(input: {
  question: string;
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  evidence: SearchHit[];
  depth: AssistOptions["depth"];
}): string[] {
  const maxItems = input.depth === "deep" ? 10 : input.depth === "concise" ? 4 : 6;
  const technicalTerms = extractAssistTechnicalTerms(input.question);
  const termFindings = technicalTerms.flatMap((term) => {
    const foldedTerm = fold(term);
    const sectionMatch = input.sections
      .flatMap((topic) => topic.sections.map((section) => ({ topic, section })))
      .find(({ topic, section }) => fold(`${topic.title} ${section.title} ${section.content}`).includes(foldedTerm));
    if (sectionMatch) {
      return [`${term}: ${sectionMatch.topic.title} — ${sectionKindLabel(sectionMatch.section.kind)}: ${makeSnippet(sectionMatch.section.content, term, input.depth === "deep" ? 620 : 420)}`];
    }
    const readMatch = input.reads.find((read) => fold(`${read.title} ${read.excerpt}`).includes(foldedTerm));
    if (readMatch) return [`${term}: ${readMatch.title} [${readMatch.version}/${readMatch.category}]: ${makeSnippet(readMatch.excerpt, term, input.depth === "deep" ? 620 : 420)}`];
    const hitMatch = input.evidence.find((hit) => fold(`${hit.title} ${hit.snippet}`).includes(foldedTerm));
    if (hitMatch) return [`${term}: ${hitMatch.title} [${hitMatch.version}/${hitMatch.category}]: ${makeSnippet(hitMatch.snippet, term, 360)}`];
    return [];
  });
  const sectionFindings = input.sections
    .flatMap((topic) => topic.sections.map((section) => ({ topic, section })))
    .filter(({ section }) => ["syntax", "parameters", "description", "examples", "notes", "restrictions", "messages", "recovery"].includes(section.kind))
    .filter(({ topic, section }, index, array) => array.findIndex((item) => item.topic.id === topic.id && item.section.kind === section.kind) === index)
    .map(({ topic, section }) => `${topic.title} — ${sectionKindLabel(section.kind)}: ${makeSnippet(section.content, input.question, input.depth === "deep" ? 760 : 460)}`);
  const readFindings = input.reads.map((read) => `${read.title} [${read.version}/${read.category}]: ${makeSnippet(read.excerpt, input.question, input.depth === "deep" ? 760 : 460)}`);
  const evidenceFindings = input.evidence.slice(0, maxItems).map((hit) => `${hit.title} [${hit.version}/${hit.category}]: ${makeSnippet(hit.snippet, input.question, 360)}`);
  return [...new Set([...termFindings, ...sectionFindings, ...readFindings, ...evidenceFindings])].slice(0, maxItems);
}

function sectionKindLabel(kind: TopicSection["kind"]): string {
  const labels: Record<TopicSection["kind"], string> = {
    syntax: "sintaxis",
    parameters: "parámetros",
    description: "descripción",
    examples: "ejemplos",
    notes: "notas",
    restrictions: "restricciones",
    messages: "mensajes",
    recovery: "recuperación",
    related: "relacionado",
    generic: "sección"
  };
  return labels[kind];
}

function taskPlanImplementationSteps(taskPlan: AssistTaskPlan): string[] {
  switch (taskPlan.family) {
    case "create_program":
      return [
        "Plan de implementación: crear o ajustar el fuente con una estructura mínima verificable antes de añadir lógica secundaria.",
        "Definir interfaz, archivos usados, parámetros y manejo de errores antes de elegir si compilar como módulo ILE o programa bound.",
        "Seleccionar CRTRPGMOD/CRTBNDRPG/CRTSQLRPGI/CRTBNDCL según lenguaje y estrategia de enlace documentada."
      ];
    case "design_dds_file":
      return [
        "Plan DDS: definir formato de registro, campos, claves y keywords antes de generar el fuente.",
        "Validar si corresponde PF o LF, y si UNIQUE/FIFO/LIFO/FCFO aplica a la semántica de claves.",
        "Preparar comando de creación CRTPF/CRTLF con SRCFILE, SRCMBR y biblioteca objetivo."
      ];
    case "design_display_or_report":
      return [
        "Plan DDS de pantalla/reporte: separar formatos, indicadores, keywords y pruebas visuales/spool.",
        "Validar DSPF/PRTF y comando de creación antes de proponer código definitivo."
      ];
    case "work_management":
      return [
        "Trabajos y locks: ubicar primero el trabajo con WRKACTJOB/DSPJOB/WRKJOB según el dato disponible.",
        "Para bloqueos de objetos o miembros, usar WRKOBJLCK y luego navegar al trabajo propietario antes de terminar o cambiar procesos.",
        "Cruzar JOB parameter, joblog y estado del trabajo antes de proponer acciones operativas."
      ];
    case "object_lock_analysis":
      return [
        "Diagnóstico de locks: identificar objeto, biblioteca, tipo y miembro antes de revisar WRKOBJLCK.",
        "Determinar trabajo/usuario/lock state y validar impacto antes de liberar o finalizar trabajos."
      ];
    case "db2_catalog_query":
      return [
        "Diseñar consulta de catálogo Db2 for i con vistas QSYS2/SYS* y columnas explícitas.",
        "Mantener la consulta en modo lectura y validar esquema/biblioteca antes de sugerir automatización."
      ];
    case "fix_compile_error":
      return ["Leer mensaje/listado de compilación, aislar línea/opción afectada y recompilar con el comando documentado más específico."];
    case "fix_runtime_error":
      return ["Leer joblog y segundo nivel del mensaje antes de cambiar código; reproducir caso mínimo y validar recovery."];
    case "code_review":
      return ["Revisar señales del código contra documentación, proponer cambios mínimos y conservar evidencia por hallazgo."];
    default:
      return [];
  }
}

function filterAssistActionItems(actionItems: string[], taskPlan: AssistTaskPlan): string[] {
  if (!usesTaskScopedMaterial(taskPlan)) return actionItems;
  const filtered = actionItems.filter((item) => isRelevantForTaskPlan(taskPlan, item));
  return filtered.length ? filtered : [];
}

function taskPlanValidationChecks(taskPlan: AssistTaskPlan): string[] {
  switch (taskPlan.family) {
    case "create_program":
      return ["Validar que el fuente compile y que el joblog/listado no tenga RNF/CPF/MCH inesperados.", "Ejecutar prueba mínima del programa con datos válidos e inválidos."];
    case "design_dds_file":
      return ["Validar DDS con CRTPF/CRTLF y revisar errores de keywords/campos/claves en el listado.", "Probar claves únicas o reglas de duplicados con datos de ejemplo antes de cerrar."];
    case "design_display_or_report":
      return ["Compilar DSPF/PRTF y validar layout/indicadores/spool con un caso mínimo."];
    case "work_management":
      return ["Confirmar trabajo por nombre calificado job-number/user/job antes de actuar.", "Validar locks con WRKOBJLCK y revisar joblog del trabajo propietario si hay errores o esperas."];
    case "object_lock_analysis":
      return ["Confirmar objeto/biblioteca/tipo/miembro antes de interpretar locks.", "No finalizar trabajos sin validar impacto y propietario del bloqueo."];
    case "db2_catalog_query":
      return ["Ejecutar consulta inicialmente con FETCH FIRST o equivalente y validar columnas retornadas.", "Confirmar autoridad de solo lectura y biblioteca/esquema objetivo."];
    default:
      return [];
  }
}

function answerTemplateHeading(taskPlan: AssistTaskPlan): string {
  switch (taskPlan.family) {
    case "create_program":
      return "Plan de implementación";
    case "design_dds_file":
      return "Plan DDS";
    case "design_display_or_report":
      return "Plan de pantalla/reporte";
    case "work_management":
      return "Trabajos y locks";
    case "object_lock_analysis":
      return "Análisis de locks";
    case "db2_catalog_query":
      return "Guía Db2 for i";
    case "fix_compile_error":
      return "Runbook de compilación";
    case "fix_runtime_error":
      return "Runbook runtime";
    case "code_review":
      return "Revisión documental de código";
    case "message_diagnostic":
      return "Diagnóstico de mensaje";
    case "version_check":
      return "Comparación por versión";
    default:
      return "Respuesta documentada";
  }
}

function buildAssistImplementationSteps(input: {
  options: AssistOptions;
  resolved: ResolveResult;
  context: ContextPackage;
  coverage: AssistCoverage;
  taskPlan: AssistTaskPlan;
  depth: AssistOptions["depth"];
}): string[] {
  const steps: string[] = [];
  if (input.coverage.status === "thin") {
    return [
      "No aplicar cambios basados únicamente en esta consulta: primero confirma el nombre exacto del comando, mensaje, opcode, BIF o tópico IBM i.",
      "Reducir la consulta a un término técnico verificable y repetir la búsqueda documental antes de tocar código productivo.",
      "Si el término pertenece a un producto/extensión no incluido en el corpus, agregar un data pack o abrir un reporte de cobertura."
    ];
  }
  steps.push(...taskPlanImplementationSteps(input.taskPlan));
  steps.push(...filterAssistActionItems(input.context.actionItems, input.taskPlan));
  if (/rtvjoba/i.test(input.options.question)) {
    steps.push("En CLLE, revisar la sentencia RTVJOBA y declarar variables receptoras con tipo/longitud compatibles con los atributos de trabajo que se van a recuperar.");
  }
  if (/monmsg/i.test(input.options.question)) {
    steps.push("Colocar MONMSG en el alcance correcto inmediatamente después del comando que quieres proteger, evitando un monitor demasiado amplio que esconda fallos no relacionados.");
  }
  if (input.resolved.messageExplanation?.recoveryChecklist.length) {
    steps.push(...input.resolved.messageExplanation.recoveryChecklist.map((item) => `Para el mensaje detectado: ${item}`));
  }
  if (input.resolved.compileGuidance?.recommendedCommands.length) {
    steps.push(`Compilar/recompilar con ${input.resolved.compileGuidance.recommendedCommands.join(" o ")} según el tipo de objeto y revisar ${input.resolved.compileGuidance.optionsToReview.join(", ") || "las opciones relevantes"}.`);
  }
  if (input.resolved.codeValidation?.findings.length) {
    steps.push(...input.resolved.codeValidation.findings.map((finding) => `Corregir hallazgo documental [${finding.severity}] ${finding.title}: ${finding.detail}`));
  }
  steps.push("Aplicar el cambio mínimo en el fuente y conservar trazabilidad del tópico/documento usado para justificar la decisión técnica.");
  steps.push("Revisar joblog/listado de compilación después del cambio para confirmar que no aparecen mensajes nuevos derivados.");
  return [...new Set(steps)].slice(0, input.depth === "deep" ? 12 : input.depth === "concise" ? 5 : 8);
}

function buildAssistValidationChecklist(input: {
  options: AssistOptions;
  resolved: ResolveResult;
  context: ContextPackage;
  coverage: AssistCoverage;
  taskPlan: AssistTaskPlan;
  depth: AssistOptions["depth"];
}): string[] {
  if (input.coverage.status === "thin") {
    return [
      "Validar que el término técnico exista en IBM Docs, RDi exportado o un data pack autorizado.",
      "Confirmar versión IBM i objetivo antes de aceptar cualquier sintaxis sugerida.",
      "No marcar la tarea como resuelta hasta tener evidencia con lectura o sección específica."
    ];
  }
  const commands = input.resolved.compileGuidance?.recommendedCommands.length
    ? input.resolved.compileGuidance.recommendedCommands
    : input.context.compileCommands;
  const checks = [
    ...taskPlanValidationChecks(input.taskPlan),
    ...(commands.length ? [`Compilar con ${commands.join(" o ")} y revisar que el listado/joblog no contenga mensajes RNF/CPF/MCH inesperados.`] : []),
    input.options.version ? `Verificar en IBM i ${input.options.version} que la sintaxis/opciones usadas existen para ese release.` : "Confirmar el release IBM i real antes de cerrar la corrección.",
    "Ejecutar un caso positivo y uno negativo para comprobar tanto el flujo normal como el manejo por MONMSG/errores.",
    "Validar que las variables CL/RPG receptoras tengan longitud/tipo compatible con la documentación consultada.",
    "Revisar joblog con el mensaje completo de segundo nivel si la compilación o ejecución falla.",
    "Conservar IDs/citas del corpus usados como evidencia de auditoría técnica."
  ];
  return [...new Set(checks)].slice(0, input.depth === "deep" ? 10 : input.depth === "concise" ? 4 : 6);
}

function buildAssistAnswer(input: {
  options: AssistOptions;
  intent: DocsIntent;
  confidence: "alta" | "media" | "baja";
  taskPlan: AssistTaskPlan;
  executiveSummary: string[];
  specificFindings: string[];
  implementationSteps: string[];
  validationChecklist: string[];
  coverage: AssistCoverage;
  citations: AnswerCitation[];
  warnings: string[];
  depth: AssistOptions["depth"];
}): string {
  const citationLimit = input.depth === "deep" ? 8 : input.depth === "concise" ? 3 : 5;
  const lines: string[] = [
    "# Respuesta asistida IBM i",
    "",
    `Consulta: ${input.options.question}`,
    `Intención: ${input.intent}`,
    `Confianza: ${input.confidence}`,
    `Plan MCP: ${input.taskPlan.family} / plantilla ${input.taskPlan.responseTemplate}`,
    "",
    `## ${answerTemplateHeading(input.taskPlan)}`,
    `- ${input.taskPlan.summary}`,
    `- Evidencia mínima requerida: ${input.taskPlan.requiredEvidence.join("; ")}.`,
    "",
    "## Resumen directo",
    ...input.executiveSummary.map((item) => `- ${item}`),
    "",
    "## Evidencia específica usada"
  ];
  if (input.specificFindings.length) lines.push(...input.specificFindings.map((item) => `- ${item}`));
  else lines.push("- No encontré evidencia suficiente para afirmar sintaxis, parámetros o comportamiento con seguridad.");

  lines.push("", "## Qué hacer");
  lines.push(...input.implementationSteps.map((item, index) => `${index + 1}. ${item}`));

  lines.push("", "## Validación");
  lines.push(...input.validationChecklist.map((item) => `- ${item}`));

  lines.push("", "## Cobertura y límites");
  lines.push(`- Estado: ${input.coverage.status}. ${input.coverage.summary}`);
  lines.push(`- Evidencia/lecturas/secciones: ${input.coverage.evidenceCount}/${input.coverage.readCount}/${input.coverage.sectionCount}.`);
  if (input.coverage.matchedTechnicalTerms.length) lines.push(`- Términos cubiertos: ${input.coverage.matchedTechnicalTerms.join(", ")}.`);
  if (input.coverage.missingTechnicalTerms.length) lines.push(`- Términos sin evidencia específica: ${input.coverage.missingTechnicalTerms.join(", ")}.`);
  for (const warning of [...new Set([...input.coverage.warnings, ...input.warnings])].slice(0, 6)) lines.push(`- Advertencia: ${warning}`);

  lines.push("", "## Citas");
  if (input.citations.length) {
    lines.push(...input.citations.slice(0, citationLimit).map((citation) => `- ${citation.id}: ${citation.title} (${citation.version}, ${citation.sourceKind})${citation.section ? ` — sección: ${citation.section}` : ""}`));
  } else {
    lines.push("- Sin citas suficientes para esta consulta.");
  }
  lines.push("", "Nota: la respuesta anterior ya incluye búsqueda, lectura, secciones enfocadas, síntesis y validación documental dentro del MCP.");
  return lines.join("\n");
}

function buildRequiredEvidenceWarnings(input: {
  intent: DocsIntent;
  evidence: SearchHit[];
  messageExplanation?: MessageExplanation;
  compileGuidance?: CompileGuidance;
  versionComparison?: VersionComparison;
}): string[] {
  const warnings: string[] = [];
  if (input.intent === "message_diagnostic" && !input.messageExplanation?.evidence.length) {
    warnings.push("La intención exige diagnóstico de mensaje, pero no se encontró evidencia exacta para el mensaje solicitado.");
  }
  if (input.intent === "message_diagnostic" && input.messageExplanation?.coverageStatus === "family") {
    warnings.push(...(input.messageExplanation.warnings ?? []));
  }
  if (input.intent === "compile_guidance" && !input.compileGuidance?.evidence.length) {
    warnings.push("La intención exige guía de compilación, pero no se encontró evidencia documental suficiente para comandos/opciones.");
  }
  if (input.intent === "version_question" && !input.versionComparison?.evidence.length) {
    warnings.push("La intención exige comparación por versión, pero no se encontró evidencia suficiente por release.");
  }
  if (!input.evidence.length) warnings.push("No hay evidencia utilizable después de aplicar guardrails de relevancia.");
  return [...new Set(warnings)];
}

function computeResolveConfidence(input: {
  intent: DocsIntent;
  evidence: SearchHit[];
  answerResult?: AnswerResult;
  messageExplanation?: MessageExplanation;
  compileGuidance?: CompileGuidance;
  versionComparison?: VersionComparison;
  warnings: string[];
}): "alta" | "media" | "baja" {
  if (input.intent === "message_diagnostic" && !input.messageExplanation?.evidence.length) return "baja";
  if (input.intent === "message_diagnostic" && input.messageExplanation?.coverageStatus === "family") return "media";
  if (input.intent === "compile_guidance" && !input.compileGuidance?.evidence.length) return "baja";
  if (input.intent === "version_question" && !input.versionComparison?.evidence.length) return "baja";
  if (input.warnings.some((warning) => /no se encontr[oó]|no hay evidencia|sin evidencia|no inventar/i.test(warning))) return "baja";
  if (input.answerResult?.confidence) return input.answerResult.confidence;
  return input.evidence[0]?.score >= 60 ? "alta" : input.evidence.length >= 2 ? "media" : "baja";
}

function renderQueryIssueMarkdown(report: QueryReport): string {
  const lines = [
    "## Reporte de búsqueda IBM i Docs",
    "",
    `- **Fecha:** ${report.generatedAt}`,
    `- **Query:** \`${report.query}\``,
    `- **Categoría:** ${report.options.category ?? "n/a"}`,
    `- **Versión:** ${report.options.version ?? "n/a"}`,
    `- **Top result:** ${report.diagnostics.topResultTitle ?? "sin resultado"} (${report.diagnostics.topResultId ?? "n/a"})`,
    `- **FTS:** \`${report.diagnostics.ftsQuery || "n/a"}\``,
    `- **Términos exactos:** ${report.diagnostics.exactTerms.join(", ") || "n/a"}`,
    `- **Resultado esperado:** ${report.options.expectedTitle ?? report.options.expectedId ?? "n/a"}`,
    `- **Estado automático:** ${report.diagnostics.pass ? "pasa" : "revisar"}`,
    "",
    "### Advertencias",
    ...(report.diagnostics.warnings.length ? report.diagnostics.warnings.map((warning) => `- ${warning}`) : ["- n/a"]),
    "",
    "### Top resultados",
    ...report.results.slice(0, 8).map((hit, index) => [
      `${index + 1}. **${hit.title}**`,
      `   - ID: \`${hit.id}\``,
      `   - Score: ${hit.score}`,
      `   - Versión/Categoría/Fuente: ${hit.version} / ${hit.category} / ${hit.sourceKind}`,
      `   - Tipo/Clave: ${hit.documentKind ?? "n/a"} / ${hit.canonicalTopicKey ?? "n/a"}`,
      `   - Razones: ${(hit.matchReasons ?? []).join("; ") || "n/a"}`,
      `   - Warnings: ${(hit.relevanceWarnings ?? []).join("; ") || "n/a"}`
    ].join("\n")),
    "",
    "### Notas del reportante",
    report.options.notes ?? "_Describe aquí qué resultado esperabas y por qué el ranking actual no ayuda._"
  ];
  return lines.join("\n");
}

function classifyResolveIntent(options: ResolveOptions): DocsIntent {
  const haystack = [options.question, options.language, options.code].filter(Boolean).join("\n");
  if (options.code?.trim()) return "code_review";
  const axes = detectIntentAxes(haystack);
  if (axes.size > 1 && axes.has("message") && (axes.has("command") || axes.has("syntax"))) return "multi_intent";
  if (/\b(RNF\d{4}|SQL\d{4,5}|CPF\d{4}|MCH\d{4})\b/i.test(haystack)) return "message_diagnostic";
  if (/ranking|rank|por qu[eé].*(resultado|sale|aparece)|explain.?ranking|score|b[uú]squeda.*mal/i.test(haystack)) return "ranking_debug";
  if (/(7\.[3456]).*(7\.[3456])|compar(a|ar|aci[oó]n)|diferencia|entre versiones|release/i.test(haystack)) return "version_question";
  if (/compil|compile|crt(sqlrpgi|rpgmod|bndcl|bndrpg|pf|lf)|crear.*(programa|m[oó]dulo|servicio)|sqlrpgle|copybook|\/\s*(copy|include)\b/i.test(haystack)) return "compile_guidance";
  if (/sintaxis|syntax|par[aá]metro|parameter|operand|opcode|operation code|ejemplo|example|%[a-z][a-z0-9_-]+|\b[A-Z]{2,}-[A-Z]{2,}\b/i.test(haystack)) return "syntax_lookup";
  if (axes.has("command")) return "syntax_lookup";
  if (/buscar|busca|lista|encuentra|find|search|documentos?|t[oó]picos?/i.test(haystack)) return "search_discovery";
  return "explain_topic";
}

function detectIntentAxes(haystack: string): Set<"message" | "command" | "compile" | "syntax" | "version" | "search"> {
  const axes = new Set<"message" | "command" | "compile" | "syntax" | "version" | "search">();
  if (/\b(RNF\d{4}|SQL\d{4,5}|CPF\d{4}|MCH\d{4}|RNF|CPF|MCH|SQLCODE|SQLSTATE)\b/i.test(haystack)) axes.add("message");
  if (extractExactTechnicalTerms(haystack).some((term) => IBM_I_COMMAND_PREFIX_PATTERN.test(term) && !isMessageIdTerm(term))) axes.add("command");
  if (/comandos?\s+CL|CL commands?|DSPFD|SBMJOB|RTVJOBA/i.test(haystack)) axes.add("command");
  if (/compil|compile|crt(sqlrpgi|rpgmod|bndcl|bndrpg|pf|lf)|sqlrpgle|copybook|\/\s*(copy|include)\b/i.test(haystack)) axes.add("compile");
  if (/sintaxis|syntax|par[aá]metro|parameter|operand|opcode|operation code|%[a-z][a-z0-9_-]+|\b[A-Z]{2,}-[A-Z]{2,}\b/i.test(haystack)) axes.add("syntax");
  if (/(7\.[3456]).*(7\.[3456])|compar(a|ar|aci[oó]n)|entre versiones|release/i.test(haystack)) axes.add("version");
  if (/buscar|busca|lista|encuentra|find|search|documentos?|t[oó]picos?/i.test(haystack)) axes.add("search");
  return axes;
}

function mixedIntentWarnings(intent: DocsIntent, axes: Set<string>, messageId?: string): string[] {
  if (intent !== "multi_intent") return [];
  return [
    `Consulta mixta detectada: ${[...axes].sort().join(", ")}.`,
    ...(!messageId && axes.has("message") ? ["Se mencionan familias de mensajes sin ID concreto; para diagnóstico exacto usa RNF0004, CPF9898, MCH3601 o SQLnnnnn."] : []),
    "La evidencia se debe leer por eje técnico; no asumir que un único tópico cubre comandos, mensajes y compilación a la vez."
  ];
}

function buildNextToolRecommendation(hit: SearchHit, options: SearchOptions): NextToolRecommendation {
  const lowerTitle = fold(hit.title);
  const exactCommand = isLikelyIbmCommandQuery(options.query) && /\b(command|description of the .+ command)\b/i.test(hit.title);
  if (exactCommand || /sintaxis|syntax|par[aá]metro|operand|%[a-z]/i.test(options.query)) {
    return {
      tool: "ibmi_docs_read",
      reason: "La búsqueda encontró un tópico técnico concreto; lee el tópico completo antes de responder para no quedarte solo con el snippet.",
      arguments: { id: hit.id, then: "ibmi_docs_sections", focus: ["syntax", "parameters", "examples", "notes"] }
    };
  }
  if (/rnf\d{4}|sql\d{4,5}|cpf\d{4}|mch\d{4}/i.test(options.query)) {
    return {
      tool: "ibmi_docs_explain_message",
      reason: "La consulta parece un mensaje IBM i; conviene generar diagnóstico y checklist de recuperación.",
      arguments: { messageId: extractMessageId(options.query) ?? options.query, limit: options.limit ?? 6 }
    };
  }
  if (/compar|7\.[3456]|release|versi[oó]n/i.test(options.query)) {
    return {
      tool: "ibmi_docs_compare_versions",
      reason: "La consulta menciona versiones; compara releases en vez de confiar en un único hit.",
      arguments: { query: options.query, versions: extractVersions(options.query), category: options.category, limit: options.limit ?? 5 }
    };
  }
  if (/compil|crtrpgmod|crtbndrpg|crtsqlrpgi|crtbndcl|crtp[fl]/i.test(options.query) || lowerTitle.includes("command")) {
    const language = normalizeLanguage(options.query) ?? (isLikelyIbmCommandQuery(options.query) ? "CLLE" : undefined);
    return {
      tool: "ibmi_docs_compile_guidance",
      reason: "La consulta apunta a construcción/compilación; usa guía de compilación para comandos, opciones y pitfalls.",
      arguments: { ...(language ? { language } : {}), version: options.version, limit: options.limit ?? 8 }
    };
  }
  return {
    tool: "ibmi_docs_read",
    reason: "Search es descubrimiento; para usar esta evidencia en una respuesta, lee el documento completo.",
    arguments: { id: hit.id }
  };
}

function applyNextToolRecommendation(hit: SearchHit, options: SearchOptions): void {
  const recommendation = buildNextToolRecommendation(hit, options);
  hit.nextRecommendedTool = recommendation.tool;
  hit.nextRecommendedReason = recommendation.reason;
  hit.nextRecommendedArguments = recommendation.arguments;
  hit.workflowHints = [
    `No responder solo con snippet: siguiente tool recomendada ${recommendation.tool}.`,
    options.includeSections ? "sectionsPreview incluido para triage; usa ibmi_docs_sections para cobertura completa." : "Si necesitas sintaxis/parámetros, activa includeSections o usa ibmi_docs_sections."
  ];
}

function shouldAutoReadSearchHit(hit: SearchHit, options: SearchOptions): boolean {
  const queryTerms = extractExactTechnicalTerms(options.query).map(fold);
  const title = fold(hit.title);
  const hasExactTerm = queryTerms.some((term) => title.includes(term));
  return hasExactTerm
    && (isLikelyIbmCommandQuery(options.query) || /%[a-z][a-z0-9_-]+/i.test(options.query) || /\b[A-Z]{2,}-[A-Z]{2,}\b/.test(options.query))
    && /\b(command|description|send|message|operation|function|keyword)\b/i.test(hit.title)
    && hit.score >= 40;
}

function extractMessageId(value: string): string | undefined {
  return value.match(/\b(RNF\d{4}|SQL\d{4,5}|CPF\d{4}|MCH\d{4})\b/i)?.[1]?.toUpperCase();
}

function extractVersions(value: string): string[] {
  return [...new Set(value.match(/\b7\.[3456]\b/g) ?? [])];
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}_#$@.\/+%-]{2,}/gu) ?? [];
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function extractExactTechnicalTerms(query: string): string[] {
  const rawTokens = query
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[%]?[a-z][a-z0-9]*(?:[-_/][a-z0-9]+)*|[#@$][a-z0-9_%-]+/gu) ?? [];
  return [...new Set(rawTokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 || token.startsWith("%"))
    .filter((token) => isCommandOrOpcodeTerm(token) || token.startsWith("%")))];
}

function extractPrimaryTechnicalTerm(title: string): string | undefined {
  const first = tokenize(title)[0];
  if (first && isCommandOrOpcodeTerm(first)) return first;
  const match = fold(title).match(/\b([a-z]{2,}[a-z0-9]*(?:-[a-z0-9]+)?)\b/);
  return match?.[1] && isCommandOrOpcodeTerm(match[1]) ? match[1] : undefined;
}

function isCommandOrOpcodeTerm(token: string): boolean {
  const foldedToken = fold(token);
  if (IBM_I_COMMAND_FALSE_POSITIVES.has(foldedToken)) return false;
  return /-/.test(token)
    || /^%[a-z][a-z0-9_-]+$/.test(token)
    || IBM_I_COMMAND_PREFIX_PATTERN.test(token)
    || /^rnf\d{4}$/i.test(token)
    || /^sql\d{4,5}$/i.test(token)
    || /^cpf\d{4}$/i.test(token)
    || /^mch\d{4}$/i.test(token);
}

function isMessageIdTerm(token: string): boolean {
  return /^(rnf|cpf|mch)\d{4}$/i.test(token) || /^sql\d{4,5}$/i.test(token);
}

function isMessageEvidenceHit(hit: Pick<SearchHit, "title" | "category" | "breadcrumbs" | "snippet">, messageId: string, family = messageId.match(/^[A-Z]+/i)?.[0] ?? ""): boolean {
  const normalizedFamily = family.toUpperCase();
  const titleAndPath = fold([hit.title, hit.breadcrumbs?.join(" ") ?? ""].join(" "));
  const category = fold(hit.category ?? "");
  if (titleAndPath.includes(fold(messageId))) return true;
  if (normalizedFamily === "RNF") return category === "mensajes-rnf" || /rpg messages|compiler messages|messages and codes/.test(titleAndPath);
  if (normalizedFamily === "SQL") return category === "sql-db2-for-i" || /sql messages|sql codes|messages and codes/.test(titleAndPath);
  if (normalizedFamily === "CPF") return category === "mensajes-cpf" || /cpf messages|system messages|message descriptions|messages and codes/.test(titleAndPath);
  if (normalizedFamily === "MCH") return category === "mensajes-mch" || /mch messages|machine messages|message descriptions|messages and codes/.test(titleAndPath);
  return /^mensajes/.test(category) || /messages and codes|message descriptions/.test(titleAndPath);
}

function messageHitContainsExactId(hit: Pick<SearchHit, "title" | "breadcrumbs" | "snippet">, messageId: string): boolean {
  const exact = fold(messageId);
  return fold([hit.title, hit.breadcrumbs?.join(" ") ?? "", hit.snippet ?? ""].join(" ")).includes(exact);
}

function isLikelyIbmCommandQuery(query: string): boolean {
  return extractExactTechnicalTerms(query).some((term) => IBM_I_COMMAND_PREFIX_PATTERN.test(term));
}

function extractCommandQueryTerm(query: string): string | undefined {
  return extractExactTechnicalTerms(query).find((term) => IBM_I_COMMAND_PREFIX_PATTERN.test(term) && !isMessageIdTerm(term));
}

function isExactCommandTitle(title: string, foldedCommand: string): boolean {
  const foldedTitle = fold(title);
  return foldedTitle === `${foldedCommand} command`
    || foldedTitle.startsWith(`${foldedCommand} command `)
    || foldedTitle === `description of the ${foldedCommand} command`;
}

function commandFallbackNeedles(foldedCommand: string): string[] {
  // Algunos comandos CL aparecen en el corpus por su descripción larga, no por el nombre corto del comando.
  return [foldedCommand, ...(IBM_I_COMMAND_ALIASES[foldedCommand] ?? [])].map((needle) => fold(needle));
}

function commandFallbackPriority(hit: SearchHit, foldedCommand: string): number {
  const haystack = fold([hit.title, hit.breadcrumbs.join(" "), hit.snippet].join(" "));
  const aliases = IBM_I_COMMAND_ALIASES[foldedCommand] ?? [];
  let score = hit.score;
  if (/cl command finder|alphabetic list of cl commands/.test(haystack)) score += 80;
  if (/ibm i commands/.test(haystack)) score += 55;
  if (fold(hit.title).includes(foldedCommand)) score += 45;
  if (aliases.some((alias) => fold(hit.title).includes(fold(alias)))) score += 90;
  if (aliases.some((alias) => haystack.includes(fold(alias)))) score += 35;
  if (/example: using the retrieve job attributes command/.test(haystack)) score += 40;
  if (hit.category === "cl-clle") score += 15;
  return score;
}

function messageFamilyEvidencePriority(hit: SearchHit): number {
  const haystack = fold([hit.title, hit.breadcrumbs.join(" "), hit.snippet].join(" "));
  let score = 0;

  // Para familias CPF/MCH sin página exacta en el corpus, priorizamos evidencia
  // de manejo/descripción de mensajes sobre índices genéricos de comandos CL.
  if (/message descriptions|defining message descriptions|retrieving message descriptions/.test(haystack)) score += 45;
  if (/\bmessages\b/.test(haystack)) score += 20;
  if (/qcpfmsg|sndpgmmsg|message file|joblog|job log/.test(haystack)) score += 15;
  if (/cl command finder|ibm i commands|alphabetic list of cl commands/.test(haystack)) score -= 35;
  if (/^example:/.test(fold(hit.title)) && !/message descriptions|message file/.test(haystack)) score -= 25;

  return score;
}

function messageFamilyFallbackScore(hit: SearchHit): number {
  const priority = messageFamilyEvidencePriority(hit);
  const boundedFts = Math.max(0, Math.min(hit.score, 99)) / 100;
  return Math.round((priority * 10 + boundedFts) * 100000) / 100000;
}

function prioritizeCompileEvidence(hits: SearchHit[], language: string, limit: number): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const hit of hits) {
    const current = seen.get(hit.id);
    if (!current || compileEvidenceScore(hit, language) > compileEvidenceScore(current, language)) seen.set(hit.id, hit);
  }
  return [...seen.values()]
    .sort((a, b) => compileEvidenceScore(b, language) - compileEvidenceScore(a, language) || b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, clamp(limit, 8, 1, 50));
}

function compileEvidenceScore(hit: SearchHit, language: string): number {
  const haystack = fold([hit.title, hit.breadcrumbs.join(" "), hit.snippet].join(" "));
  let score = hit.score;
  if (language === "SQLRPGLE") {
    if (/crtsqlrpgi/.test(haystack)) score += 120;
    if (/embedded sql|sql rpg|precompiler|rpgppopt/.test(haystack)) score += 70;
    if (/copy|include/.test(haystack)) score += 25;
    if (/sysindexstat|catalog table|catalog view/.test(haystack)) score -= 120;
  }
  return score;
}

function messageFamilyFallbackQuery(messageId: string): string | undefined {
  const family = messageId.match(/^[A-Z]+/)?.[0]?.toUpperCase();
  if (family === "CPF") return "message descriptions message file QCPFMSG SNDPGMMSG joblog";
  if (family === "MCH") return "machine messages message descriptions joblog";
  if (family === "SQL") return "SQL messages SQLCODE SQLSTATE Db2 for i";
  if (family === "RNF") return "RPG Messages compiler messages RNF";
  return undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function likePattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function resolvePreset(input?: string): LanguagePreset | undefined {
  if (!input) return undefined;
  const normalized = normalizeLanguage(input);
  return LANGUAGE_PRESETS.find((preset) => preset.language === normalized) ?? LANGUAGE_PRESETS.find((preset) => preset.signals.some((signal) => signal.test(input)));
}

function normalizeLanguage(input?: string): string | undefined {
  if (!input) return undefined;
  const value = input.trim().toUpperCase();
  if (/SQL\s*RPG|SQLRPGLE|EMBEDDED\s+SQL/.test(value)) return "SQLRPGLE";
  if (/RPGLE|ILE\s+RPG|RPG/.test(value)) return "RPGLE";
  if (/CLLE|CONTROL\s+LANGUAGE|\bCL\b/.test(value)) return "CLLE";
  if (/DDS|PHYSICAL\s+FILE|LOGICAL\s+FILE|\bPF\b|\bLF\b/.test(value)) return "DDS";
  if (/COBOL/.test(value)) return "COBOL";
  return undefined;
}

function detectSignals(task: string, language?: string, preset?: LanguagePreset): string[] {
  const haystack = [task, language].filter(Boolean).join(" ");
  const signals = new Set<string>();
  if (preset) signals.add(preset.language);
  if (/exec\s+sql|embedded\s+sql|sqlrpgle|crtsqlrpgi/i.test(haystack)) signals.add("embedded SQL");
  if (/\/\s*(copy|include)|copybook|include/i.test(haystack)) signals.add("/COPY /INCLUDE");
  if (/rnf\d{4}/i.test(haystack)) signals.add("RNF message");
  if (/\bdds\b|\bpf\b|physical file|logical file/i.test(haystack)) signals.add("DDS/PF/LF");
  if (/monmsg/i.test(haystack)) signals.add("MONMSG");
  if (/sndpgmmsg/i.test(haystack)) signals.add("SNDPGMMSG");
  if (/sbmjob/i.test(haystack)) signals.add("SBMJOB");
  if (/rtvjoba/i.test(haystack)) signals.add("RTVJOBA");
  if (/cpf\d{4}/i.test(haystack)) signals.add("CPF message");
  return [...signals];
}

function buildVersionNotes(hits: SearchHit[]): string[] {
  const versions = [...new Set(hits.map((hit) => hit.version))].sort(naturalVersionSort);
  if (!versions.length) return ["No se encontró cobertura versionada para la consulta."];
  return [`Evidencia encontrada en versiones/fuentes: ${versions.join(", ")}.`];
}

function queryCounts(db: Database.Database, column: "category" | "version" | "source_kind"): Record<string, number> {
  const rows = db.prepare(`SELECT ${column} AS key, COUNT(*) AS value FROM documents GROUP BY ${column}`).all() as Array<{ key: string; value: number }>;
  return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.value)]));
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function unique<T>(value: T, index: number, array: T[]): boolean {
  return array.indexOf(value) === index;
}

function naturalVersionSort(a: string, b: string): number {
  if (a === "RDi-local") return 1;
  if (b === "RDi-local") return -1;
  return a.localeCompare(b, undefined, { numeric: true });
}

function normalizeVersionInput(version: string): string {
  const match = version.match(/7\.[3456]/);
  if (match) return match[0];
  if (/rdi/i.test(version)) return "RDi-local";
  return version;
}
