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
import { queryHeadDiagnostics } from "./neuralQueryHead.js";
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
  perspectiveRrfScores: number[];
  perspectiveSimilarities: number[];
  perspectiveRerankerLogits: number[];
  basePerspectiveCount: number;
  titleRelevanceLogit: number;
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
const ANSWER_RERANK_LIMIT = 160;
const ANSWER_TITLE_RERANK_LIMIT = 512;
const ANSWER_TITLE_COVERAGE_LIMIT = 512;
const ANSWER_BODY_TITLE_COVERAGE_LIMIT = 96;
const ANSWER_PERSPECTIVE_RERANK_LIMIT = 48;
// El umbral de soporte calibra exclusivamente la decisión dentro/fuera del
// corpus. La selección de evidencias usa un piso distinto para no descartar
// pasajes complementarios que el cross-encoder considera útiles, aunque no
// sean suficientes por sí solos para afirmar que toda la consulta está cubierta.
const MIN_NEURAL_SUPPORT_LOGIT = 0.5;
const MIN_NEURAL_CORROBORATION_LOGIT = -0.95;
const MIN_NEURAL_PASSAGE_LOGIT = 0;

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
      queryToCorpusHead: queryHeadDiagnostics(),
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
    const perspectives = buildNeuralQueryPerspectives(query);
    const baseQueryVectors = await embedTexts(perspectives.map((perspective) => semanticQueryText(perspective)), { localOnly: true, kind: "query" });
    const queryVectors = baseQueryVectors;
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
      const perspective = perspectives[perspectiveIndex] ?? query;
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
      const scopedTop = results[0];
      const broaderTop = broaderResults[0];
      const sameCanonicalTopic = Boolean(scopedTop?.canonicalTopicKey)
        && scopedTop?.canonicalTopicKey === broaderTop?.canonicalTopicKey;
      // Si otra versión contiene el mismo tópico canónico, se respeta el
      // release pedido aunque su coseno fluctúe. Solo se amplía cuando el mejor
      // tópico global es distinto y neuronalmente supera al scope solicitado.
      if (broaderTop && (!scopedTop || (!sameCanonicalTopic && broaderTop.score > scopedTop.score))) results = broaderResults.map((hit) => ({
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
    const contextualQuestion = composeNeuralQuestion(question, undefined, options.code);
    const perspectives = uniqueNonEmpty([
      contextualQuestion,
      ...buildNeuralQueryPerspectives(question),
      options.code ?? ""
    ]);
    const baseQueryVectors = await embedTexts(
      perspectives.map((perspective) => semanticQueryText(perspective)),
      { localOnly: true, kind: "query" }
    );
    // El ensamble conserva dos salidas del mismo Transformer: la geometría E5
    // general y su proyección IBM i query->corpus. Ambas
    // vistas participan siempre y la cabeza afinada gobierna el score directo.
    const foundationQueryVectors = await embedTexts(
      [semanticQueryText(contextualQuestion)],
      { localOnly: true, kind: "query-foundation" }
    );
    const queryVectors = [...baseQueryVectors, ...foundationQueryVectors];
    perspectives.push(...foundationQueryVectors.map(() => contextualQuestion));
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
      perspectiveRrfScores: number[];
      perspectiveSimilarities: number[];
      titleRelevanceLogit: number;
    };
    const buildCandidatePool = (scope: NeuralCandidate[]): Map<string, CandidatePoolEntry> => {
      const candidatePool = new Map<string, CandidatePoolEntry>();
      const titleRepresentatives = scope.filter((candidate) => candidate.chunkIndex === 0);
      for (let perspectiveIndex = 0; perspectiveIndex < queryVectors.length; perspectiveIndex += 1) {
        const vector = queryVectors[perspectiveIndex];
        // La proyección query->corpus gobierna; la geometría fundacional E5
        // preserva consultas generales y aporta cobertura con menor peso.
        const perspectiveWeight = perspectiveIndex < baseQueryVectors.length ? 1 : 0.35;
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
            const reciprocalRankScore = perspectiveWeight / (40 + rank + 1);
            const existing = candidatePool.get(item.candidate.chunkId);
            if (existing) {
              existing.reciprocalRankScore += reciprocalRankScore;
              existing.embeddingSimilarity = Math.max(existing.embeddingSimilarity, item.similarity);
              existing.perspectiveRrfScores[perspectiveIndex] += reciprocalRankScore;
              existing.perspectiveSimilarities[perspectiveIndex] = Math.max(
                existing.perspectiveSimilarities[perspectiveIndex],
                item.similarity
              );
              continue;
            }
            const perspectiveRrfScores = Array(queryVectors.length).fill(0) as number[];
            const perspectiveSimilarities = Array(queryVectors.length).fill(Number.NEGATIVE_INFINITY) as number[];
            perspectiveRrfScores[perspectiveIndex] = reciprocalRankScore;
            perspectiveSimilarities[perspectiveIndex] = item.similarity;
            candidatePool.set(item.candidate.chunkId, {
              candidate: item.candidate,
              // La cabeza fue entrenada específicamente query->documento. Su
              // score canónico compara la consulta con el vector documental;
              // un chunk corto no puede suplantarlo por una similitud accidental.
              directSimilarity: neuralCosineSimilarity(
                queryVectors[0], item.candidate.titleVector
              ),
              embeddingSimilarity: item.similarity,
              reciprocalRankScore,
              perspectiveRrfScores,
              perspectiveSimilarities,
              titleRelevanceLogit: Number.NEGATIVE_INFINITY
            });
          }
        }
      }
      return candidatePool;
    };

    // La cabeza query->corpus ya ejecuta el salto neuronal aprendido desde la
    // intención hacia documentos reales. Reinyectar textos de candidatos como
    // nuevas consultas añadía deriva temática, multiplicaba el coste y podía
    // desplazar la pregunta original; por eso la ruta canónica usa únicamente
    // vistas completas proporcionadas por el usuario.
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

    // La cabeza query->corpus ya fue entrenada contra los vectores documentales
    // completos. Su ranking de títulos es el índice neuronal canónico; aplicar
    // otro cross-encoder solo al título reintroducía sesgo hacia palabras
    // visibles y duplicaba inferencias sin leer todavía el contenido.
    const titleFocusedRepresentatives = [...globalCandidatePool.values()]
      .filter((item) => item.candidate.chunkIndex === 0)
      .sort((left, right) => {
        // La consulta completa gobierna cobertura de títulos. Las facetas se
        // recuperan por separado en RRF, pero usar aquí su máximo podía llenar
        // los 512 puestos con coincidencias de media frase y expulsar la
        // respuesta global que sí estaba bien posicionada para la petición.
        const leftScore = neuralCosineSimilarity(baseQueryVectors[0], left.candidate.titleVector);
        const rightScore = neuralCosineSimilarity(baseQueryVectors[0], right.candidate.titleVector);
        return rightScore - leftScore;
      })
      .slice(0, ANSWER_TITLE_RERANK_LIMIT);
    const titleRepresentatives = uniqueCandidatesByCanonicalTopic(
      titleFocusedRepresentatives
    ).slice(0, ANSWER_TITLE_RERANK_LIMIT);
    const titleRanking: NeuralRerankedPassage[] = titleRepresentatives.map((item) => {
      const relevanceLogit = item.directSimilarity;
      return {
        id: item.candidate.documentId,
        title: item.candidate.title,
        body: item.candidate.title,
        category: item.candidate.category,
        version: item.candidate.version,
        breadcrumbs: item.candidate.breadcrumbs,
        relevanceLogit,
        relevanceProbability: sigmoidScore(relevanceLogit)
      };
    });
    const titleLogitByDocument = new Map(titleRanking.map((item) => [item.id, item.relevanceLogit]));
    for (const pool of [globalCandidatePool, preferredCandidatePool].filter(Boolean) as Array<Map<string, CandidatePoolEntry>>) {
      for (const item of pool.values()) {
        item.titleRelevanceLogit = titleLogitByDocument.get(item.candidate.documentId)
          ?? Number.NEGATIVE_INFINITY;
      }
    }
    const spanCoverageDocuments = new Set(
      titleRanking.slice(0, 12).map((item) => item.id)
    );
    const titleMetadataByDocument = new Map(
      [...globalCandidatePool.values()]
        .filter((item) => item.candidate.chunkIndex === 0)
        .map((item) => [item.candidate.documentId, item] as const)
    );
    // Conserva el orden decidido por el cross-encoder de títulos. Filtrar el
    // pool RRF anterior mantenía accidentalmente su orden original y podía
    // expulsar de los primeros N precisamente al documento que el reranker
    // acababa de promover.
    const titleCoveragePool = titleRanking
      .slice(0, ANSWER_TITLE_COVERAGE_LIMIT)
      .map((item) => titleMetadataByDocument.get(item.id))
      .filter((item): item is CandidatePoolEntry => Boolean(item));
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
      ? preferredPooled.slice(0, ANSWER_RERANK_LIMIT)
      : [];
    const perspectiveFocusedPool = baseQueryVectors.flatMap((_, perspectiveIndex) =>
      [...pooled]
        .sort((left, right) =>
          (right.perspectiveRrfScores[perspectiveIndex] ?? 0)
          - (left.perspectiveRrfScores[perspectiveIndex] ?? 0)
        )
        .slice(0, 12)
    );
    const globalRerankPool = uniqueCandidatesByChunk([
      ...perspectiveFocusedPool,
      ...titleCoveragePool.slice(0, ANSWER_BODY_TITLE_COVERAGE_LIMIT),
      ...concise,
      ...pooled.slice(0, 24),
      ...[...pooled].sort((left, right) => right.directSimilarity - left.directSimilarity).slice(0, 32),
      ...[...pooled].sort((left, right) => right.embeddingSimilarity - left.embeddingSimilarity).slice(0, 32)
    ])
      .slice(0, ANSWER_RERANK_LIMIT);
    const rerankCandidatePool = async (
      pool: typeof globalRerankPool
    ): Promise<NeuralAnswerCandidate[]> => {
      // El cross-encoder debe decidir a partir de la petición real. Un hint
      // corto como "CLLE" sirve para ampliar la recuperación, pero concatenarlo
      // como si fuese parte de la pregunta puede dominar los logits y favorecer
      // cualquier página que mencione ese entorno. El código sí conserva valor
      // semántico porque forma parte del problema que el usuario quiere resolver.
      const rerankerQuestion = requestedVersion
        ? `${composeNeuralRerankerQuestion(question, options.code)}\n\nPreferred IBM i version: ${requestedVersion}`
        : composeNeuralRerankerQuestion(question, options.code);
      const reranked = await rerankPassages(
        rerankerQuestion,
        pool.map((item) => ({
          id: item.candidate.chunkId,
          title: item.candidate.title,
          body: normalizeCorpusPassage(item.candidate.body, false),
          category: item.candidate.category,
          version: item.candidate.version,
          breadcrumbs: item.candidate.breadcrumbs
        })),
        { localOnly: true, maxLength: 384 }
      );
      const metadataByChunk = new Map(pool.map((item) => [item.candidate.chunkId, item]));
      const globalLogitByChunk = new Map(reranked.map((item) => [item.id, item.relevanceLogit]));
      const perspectiveLogitsByChunk = new Map(
        pool.map((item) => [
          item.candidate.chunkId,
          Array.from({ length: baseQueryVectors.length }, (_, index) =>
            index === 0
              ? globalLogitByChunk.get(item.candidate.chunkId) ?? Number.NEGATIVE_INFINITY
              : Number.NEGATIVE_INFINITY
          )
        ])
      );

      // Cada perspectiva semántica vuelve a leer sus candidatos más fuertes
      // con el cross-encoder. Esto permite cubrir peticiones compuestas sin
      // delegar subconsultas al agente y sin inferir componentes mediante
      // palabras, regex o categorías predefinidas.
      // La primera perspectiva coincide con la lectura global ya calculada.
      // Solo el contexto de código adicional necesita una segunda inferencia.
      for (let perspectiveIndex = 1; perspectiveIndex < baseQueryVectors.length; perspectiveIndex += 1) {
        const perspectivePool = [...pool]
          .sort((left, right) =>
            (right.perspectiveRrfScores[perspectiveIndex] ?? 0)
            - (left.perspectiveRrfScores[perspectiveIndex] ?? 0)
          )
          .slice(0, ANSWER_PERSPECTIVE_RERANK_LIMIT);
        const perspectiveRanking = await rerankPassages(
          perspectives[perspectiveIndex] ?? rerankerQuestion,
          perspectivePool.map((item) => ({
            id: item.candidate.chunkId,
            title: item.candidate.title,
            body: normalizeCorpusPassage(item.candidate.body, false),
            category: item.candidate.category,
            version: item.candidate.version,
            breadcrumbs: item.candidate.breadcrumbs
          })),
          { localOnly: true, maxLength: 192 }
        );
        for (const item of perspectiveRanking) {
          const logits = perspectiveLogitsByChunk.get(item.id);
          if (logits) logits[perspectiveIndex] = item.relevanceLogit;
        }
      }
      const materialized = reranked.map((item): NeuralAnswerCandidate => {
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
          perspectiveRrfScores: metadata.perspectiveRrfScores,
          perspectiveSimilarities: metadata.perspectiveSimilarities,
          perspectiveRerankerLogits: perspectiveLogitsByChunk.get(metadata.candidate.chunkId)
            ?? Array(baseQueryVectors.length).fill(Number.NEGATIVE_INFINITY),
          basePerspectiveCount: baseQueryVectors.length,
          titleRelevanceLogit: metadata.titleRelevanceLogit,
          neuralConsensusScore: 0
        };
      });

      // Una página relevante puede contener la condición decisiva al final del
      // primer bloque. Se crean ventanas de oraciones solo para los documentos
      // que ya superaron dos recuperadores neuronales (vector + título) y se
      // rerankean con el mismo cross-encoder. Esta expansión no usa palabras,
      // regex, categorías ni respuestas codificadas manualmente.
      const spanMetadata = new Map<string, { metadata: CandidatePoolEntry; body: string }>();
      for (const metadata of pool) {
        if (metadata.candidate.chunkIndex !== 0
          || !spanCoverageDocuments.has(metadata.candidate.documentId)) continue;
        const spans = buildNeuralPassageWindows(metadata.candidate.body);
        spans.forEach((body, index) => {
          const id = `${metadata.candidate.chunkId}::semantic-span:${index}`;
          spanMetadata.set(id, { metadata, body });
        });
      }
      if (spanMetadata.size) {
        const spanRanking = await rerankPassages(
          rerankerQuestion,
          [...spanMetadata.entries()].map(([id, span]) => ({
            id,
            title: span.metadata.candidate.title,
            body: span.body,
            category: span.metadata.candidate.category,
            version: span.metadata.candidate.version,
            breadcrumbs: span.metadata.candidate.breadcrumbs
          })),
          { localOnly: true, maxLength: 192 }
        );
        materialized.push(...spanRanking.map((item): NeuralAnswerCandidate => {
          const span = spanMetadata.get(item.id);
          if (!span) throw new Error(`No se encontro metadata neuronal para el span ${item.id}.`);
          return {
            ...item,
            body: span.body,
            candidate: span.metadata.candidate,
            directSimilarity: span.metadata.directSimilarity,
            embeddingSimilarity: span.metadata.embeddingSimilarity,
            reciprocalRankScore: span.metadata.reciprocalRankScore,
            perspectiveRrfScores: span.metadata.perspectiveRrfScores,
            perspectiveSimilarities: span.metadata.perspectiveSimilarities,
            perspectiveRerankerLogits: perspectiveLogitsByChunk.get(span.metadata.candidate.chunkId)
              ?? Array(baseQueryVectors.length).fill(Number.NEGATIVE_INFINITY),
            basePerspectiveCount: baseQueryVectors.length,
            titleRelevanceLogit: span.metadata.titleRelevanceLogit,
            neuralConsensusScore: 0
          };
        }));
      }
      // El título sirve exclusivamente para descubrir documentos candidatos.
      // La evidencia y la decisión dentro/fuera del dominio siempre vuelven a
      // pasar por el cross-encoder pregunta-pasaje; un título temáticamente
      // parecido no puede convertirse por sí solo en una respuesta soportada.
      const rerankerStats = numericDistribution(materialized.map((item) => item.relevanceLogit));
      const retrievalStats = numericDistribution(materialized.map((item) => item.reciprocalRankScore));
      const directStats = numericDistribution(materialized.map((item) => item.directSimilarity));
      const titleStats = numericDistribution(materialized
        .map((item) => item.titleRelevanceLogit)
        .filter(Number.isFinite));
      for (const item of materialized) {
        // Ambos componentes son salidas neuronales. Estandarizarlos evita que
        // la escala arbitraria de logits anule el consenso de las perspectivas
        // producidas por el Transformer afinado, o viceversa.
        // La cabeza query->corpus fue entrenada end-to-end contra los 7.027
        // documentos reales y por ello gobierna la selección. El cross-encoder
        // corrobora pasajes, pero no puede anular una relación query-documento
        // aprendida solo porque una palabra de la pregunta aparece en otro título.
        item.neuralConsensusScore = (zScore(item.directSimilarity, directStats) * 2)
          + zScore(item.reciprocalRankScore, retrievalStats)
          + (zScore(item.relevanceLogit, rerankerStats) * 0.75)
          + (Number.isFinite(item.titleRelevanceLogit)
            ? zScore(item.titleRelevanceLogit, titleStats) * 0.25
            : 0);
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
    let candidates = await rerankCandidatePool(
      preferredVersionPool.length ? preferredVersionPool : globalRerankPool
    );
    const preferredCandidate = requestedVersion
      ? candidates.find((candidate) => candidate.version === requestedVersion
        && candidate.relevanceLogit >= MIN_NEURAL_SUPPORT_LOGIT)
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
      && (!preferredCandidate || candidates[0].relevanceLogit < MIN_NEURAL_SUPPORT_LOGIT)) {
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
    // El soporte exige consenso entre dos redes entrenadas con objetivos
    // distintos: el cross-encoder debe validar el pasaje y el documento elegido
    // debe permanecer dentro del vecindario principal de la cabeza query->corpus.
    // Esta calibración numérica evita que una asociación accidental del
    // cross-encoder convierta una petición ajena al corpus en respuesta IBM i.
    const maximumCandidateDirectScore = candidates.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.directSimilarity),
      0
    );
    const neuralAgreementRatio = maximumCandidateDirectScore > 0
      ? selectedDirectEmbeddingScore / maximumCandidateDirectScore
      : 0;
    const supported = topRerankerLogit >= 1
      || (topRerankerLogit >= MIN_NEURAL_CORROBORATION_LOGIT && neuralAgreementRatio >= 0.9);

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
        `reranker de título=${roundScore(item.titleRelevanceLogit)}`,
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
    const contextualQuestion = composeNeuralQuestion(question, undefined, options.code);
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
      : answerSelection.topRerankerLogit >= -2
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
    if (marker.marker?.modelId !== model) {
      throw new Error(`El corpus requiere ${model}, pero la instalación local reporta ${marker.marker?.modelId ?? "un modelo desconocido"}. Ejecuta npm install para sincronizarlos.`);
    }
    if (!fs.existsSync(path.join(marker.modelPath, "onnx", "model_quantized.onnx"))) {
      throw new Error(`El modelo semántico local está incompleto en ${marker.modelPath}. Ejecuta npm install para reconstruirlo.`);
    }
    // Verifica la cabeza query->corpus obligatoria. Nunca se degrada de forma
    // silenciosa a otra estrategia si el artefacto falta o está corrupto.
    queryHeadDiagnostics();
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

function composeNeuralRerankerQuestion(question: string, code?: string): string {
  return [
    question.trim(),
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

function uniqueCandidatesByChunk<T extends { candidate: NeuralCandidate }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.candidate.chunkId)) return false;
    seen.add(item.candidate.chunkId);
    return true;
  });
}

function uniqueCandidatesByDocument<T extends { candidate: NeuralCandidate }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.candidate.documentId)) return false;
    seen.add(item.candidate.documentId);
    return true;
  });
}

function uniqueCandidatesByCanonicalTopic<T extends { candidate: NeuralCandidate }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    // La clave canónica agrupa la misma documentación publicada para varias
    // releases; si no existe, el documento sigue siendo su propia identidad.
    const canonicalTopic = String(item.candidate.row.canonical_topic_key ?? "").trim();
    const identity = canonicalTopic || item.candidate.documentId;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function selectResponseCandidates(candidates: NeuralAnswerCandidate[]): NeuralAnswerCandidate[] {
  if (!candidates.length) return [];
  const top = candidates[0];
  const topLength = compactAnswerPassage(top.body, 900).length;
  const sameDocument = candidates.slice(1, 12).filter((candidate) =>
    candidate.candidate.documentId === top.candidate.documentId
    && candidate.relevanceLogit >= Math.max(MIN_NEURAL_PASSAGE_LOGIT, top.relevanceLogit - 2.5)
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
  const selectedTop = expandedPrimary ?? top;
  const documentLead = candidates.find((candidate) =>
    candidate.candidate.documentId === selectedTop.candidate.documentId
    && candidate.candidate.chunkIndex === 0
    && !candidate.id.includes("::semantic-span:")
  );
  // La ventana más pertinente aporta precisión, mientras el primer bloque del
  // mismo documento aporta definición y contexto. Se combinan ambas evidencias
  // neuronales para responder de forma autocontenida sin copiar otros tópicos.
  const primary = documentLead && documentLead.id !== selectedTop.id
    ? {
        ...selectedTop,
        body: combineDocumentEvidence(
          compactAnswerPassage(documentLead.body, 1_150),
          compactAnswerPassage(selectedTop.body, 450)
        )
      }
    : selectedTop;
  const selected = [primary];
  const primaryTopicKey = String(primary.candidate.row.canonical_topic_key ?? "");
  const seenTopics = new Set(primaryTopicKey ? [primaryTopicKey] : []);
  const relativeFloor = Math.max(MIN_NEURAL_PASSAGE_LOGIT, top.relevanceLogit - 0.9);
  const basePerspectiveCount = Math.max(1, primary.basePerspectiveCount);
  const perspectiveStats = Array.from({ length: basePerspectiveCount }, (_, perspectiveIndex) => {
    const values = candidates
      .map((candidate) => candidate.perspectiveRerankerLogits[perspectiveIndex])
      .filter(Number.isFinite)
      .sort((left, right) => right - left);
    if (!values.length) return { median: 0, spread: 1, discriminativeWeight: 0 };
    const median = values[Math.floor(values.length / 2)];
    const top = values[0];
    const spread = Math.sqrt(
      values.reduce((sum, value) => sum + (value - median) ** 2, 0) / values.length
    ) || 1;
    // Una vista genérica suele asignar logits altos y casi planos a muchos
    // documentos. El margen top-mediana mide cuánta información discriminante
    // aporta realmente esa perspectiva, sin mirar su texto ni su categoría.
    const discriminativeWeight = 1 - Math.exp(-Math.max(0, top - median));
    return { median, spread, discriminativeWeight };
  });
  const normalizedPerspectiveCoverage = (candidate: NeuralAnswerCandidate): number[] =>
    perspectiveStats.map((stats, perspectiveIndex) => {
      const logit = candidate.perspectiveRerankerLogits[perspectiveIndex];
      if (!Number.isFinite(logit) || stats.discriminativeWeight <= 0) return 0;
      return sigmoidScore((logit - stats.median) / stats.spread) * stats.discriminativeWeight;
    });
  const coveredPerspectives = normalizedPerspectiveCoverage(primary);

  // La respuesta puede requerir varias evidencias. Se aplica MMR sobre salidas
  // neuronales: pertinencia del cross-encoder, consenso de perspectivas y
  // diversidad vectorial. No se inspeccionan palabras ni categorías.
  const alternatives = candidates
    .filter((candidate) => candidate.id !== primary.id)
    // Solo documentos dentro del mismo vecindario query->corpus pueden
    // complementar la respuesta. El ratio opera sobre salidas neuronales y
    // evita que la diversidad MMR introduzca tópicos remotos como relleno.
    .filter((candidate) => candidate.directSimilarity >= primary.directSimilarity * 0.65)
    .filter((candidate) => candidate.relevanceLogit >= relativeFloor
      || Math.max(...normalizedPerspectiveCoverage(candidate), 0) >= 0.35)
    .filter((candidate) => compactAnswerPassage(candidate.body, 900).length >= 20);
  // Dos documentos independientes cubren la comparación y la mayoría de
  // respuestas compuestas sin convertir diversidad en relleno tangencial.
  // Cada documento puede aportar varias ventanas internas ya sintetizadas.
  while (selected.length < 2 && alternatives.length) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < alternatives.length; index += 1) {
      const candidate = alternatives[index];
      const topicKey = String(candidate.candidate.row.canonical_topic_key ?? "");
      if (topicKey && seenTopics.has(topicKey)) continue;
      const maximumRedundancy = Math.max(...selected.map((item) =>
        neuralCosineSimilarity(candidate.candidate.vector, item.candidate.vector)
      ));
      if (maximumRedundancy >= 0.985) continue;
      const candidateCoverage = normalizedPerspectiveCoverage(candidate);
      const relevance = Math.exp(Math.min(0, candidate.relevanceLogit - top.relevanceLogit));
      const novelty = 1 - Math.max(-1, Math.min(1, maximumRedundancy));
      const coverageGain = candidateCoverage.reduce((gain, value, perspectiveIndex) =>
        gain + Math.max(0, value - coveredPerspectives[perspectiveIndex]), 0
      ) / basePerspectiveCount;
      const directAlignment = primary.directSimilarity > 0
        ? Math.max(0, Math.min(1, candidate.directSimilarity / primary.directSimilarity))
        : 0;
      const score = (relevance * 0.65)
        + (novelty * 0.10)
        + (coverageGain * 0.15)
        + (directAlignment * 0.10);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [chosen] = alternatives.splice(bestIndex, 1);
    selected.push(chosen);
    const chosenCoverage = normalizedPerspectiveCoverage(chosen);
    chosenCoverage.forEach((value, perspectiveIndex) => {
      coveredPerspectives[perspectiveIndex] = Math.max(coveredPerspectives[perspectiveIndex], value);
    });
    const topicKey = String(chosen.candidate.row.canonical_topic_key ?? "");
    if (topicKey) seenTopics.add(topicKey);
  }
  return selected;
}

function sigmoidScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return 1 / (1 + Math.exp(-value));
}

/**
 * Conserva la intención completa. Dividir por posición una petición técnica
 * alteraba palabras y relaciones; la cabeza neuronal genera la proyección
 * semántica sin recortes ni vistas construidas manualmente.
 */
function buildNeuralQueryPerspectives(query: string): string[] {
  const clean = query.trim();
  return clean ? [clean] : [];
}

/**
 * Construye ventanas estructurales para que el cross-encoder lea condiciones
 * internas sin depender de cortes fijos del data pack. Intl.Segmenter aporta
 * límites lingüísticos y cada oración participa después por pertinencia neural.
 */
function buildNeuralPassageWindows(text: string): string[] {
  const clean = normalizeCorpusPassage(text, false);
  if (!clean) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const sentences = [...segmenter.segment(clean)]
    .map((segment) => segment.segment.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 20);
  if (!sentences.length) return [clean.slice(0, 700)];
  const windows: string[] = [];
  for (let index = 0; index < sentences.length; index += 2) {
    const window = [sentences[index], sentences[index + 1]]
      .filter(Boolean)
      .join(" ")
      .slice(0, 700)
      .trim();
    if (window) windows.push(window);
  }
  return uniqueNonEmpty(windows).slice(0, 8);
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
    .map((candidate) => ({
      title: candidate.title.trim(),
      // Un pasaje de hasta 1.600 caracteres conserva parámetros, condiciones
      // y restricciones que antes podían quedar cortados a mitad de respuesta.
      body: compactAnswerPassage(candidate.body, 1600)
    }))
    .filter((fragment) => Boolean(fragment.body));
  if (!fragments.length) {
    return "No encontré evidencia documental suficientemente relacionada en el corpus IBM i para responder con fiabilidad.";
  }
  const rendered = fragments.map((fragment) => renderTitledAnswerFragment(fragment.title, fragment.body));
  const answer = rendered.length === 1
    ? rendered[0]
    : [rendered[0], "", ...rendered.slice(1).map((fragment) => `- ${fragment}`)].join("\n");
  const primaryVersion = input.candidates[0].version;
  if (input.requestedVersion && primaryVersion && primaryVersion !== input.requestedVersion) {
    return `${answer}\n\nLa información disponible corresponde a IBM i ${primaryVersion}; no se encontró soporte equivalente con suficiente relevancia en IBM i ${input.requestedVersion}.`;
  }
  return answer;
}

function renderTitledAnswerFragment(title: string, body: string): string {
  if (!title) return body;
  // El título es evidencia útil (por ejemplo, el nombre del comando), no
  // telemetría interna. Se evita repetirlo cuando el propio pasaje ya comienza
  // con él.
  if (body.toLocaleLowerCase().startsWith(title.toLocaleLowerCase())) return body;
  return `${title}: ${body}`;
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

function combineDocumentEvidence(lead: string, detail: string): string {
  if (!detail || lead.toLocaleLowerCase().includes(detail.toLocaleLowerCase())) return lead;
  return joinUniqueFragments([lead, detail], 1_600);
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
