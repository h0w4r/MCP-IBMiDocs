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
import {
  rerankPassages,
  rerankerDiagnostics,
  type NeuralRerankedPassage
} from "./neuralReranker.js";
import {
  expandNeuralQueryVectors,
  neuralQueryAdapterDiagnostics
} from "./neuralQueryAdapter.js";
import type {
  AnswerCitation,
  AnswerOptions,
  AnswerResult,
  AssistCoverage,
  AssistOptions,
  AssistResult,
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
  VectorCoverageDiagnostics,
  VersionComparison,
  WorkflowPolicy,
  WorkflowStage
} from "../types.js";
import { clamp } from "../util/common.js";

type Row = Record<string, unknown>;

interface NeuralCandidate {
  chunkId: string;
  chunkIndex: number;
  row: Row;
  documentId: string;
  title: string;
  body: string;
  category: string;
  version: string;
  breadcrumbs: string[];
  vector: Float32Array;
  titleVector: Float32Array;
}

interface NeuralPassageMatch {
  candidate: NeuralCandidate;
  similarity: number;
  perspective: string;
  perspectiveIndex: number;
}

interface NeuralDocumentAggregate {
  documentId: string;
  row: Row;
  title: string;
  category: string;
  version: string;
  breadcrumbs: string[];
  best: NeuralPassageMatch;
  primaryBest: NeuralPassageMatch;
  passages: NeuralPassageMatch[];
  perspectiveBest: Map<number, NeuralPassageMatch>;
}

interface NeuralAnswerCandidate extends NeuralRerankedPassage {
  candidate: NeuralCandidate;
  directSimilarity: number;
  embeddingSimilarity: number;
  reciprocalRankScore: number;
  neuralConsensusScore: number;
}

interface NeuralAnswerSelection {
  candidates: NeuralAnswerCandidate[];
  directEmbeddingScore: number;
  supported: boolean;
  topRerankerLogit: number;
  topRerankerProbability: number;
}

const SUPPORTED_VERSIONS = ["7.3", "7.4", "7.5", "7.6", "RDi-local"];
const ANSWER_RETRIEVAL_PER_PERSPECTIVE = 512;
const ANSWER_RERANK_LIMIT = 48;
const MIN_DIRECT_EMBEDDING_SUPPORT = 0.8;
const CONDITIONAL_RERANKER_SUPPORT = -6;

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
      reranker: rerankerDiagnostics(),
      queryAdapter: neuralQueryAdapterDiagnostics(),
      vectorCoverage: this.vectorCoverageDiagnostics(),
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
    const perspectives = [query];
    const baseQueryVectors = await embedTexts(perspectives.map((perspective) => semanticQueryText(perspective)), { localOnly: true, kind: "query" });
    const queryVectors = expandNeuralQueryVectors(baseQueryVectors);
    if (!queryVectors.length) {
      this.recordTrace("ibmi_docs_search", started, { query, resultCount: 0 });
      return [];
    }

    const limit = clamp(options.limit, 8, 1, 50);
    const candidates = this.getNeuralCandidates().filter((candidate) => {
      if (version && candidate.version !== version) return false;
      if (category && candidate.category !== category) return false;
      return true;
    });

    const aggregateByDocument = new Map<string, NeuralDocumentAggregate>();
    for (let perspectiveIndex = 0; perspectiveIndex < queryVectors.length; perspectiveIndex += 1) {
      const queryVector = queryVectors[perspectiveIndex];
      const perspective = perspectives[Math.floor(perspectiveIndex / 2)] ?? query;
      for (const candidate of candidates) {
        const similarity = neuralFacetSimilarity(queryVector, candidate);
        const match: NeuralPassageMatch = { candidate, similarity, perspective, perspectiveIndex };
        const existing = aggregateByDocument.get(candidate.documentId);
        if (!existing) {
          aggregateByDocument.set(candidate.documentId, {
            documentId: candidate.documentId,
            row: candidate.row,
            title: candidate.title,
            category: candidate.category,
            version: candidate.version,
            breadcrumbs: candidate.breadcrumbs,
            best: match,
            primaryBest: match,
            passages: [match],
            perspectiveBest: new Map([[perspectiveIndex, match]])
          });
          continue;
        }
        if (similarity > existing.best.similarity) existing.best = match;
        const existingPerspective = existing.perspectiveBest.get(perspectiveIndex);
        if (!existingPerspective || similarity > existingPerspective.similarity) {
          existing.perspectiveBest.set(perspectiveIndex, match);
        }
        if (perspectiveIndex === 0 && similarity > existing.primaryBest.similarity) {
          existing.primaryBest = match;
        }
        insertNeuralPassageMatch(existing.passages, match, 4);
      }
    }

    let results = [...aggregateByDocument.values()]
      .map((aggregate) => this.hitFromAggregate(aggregate, query))
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
      semanticQueries: perspectives,
      resultCount: results.length,
      topResultId: results[0]?.id,
      topResultTitle: results[0]?.title,
      autoReadApplied: results.some((hit) => hit.autoReadApplied),
      followedReadCandidateIds: results.slice(0, 3).map((hit) => hit.id)
    });
    return results;
  }

  /**
   * Construye el conjunto de pasajes que alimenta la respuesta final. Primero
   * recupera con el bi-encoder E5 desde varias perspectivas y despues deja que
   * el cross-encoder multilingue lea pregunta y pasaje conjuntamente.
   */
  private async selectNeuralAnswer(options: AssistOptions, question: string): Promise<NeuralAnswerSelection> {
    const requestedVersion = normalizeVersionOption(options.version ?? options.ibmiVersion);
    const contextualQuestion = composeNeuralQuestion(question, options.language, options.code);
    const perspectives = uniqueNonEmpty([contextualQuestion, question, options.code ?? ""]);
    const baseQueryVectors = await embedTexts(
      perspectives.map((perspective) => semanticQueryText(perspective)),
      { localOnly: true, kind: "query" }
    );
    const queryVectors = expandNeuralQueryVectors(baseQueryVectors);
    if (!queryVectors.length) {
      return {
        candidates: [],
        directEmbeddingScore: 0,
        supported: false,
        topRerankerLogit: Number.NEGATIVE_INFINITY,
        topRerankerProbability: 0
      };
    }

    const requestedCategory = options.category?.trim();
    const corpusCandidates = this.getNeuralCandidates().filter((candidate) => {
      // Todas las versiones permanecen candidatas. El cross-encoder recibe la
      // preferencia de release y puede recuperar otra cuando el release pedido
      // no contiene evidencia suficientemente útil.
      if (requestedCategory && candidate.category !== requestedCategory) return false;
      return true;
    });
    type CandidatePoolEntry = {
      candidate: NeuralCandidate;
      directSimilarity: number;
      embeddingSimilarity: number;
      reciprocalRankScore: number;
    };
    const buildCandidatePool = (scope: NeuralCandidate[]): Map<string, CandidatePoolEntry> => {
      const candidatePool = new Map<string, CandidatePoolEntry>();
      const titleRepresentatives = scope.filter((candidate) => candidate.chunkIndex === 0);
      for (let perspectiveIndex = 0; perspectiveIndex < queryVectors.length; perspectiveIndex += 1) {
        const vector = queryVectors[perspectiveIndex];
        const rankings = [
          scope
            .map((candidate) => ({ candidate, similarity: neuralCosineSimilarity(vector, candidate.vector) }))
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, ANSWER_RETRIEVAL_PER_PERSPECTIVE),
          titleRepresentatives
            .map((candidate) => ({ candidate, similarity: neuralCosineSimilarity(vector, candidate.titleVector) }))
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, ANSWER_RETRIEVAL_PER_PERSPECTIVE)
        ];
        for (const ranked of rankings) {
          for (let rank = 0; rank < ranked.length; rank += 1) {
            const item = ranked[rank];
            const reciprocalRankScore = 1 / (40 + rank + 1);
            const existing = candidatePool.get(item.candidate.chunkId);
            if (existing) {
              existing.reciprocalRankScore += reciprocalRankScore;
              existing.embeddingSimilarity = Math.max(existing.embeddingSimilarity, item.similarity);
              continue;
            }
            candidatePool.set(item.candidate.chunkId, {
              candidate: item.candidate,
              directSimilarity: neuralFacetSimilarity(queryVectors[0], item.candidate),
              embeddingSimilarity: item.similarity,
              reciprocalRankScore
            });
          }
        }
      }
      return candidatePool;
    };

    const globalCandidatePool = buildCandidatePool(corpusCandidates);
    const preferredCandidatePool = requestedVersion
      ? buildCandidatePool(corpusCandidates.filter((candidate) => candidate.version === requestedVersion))
      : undefined;
    const pooled = [...globalCandidatePool.values()]
      .sort((left, right) => right.reciprocalRankScore - left.reciprocalRankScore
        || right.embeddingSimilarity - left.embeddingSimilarity);
    const preferredPooled = preferredCandidatePool
      ? [...preferredCandidatePool.values()].sort((left, right) => right.reciprocalRankScore - left.reciprocalRankScore
        || right.embeddingSimilarity - left.embeddingSimilarity)
      : [];
    const directEmbeddingScore = pooled.reduce(
      (best, item) => Math.max(best, item.directSimilarity),
      0
    );
    const concisePool = pooled.filter((item) => {
        const length = normalizeCorpusPassage(item.candidate.body).length;
        return length >= 8 && length <= 280;
      });
    // Se conservan varias vistas neuronales del mismo pool para que un pasaje
    // breve y directo no quede fuera solo porque otra perspectiva produjo un
    // documento largo con un score marginalmente mayor.
    const concise = uniqueCandidatesByChunk([
      ...concisePool.slice(0, 6),
      ...[...concisePool].sort((left, right) => right.embeddingSimilarity - left.embeddingSimilarity).slice(0, 6),
      ...[...concisePool].sort((left, right) => right.directSimilarity - left.directSimilarity).slice(0, 6)
    ]);
    const preferredVersionPool = requestedVersion
      ? preferredPooled
        .sort((left, right) => right.directSimilarity - left.directSimilarity)
        .slice(0, ANSWER_RERANK_LIMIT)
      : [];
    const globalRerankPool = uniqueCandidatesByChunk([
      ...concise,
      ...pooled.slice(0, 24),
      ...[...pooled].sort((left, right) => right.directSimilarity - left.directSimilarity).slice(0, 32),
      ...[...pooled].sort((left, right) => right.embeddingSimilarity - left.embeddingSimilarity).slice(0, 32)
    ])
      .slice(0, ANSWER_RERANK_LIMIT);
    const rerankCandidatePool = async (pool: typeof globalRerankPool): Promise<NeuralAnswerCandidate[]> => {
      const reranked = await rerankPassages(
        requestedVersion ? `${contextualQuestion}\n\nPreferred IBM i version: ${requestedVersion}` : contextualQuestion,
        pool.map((item) => ({
          id: item.candidate.chunkId,
          title: item.candidate.title,
          body: normalizeCorpusPassage(item.candidate.body, false),
          category: item.candidate.category,
          version: item.candidate.version,
          breadcrumbs: item.candidate.breadcrumbs
        })),
        { localOnly: true, maxLength: 160 }
      );
      const metadataByChunk = new Map(pool.map((item) => [item.candidate.chunkId, item]));
      const materialized = reranked.map((item) => {
        const metadata = metadataByChunk.get(item.id);
        if (!metadata) throw new Error(`No se encontro metadata neuronal para el pasaje ${item.id}.`);
        return {
          ...item,
          // El modelo recibe una versión normalizada con metadatos de ruta,
          // pero la respuesta pública se compone desde el cuerpo documental
          // original para poder limpiar encabezados sin perder estructura.
          body: metadata.candidate.body,
          candidate: metadata.candidate,
          directSimilarity: metadata.directSimilarity,
          embeddingSimilarity: metadata.embeddingSimilarity,
          reciprocalRankScore: metadata.reciprocalRankScore,
          neuralConsensusScore: 0
        };
      });
      const rerankerStats = numericDistribution(materialized.map((item) => item.relevanceLogit));
      const retrievalStats = numericDistribution(materialized.map((item) => item.reciprocalRankScore));
      for (const item of materialized) {
        // Ambos componentes son salidas neuronales. Estandarizarlos evita que
        // la escala arbitraria de logits anule el consenso de las vistas base
        // y adaptada, o viceversa.
        item.neuralConsensusScore = zScore(item.relevanceLogit, rerankerStats)
          + zScore(item.reciprocalRankScore, retrievalStats);
      }
      const pureRerankerTop = materialized[0];
      materialized.sort((left, right) => right.neuralConsensusScore - left.neuralConsensusScore
        || right.relevanceLogit - left.relevanceLogit);
      const consensusTop = materialized[0];
      // El ensamble no puede sustituir una evidencia que el cross-encoder
      // considera muy superior por otra varios logits peor. Este guardrail es
      // estadístico y transversal; no depende de términos ni clases IBM i.
      if (pureRerankerTop && consensusTop
        && pureRerankerTop.relevanceLogit - consensusTop.relevanceLogit > 2) {
        return [pureRerankerTop, ...materialized.filter((item) => item.id !== pureRerankerTop.id)];
      }
      return materialized;
    };
    let candidates = await rerankCandidatePool(preferredVersionPool.length ? preferredVersionPool : globalRerankPool);
    const preferredCandidate = requestedVersion
      ? candidates.find((candidate) => candidate.version === requestedVersion
        && candidate.directSimilarity >= MIN_DIRECT_EMBEDDING_SUPPORT
        && candidate.relevanceLogit >= CONDITIONAL_RERANKER_SUPPORT)
      : undefined;
    if (preferredCandidate) {
      candidates = [
        preferredCandidate,
        ...candidates.filter((candidate) => candidate.id !== preferredCandidate.id)
      ];
    }
    // Una coincidencia temática débil en el release pedido no debe bloquear
    // una definición mucho más precisa disponible en otro release. La decisión
    // compara logits del mismo cross-encoder; no usa términos ni categorías.
    if (requestedVersion && preferredVersionPool.length
      && (!preferredCandidate || candidates[0].relevanceLogit < 0.25)) {
      const globalCandidates = await rerankCandidatePool(globalRerankPool);
      const preferredTopLogit = candidates[0]?.relevanceLogit ?? Number.NEGATIVE_INFINITY;
      const globalTopLogit = globalCandidates[0]?.relevanceLogit ?? Number.NEGATIVE_INFINITY;
      if (!preferredCandidate || globalTopLogit > preferredTopLogit + 0.5) {
        candidates = globalCandidates;
      }
    }
    candidates = candidates.filter((candidate) => compactAnswerPassage(candidate.body, 900).length >= 3);
    // Una versión solicitada explícitamente gobierna la selección cuando su
    // mejor pasaje supera el mismo gate neuronal. Solo entonces se reordena;
    // si no hay soporte suficiente, se conserva la recuperación global y la
    // respuesta identifica el release realmente usado.
    const selectedDirectEmbeddingScore = candidates[0]?.directSimilarity ?? directEmbeddingScore;
    const topRerankerLogit = candidates[0]?.relevanceLogit ?? Number.NEGATIVE_INFINITY;
    const topRerankerProbability = candidates[0]?.relevanceProbability ?? 0;
    const supported = selectedDirectEmbeddingScore >= MIN_DIRECT_EMBEDDING_SUPPORT
      && topRerankerLogit >= CONDITIONAL_RERANKER_SUPPORT;

    return {
      candidates,
      directEmbeddingScore: selectedDirectEmbeddingScore,
      supported,
      topRerankerLogit,
      topRerankerProbability
    };
  }

  private hitFromAnswerCandidate(item: NeuralAnswerCandidate, query: string): SearchHit {
    const hit = this.hitFromDocumentRow(item.candidate.row, query, roundScore(item.relevanceProbability * 100));
    return {
      ...hit,
      snippet: compactAnswerPassage(item.body, 900),
      semanticScore: roundScore(item.directSimilarity),
      matchReasons: [
        `cross-encoder=${roundScore(item.relevanceLogit)}`,
        `embedding directo=${roundScore(item.directSimilarity)}`,
        `embedding multi-perspectiva=${roundScore(item.embeddingSimilarity)}`,
        `consenso RRF=${roundScore(item.reciprocalRankScore)}`,
        `ensamble neuronal=${roundScore(item.neuralConsensusScore)}`
      ]
    };
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
    const sectionLimit = depth === "deep" ? 8 : depth === "concise" ? 3 : 5;
    const contextualQuestion = composeNeuralQuestion(question, options.language, options.code);
    const answerSelection = await this.selectNeuralAnswer(options, question);
    const answerHits = answerSelection.candidates
      .slice(0, Math.max(limit * 2, 8))
      .map((candidate) => this.hitFromAnswerCandidate(candidate, question));
    const evidence = answerHits.slice(0, limit * 2);
    const responseCandidates = selectResponseCandidates(answerSelection.candidates);
    const selectedByDocument = new Map<string, NeuralAnswerCandidate>();
    for (const candidate of responseCandidates) {
      if (!selectedByDocument.has(candidate.candidate.documentId)) {
        selectedByDocument.set(candidate.candidate.documentId, candidate);
      }
    }
    const selectedPairs = [...selectedByDocument.values()]
      .map((candidate) => ({ candidate, read: this.read(candidate.candidate.documentId) }))
      .filter((pair): pair is { candidate: NeuralAnswerCandidate; read: ReadResult } => Boolean(pair.read));
    const reads = selectedPairs.map((pair) =>
      toReadSummary(pair.read, question, sectionLimit, compactAnswerPassage(pair.candidate.body, 900))
    );
    const sections = selectedPairs.map((pair) => ({
      id: pair.read.id,
      title: pair.read.title,
      sections: (pair.read.sections ?? []).slice(0, sectionLimit)
    }));
    const citations = selectedPairs.map((pair) => readToCitation(pair.read, pair.read.sections?.[0]?.title));
    const warnings = answerSelection.supported
      ? []
      : ["La evidencia neuronal recuperada no supera el umbral conjunto de pertinencia."];
    const coverage = buildNeuralCoverage({
      evidence,
      reads,
      sections,
      warnings,
      directEmbeddingScore: answerSelection.directEmbeddingScore,
      rerankerLogit: answerSelection.topRerankerLogit,
      supported: answerSelection.supported
    });
    const confidence = !answerSelection.supported
      ? "baja"
      : answerSelection.topRerankerLogit >= -2 && answerSelection.directEmbeddingScore >= 0.84
        ? "alta"
        : "media";
    const retrievalHop: AssistRetrievalHop = {
      axis: "primary",
      query: contextualQuestion,
      reason: "Recuperación multi-perspectiva y reranking neuronal sobre todo el índice vectorial.",
      status: "executed",
      resultCount: answerSelection.candidates.length,
      readCount: reads.length,
      sectionCount: sections.reduce((total, topic) => total + topic.sections.length, 0),
      evidenceIds: evidence.map((hit) => hit.id).slice(0, 10),
      warnings
    };
    const retrievalPlan: AssistRetrievalPlan = {
      strategy: "multi-hop",
      axes: ["primary", "semantic-variant"],
      initialQueries: [contextualQuestion],
      followUpQueries: [],
      hops: [retrievalHop],
      coverageGaps: coverage.missingTechnicalTerms
    };
    const taskPlan: AssistTaskPlan = {
      family: "neural_retrieval",
      summary: "Recuperación neuronal local sobre el corpus IBM i sin clases, anclas ni reglas de decisión manual.",
      primaryLanguage: options.language,
      requiredEvidence: NEURAL_POLICY.requiredEvidence,
      retrievalAxes: retrievalPlan.axes,
      responseTemplate: "Respuesta final compacta respaldada por recuperación y reranking neuronales.",
      minimumCoverage: "exploratory"
    };
    const answer = renderFinalAgentAnswer({
      supported: answerSelection.supported,
      candidates: responseCandidates,
      requestedVersion: normalizeVersionOption(options.version ?? options.ibmiVersion)
    });
    const specificFindings = responseCandidates.map((candidate) => compactAnswerPassage(candidate.body, 900));
    const executiveSummary = [answer];
    const implementationSteps: string[] = [];
    const validationChecklist: string[] = [];
    const workflow: WorkflowStage[] = [
      {
        tool: "ibmi_docs_neural_retrieval",
        reason: "Codificar varias vistas contextuales y recuperar candidatos sobre todos los vectores del corpus.",
        status: answerSelection.candidates.length ? "executed" : "skipped",
        evidenceIds: evidence.map((hit) => hit.id).slice(0, 12),
        outputSummary: `${answerSelection.candidates.length} candidato(s) neuronales.`
      },
      {
        tool: "ibmi_docs_neural_reranker",
        reason: "Leer conjuntamente la consulta y los pasajes candidatos con un cross-encoder multilingue.",
        status: answerSelection.candidates.length ? "executed" : "skipped",
        evidenceIds: answerSelection.candidates.slice(0, 12).map((candidate) => candidate.candidate.documentId),
        outputSummary: `${answerSelection.candidates.length} pasaje(s) rerankeados; soporte=${answerSelection.supported}.`
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
      relevance: {
        directEmbeddingScore: roundScore(answerSelection.directEmbeddingScore),
        rerankerLogit: roundScore(answerSelection.topRerankerLogit),
        rerankerProbability: roundScore(answerSelection.topRerankerProbability),
        supported: answerSelection.supported,
        selectedPassageIds: responseCandidates.map((candidate) => candidate.id)
      },
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
    return { query: options.query, semanticQueries: [options.query], results: [] };
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
      vectorCoverage: this.vectorCoverageDiagnostics(),
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
      vectorCoverage: this.vectorCoverageDiagnostics(),
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
      SELECT c.id AS chunk_id, c.chunk_index, d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url,
             d.text_length, d.breadcrumbs_json, d.document_kind, d.canonical_topic_key,
             d.normalized_text_path, d.sha256, d.language, d.product,
             c.body, v.vector, dv.vector AS title_vector
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN chunk_vectors v ON v.chunk_id = c.id
      JOIN document_vectors dv ON dv.document_id = d.id
    `).all() as Row[];
    const candidates = rows.map((row) => ({
      chunkId: String(row.chunk_id),
      chunkIndex: Number(row.chunk_index),
      row,
      documentId: String(row.id),
      title: String(row.title),
      body: String(row.body ?? ""),
      category: String(row.category),
      version: String(row.version),
      breadcrumbs: parseStringArray(row.breadcrumbs_json),
      vector: bufferToNeuralVector(row.vector as Buffer),
      titleVector: bufferToNeuralVector(row.title_vector as Buffer)
    }));
    CorpusRepository.candidateCache.set(dbPath, candidates);
    return candidates;
  }

  private hitFromAggregate(aggregate: NeuralDocumentAggregate, query: string): SearchHit {
    const row = aggregate.row;
    const best = aggregate.best;
    const primary = aggregate.primaryBest;
    const perspectiveScores = [...aggregate.perspectiveBest.values()]
      .map((passage) => passage.similarity)
      .sort((left, right) => left - right);
    const medianPerspectiveScore = perspectiveScores.length
      ? perspectiveScores[Math.floor(perspectiveScores.length / 2)]
      : primary.similarity;
    // La consulta original gobierna el ranking. Las reformulaciones neuronales
    // solo corroboran; nunca pueden convertir por si solas un tema ajeno en un
    // resultado de confianza alta.
    const score = roundScore(((primary.similarity * 0.72) + (medianPerspectiveScore * 0.18) + (best.similarity * 0.10)) * 100);
    const orderedPassages = [primary, ...aggregate.passages.filter((passage) => passage.candidate.chunkId !== primary.candidate.chunkId)];
    const passageSummary = orderedPassages
      .slice(0, 4)
      .map((passage, index) => `${index + 1}) ${makeSnippet(passage.candidate.body, "", 260)}`)
      .join(" ");
    return {
      id: aggregate.documentId,
      title: aggregate.title,
      snippet: makeSnippet([makeSnippet(primary.candidate.body, "", 520), passageSummary].filter(Boolean).join(" "), query, 700),
      score,
      semanticScore: roundScore(primary.similarity),
      sourceKind: String(row.source_kind) as SourceKind,
      sourceId: String(row.source_id),
      version: aggregate.version,
      category: aggregate.category,
      canonicalUrl: String(row.canonical_url),
      breadcrumbs: aggregate.breadcrumbs,
      textLength: Number(row.text_length ?? 0),
      documentKind: normalizeDocumentKind(row.document_kind),
      canonicalTopicKey: String(row.canonical_topic_key ?? ""),
      matchReasons: [
        `consulta original Transformers.js=${roundScore(primary.similarity)}`,
        `mejor perspectiva neuronal=${roundScore(best.similarity)}`,
        `perspectivas neuronales corroboradas=${aggregate.perspectiveBest.size}`
      ],
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

  private vectorCoverageDiagnostics(): VectorCoverageDiagnostics {
    const documents = this.scalarNumber("SELECT COUNT(*) FROM documents");
    const chunks = this.scalarNumber("SELECT COUNT(*) FROM chunks");
    const vectors = this.scalarNumber("SELECT COUNT(*) FROM chunk_vectors");
    const documentVectors = this.scalarNumber("SELECT COUNT(*) FROM document_vectors");
    const documentsWithoutChunks = this.scalarNumber(`
      SELECT COUNT(*)
      FROM documents d
      WHERE NOT EXISTS (
        SELECT 1
        FROM chunks c
        WHERE c.document_id = d.id
      )
    `);
    const chunksWithoutVectors = this.scalarNumber(`
      SELECT COUNT(*)
      FROM chunks c
      WHERE NOT EXISTS (
        SELECT 1
        FROM chunk_vectors v
        WHERE v.chunk_id = c.id
      )
    `);
    const documentsWithoutVectors = this.scalarNumber(`
      SELECT COUNT(*)
      FROM documents d
      WHERE NOT EXISTS (
        SELECT 1
        FROM document_vectors v
        WHERE v.document_id = d.id
      )
    `);
    return {
      ok: documents > 0 && chunks > 0 && vectors === chunks && documentVectors === documents
        && documentsWithoutChunks === 0 && chunksWithoutVectors === 0 && documentsWithoutVectors === 0,
      documents,
      chunks,
      vectors,
      documentVectors,
      documentsWithoutChunks,
      documentsWithoutVectors,
      chunksWithoutVectors
    };
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
      relevance: {
        directEmbeddingScore: 0,
        rerankerLogit: Number.NEGATIVE_INFINITY,
        rerankerProbability: 0,
        supported: false,
        selectedPassageIds: []
      },
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

function insertNeuralPassageMatch(passages: NeuralPassageMatch[], match: NeuralPassageMatch, maxItems: number): void {
  passages.push(match);
  passages.sort((a, b) => b.similarity - a.similarity);
  if (passages.length > maxItems) passages.splice(maxItems);
}

function neuralFacetSimilarity(queryVector: Float32Array, candidate: NeuralCandidate): number {
  const contentSimilarity = neuralCosineSimilarity(queryVector, candidate.vector);
  if (candidate.chunkIndex !== 0) return contentSimilarity;
  return Math.max(contentSimilarity, neuralCosineSimilarity(queryVector, candidate.titleVector));
}

function numericDistribution(values: number[]): { mean: number; standardDeviation: number } {
  if (!values.length) return { mean: 0, standardDeviation: 1 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, standardDeviation: Math.sqrt(variance) || 1 };
}

function zScore(value: number, distribution: { mean: number; standardDeviation: number }): number {
  return (value - distribution.mean) / distribution.standardDeviation;
}

function buildNeuralCoverage(input: {
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  warnings: string[];
  directEmbeddingScore: number;
  rerankerLogit: number;
  supported: boolean;
}): AssistCoverage {
  const sectionCount = input.sections.reduce((total, topic) => total + topic.sections.length, 0);
  const status: AssistCoverage["status"] = !input.supported
    ? "thin"
    : input.evidence.length >= 2 && input.reads.length
      ? "complete"
      : "partial";
  return {
    status,
    summary: `${input.evidence.length} evidencia(s), ${input.reads.length} lectura(s), ${sectionCount} sección(es); embedding=${roundScore(input.directEmbeddingScore)}; reranker=${roundScore(input.rerankerLogit)}.`,
    evidenceCount: input.evidence.length,
    readCount: input.reads.length,
    sectionCount,
    matchedTechnicalTerms: [],
    missingTechnicalTerms: [],
    warnings: input.warnings
  };
}

function toReadSummary(read: ReadResult, query: string, sectionLimit: number, retrievedSnippet = ""): ContextReadSummary {
  const excerpt = joinUniqueFragments([
    retrievedSnippet,
    makeSnippet(read.content, query, 900)
  ], 1200);
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
    excerpt,
    focusedSections: (read.sections ?? []).slice(0, sectionLimit)
  };
}

function readToCitation(read: ReadResult, section?: string): AnswerCitation {
  return { id: read.id, title: read.title, version: read.version, sourceKind: read.sourceKind, canonicalUrl: read.canonicalUrl, section };
}

function uniqueCandidatesByChunk(items: Array<{
  candidate: NeuralCandidate;
  directSimilarity: number;
  embeddingSimilarity: number;
  reciprocalRankScore: number;
}>): Array<{
  candidate: NeuralCandidate;
  directSimilarity: number;
  embeddingSimilarity: number;
  reciprocalRankScore: number;
}> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.candidate.chunkId)) return false;
    seen.add(item.candidate.chunkId);
    return true;
  });
}

function selectResponseCandidates(candidates: NeuralAnswerCandidate[]): NeuralAnswerCandidate[] {
  if (!candidates.length) return [];
  const top = candidates[0];
  const topLength = compactAnswerPassage(top.body, 900).length;
  const sameDocument = candidates.slice(1, 12).filter((candidate) =>
    candidate.candidate.documentId === top.candidate.documentId
    && candidate.relevanceLogit >= Math.max(CONDITIONAL_RERANKER_SUPPORT, top.relevanceLogit - 2.5)
  );
  const expandedPrimary = topLength < 120
    ? sameDocument
      .filter((candidate) => compactAnswerPassage(candidate.body, 900).length > topLength + 80)
      .sort((left, right) => {
        const leftLength = Math.min(900, compactAnswerPassage(left.body, 900).length) / 900;
        const rightLength = Math.min(900, compactAnswerPassage(right.body, 900).length) / 900;
        return (right.relevanceLogit + rightLength * 0.8) - (left.relevanceLogit + leftLength * 0.8);
      })[0]
    : undefined;
  const primary = expandedPrimary ?? top;
  // Sin un generador fundamentado, concatenar otro documento competitivo puede
  // mezclar dos conceptos cercanos pero distintos. La recuperación interna sí
  // conserva todos los candidatos; la respuesta pública usa solo el pasaje que
  // ganó el consenso neuronal para no trasladar ambigüedad al agente usuario.
  return [primary];
}

function renderFinalAgentAnswer(input: {
  supported: boolean;
  candidates: NeuralAnswerCandidate[];
  requestedVersion?: string;
}): string {
  if (!input.supported || !input.candidates.length) {
    return "No encontré evidencia documental suficientemente relacionada en el corpus IBM i para responder con fiabilidad.";
  }
  const fragments = input.candidates
    .map((candidate) => compactAnswerPassage(candidate.body, 900))
    .filter(Boolean);
  if (!fragments.length) {
    return "No encontré evidencia documental suficientemente relacionada en el corpus IBM i para responder con fiabilidad.";
  }
  const answer = fragments.length === 1
    ? fragments[0]
    : [fragments[0], "", ...fragments.slice(1).map((fragment) => `- ${fragment}`)].join("\n");
  const primaryVersion = input.candidates[0].version;
  if (input.requestedVersion && primaryVersion && primaryVersion !== input.requestedVersion) {
    return `${answer}\n\nLa información disponible corresponde a IBM i ${primaryVersion}; no se encontró soporte equivalente con suficiente relevancia en IBM i ${input.requestedVersion}.`;
  }
  return answer;
}

function normalizeCorpusPassage(text: string, stripPresentationMetadata = true): string {
  const paragraphs = String(text ?? "")
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((paragraph) => !(paragraph.includes("IBM i programming resources >") && paragraph.split(">").length >= 3))
    .filter((paragraph) => !stripPresentationMetadata || !(paragraph.includes("Last Updated:") && paragraph.length <= 240))
    .filter((paragraph) => !stripPresentationMetadata || !paragraph.toLocaleLowerCase().startsWith("parent topic:"));
  return uniqueReadableItems(paragraphs).join(" ").trim();
}

function compactAnswerPassage(text: string, maxLength: number): string {
  const normalized = normalizeCorpusPassage(text);
  if (!normalized) return "";
  const numberedFragments = normalized
    .split(/\s+\d+\)\s+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  const uniqueFragments = uniqueReadableItems(numberedFragments);
  let compact = uniqueFragments.join(" ");
  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length === 2 && words[0].toLocaleLowerCase() === words[1].toLocaleLowerCase()) {
    compact = words[0];
  }
  if (compact.length > maxLength) {
    const clipped = compact.slice(0, maxLength);
    const sentenceEnd = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("; "), clipped.lastIndexOf(": "));
    compact = `${(sentenceEnd >= Math.floor(maxLength * 0.55) ? clipped.slice(0, sentenceEnd + 1) : clipped).trim()}…`;
  }
  return compact;
}

function makeSnippet(text: string, query: string, maxLength: number): string {
  const clean = text.split("\r").join(" ").split("\n").join(" ").split("\t").join(" ").trim();
  if (!clean) return "";
  const index = query.trim() ? clean.toLowerCase().indexOf(query.trim().toLowerCase()) : -1;
  const start = index > 80 ? index - 80 : 0;
  const snippet = clean.slice(start, start + maxLength).trim();
  return snippet.length < clean.length - start ? `${snippet}…` : snippet;
}

function joinUniqueFragments(fragments: string[], maxLength: number): string {
  const joined = uniqueReadableItems(fragments).join(" ");
  return joined.length > maxLength ? `${joined.slice(0, maxLength).trim()}…` : joined;
}

function uniqueReadableItems(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output;
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
