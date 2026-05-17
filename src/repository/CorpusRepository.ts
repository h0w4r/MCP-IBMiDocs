import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
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
  ExplainMessageOptions,
  MessageExplanation,
  PackDiagnostics,
  ReadResult,
  RelatedDocuments,
  RelatedOptions,
  SearchHit,
  SearchOptions,
  VersionComparison
} from "../types.js";
import { clamp } from "../util/common.js";

const SUPPORTED_VERSIONS = ["7.3", "7.4", "7.5", "7.6", "RDi-local"];

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
    const limit = clamp(options.limit, 8, 1, 50);
    const fts = toFtsQuery(options.query);
    if (!fts) return [];
    const filters: string[] = [];
    const params: Record<string, string | number> = { fts, limit: Math.max(limit * 16, 80) };
    if (options.version) {
      filters.push("d.version = @version");
      params.version = normalizeVersionInput(options.version);
    }
    if (options.category) {
      filters.push("d.category = @category");
      params.category = options.category;
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const sql = `
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url,
             d.breadcrumbs_json, c.body, c.chunk_index, bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH @fts ${where}
      ORDER BY rank ASC
      LIMIT @limit
    `;
    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    const bestByDocument = new Map<string, SearchHit>();
    for (const row of rows) {
      const hit = rowToHit(row, options.query);
      hit.score = scoreHit(hit, String(row.body), Number(row.rank ?? 0), options, Number(row.chunk_index ?? 0));
      const existing = bestByDocument.get(hit.id);
      if (!existing || hit.score > existing.score) bestByDocument.set(hit.id, hit);
    }
    return [...bestByDocument.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  read(id: string): ReadResult | null {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const textPath = path.join(this.packDir, String(row.normalized_text_path));
    const content = fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8") : "";
    return {
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
      sha256: String(row.sha256)
    };
  }

  context(options: ContextOptions): ContextPackage {
    const preset = resolvePreset(options.language ?? options.task);
    const detectedSignals = detectSignals(options.task, options.language, preset);
    const queries = [...new Set([options.task, ...(preset?.queries ?? [])].filter(Boolean))];
    const hits = this.searchMany(queries, { category: preset?.category, version: options.version, limit: options.limit ?? 8 });
    return {
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
  }

  compileGuidance(options: CompileGuidanceOptions): CompileGuidance {
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
    return {
      language: preset.language,
      target: options.target ?? "program",
      recommendedCommands,
      relatedCommands: preset.relatedCommands,
      optionsToReview,
      pitfalls: preset.pitfalls,
      evidence
    };
  }

  explainMessage(options: ExplainMessageOptions): MessageExplanation {
    const messageId = options.messageId.trim().toUpperCase();
    const family = messageId.match(/^[A-Z]+/)?.[0] ?? "MESSAGE";
    const category = family === "RNF" ? "mensajes-rnf" : family === "SQL" ? "sql-db2-for-i" : "ibm-i-general";
    const evidence = this.search({ query: messageId, category, limit: options.limit ?? 6 });
    return {
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

  related(id: string, options: RelatedOptions = {}): RelatedDocuments {
    const topic = this.read(id);
    if (!topic) return { topic: null, equivalentVersions: [], related: [] };
    const equivalentVersions = this.findEquivalentVersions(topic).filter((hit) => hit.id !== id);
    const relatedQuery = [topic.title, topic.breadcrumbs.slice(-3).join(" ")].filter(Boolean).join(" ");
    const related = this.search({ query: relatedQuery, category: topic.category, limit: options.limit ?? 8 }).filter((hit) => hit.id !== id);
    return { topic, equivalentVersions, related };
  }

  compareVersions(options: CompareVersionsOptions): VersionComparison {
    const versions = options.versions.map((version) => normalizeVersionInput(version));
    const evidence: SearchHit[] = [];
    const entries = versions.map((version) => {
      const result = this.search({ query: options.query, version, category: options.category, limit: options.limit ?? 5 })[0];
      if (result) evidence.push(result);
      return {
        version,
        found: Boolean(result),
        result,
        notes: result ? [`Encontrado: ${result.title} (${result.sourceKind})`] : ["No se encontró tópico equivalente para esta versión."]
      };
    });
    return { query: options.query, versions: entries, evidence };
  }

  validateCodeContext(options: CodeValidationOptions): CodeValidationResult {
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
    return { language: preset?.language ?? normalizeLanguage(options.language) ?? options.language, detectedSignals, findings, evidence };
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
      SELECT d.id, d.title, d.source_kind, d.source_id, d.version, d.category, d.canonical_url,
             d.breadcrumbs_json, c.body, c.chunk_index, 0 AS rank
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
      WHERE lower(d.title) = lower(@title)
      ORDER BY d.version
      LIMIT 20
    `).all({ title: topic.title }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...rowToHit(row, topic.title), score: 5 }));
  }
}

export function toFtsQuery(query: string): string {
  const tokens = tokenize(query).slice(0, 16);
  const expanded = expandIbmiTerms(tokens);
  // Cada token se escapa y se consulta como frase para evitar inyección FTS; todo entra por parámetro preparado.
  return [...new Set(expanded)].map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
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
  return {
    id: String(row.id),
    title: String(row.title),
    snippet: makeSnippet(String(row.body ?? ""), query, 520),
    score: 0,
    sourceKind: String(row.source_kind) as SearchHit["sourceKind"],
    sourceId: String(row.source_id),
    version: String(row.version),
    category: String(row.category),
    canonicalUrl: String(row.canonical_url),
    breadcrumbs: JSON.parse(String(row.breadcrumbs_json || "[]")) as string[]
  };
}

function scoreHit(hit: SearchHit, body: string, rank: number, options: SearchOptions, chunkIndex: number): number {
  const queryTokens = tokenize(options.query);
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

function tokenize(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}_#$@.\/+%-]{2,}/gu) ?? [];
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
