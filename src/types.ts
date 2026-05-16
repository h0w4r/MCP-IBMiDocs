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
}

export interface ReadResult extends SearchHit {
  content: string;
  textLength: number;
  sha256: string;
}
