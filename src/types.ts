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

export interface SearchOptions {
  query: string;
  version?: string;
  category?: string;
  limit?: number;
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
}

export interface ReadResult extends SearchHit {
  content: string;
  textLength: number;
  sha256: string;
}

export interface ContextOptions {
  task: string;
  language?: string;
  limit?: number;
  version?: string;
}

export interface ContextPackage {
  task: string;
  intent: {
    language: string;
    category?: string;
    detectedSignals: string[];
    queries: string[];
  };
  recommendedDocs: SearchHit[];
  compileCommands: string[];
  optionsToReview: string[];
  pitfalls: string[];
  versionNotes: string[];
  evidence: SearchHit[];
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
