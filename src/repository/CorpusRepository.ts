import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { appendTraceEvent, buildTraceReport, defaultTraceFile, isTraceEnabled } from "./trace/traceStore.js";
import {
  bufferToVector as bufferToNeuralVector,
  cosineSimilarity as neuralCosineSimilarity,
  embedTexts,
  embeddingModelDiagnostics,
  semanticQueryText
} from "./neuralEmbeddings.js";
import type {
  AnswerCitation,
  AnswerOptions,
  AnswerResult,
  AssistCoverage,
  AssistOptions,
  AssistResult,
  AssistRetrievalAxis,
  AssistRetrievalHop,
  AssistRetrievalPlan,
  AssistTaskPlan,
  CategoryDiagnostics,
  CodeValidationFinding,
  CodeValidationOptions,
  CodeValidationResult,
  CompareVersionsOptions,
  CompileGuidance,
  ContextOptions,
  ContextPackage,
  ContextReadSummary,
  CorpusManifest,
  DocsIntent,
  DocsRecipe,
  MessageExplanation,
  PackDiagnostics,
  QualityReport,
  QueryReport,
  QueryReportOptions,
  RankingExplanation,
  RankingExplanationOptions,
  ReadResult,
  RelatedDocuments,
  RelatedOptions,
  ResolveOptions,
  ResolveResult,
  SearchHit,
  SearchOptions,
  SourceKind,
  TopicSection,
  TraceEvent,
  TraceReport,
  VersionComparison,
  WorkflowPolicy,
  WorkflowStage
} from "../types.js";
import { clamp } from "../util/common.js";

type Row = Record<string, unknown>;

interface NeuralCandidate {
  row: Row;
  documentId: string;
  title: string;
  body: string;
  category: string;
  version: string;
  breadcrumbs: string[];
  vector: Float32Array;
}

const SUPPORTED_VERSIONS = ["7.3", "7.4", "7.5", "7.6", "RDi-local"];

const NEURAL_POLICY: WorkflowPolicy = {
  intent: "explain_topic",
  preferredTools: ["ibmi_docs_assist"],
  requiredEvidence: ["chunks vectoriales", "lecturas materializadas", "secciones precomputadas", "citas trazables"],
  defaultLimit: 6,
  description: "Recuperación neuronal local con Transformers.js sobre embeddings del corpus."
};

const RECIPES: DocsRecipe[] = [
  {
    id: "consulta-agentica",
    title: "Consulta IBM i one-shot",
    prompt: "Pasa la tarea completa a ibmi_docs_assist con lenguaje, versión y código si existen.",
    tools: ["ibmi_docs_assist"],
    expectedOutcome: "Respuesta autocontenida con evidencia, lecturas, secciones, pasos y validación."
  },
  {
    id: "auditoria-ranking",
    title: "Auditar una recuperación documental",
    prompt: "Usa ibmi_docs_assist primero; si el resultado no convence, reporta la consulta con evidencia reproducible.",
    tools: ["ibmi_docs_assist", "ibmi_docs_report_query"],
    expectedOutcome: "Caso reproducible para mejorar corpus, embeddings o evaluación."
  }
];

export class CorpusRepository {
  private static readonly candidateCache = new Map<string, NeuralCandidate[]>();

  private readonly db: Database.Database;
  readonly packDir: string;

  constructor(packDir = path.resolve("data", "pack")) {
    this.packDir = packDir;
    const dbPath = path.join(packDir, "ibmi-docs.sqlite");
    if (!fs.existsSync(dbPath)) throw new Error(`No existe el índice local ${dbPath}. Ejecuta build-pack o instala un data pack.`);
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
    return {
      corpusVersion: manifest.corpusVersion,
      generatedAt: manifest.generatedAt,
      sources: manifest.sources.map((source) => ({ id: source.id, kind: source.kind, documents: source.documentCount, exportedAt: source.exportedAt })),
      coverage: manifest.coverage,
      documents: this.scalarNumber("SELECT COUNT(*) FROM documents"),
      chunks: this.scalarNumber("SELECT COUNT(*) FROM chunks"),
      embedding: {
        provider: this.getMetaValue("embedding_provider") ?? "transformers-js-required",
        model: this.getMetaValue("embedding_model") ?? "model-not-installed",
        dimensions: Number(this.getMetaValue("embedding_dimensions") ?? 0),
        runtimePolicy: this.getMetaValue("embedding_runtime_policy") ?? "transformers-required",
        modelInstall: embeddingModelDiagnostics()
      },
      retrievalPolicy: "neural-only-transformers",
      runtimeDependency: "Sin RDi, sin Eclipse Help, sin endpoint local de RDi"
    };
  }

  async searchSmart(options: SearchOptions): Promise<SearchHit[]> {
    const started = Date.now();
    const allowVersionExpansion = !(options as SearchOptions & { skipVersionExpansion?: boolean }).skipVersionExpansion;
    const query = String(options.query ?? "").trim();
    const version = normalizeVersionOption(options.version ?? options.ibmiVersion);
    const category = options.category ? String(options.category).trim() : undefined;
    if (!query) {
      this.recordTrace("ibmi_docs_search", started, { query: "", resultCount: 0 });
      return [];
    }

    this.assertNeuralDataPackReady();
    const [queryVector] = await embedTexts([semanticQueryText(query)], { localOnly: true, kind: "query" });
    if (!queryVector) {
      this.recordTrace("ibmi_docs_search", started, { query, resultCount: 0 });
      return [];
    }

    const limit = clamp(options.limit, 8, 1, 50);
    const candidates = this.getNeuralCandidates().filter((candidate) => {
      if (version && candidate.version !== version) return false;
      if (category && candidate.category !== category) return false;
      return true;
    });

    const bestByDocument = new Map<string, SearchHit>();
    for (const candidate of candidates) {
      const similarity = neuralCosineSimilarity(queryVector, candidate.vector);
      const score = roundScore(similarity * 100);
      const existing = bestByDocument.get(candidate.documentId);
      if (existing && existing.score >= score) continue;
      bestByDocument.set(candidate.documentId, this.hitFromCandidate(candidate, query, score, similarity));
    }

    let results = [...bestByDocument.values()]
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit)
      .map((hit) => this.materializeHit(hit, options));

    // Si el usuario fijó versión y no hay evidencia, se permite ampliar release
    // sin inventar equivalencias: se marca explícitamente la versión usada.
    if (version && allowVersionExpansion) {
      const broaderResults = await this.searchSmart({ ...options, version: undefined, ibmiVersion: undefined, limit, skipVersionExpansion: true } as SearchOptions);
      const scopedTopScore = results[0]?.score ?? 0;
      const broaderTopScore = broaderResults[0]?.score ?? 0;
      if (!results.length || broaderTopScore > scopedTopScore + 1) results = broaderResults.map((hit) => ({
        ...hit,
        requestedVersionScopeExpansion: true,
        relevanceWarnings: [
          ...(hit.relevanceWarnings ?? []),
          `No se encontró evidencia en IBM i ${version}; se muestra evidencia disponible en ${hit.version}.`
        ]
      }));
    }

    this.recordTrace("ibmi_docs_search", started, {
      query,
      resultCount: results.length,
      topResultId: results[0]?.id,
      topResultTitle: results[0]?.title,
      autoReadApplied: results.some((hit) => hit.autoReadApplied),
      followedReadCandidateIds: results.slice(0, 3).map((hit) => hit.id)
    });
    return results;
  }

  search(_options: SearchOptions): SearchHit[] {
    throw new Error("La API síncrona search() fue retirada del runtime público: usa searchSmart(), que ejecuta recuperación neuronal local con Transformers.js.");
  }

  read(id: string): ReadResult | null {
    const started = Date.now();
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
    if (!row) {
      this.recordTrace("ibmi_docs_read", started, { id, resultCount: 0 });
      return null;
    }
    const content = this.readNormalizedText(row);
    const result: ReadResult = {
      id: String(row.id),
      title: String(row.title),
      snippet: makeSnippet(content, "", 520),
      score: 1,
      sourceKind: String(row.source_kind) as SourceKind,
      sourceId: String(row.source_id),
      version: String(row.version),
      category: String(row.category),
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: parseStringArray(row.breadcrumbs_json),
      textLength: Number(row.text_length ?? content.length),
      sha256: String(row.sha256),
      content,
      sections: this.sectionsForDocument(String(row.id), content),
      documentKind: normalizeDocumentKind(row.document_kind),
      canonicalTopicKey: String(row.canonical_topic_key ?? "")
    };
    result.sectionsPreview = result.sections?.slice(0, 6);
    this.recordTrace("ibmi_docs_read", started, { id, resultCount: 1, topResultId: result.id, topResultTitle: result.title });
    return result;
  }

  sections(id: string): { topic: ReadResult | null; sections: TopicSection[] } {
    const started = Date.now();
    const topic = this.read(id);
    const sections = topic?.sections ?? [];
    this.recordTrace("ibmi_docs_sections", started, { id, resultCount: sections.length, topResultId: topic?.id, topResultTitle: topic?.title });
    return { topic, sections };
  }

  async assistSmart(options: AssistOptions): Promise<AssistResult> {
    const started = Date.now();
    const question = String(options.question ?? options.query ?? "").trim();
    const depth = options.depth ?? "standard";
    const defaultLimit = depth === "deep" ? 8 : depth === "concise" ? 4 : 6;
    const limit = clamp(options.limit, defaultLimit, 1, 12);
    const initialQueries = uniqueNonEmpty([composeNeuralQuestion(question, options.language, options.code)]);
    const readLimit = depth === "deep" ? 4 : depth === "concise" ? 1 : 2;
    const sectionLimit = depth === "deep" ? 8 : depth === "concise" ? 3 : 5;

    const planWorkflow: WorkflowStage = {
      tool: "ibmi_docs_assist_planner",
      reason: "Preparar recuperación multi-hop usando únicamente embeddings Transformers y evidencia del corpus.",
      status: "executed",
      outputSummary: `neural-only; depth=${depth}; limit=${limit}`
    };
    const hops: AssistRetrievalHop[] = [];
    const evidenceGroups: SearchHit[][] = [];
    const readGroups: ContextReadSummary[][] = [];
    const sectionGroups: Array<Array<{ id: string; title: string; sections: TopicSection[] }>> = [];
    const citationGroups: AnswerCitation[][] = [];

    const executeHop = async (axis: AssistRetrievalAxis, query: string, reason: string): Promise<void> => {
      const hits = await this.searchSmart({
        query,
        version: normalizeVersionOption(options.version ?? options.ibmiVersion),
        category: options.category,
        limit,
        includeSections: false,
        autoRead: false
      });
      evidenceGroups.push(hits);
      const selectedReads = hits.slice(0, readLimit).map((hit) => this.read(hit.id)).filter((read): read is ReadResult => Boolean(read));
      const readSummaries = selectedReads.map((read) => toReadSummary(read, query, sectionLimit));
      const sectionTopics = selectedReads.map((read) => ({
        id: read.id,
        title: read.title,
        sections: (read.sections ?? []).slice(0, sectionLimit)
      }));
      const citations = selectedReads.map((read) => readToCitation(read, read.sections?.[0]?.title));
      readGroups.push(readSummaries);
      sectionGroups.push(sectionTopics);
      citationGroups.push(citations);
      hops.push({
        axis,
        query,
        reason,
        status: "executed",
        resultCount: hits.length,
        readCount: selectedReads.length,
        sectionCount: sectionTopics.reduce((total, topic) => total + topic.sections.length, 0),
        evidenceIds: hits.map((hit) => hit.id).slice(0, 10),
        warnings: hits.length ? [] : [`Sin evidencia documental para la consulta neural: ${query}`]
      });
    };

    for (const query of initialQueries) {
      await executeHop("primary", query, "Búsqueda vectorial directa de la petición completa.");
    }

    const firstEvidence = mergeHits(evidenceGroups);
    const followUpQueries = buildEvidenceDrivenQueries(question, firstEvidence).slice(0, depth === "deep" ? 4 : 2);
    for (const query of followUpQueries) {
      await executeHop("related", query, "Búsqueda vectorial derivada de la evidencia recuperada previamente.");
    }

    const evidence = mergeHits(evidenceGroups).slice(0, limit * 2);
    const reads = mergeReads(readGroups).slice(0, Math.max(readLimit * 2, 3));
    const sections = mergeSections(sectionGroups).slice(0, Math.max(readLimit * 2, 3));
    const citations = mergeCitations(citationGroups).slice(0, Math.max(readLimit * 2, 3));
    const warnings = uniqueNonEmpty(hops.flatMap((hop) => hop.warnings));
    const coverage = buildNeuralCoverage({ evidence, reads, sections, warnings });
    const confidence = coverage.status === "complete" ? "alta" : coverage.status === "partial" ? "media" : "baja";
    const axes = uniqueNonEmpty(hops.map((hop) => hop.axis)) as AssistRetrievalAxis[];
    const retrievalPlan: AssistRetrievalPlan = {
      strategy: hops.length > 1 ? "multi-hop" : "single-pass",
      axes: axes.length ? axes : ["primary"],
      initialQueries,
      followUpQueries,
      hops,
      coverageGaps: coverage.missingTechnicalTerms
    };
    const taskPlan: AssistTaskPlan = {
      family: "neural_retrieval",
      summary: "Recuperación neuronal local sobre el corpus IBM i sin clases, anclas ni reglas de decisión manual.",
      primaryLanguage: options.language,
      requiredEvidence: NEURAL_POLICY.requiredEvidence,
      retrievalAxes: retrievalPlan.axes,
      responseTemplate: "Síntesis extractiva con evidencia materializada y citas.",
      minimumCoverage: "exploratory"
    };
    const executiveSummary = buildExecutiveSummary(question, confidence, evidence, reads);
    const specificFindings = buildSpecificFindings(reads, evidence);
    const implementationSteps = buildImplementationSteps(evidence, reads);
    const validationChecklist = buildValidationChecklist(evidence, reads);
    const answer = renderNeuralAssistAnswer({ question, confidence, executiveSummary, specificFindings, implementationSteps, validationChecklist, citations, warnings });
    const workflow: WorkflowStage[] = [
      planWorkflow,
      {
        tool: "ibmi_docs_search",
        reason: "Recuperar candidatos mediante similitud vectorial Transformers.js contra chunks del corpus.",
        status: hops.length ? "executed" : "skipped",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 12),
        outputSummary: `${hops.length} hop(s); ${evidence.length} evidencia(s).`
      },
      {
        tool: "ibmi_docs_read",
        reason: "Materializar documentos completos para que el agente no tenga que llamar otra tool.",
        status: reads.length ? "executed" : "skipped",
        evidenceIds: reads.map((read) => read.id).slice(0, 12),
        outputSummary: `${reads.length} lectura(s).`
      },
      {
        tool: "ibmi_docs_sections",
        reason: "Adjuntar secciones precomputadas desde el data pack.",
        status: sections.some((topic) => topic.sections.length) ? "executed" : "skipped",
        evidenceIds: sections.map((topic) => topic.id).slice(0, 12),
        outputSummary: `${sections.reduce((total, topic) => total + topic.sections.length, 0)} sección(es).`
      }
    ];

    const result: AssistResult = {
      question,
      intent: "explain_topic",
      confidence,
      taskPlan,
      answer,
      executiveSummary,
      specificFindings,
      implementationSteps,
      validationChecklist,
      coverage,
      retrievalPlan,
      workflow,
      evidence,
      reads,
      sections,
      citations,
      warnings
    };
    this.recordTrace("ibmi_docs_assist", started, {
      query: question,
      intent: "explain_topic",
      resultCount: evidence.length,
      topResultId: evidence[0]?.id,
      topResultTitle: evidence[0]?.title
    });
    return result;
  }

  assist(options: AssistOptions): AssistResult {
    return this.neuralOnlySyncNotice(options.question ?? options.query ?? "", "ibmi_docs_assist") as AssistResult;
  }

  answer(options: AnswerOptions): AnswerResult {
    const notice = this.neuralOnlySyncNotice(options.question ?? options.query ?? "", "ibmi_docs_answer");
    return {
      question: notice.question ?? String(options.question ?? options.query ?? "").trim(),
      answer: notice.answer ?? "",
      confidence: "baja",
      citations: [],
      evidence: [],
      warnings: notice.warnings ?? [],
      suggestedTools: []
    };
  }

  context(options: ContextOptions): ContextPackage {
    const task = String(options.task ?? options.query ?? "").trim();
    return {
      task,
      intent: { language: options.language ?? "IBM i", category: undefined, detectedSignals: ["neural-only-sync-api-disabled"], queries: [task] },
      answer: "La API síncrona de contexto fue retirada del runtime público. Usa ibmi_docs_assist, que materializa contexto con recuperación neuronal.",
      appliedWorkflow: [{ tool: "ibmi_docs_assist", reason: "Entrada canónica neural-only.", status: "planned" }],
      recommendedDocs: [],
      compileCommands: [],
      optionsToReview: [],
      pitfalls: [],
      actionItems: [],
      versionNotes: [],
      evidence: [],
      reads: [],
      sections: [],
      citations: [],
      warnings: ["Usa assistSmart()/ibmi_docs_assist para recuperación neural real."]
    };
  }

  resolve(options: ResolveOptions): ResolveResult {
    const question = String(options.question ?? options.query ?? "").trim();
    return {
      question,
      intent: "explain_topic",
      policy: NEURAL_POLICY,
      answer: "La API síncrona resolve() fue retirada del runtime público. Usa ibmi_docs_assist/assistSmart para ejecutar recuperación neuronal.",
      confidence: "baja",
      stages: [{ tool: "ibmi_docs_assist", reason: "Entrada canónica neural-only.", status: "planned" }],
      evidence: [],
      reads: [],
      sections: [],
      citations: [],
      suggestedTools: [],
      warnings: ["No se ejecutó recuperación síncrona para evitar rutas no neuronales."]
    };
  }

  compileGuidance(options: import("../types.js").CompileGuidanceOptions): CompileGuidance {
    return {
      language: options.language ?? "IBM i",
      target: options.target ?? "documented target",
      recommendedCommands: [],
      relatedCommands: [],
      optionsToReview: [],
      pitfalls: ["Usa ibmi_docs_assist para recuperar guía de compilación con evidencia neuronal materializada."],
      evidence: []
    };
  }

  explainMessage(options: { messageId: string; limit?: number }): MessageExplanation {
    return {
      messageId: options.messageId,
      family: "neural-only",
      category: "documental",
      summary: "Usa ibmi_docs_assist para diagnosticar mensajes con recuperación neuronal materializada.",
      recoveryChecklist: [],
      evidence: [],
      coverageStatus: "unsupported",
      warnings: ["API síncrona especializada retirada para evitar rutas manuales."]
    };
  }

  validateCodeContext(options: CodeValidationOptions): CodeValidationResult {
    const finding: CodeValidationFinding = {
      severity: "info",
      title: "Validación neural disponible vía assist",
      detail: "Usa ibmi_docs_assist/assistSmart con question y code para recuperar evidencia neuronal materializada.",
      evidenceIds: []
    };
    return { language: options.language, detectedSignals: [], findings: [finding], evidence: [] };
  }

  related(id: string, options: RelatedOptions = {}): RelatedDocuments {
    const topic = this.read(id);
    if (!topic) return { topic: null, equivalentVersions: [], related: [] };
    const limit = clamp(options.limit, 8, 1, 20);
    const equivalents = topic.canonicalTopicKey
      ? this.db.prepare("SELECT * FROM documents WHERE canonical_topic_key = ? AND id <> ? LIMIT ?").all(topic.canonicalTopicKey, topic.id, limit) as Row[]
      : [];
    return { topic, equivalentVersions: equivalents.map((row) => this.hitFromDocumentRow(row, topic.title, 1)), related: [] };
  }

  compareVersions(options: CompareVersionsOptions): VersionComparison {
    const versions = options.versions.length ? options.versions : SUPPORTED_VERSIONS;
    return {
      query: options.query,
      versions: versions.map((version) => ({ version, found: false, notes: ["Usa ibmi_docs_assist para comparación neuronal materializada por versión."] })),
      evidence: []
    };
  }

  explainRanking(options: RankingExplanationOptions): RankingExplanation {
    return { query: options.query, semanticProfile: { concepts: [], intentHints: [] }, semanticQueries: [options.query], results: [] };
  }

  reportQuery(options: QueryReportOptions): QueryReport {
    const ranking = this.explainRanking(options);
    return {
      generatedAt: new Date().toISOString(),
      query: options.query,
      options,
      diagnostics: {
        topResultTitle: undefined,
        topResultId: undefined,
        semanticConcepts: [],
        semanticIntentHints: [],
        pass: false,
        warnings: ["El reporte síncrono no ejecuta recuperación; usa ibmi_docs_assist para evidencia neural."]
      },
      results: [],
      ranking,
      issueMarkdown: [`# IBM i Docs query report`, ``, `Query: ${options.query}`, ``, `Runtime: neural-only; usa assistSmart para reproducir.`].join("\n")
    };
  }

  categories(): CategoryDiagnostics {
    return {
      categories: this.distinctValues("documents", "category"),
      versions: this.distinctValues("documents", "version"),
      sources: this.distinctValues("documents", "source_kind"),
      byCategory: this.countBy("category"),
      byVersion: this.countBy("version"),
      bySource: this.countBy("source_kind")
    };
  }

  packDiagnostics(): PackDiagnostics {
    const manifest = this.manifest();
    const rows = this.db.prepare("SELECT normalized_text_path FROM documents").all() as Array<{ normalized_text_path: string }>;
    let missingFiles = 0;
    const longPaths: string[] = [];
    for (const row of rows) {
      const fullPath = path.join(this.packDir, String(row.normalized_text_path));
      if (!fs.existsSync(fullPath)) missingFiles += 1;
      if (fullPath.length > 240) longPaths.push(fullPath);
    }
    return {
      ok: missingFiles === 0,
      packDir: this.packDir,
      corpusVersion: manifest.corpusVersion,
      documents: this.scalarNumber("SELECT COUNT(*) FROM documents"),
      chunks: this.scalarNumber("SELECT COUNT(*) FROM chunks"),
      missingFiles,
      checkedFiles: rows.length,
      longPaths,
      anomalies: [],
      runtimeDependency: "Sin RDi, sin Eclipse Help, sin endpoint local de RDi"
    };
  }

  qualityReport(): QualityReport {
    const diagnostics = this.categories();
    const manifest = this.manifest();
    const shortRows = this.db.prepare("SELECT id,title,text_length,category,version FROM documents WHERE text_length < 300 LIMIT 50").all() as Row[];
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      corpusVersion: manifest.corpusVersion,
      documents: this.scalarNumber("SELECT COUNT(*) FROM documents"),
      chunks: this.scalarNumber("SELECT COUNT(*) FROM chunks"),
      coverage: diagnostics,
      shortDocuments: shortRows.map((row) => ({ id: String(row.id), title: String(row.title), textLength: Number(row.text_length), category: String(row.category), version: String(row.version) })),
      duplicateTitles: [],
      duplicateTitlesSameVersion: [],
      duplicateTitlesCrossVersionExpected: [],
      duplicateCanonicalTopics: [],
      documentKinds: {
        topic: this.countDocumentKind("topic"),
        reference: this.countDocumentKind("reference"),
        index: this.countDocumentKind("index"),
        landing: this.countDocumentKind("landing"),
        stub: this.countDocumentKind("stub")
      },
      sparseCategories: [],
      benchmarkHints: ["Ejecuta eval:question-bank contra ibmi_docs_assist para validar recuperación neural end-to-end."],
      recommendations: ["Las mejoras deben venir de corpus, embeddings, fine-tuning o evaluación; no de reglas manuales."]
    };
  }

  recipes(): DocsRecipe[] {
    return RECIPES;
  }

  traceReport(limit = 50): TraceReport {
    return buildTraceReport(defaultTraceFile(), limit);
  }

  private getNeuralCandidates(): NeuralCandidate[] {
    const dbPath = path.join(this.packDir, "ibmi-docs.sqlite");
    const cached = CorpusRepository.candidateCache.get(dbPath);
    if (cached) return cached;
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url,
             d.text_length, d.breadcrumbs_json, d.document_kind, d.canonical_topic_key,
             c.body, v.vector
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN chunk_vectors v ON v.chunk_id = c.id
    `).all() as Row[];
    const candidates = rows.map((row) => ({
      row,
      documentId: String(row.id),
      title: String(row.title),
      body: String(row.body ?? ""),
      category: String(row.category),
      version: String(row.version),
      breadcrumbs: parseStringArray(row.breadcrumbs_json),
      vector: bufferToNeuralVector(row.vector as Buffer)
    }));
    CorpusRepository.candidateCache.set(dbPath, candidates);
    return candidates;
  }

  private hitFromCandidate(candidate: NeuralCandidate, query: string, score: number, similarity: number): SearchHit {
    const row = candidate.row;
    return {
      id: candidate.documentId,
      title: candidate.title,
      snippet: makeSnippet(candidate.body, query, 520),
      score,
      semanticScore: roundScore(similarity),
      sourceKind: String(row.source_kind) as SourceKind,
      sourceId: String(row.source_id),
      version: candidate.version,
      category: candidate.category,
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: candidate.breadcrumbs,
      textLength: Number(row.text_length ?? 0),
      documentKind: normalizeDocumentKind(row.document_kind),
      canonicalTopicKey: String(row.canonical_topic_key ?? ""),
      matchReasons: [`similitud vectorial Transformers.js=${roundScore(similarity)}`],
      relevanceWarnings: []
    };
  }

  private hitFromDocumentRow(row: Row, query: string, score: number): SearchHit {
    const content = this.readNormalizedText(row);
    return {
      id: String(row.id),
      title: String(row.title),
      snippet: makeSnippet(content, query, 520),
      score,
      sourceKind: String(row.source_kind) as SourceKind,
      sourceId: String(row.source_id),
      version: String(row.version),
      category: String(row.category),
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: parseStringArray(row.breadcrumbs_json),
      textLength: Number(row.text_length ?? content.length),
      documentKind: normalizeDocumentKind(row.document_kind),
      canonicalTopicKey: String(row.canonical_topic_key ?? "")
    };
  }

  private materializeHit(hit: SearchHit, options: SearchOptions): SearchHit {
    if (!options.autoRead && !options.includeSections) return hit;
    const read = this.read(hit.id);
    if (!read) return hit;
    if (options.includeSections) hit.sectionsPreview = read.sections?.slice(0, 6);
    if (options.autoRead) {
      hit.autoReadApplied = true;
      hit.fullContent = read.content;
    }
    return hit;
  }

  private readNormalizedText(row: Row): string {
    const relativePath = String(row.normalized_text_path ?? "");
    const fullPath = path.join(this.packDir, relativePath);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
  }

  private sectionsForDocument(documentId: string, content: string): TopicSection[] {
    const rows = this.db.prepare(`
      SELECT kind,title,body,start_line,end_line
      FROM document_sections
      WHERE document_id = ?
      ORDER BY section_index
    `).all(documentId) as Row[];
    if (rows.length) {
      return rows.map((row) => ({
        kind: normalizeSectionKind(row.kind),
        title: String(row.title),
        content: String(row.body),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line)
      }));
    }
    return content.trim()
      ? [{ kind: "generic", title: "Contenido", content: content.slice(0, 4000), startLine: 1, endLine: content.split("\n").length }]
      : [];
  }

  private assertNeuralDataPackReady(): void {
    const provider = this.getMetaValue("embedding_provider");
    const model = this.getMetaValue("embedding_model");
    if (provider !== "transformers-js" || !model) throw new Error("El data pack no contiene embeddings Transformers.js. Reconstruye el corpus con npm run build:pack.");
    const marker = embeddingModelDiagnostics();
    if (!marker.markerExists) throw new Error(`El modelo semántico local no está instalado en ${marker.cacheDir}. Ejecuta npm install o node postinstall.cjs.`);
  }

  private neuralOnlySyncNotice(question: string, tool: string): Partial<AssistResult> {
    const text = String(question ?? "").trim();
    return {
      question: text,
      intent: "explain_topic" as DocsIntent,
      confidence: "baja",
      taskPlan: {
        family: "neural_retrieval",
        summary: "La entrada canónica neural-only es assistSmart()/ibmi_docs_assist.",
        requiredEvidence: NEURAL_POLICY.requiredEvidence,
        retrievalAxes: ["primary"],
        responseTemplate: "Recuperación neuronal asíncrona.",
        minimumCoverage: "exploratory"
      },
      answer: `La API síncrona ${tool} fue retirada para evitar rutas manuales. Usa ibmi_docs_assist/assistSmart, que ejecuta Transformers.js local y materializa evidencia.`,
      executiveSummary: [],
      specificFindings: [],
      implementationSteps: [],
      validationChecklist: [],
      coverage: { status: "thin", summary: "Sin ejecución síncrona.", evidenceCount: 0, readCount: 0, sectionCount: 0, matchedTechnicalTerms: [], missingTechnicalTerms: [], warnings: [] },
      retrievalPlan: { strategy: "single-pass", axes: ["primary"], initialQueries: [text], followUpQueries: [], hops: [], coverageGaps: [] },
      workflow: [{ tool: "ibmi_docs_assist", reason: "Entrada canónica neural-only.", status: "planned" }],
      evidence: [],
      reads: [],
      sections: [],
      citations: [],
      warnings: ["No se ejecutó recuperación síncrona para evitar rutas no neuronales."]
    };
  }

  private scalarNumber(sql: string): number {
    const row = this.db.prepare(sql).get() as Record<string, number> | undefined;
    return Number(row ? Object.values(row)[0] : 0);
  }

  private getMetaValue(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private distinctValues(table: string, column: string): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT ${column} AS value FROM ${table} ORDER BY value`).all() as Array<{ value: string }>;
    return rows.map((row) => String(row.value));
  }

  private countBy(column: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM documents GROUP BY ${column} ORDER BY ${column}`).all() as Array<{ value: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [String(row.value), Number(row.count)]));
  }

  private countDocumentKind(kind: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE document_kind = ?").get(kind) as { count: number }).count);
  }

  private recordTrace(tool: string, started: number, event: Partial<TraceEvent>): void {
    if (!isTraceEnabled()) return;
    appendTraceEvent(defaultTraceFile(), { timestamp: new Date().toISOString(), tool, durationMs: Date.now() - started, ...event });
  }
}

function normalizeVersionOption(value?: string): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return text.startsWith("IBM i ") ? text.slice(6).trim() : text;
}

function composeNeuralQuestion(question: string, language?: string, code?: string): string {
  return [
    question.trim(),
    language ? `Language or environment hint: ${language.trim()}` : "",
    code ? `Code context:\n${code.trim()}` : ""
  ].filter((part) => part.trim()).join("\n\n").trim();
}

function buildEvidenceDrivenQueries(question: string, evidence: SearchHit[]): string[] {
  return uniqueNonEmpty(evidence.slice(0, 4).map((hit) => [question, hit.title, hit.breadcrumbs.join(" > "), hit.snippet].filter(Boolean).join("\n")));
}

function buildNeuralCoverage(input: {
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  warnings: string[];
}): AssistCoverage {
  const sectionCount = input.sections.reduce((total, topic) => total + topic.sections.length, 0);
  const status: AssistCoverage["status"] = input.evidence.length >= 3 && input.reads.length >= 2 ? "complete" : input.evidence.length ? "partial" : "thin";
  return {
    status,
    summary: `${input.evidence.length} evidencia(s), ${input.reads.length} lectura(s), ${sectionCount} sección(es).`,
    evidenceCount: input.evidence.length,
    readCount: input.reads.length,
    sectionCount,
    matchedTechnicalTerms: [],
    missingTechnicalTerms: [],
    warnings: input.warnings
  };
}

function toReadSummary(read: ReadResult, query: string, sectionLimit: number): ContextReadSummary {
  return {
    id: read.id,
    title: read.title,
    version: read.version,
    category: read.category,
    sourceKind: read.sourceKind,
    canonicalUrl: read.canonicalUrl,
    documentKind: read.documentKind,
    canonicalTopicKey: read.canonicalTopicKey,
    textLength: read.textLength,
    excerpt: makeSnippet(read.content, query, 900),
    focusedSections: (read.sections ?? []).slice(0, sectionLimit)
  };
}

function readToCitation(read: ReadResult, section?: string): AnswerCitation {
  return { id: read.id, title: read.title, version: read.version, sourceKind: read.sourceKind, canonicalUrl: read.canonicalUrl, section };
}

function buildExecutiveSummary(question: string, confidence: "alta" | "media" | "baja", evidence: SearchHit[], reads: ContextReadSummary[]): string[] {
  if (!evidence.length) return [`No encontré evidencia documental suficiente para: ${question}`];
  return [
    `Confianza ${confidence}: la respuesta se apoya en ${evidence.length} resultado(s) vectoriales y ${reads.length} lectura(s) materializada(s).`,
    `Documento principal: ${evidence[0].title} [${evidence[0].version}/${evidence[0].category}].`
  ];
}

function buildSpecificFindings(reads: ContextReadSummary[], evidence: SearchHit[]): string[] {
  const fromReads = reads.map((read) => `${read.title}: ${read.excerpt}`);
  return fromReads.length ? fromReads : evidence.slice(0, 3).map((hit) => `${hit.title}: ${hit.snippet}`);
}

function buildImplementationSteps(evidence: SearchHit[], reads: ContextReadSummary[]): string[] {
  if (!evidence.length) return ["No implementar cambios basados en esta respuesta sin nueva evidencia documental."];
  return [
    "Usar primero los tópicos citados como referencia técnica.",
    reads.length ? "Aplicar la sintaxis/parámetros según las lecturas materializadas." : "Leer el tópico principal si se necesita detalle adicional.",
    "Validar el cambio en el entorno IBM i correspondiente y contrastar mensajes/errores contra el corpus."
  ];
}

function buildValidationChecklist(evidence: SearchHit[], reads: ContextReadSummary[]): string[] {
  return [
    evidence.length ? "Existe evidencia vectorial en el corpus." : "No existe evidencia vectorial suficiente en el corpus.",
    reads.length ? "Se materializó contenido completo para el agente." : "No se materializó lectura completa.",
    "No se usaron clases, anclas, categorías inferidas ni reglas manuales."
  ];
}

function renderNeuralAssistAnswer(input: {
  question: string;
  confidence: "alta" | "media" | "baja";
  executiveSummary: string[];
  specificFindings: string[];
  implementationSteps: string[];
  validationChecklist: string[];
  citations: AnswerCitation[];
  warnings: string[];
}): string {
  return [
    `Respuesta IBM i Docs para: ${input.question}`,
    `Confianza: ${input.confidence}`,
    "",
    "Resumen:",
    ...input.executiveSummary.map((item) => `- ${item}`),
    "",
    "Evidencia relevante:",
    ...(input.specificFindings.length ? input.specificFindings.map((item) => `- ${item}`) : ["- Sin evidencia suficiente."]),
    "",
    "Pasos sugeridos:",
    ...input.implementationSteps.map((item) => `- ${item}`),
    "",
    "Validación:",
    ...input.validationChecklist.map((item) => `- ${item}`),
    "",
    "Citas:",
    ...(input.citations.length ? input.citations.map((citation) => `- ${citation.title} [${citation.version}] ${citation.canonicalUrl}`) : ["- Sin citas materializadas."]),
    input.warnings.length ? "" : undefined,
    input.warnings.length ? "Advertencias:" : undefined,
    ...input.warnings.map((warning) => `- ${warning}`)
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function makeSnippet(text: string, query: string, maxLength: number): string {
  const clean = text.split("\r").join(" ").split("\n").join(" ").split("\t").join(" ").trim();
  if (!clean) return "";
  const index = query.trim() ? clean.toLowerCase().indexOf(query.trim().toLowerCase()) : -1;
  const start = index > 80 ? index - 80 : 0;
  const snippet = clean.slice(start, start + maxLength).trim();
  return snippet.length < clean.length - start ? `${snippet}…` : snippet;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeDocumentKind(value: unknown): SearchHit["documentKind"] {
  const text = String(value ?? "topic");
  if (text === "reference" || text === "index" || text === "landing" || text === "stub") return text;
  return "topic";
}

function normalizeSectionKind(value: unknown): TopicSection["kind"] {
  const text = String(value ?? "generic");
  const allowed: TopicSection["kind"][] = ["syntax", "parameters", "description", "examples", "notes", "restrictions", "messages", "recovery", "related", "generic"];
  return allowed.includes(text as TopicSection["kind"]) ? text as TopicSection["kind"] : "generic";
}

function roundScore(value: number): number {
  return Math.round(value * 100000) / 100000;
}

function uniqueNonEmpty<T extends string>(values: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text as T);
  }
  return output;
}

function mergeHits(groups: SearchHit[][]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const group of groups) {
    for (const hit of group) {
      const existing = byId.get(hit.id);
      if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function mergeReads(groups: ContextReadSummary[][]): ContextReadSummary[] {
  const byId = new Map<string, ContextReadSummary>();
  for (const group of groups) for (const read of group) if (!byId.has(read.id)) byId.set(read.id, read);
  return [...byId.values()];
}

function mergeSections(groups: Array<Array<{ id: string; title: string; sections: TopicSection[] }>>): Array<{ id: string; title: string; sections: TopicSection[] }> {
  const byId = new Map<string, { id: string; title: string; sections: TopicSection[] }>();
  for (const group of groups) for (const topic of group) if (!byId.has(topic.id)) byId.set(topic.id, topic);
  return [...byId.values()];
}

function mergeCitations(groups: AnswerCitation[][]): AnswerCitation[] {
  const byId = new Map<string, AnswerCitation>();
  for (const group of groups) for (const citation of group) if (!byId.has(citation.id)) byId.set(citation.id, citation);
  return [...byId.values()];
}
