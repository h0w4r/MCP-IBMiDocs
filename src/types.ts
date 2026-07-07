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
  strictCategory?: boolean;
}

export type DocsIntent =
  | "explain_topic"
  | "multi_intent"
  | "syntax_lookup"
  | "compile_guidance"
  | "message_diagnostic"
  | "code_review"
  | "version_question"
  | "ranking_debug"
  | "search_discovery";

export interface WorkflowStage {
  tool: string;
  reason: string;
  status: "planned" | "executed" | "skipped";
  evidenceIds?: string[];
  outputSummary?: string;
}

export interface NextToolRecommendation {
  tool: string;
  reason: string;
  arguments: Record<string, unknown>;
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
  readHint?: string;
  taxonomy?: TopicTaxonomy;
  semanticScore?: number;
  matchReasons?: string[];
  sectionsPreview?: TopicSection[];
  autoReadApplied?: boolean;
  fullContent?: string;
  nextRecommendedTool?: string;
  nextRecommendedReason?: string;
  nextRecommendedArguments?: Record<string, unknown>;
  workflowHints?: string[];
  documentKind?: DocumentKind;
  canonicalTopicKey?: string;
  relevanceWarnings?: string[];
  requestedVersionScopeExpansion?: boolean;
  requestedCategoryScopeExpansion?: boolean;
  messageFamilyScopeExpansion?: boolean;
  /** @deprecated Use requestedVersionScopeExpansion. */
  requestedVersionFallback?: boolean;
  /** @deprecated Use requestedCategoryScopeExpansion. */
  requestedCategoryFallback?: boolean;
  /** @deprecated Use messageFamilyScopeExpansion. */
  messageFamilyFallback?: boolean;
  synthetic?: boolean;
}

export interface ReadResult extends SearchHit {
  content: string;
  textLength: number;
  sha256: string;
  sections?: TopicSection[];
}

export interface ContextOptions {
  task: string;
  query?: string;
  language?: string;
  limit?: number;
  version?: string;
  ibmiVersion?: string;
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

export interface ContextPackage {
  task: string;
  intent: {
    language: string;
    category?: string;
    detectedSignals: string[];
    queries: string[];
  };
  answer: string;
  appliedWorkflow: WorkflowStage[];
  recommendedDocs: SearchHit[];
  compileCommands: string[];
  optionsToReview: string[];
  pitfalls: string[];
  actionItems: string[];
  versionNotes: string[];
  evidence: SearchHit[];
  reads: ContextReadSummary[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  citations: AnswerCitation[];
  warnings: string[];
}

export interface CompileGuidanceOptions {
  language: string;
  target?: "module" | "program" | "service-program" | "file" | string;
  usesEmbeddedSql?: boolean;
  usesCopybook?: boolean;
  version?: string;
  limit?: number;
}

export interface CompileGuidance {
  language: string;
  target: string;
  recommendedCommands: string[];
  relatedCommands: string[];
  optionsToReview: string[];
  pitfalls: string[];
  evidence: SearchHit[];
}

export interface ExplainMessageOptions {
  messageId: string;
  limit?: number;
}

export interface MessageExplanation {
  messageId: string;
  family: string;
  category: string;
  summary: string;
  recoveryChecklist: string[];
  evidence: SearchHit[];
  specificMatch?: boolean;
  coverageStatus?: "specific" | "family" | "unsupported";
  warnings?: string[];
}

export interface RelatedOptions {
  limit?: number;
}

export interface RelatedDocuments {
  topic: ReadResult | null;
  equivalentVersions: SearchHit[];
  related: SearchHit[];
}

export interface CompareVersionsOptions {
  query: string;
  versions: string[];
  category?: string;
  limit?: number;
}

export interface VersionComparisonEntry {
  version: string;
  found: boolean;
  result?: SearchHit;
  notes: string[];
}

export interface VersionComparison {
  query: string;
  versions: VersionComparisonEntry[];
  evidence: SearchHit[];
}

export interface CodeValidationOptions {
  language: string;
  code: string;
  limit?: number;
}

export interface CodeValidationFinding {
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  evidenceIds: string[];
}

export interface CodeValidationResult {
  language: string;
  detectedSignals: string[];
  findings: CodeValidationFinding[];
  evidence: SearchHit[];
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
  missingFiles: number;
  checkedFiles: number;
  longPaths: string[];
  anomalies: string[];
  runtimeDependency: string;
}


export interface AnswerOptions {
  question: string;
  query?: string;
  language?: string;
  version?: string;
  ibmiVersion?: string;
  category?: string;
  includeExamples?: boolean;
  includeCompileCommands?: boolean;
  limit?: number;
}

export interface AnswerCitation {
  id: string;
  title: string;
  version: string;
  sourceKind: SourceKind;
  canonicalUrl: string;
  section?: string;
}

export interface AnswerResult {
  question: string;
  answer: string;
  confidence: "alta" | "media" | "baja";
  citations: AnswerCitation[];
  evidence: SearchHit[];
  warnings: string[];
  suggestedTools: string[];
}

export interface WorkflowPolicy {
  intent: DocsIntent;
  preferredTools: string[];
  requiredEvidence: string[];
  defaultLimit: number;
  description: string;
}

export interface ResolveOptions {
  question: string;
  query?: string;
  language?: string;
  version?: string;
  ibmiVersion?: string;
  category?: string;
  code?: string;
  includeExamples?: boolean;
  includeCompileCommands?: boolean;
  limit?: number;
}

export interface ResolveResult {
  question: string;
  intent: DocsIntent;
  policy: WorkflowPolicy;
  answer: string;
  confidence: "alta" | "media" | "baja";
  stages: WorkflowStage[];
  evidence: SearchHit[];
  reads: ReadResult[];
  sections: Array<{ id: string; title: string; sections: TopicSection[] }>;
  citations: AnswerCitation[];
  answerResult?: AnswerResult;
  context?: ContextPackage;
  compileGuidance?: CompileGuidance;
  messageExplanation?: MessageExplanation;
  versionComparison?: VersionComparison;
  rankingExplanation?: RankingExplanation;
  codeValidation?: CodeValidationResult;
  related?: RelatedDocuments;
  suggestedTools: string[];
  warnings: string[];
}

export type AssistDepth = "concise" | "standard" | "deep";

export type AssistAudience = "agent" | "developer" | "maintainer";

export interface AssistOptions {
  question: string;
  query?: string;
  language?: string;
  version?: string;
  ibmiVersion?: string;
  category?: string;
  code?: string;
  depth?: AssistDepth;
  audience?: AssistAudience;
  includeExamples?: boolean;
  includeCompileCommands?: boolean;
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
  | "syntax"
  | "compile"
  | "message"
  | "version"
  | "code"
  | "related"
  | "administration"
  | "database"
  | "datatype"
  | "gap-followup";

export type AssistTaskFamily =
  | "create_program"
  | "fix_compile_error"
  | "fix_runtime_error"
  | "code_review"
  | "design_dds_file"
  | "design_display_or_report"
  | "command_lookup"
  | "work_management"
  | "object_lock_analysis"
  | "db2_catalog_query"
  | "date_time_conversion"
  | "message_diagnostic"
  | "version_check"
  | "general_explanation";

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
  strategy: "single-pass" | "multi-hop";
  axes: AssistRetrievalAxis[];
  initialQueries: string[];
  followUpQueries: string[];
  hops: AssistRetrievalHop[];
  coverageGaps: string[];
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
  semanticProfile: {
    concepts: string[];
    intentHints: string[];
  };
  semanticQueries: string[];
  results: RankingExplanationItem[];
}

export interface QualityReport {
  ok: boolean;
  generatedAt: string;
  corpusVersion: string;
  documents: number;
  chunks: number;
  coverage: CategoryDiagnostics;
  shortDocuments: Array<{ id: string; title: string; textLength: number; category: string; version: string }>;
  duplicateTitles: Array<{ title: string; count: number; versions: string[] }>;
  duplicateTitlesSameVersion?: Array<{ title: string; count: number; version: string; categories: string[] }>;
  duplicateTitlesCrossVersionExpected?: Array<{ title: string; count: number; versions: string[] }>;
  duplicateCanonicalTopics: Array<{ canonicalTopicKey: string; count: number; titles: string[]; versions: string[] }>;
  documentKinds: Record<DocumentKind, number>;
  sparseCategories: Array<{ category: string; count: number }>;
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
    semanticConcepts: string[];
    semanticIntentHints: string[];
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
  query?: string;
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
  answerUsageRate: number;
  resolveUsageRate: number;
  scopeExpansionCount: number;
  scopeExpansionByKind: Record<string, number>;
  scopeExpansionByRequestedScope: Record<string, number>;
  scopeExpansionFeedback: Array<TraceScopeExpansion & { query?: string; timestamp: string; tool: string }>;
  recent: TraceEvent[];
}
