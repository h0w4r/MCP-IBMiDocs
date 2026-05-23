import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
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
  CorpusManifest,
  DocsIntent,
  ExplainMessageOptions,
  DocsRecipe,
  MessageExplanation,
  NextToolRecommendation,
  PackDiagnostics,
  QualityReport,
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
    preferredTools: ["ibmi_docs_answer", "ibmi_docs_read", "ibmi_docs_sections"],
    requiredEvidence: ["respuesta extractiva", "lectura completa de los tópicos principales", "citas auditables"],
    defaultLimit: 6,
    description: "Consulta explicativa general: responder con citas y leer los tópicos principales antes de concluir."
  },
  syntax_lookup: {
    intent: "syntax_lookup",
    preferredTools: ["ibmi_docs_search", "ibmi_docs_read", "ibmi_docs_sections"],
    requiredEvidence: ["tópico exacto", "secciones de sintaxis/parámetros/ejemplos", "lectura completa"],
    defaultLimit: 6,
    description: "Consulta de sintaxis, comandos, opcodes o BIFs: resolver el tópico exacto y extraer secciones relevantes."
  },
  compile_guidance: {
    intent: "compile_guidance",
    preferredTools: ["ibmi_docs_context", "ibmi_docs_compile_guidance", "ibmi_docs_read"],
    requiredEvidence: ["comandos de compilación", "opciones/pitfalls", "evidencia por lenguaje"],
    defaultLimit: 8,
    description: "Guía de compilación/desarrollo: combinar contexto por lenguaje con comandos y opciones documentadas."
  },
  message_diagnostic: {
    intent: "message_diagnostic",
    preferredTools: ["ibmi_docs_explain_message", "ibmi_docs_read", "ibmi_docs_sections"],
    requiredEvidence: ["mensaje exacto o familia", "checklist de recuperación", "lectura del tópico de mensajes"],
    defaultLimit: 6,
    description: "Diagnóstico RNF/SQL/CPF/MCH: explicar familia, evidencia y recuperación."
  },
  code_review: {
    intent: "code_review",
    preferredTools: ["ibmi_docs_validate_code_context", "ibmi_docs_answer", "ibmi_docs_compile_guidance"],
    requiredEvidence: ["señales detectadas en código", "hallazgos", "documentos relacionados"],
    defaultLimit: 8,
    description: "Revisión documental de código IBM i: detectar señales y contrastarlas con documentación."
  },
  version_question: {
    intent: "version_question",
    preferredTools: ["ibmi_docs_compare_versions", "ibmi_docs_read"],
    requiredEvidence: ["comparación por release", "deltas estructurales", "citas por versión"],
    defaultLimit: 5,
    description: "Pregunta entre versiones IBM i: buscar cada release y comparar cobertura/estructura."
  },
  ranking_debug: {
    intent: "ranking_debug",
    preferredTools: ["ibmi_docs_explain_ranking", "ibmi_docs_search", "ibmi_docs_read"],
    requiredEvidence: ["razones de ranking", "query FTS", "expansiones semánticas"],
    defaultLimit: 5,
    description: "Depuración de búsqueda/ranking: explicar por qué ganó cada resultado."
  },
  search_discovery: {
    intent: "search_discovery",
    preferredTools: ["ibmi_docs_search", "ibmi_docs_read"],
    requiredEvidence: ["candidatos de búsqueda", "siguiente lectura recomendada"],
    defaultLimit: 8,
    description: "Exploración amplia: descubrir documentos candidatos y recomendar lectura posterior."
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
      rows.push(...(stmt.all({ ...baseParams, fts }) as Array<Record<string, unknown>>));
    }
    rows.push(...this.findExactTechnicalRows(exactTerms, options));
    const bestByDocument = new Map<string, SearchHit>();
    for (const row of rows) {
      const hit = rowToHit(row, options.query);
      hit.taxonomy = classifyTaxonomy(hit, String(row.body ?? ""));
      hit.semanticScore = semanticScore(hit, options.query, semantic);
      hit.matchReasons = buildMatchReasons(hit, String(row.body ?? ""), options.query, semantic);
      hit.score = scoreHit(hit, String(row.body), Number(row.rank ?? 0), options, Number(row.chunk_index ?? 0)) + hit.semanticScore;
      applyNextToolRecommendation(hit, options);
      if (options.includeSections) hit.sectionsPreview = extractTopicSections(String(row.body ?? "")).slice(0, 4);
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
    const results = [...bestByDocument.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
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
      breadcrumbs: JSON.parse(String(row.breadcrumbs_json || "[]")) as string[],
      content,
      textLength: Number(row.text_length),
      sha256: String(row.sha256),
      sections
    };
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
    const reads = hits.slice(0, Math.min(3, hits.length)).map((hit) => this.read(hit.id)).filter((value): value is ReadResult => Boolean(value));
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
    if (hits.length && hits[0].score < 20) warnings.push("La evidencia existe, pero el score principal es bajo; conviene leer los tópicos antes de responder con seguridad.");

    const result: AnswerResult = {
      question: options.question,
      answer: buildExtractiveAnswer(options, reads, compile),
      confidence: hits[0]?.score >= 60 ? "alta" : hits.length >= 2 ? "media" : "baja",
      citations,
      evidence: hits,
      warnings,
      suggestedTools: hits.length ? ["ibmi_docs_read", "ibmi_docs_sections", "ibmi_docs_explain_ranking"] : ["ibmi_docs_search"]
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
        hit,
        reasons: hit.matchReasons ?? [],
        taxonomy: hit.taxonomy ?? classifyTaxonomy(hit, hit.snippet),
        semanticScore: hit.semanticScore ?? 0
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
    const queries = [...new Set([options.task, ...(preset?.queries ?? [])].filter(Boolean))];
    const hits = this.searchMany(queries, { category: preset?.category, version: options.version, limit: options.limit ?? 8 });
    const result: ContextPackage = {
      task: options.task,
      intent: {
        language: preset?.language ?? normalizeLanguage(options.language) ?? "IBM i",
        category: preset?.category,
        detectedSignals,
        queries
      },
      recommendedDocs: hits.slice(0, options.limit ?? 8),
      compileCommands: preset?.compileCommands ?? [],
      optionsToReview: preset?.optionsToReview ?? [],
      pitfalls: preset?.pitfalls ?? [],
      versionNotes: buildVersionNotes(hits),
      evidence: hits
    };
    this.recordTrace("ibmi_docs_context", started, {
      query: options.task,
      resultCount: hits.length,
      topResultId: hits[0]?.id,
      topResultTitle: hits[0]?.title
    });
    return result;
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
    const evidence = this.searchMany(queries, { category, version: options.version, limit: options.limit ?? 8 });
    const recommendedCommands = options.usesEmbeddedSql || preset.language === "SQLRPGLE" ? ["CRTSQLRPGI"] : preset.compileCommands;
    const optionsToReview = [...new Set([...preset.optionsToReview, ...(options.usesCopybook ? ["RPGPPOPT"] : []), ...(options.usesEmbeddedSql ? ["COMMIT"] : [])])];
    const result: CompileGuidance = {
      language: preset.language,
      target: options.target ?? "program",
      recommendedCommands,
      relatedCommands: preset.relatedCommands,
      optionsToReview,
      pitfalls: preset.pitfalls,
      evidence
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
    const category = family === "RNF" ? "mensajes-rnf" : family === "SQL" ? "sql-db2-for-i" : "ibm-i-general";
    const evidence = this.search({ query: messageId, category, limit: options.limit ?? 6 });
    const result: MessageExplanation = {
      messageId,
      family,
      category,
      summary: evidence.length
        ? `Se encontró evidencia documental para ${messageId} en ${evidence[0].title}.`
        : `No se encontró una entrada exacta para ${messageId}; revisar listado de compilación o joblog completo.`,
      recoveryChecklist: [
        "Confirmar el mensaje exacto, severidad y texto de segundo nivel en el listado/joblog.",
        "Corregir primero mensajes anteriores que puedan provocar errores derivados.",
        "Recompilar y validar que el mensaje desaparezca o cambie de severidad.",
        "Si aplica, contrastar opciones de compilación y miembros /COPY o /INCLUDE referenciados."
      ],
      evidence
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
        const file = path.join(this.packDir, String(row[key]));
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
    const sparseCategories = Object.entries(coverage.byCategory)
      .filter(([, count]) => count < 50)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.count - b.count);
    return {
      ok: pack.ok && shortDocuments.length < 100,
      generatedAt: new Date().toISOString(),
      corpusVersion: manifest.corpusVersion,
      documents: pack.documents,
      chunks: pack.chunks,
      coverage,
      shortDocuments,
      duplicateTitles,
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

    // En guía de compilación el resumen final se arma desde context + compileGuidance;
    // ejecutar answer además duplica búsquedas/lecturas y vuelve el workflow innecesariamente pesado.
    const answerResult = intent !== "ranking_debug" && intent !== "compile_guidance"
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

    const context = intent === "compile_guidance" || intent === "code_review"
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

    const compileGuidance = intent === "compile_guidance" || intent === "code_review"
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

    const messageExplanation = intent === "message_diagnostic" && messageId
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

    const evidence = [...evidenceById.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const warnings = [
      ...(answerResult?.warnings ?? []),
      ...(!evidence.length ? ["No se encontró evidencia documental suficiente; no inventar detalles fuera del corpus."] : []),
      ...(intent === "search_discovery" ? ["Esta resolución es exploratoria: lee los IDs recomendados antes de citar detalles finos."] : [])
    ];
    const suggestedTools = [...new Set([
      ...policy.preferredTools,
      ...(searchHits[0]?.nextRecommendedTool ? [searchHits[0].nextRecommendedTool] : []),
      "ibmi_docs_explain_ranking"
    ])];

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
      confidence: answerResult?.confidence ?? (evidence[0]?.score >= 60 ? "alta" : evidence.length >= 2 ? "media" : "baja"),
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
    const equivalentVersions = this.findEquivalentVersions(topic).filter((hit) => hit.id !== id);
    const relatedQuery = [topic.title, topic.breadcrumbs.slice(-3).join(" ")].filter(Boolean).join(" ");
    const related = this.search({ query: relatedQuery, category: topic.category, limit: options.limit ?? 8 }).filter((hit) => hit.id !== id);
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
        result,
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
    const result: VersionComparison = { query: options.query, versions: entries, evidence };
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
    if (!findings.length) {
      findings.push({
        severity: "info",
        title: "Sin señales críticas automáticas",
        detail: "No se detectaron patrones problemáticos básicos; revisar evidencia documental recomendada para el lenguaje.",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 3)
      });
    }
    const result: CodeValidationResult = { language: preset?.language ?? normalizeLanguage(options.language) ?? options.language, detectedSignals, findings, evidence };
    this.recordTrace("ibmi_docs_validate_code_context", started, {
      query: options.language,
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  private traceFile(): string {
    return process.env.IBMI_DOCS_TRACE_FILE
      ? path.resolve(process.env.IBMI_DOCS_TRACE_FILE)
      : path.resolve("data", "ibmi-docs-trace.ndjson");
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
  return {
    id,
    title: String(row.title),
    snippet: makeSnippet(String(row.body ?? ""), query, 520),
    score: 0,
    sourceKind: String(row.source_kind) as SearchHit["sourceKind"],
    sourceId: String(row.source_id),
    version: String(row.version),
    category: String(row.category),
    canonicalUrl: String(row.canonical_url),
    breadcrumbs: JSON.parse(String(row.breadcrumbs_json || "[]")) as string[],
    textLength: Number(row.text_length ?? 0),
    readHint: `Para obtener la ayuda completa llama ibmi_docs_read con id="${id}".`
  };
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
  const haystack = fold([hit.title, hit.category, hit.breadcrumbs?.join(" ") ?? "", content.slice(0, 1200)].join(" "));
  const signals: string[] = [];
  const match = (kind: TopicTaxonomy["kind"], label: string, checks: Array<[RegExp, string]>): TopicTaxonomy | undefined => {
    for (const [pattern, signal] of checks) if (pattern.test(haystack)) signals.push(signal);
    if (!signals.length) return undefined;
    return { kind, label, confidence: Math.min(1, 0.45 + signals.length * 0.18), signals: [...new Set(signals)] };
  };
  return match("rpg-bif", "Built-in function RPG", [[/%[a-z][a-z0-9_-]+/, "percent-bif"], [/built-in function/, "built-in function"]])
    ?? match("rpg-opcode", "Operation code RPG", [[/\bsnd-msg\b|\bchain\b|\breade\b|\bmonitor\b|\bon-error\b/, "rpg opcode"], [/operation codes?/, "operation code"]])
    ?? match("message", "Mensaje IBM i/RNF/SQL", [[/\brnf\d{4}\b/, "RNF"], [/\bsql\d{4,5}\b/, "SQL message"], [/messages?/, "message"]])
    ?? match("command", "Comando IBM i", [[/\b(add|chg|crt|dlt|dsp|end|mon|ovr|rcv|rmv|rst|sav|snd|str|wrk)[a-z0-9]{2,}\b/, "command prefix"], [/\bcommand\b/, "command"]])
    ?? match("dds-keyword", "DDS/keyword", [[/\bdds\b|\bphysical file\b|\blogical file\b|\bkeyword\b/, "dds keyword"], [/\b(unique|reffld|edtcde|dspatr)\b/, "dds keyword name"]])
    ?? match("sql", "Db2 for i / SQL", [[/\bsqlrpgle\b|embedded sql|exec sql|db2 for i/, "sql"], [/\bselect\b|\bcommit\b|\bcursor\b/, "sql statement"]])
    ?? match("api", "API IBM i", [[/\bq[a-z0-9]{6,}\b/, "qsys api"], [/\bapi\b/, "api"]])
    ?? match("language-guide", "Guía de lenguaje", [[/ile rpg|cl programs|cobol|control language/, "language guide"]])
    ?? { kind: "general", label: "General IBM i", confidence: 0.2, signals: [] };
}

function extractTopicSections(content: string): TopicSection[] {
  const lines = content.split(/\r?\n/);
  const headingIndexes: Array<{ index: number; title: string; kind: TopicSection["kind"] }> = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 140) return;
    const kind = detectSectionKind(trimmed);
    const looksHeading = kind !== "generic" || (/^[A-Z0-9_/%*()[\] .,:;-]{4,}$/.test(trimmed) && index > 0);
    if (looksHeading) headingIndexes.push({ index, title: trimmed, kind });
  });
  if (!headingIndexes.length) {
    return [{ kind: "description", title: "Contenido", content: content.trim(), startLine: 1, endLine: lines.length }];
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
  return sections.slice(0, 80);
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
      "Siguiente paso recomendado: ampliar la consulta con nombre de comando, mensaje RNF/SQL, lenguaje o versión IBM i."
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
  lines.push("", "Citas: usa los IDs devueltos en structuredContent con ibmi_docs_read para auditar el texto completo.");
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
  lines.push("Siguiente acción recomendada: si necesitas citar detalles finos, usa ibmi_docs_read con los IDs anteriores o ibmi_docs_sections para saltar directo a sintaxis/parámetros/ejemplos.");
  return lines.join("\n");
}

function classifyResolveIntent(options: ResolveOptions): DocsIntent {
  const haystack = [options.question, options.language, options.code].filter(Boolean).join("\n");
  if (options.code?.trim()) return "code_review";
  if (/\b(RNF\d{4}|SQL\d{4,5}|CPF\d{4}|MCH\d{4})\b/i.test(haystack)) return "message_diagnostic";
  if (/ranking|rank|por qu[eé].*(resultado|sale|aparece)|explain.?ranking|score|b[uú]squeda.*mal/i.test(haystack)) return "ranking_debug";
  if (/(7\.[3456]).*(7\.[3456])|compar(a|ar|aci[oó]n)|diferencia|entre versiones|release/i.test(haystack)) return "version_question";
  if (/compil|compile|crt(sqlrpgi|rpgmod|bndcl|bndrpg|pf|lf)|crear.*(programa|m[oó]dulo|servicio)|sqlrpgle|copybook|\/\s*(copy|include)\b/i.test(haystack)) return "compile_guidance";
  if (/sintaxis|syntax|par[aá]metro|parameter|operand|opcode|operation code|ejemplo|example|%[a-z][a-z0-9_-]+|\b[A-Z]{2,}-[A-Z]{2,}\b/i.test(haystack)) return "syntax_lookup";
  if (/buscar|busca|lista|encuentra|find|search|documentos?|t[oó]picos?/i.test(haystack)) return "search_discovery";
  return "explain_topic";
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
    return {
      tool: "ibmi_docs_compile_guidance",
      reason: "La consulta apunta a construcción/compilación; usa guía de compilación para comandos, opciones y pitfalls.",
      arguments: { language: normalizeLanguage(options.query) ?? "RPGLE", version: options.version, limit: options.limit ?? 8 }
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
  return /-/.test(token)
    || /^%[a-z][a-z0-9_-]+$/.test(token)
    || /^(add|chg|crt|dlt|dsp|end|mon|ovr|rcv|rmv|rst|sav|snd|str|wrk)[a-z0-9]{2,}$/i.test(token)
    || /^rnf\d{4}$/i.test(token)
    || /^sql\d{4,5}$/i.test(token);
}

function isLikelyIbmCommandQuery(query: string): boolean {
  return extractExactTechnicalTerms(query).some((term) => /^(add|chg|crt|dlt|dsp|end|mon|ovr|rcv|rmv|rst|sav|snd|str|wrk)[a-z0-9]{2,}$/i.test(term));
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
  return value || undefined;
}

function detectSignals(task: string, language?: string, preset?: LanguagePreset): string[] {
  const haystack = [task, language].filter(Boolean).join(" ");
  const signals = new Set<string>();
  if (preset) signals.add(preset.language);
  if (/exec\s+sql|embedded\s+sql|sqlrpgle|crtsqlrpgi/i.test(haystack)) signals.add("embedded SQL");
  if (/\/\s*(copy|include)|copybook|include/i.test(haystack)) signals.add("/COPY /INCLUDE");
  if (/rnf\d{4}/i.test(haystack)) signals.add("RNF message");
  if (/\bdds\b|\bpf\b|physical file|logical file/i.test(haystack)) signals.add("DDS/PF/LF");
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

function isTraceEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.IBMI_DOCS_TRACE ?? "");
}

function appendTraceEvent(file: string, event: TraceEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // La traza es diagnóstica y opcional: nunca debe romper una consulta documental.
  }
}

function readTraceEvents(file: string, limit = 500): TraceEvent[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit);
  const events: TraceEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Ignorar líneas corruptas o truncadas; el reporte debe seguir siendo útil.
    }
  }
  return events;
}

function buildTraceReport(file: string, limit: number): TraceReport {
  const events = readTraceEvents(file, Math.max(limit, 500));
  const byTool: Record<string, number> = {};
  for (const event of events) byTool[event.tool] = (byTool[event.tool] ?? 0) + 1;
  const searchEvents = events.filter((event) => event.tool === "ibmi_docs_search");
  const readEvents = events.filter((event) => event.tool === "ibmi_docs_read");
  const readIds = new Set(readEvents.map((event) => event.id ?? event.topResultId).filter(Boolean));
  const searchThenRead = searchEvents.filter((event) => (event.followedReadCandidateIds ?? []).some((id) => readIds.has(id)));
  const answerEvents = events.filter((event) => event.tool === "ibmi_docs_answer");
  const resolveEvents = events.filter((event) => event.tool === "ibmi_docs_resolve");
  const denominator = events.length || 1;
  const searchDenominator = searchEvents.length || 1;
  return {
    enabled: isTraceEnabled(),
    traceFile: file,
    events: events.length,
    byTool,
    searchEvents: searchEvents.length,
    searchOnlyRate: roundRate((searchEvents.length - searchThenRead.length) / searchDenominator),
    searchThenReadRate: roundRate(searchThenRead.length / searchDenominator),
    answerUsageRate: roundRate(answerEvents.length / denominator),
    resolveUsageRate: roundRate(resolveEvents.length / denominator),
    recent: events.slice(-limit)
  };
}

function roundRate(value: number): number {
  return Math.round(value * 10000) / 100;
}
