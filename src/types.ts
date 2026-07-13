export type SourceKind = "rdi-local-export" | "ibm-docs" | "manual-pack";

export interface TocNodeRecord {
  id: string;
  title: string;
  href: string;
  path: string[];
  tocId: string;
  isLeaf: boolean;
}

export interface DocumentRecord {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  breadcrumbs: string[];
  product: string;
  version: string;
  language: string;
  category: string;
  rawHtmlPath: string;
  normalizedTextPath: string;
  sha256: string;
  textLength: number;
  collectedAt: string;
  documentKind?: DocumentKind;
  canonicalTopicKey?: string;
}

export interface SourceManifest {
  id: string;
  kind: SourceKind;
  name: string;
  baseUrl: string;
  exportedAt: string;
  documentCount: number;
  failedCount: number;
  notes: string[];
}

export interface CorpusManifest {
  schemaVersion: 1;
  corpusVersion: string;
  generatedAt: string;
  description: string;
  sources: SourceManifest[];
  documents: DocumentRecord[];
  coverage: Record<string, unknown>;
}


export type TaxonomyKind =
  | "command"
  | "rpg-opcode"
  | "rpg-bif"
  | "message"
  | "dds-keyword"
  | "sql"
  | "api"
  | "language-guide"
  | "general";

export interface TopicTaxonomy {
  kind: TaxonomyKind;
  label: string;
  confidence: number;
  signals: string[];
  relatedKinds?: TaxonomyKind[];
}

export type TopicSectionKind = "syntax" | "parameters" | "description" | "examples" | "notes" | "restrictions" | "messages" | "recovery" | "related" | "generic";

export type DocumentKind = "topic" | "reference" | "index" | "landing" | "stub";

export interface TopicSection {
  kind: TopicSectionKind;
  title: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface SearchOptions {
  query: string;
  version?: string;
  ibmiVersion?: string;
  category?: string;
  limit?: number;
  autoRead?: boolean;
  includeSections?: boolean;
}

export type DocsIntent = "neural_retrieval";

export interface WorkflowStage {
  tool: string;
  reason: string;
  status: "planned" | "executed" | "skipped";
  evidenceIds?: string[];
  outputSummary?: string;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  sourceKind: SourceKind;
  sourceId: string;
  version: string;
  category: string;
  canonicalUrl: string;
  breadcrumbs: string[];
  textLength?: number;
  taxonomy?: TopicTaxonomy;
  semanticScore?: number;
  matchReasons?: string[];
  sectionsPreview?: TopicSection[];
  autoReadApplied?: boolean;
  fullContent?: string;
  documentKind?: DocumentKind;
  canonicalTopicKey?: string;
  relevanceWarnings?: string[];
  requestedVersionScopeExpansion?: boolean;
}

export interface ReadResult extends SearchHit {
  content: string;
  textLength: number;
  sha256: string;
  sections?: TopicSection[];
}

export interface ContextReadSummary {
  id: string;
  title: string;
  version: string;
  category: string;
  sourceKind: SourceKind;
  canonicalUrl: string;
  documentKind?: DocumentKind;
  canonicalTopicKey?: string;
  taxonomy?: TopicTaxonomy;
  textLength: number;
  excerpt: string;
  focusedSections: TopicSection[];
}

export interface RelatedOptions {
  limit?: number;
}

export interface RelatedDocuments {
  topic: ReadResult | null;
  equivalentVersions: SearchHit[];
  related: SearchHit[];
}

export interface CategoryDiagnostics {
  categories: string[];
  versions: string[];
  sources: string[];
  byCategory: Record<string, number>;
  byVersion: Record<string, number>;
  bySource: Record<string, number>;
}

export interface PackDiagnostics {
  ok: boolean;
  packDir: string;
  corpusVersion: string;
  documents: number;
  chunks: number;
  vectorCoverage?: VectorCoverageDiagnostics;
  missingFiles: number;
  checkedFiles: number;
  longPaths: string[];
  anomalies: string[];
  runtimeDependency: string;
}

export interface VectorCoverageDiagnostics {
  ok: boolean;
  documents: number;
  chunks: number;
  vectors: number;
  documentVectors: number;
  documentsWithoutChunks: number;
  documentsWithoutVectors: number;
  chunksWithoutVectors: number;
}


export interface AnswerCitation {
  id: string;
  title: string;
  version: string;
  sourceKind: SourceKind;
  canonicalUrl: string;
  section?: string;
}

export interface WorkflowPolicy {
  intent: DocsIntent;
  preferredTools: string[];
  requiredEvidence: string[];
  defaultLimit: number;
  description: string;
}

export type AssistDepth = "concise" | "standard" | "deep";

export interface AssistOptions {
  question: string;
  query?: string;
  language?: string;
  version?: string;
  ibmiVersion?: string;
  category?: string;
  code?: string;
  depth?: AssistDepth;
  limit?: number;
}

export interface AssistCoverage {
  status: "complete" | "partial" | "thin";
  summary: string;
  evidenceCount: number;
  readCount: number;
  sectionCount: number;
  matchedTechnicalTerms: string[];
  missingTechnicalTerms: string[];
  warnings: string[];
}

export type AssistRetrievalAxis =
  | "primary"
  | "semantic-variant";

export type AssistTaskFamily = "neural_retrieval";

export interface AssistTaskPlan {
  family: AssistTaskFamily;
  summary: string;
  primaryLanguage?: string;
  requiredEvidence: string[];
  retrievalAxes: AssistRetrievalAxis[];
  responseTemplate: string;
  minimumCoverage: "strong" | "moderate" | "exploratory";
}

export interface AssistRetrievalHop {
  axis: AssistRetrievalAxis;
  query: string;
  reason: string;
  status: "executed" | "skipped";
  resultCount: number;
  readCount: number;
  sectionCount: number;
  evidenceIds: string[];
  warnings: string[];
}

export interface AssistRetrievalPlan {
  strategy: "single-pass";
  axes: AssistRetrievalAxis[];
  initialQueries: string[];
  followUpQueries: string[];
  hops: AssistRetrievalHop[];
  coverageGaps: string[];
}

export interface AssistNeuralRelevance {
  directEmbeddingScore: number;
  rerankerLogit: number;
  rerankerProbability: number;
  supported: boolean;
  selectedPassageIds: string[];
}

export interface AssistResult {
  question: string;
  intent: DocsIntent;
  confidence: "alta" | "media" | "baja";
  taskPlan: AssistTaskPlan;
  answer: string;
  executiveSummary: string[];
  specificFindings: string[];
  implementationSteps: string[];
  validationChecklist: string[];
  relevance: AssistNeuralRelevance;
  coverage: AssistCoverage;
  retrievalPlan: AssistRetrievalPlan;
  workflow: WorkflowStage[];
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  citations: AnswerCitation[];
  warnings: string[];
}

export interface RankingExplanationOptions extends SearchOptions {
  top?: number;
}

export interface RankingExplanationItem {
  hit: SearchHit;
  reasons: string[];
  taxonomy: TopicTaxonomy;
  semanticScore: number;
  documentKind?: DocumentKind;
  canonicalTopicKey?: string;
  relevanceWarnings?: string[];
}

export interface RankingExplanation {
  query: string;
  semanticQueries: string[];
  results: RankingExplanationItem[];
}

export interface QualityReport {
  ok: boolean;
  generatedAt: string;
  corpusVersion: string;
  documents: number;
  chunks: number;
  vectorCoverage?: VectorCoverageDiagnostics;
  coverage: CategoryDiagnostics;
  shortDocuments: Array<{ id: string; title: string; textLength: number; category: string; version: string }>;
  duplicateTitles: Array<{ title: string; count: number; versions: string[] }>;
  duplicateTitlesSameVersion?: Array<{ title: string; count: number; version: string; categories: string[] }>;
  duplicateTitlesCrossVersionExpected?: Array<{ title: string; count: number; versions: string[] }>;
  duplicateCanonicalTopics: Array<{ canonicalTopicKey: string; count: number; titles: string[]; versions: string[] }>;
    documentKinds: Record<DocumentKind, number>;
    sparseCategories: Array<{ category: string; count: number }>;
    qualityPolicy: {
      ok: boolean;
      checks: Array<{
        name: string;
        ok: boolean;
        actual: number;
        threshold: number;
        operator: "gte" | "lte" | "eq";
        detail: string;
      }>;
      failedChecks: string[];
    };
    benchmarkHints: string[];
  recommendations: string[];
}

export interface QueryReportOptions extends SearchOptions {
  expectedTitle?: string;
  expectedId?: string;
  notes?: string;
}

export interface QueryReport {
  generatedAt: string;
  query: string;
  options: QueryReportOptions;
  diagnostics: {
    topResultTitle?: string;
    topResultId?: string;
    pass: boolean;
    warnings: string[];
  };
  results: SearchHit[];
  ranking: RankingExplanation;
  issueMarkdown: string;
}

export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SetupReport {
  ok: boolean;
  packDir: string;
  checks: SetupCheck[];
  codexConfig?: string;
}

export interface DocsRecipe {
  id: string;
  title: string;
  prompt: string;
  tools: string[];
  expectedOutcome: string;
}

export interface TraceEvent {
  timestamp: string;
  tool: string;
  queryFingerprint?: string;
  queryLength?: number;
  queryPreview?: string;
  semanticQueryCount?: number;
  id?: string;
  intent?: DocsIntent;
  topResultId?: string;
  topResultTitle?: string;
  resultCount?: number;
  durationMs: number;
  autoReadApplied?: boolean;
  followedReadCandidateIds?: string[];
  scopeExpansions?: TraceScopeExpansion[];
}

export interface TraceScopeExpansion {
  kind: "version" | "category" | "message-family";
  requestedScope: string;
  usedScope: string;
  topResultId?: string;
  topResultTitle?: string;
  reason: string;
  improvementHint: string;
}

export interface TraceReport {
  enabled: boolean;
  traceFile: string;
  traceFileSizeBytes: number;
  maxBytes: number;
  rotatedFiles: string[];
  omittedEvents: number;
  corruptLines: number;
  events: number;
  byTool: Record<string, number>;
  searchEvents: number;
  searchOnlyRate: number;
  searchThenReadRate: number;
  assistUsageRate: number;
  scopeExpansionCount: number;
  scopeExpansionByKind: Record<string, number>;
  scopeExpansionByRequestedScope: Record<string, number>;
  scopeExpansionFeedback: Array<TraceScopeExpansion & { queryFingerprint?: string; queryPreview?: string; timestamp: string; tool: string }>;
  recent: TraceEvent[];
}
