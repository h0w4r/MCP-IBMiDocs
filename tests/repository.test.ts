import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";
import type { SearchHit } from "../src/types.js";

interface GoldenQuery {
  name: string;
  query: string;
  category?: string;
  version?: string;
  mustBeFirstTitle?: string;
  mustContainTitle?: string;
  mustContainTitlePattern?: string;
}

const fixturePath = new URL("./fixtures/golden-queries.json", import.meta.url);
const goldenQueries = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as GoldenQuery[];
const extendedFixturePath = new URL("./fixtures/extended-golden-queries.json", import.meta.url);
const extendedGoldenQueries = JSON.parse(fs.readFileSync(extendedFixturePath, "utf8")) as GoldenQuery[];

function withRepo<T>(callback: (repo: CorpusRepository) => T): T {
  const repo = new CorpusRepository(path.resolve("data", "pack"));
  try {
    return callback(repo);
  } finally {
    repo.close();
  }
}

function titles(results: SearchHit[]): string[] {
  return results.map((result) => result.title);
}

describe("benchmark golden de recuperación documental", () => {
  for (const golden of goldenQueries) {
    it(golden.name, () => {
      const results = withRepo((repo) => repo.search({ query: golden.query, category: golden.category, version: golden.version, limit: 5 }));
      expect(results.length, `Sin resultados para ${golden.query}`).toBeGreaterThan(0);
      const firstTitles = titles(results).slice(0, 3).join("\n");
      if (golden.mustBeFirstTitle) {
        expect(results[0].title).toBe(golden.mustBeFirstTitle);
      }
      if (golden.mustContainTitle) {
        expect(firstTitles).toContain(golden.mustContainTitle);
      }
      if (golden.mustContainTitlePattern) {
        expect(firstTitles).toMatch(new RegExp(golden.mustContainTitlePattern, "i"));
      }
    });
  }

  it("mantiene un benchmark ampliado con cobertura comunitaria", () => {
    expect(extendedGoldenQueries.length).toBeGreaterThanOrEqual(100);
    const sample = extendedGoldenQueries.slice(0, 12);
    const misses = withRepo((repo) => sample.filter((golden) => repo.search({ query: golden.query, category: golden.category, limit: 3 }).length === 0));
    expect(misses).toEqual([]);
  });
});

describe("capacidades agénticas del repositorio", () => {
  it("genera contexto estructurado para SQLRPGLE con comandos, riesgos y evidencia", () => {
    const context = withRepo((repo) => repo.context({
      task: "Crear un programa SQLRPGLE que consulte una tabla física y use includes",
      language: "SQLRPGLE",
      limit: 6
    }));

    expect(context.intent.language).toBe("SQLRPGLE");
    expect(context.compileCommands).toContain("CRTSQLRPGI");
    expect(context.pitfalls.join(" ")).toMatch(/COPY|INCLUDE|precompilador|RPGPPOPT/i);
    expect(context.recommendedDocs.length).toBeGreaterThan(0);
    expect(context.evidence.length).toBeGreaterThan(0);
  });

  it("entrega guía de compilación SQLRPGLE con evidencia trazable", () => {
    const guidance = withRepo((repo) => repo.compileGuidance({
      language: "SQLRPGLE",
      target: "program",
      usesEmbeddedSql: true,
      usesCopybook: true,
      version: "7.6"
    }));

    expect(guidance.recommendedCommands).toContain("CRTSQLRPGI");
    expect(guidance.optionsToReview).toEqual(expect.arrayContaining(["RPGPPOPT", "DBGVIEW"]));
    expect(guidance.evidence.length).toBeGreaterThan(0);
  });

  it("explica mensajes RNF consultando la familia documental correcta", () => {
    const explanation = withRepo((repo) => repo.explainMessage({ messageId: "RNF0004" }));

    expect(explanation.messageId).toBe("RNF0004");
    expect(explanation.category).toBe("mensajes-rnf");
    expect(explanation.evidence[0]?.title).toContain("RPG Messages");
  });

  it("lista categorías y diagnostica integridad del pack", () => {
    const result = withRepo((repo) => ({ categories: repo.categories(), diagnostics: repo.packDiagnostics() }));

    expect(result.categories.categories).toEqual(expect.arrayContaining(["ile-rpg", "cl-clle", "dds", "sql-db2-for-i", "mensajes-rnf"]));
    expect(result.diagnostics.ok).toBe(true);
    expect(result.diagnostics.missingFiles).toBe(0);
    expect(result.diagnostics.longPaths.length).toBe(0);
  });

  it("relaciona un tópico con equivalentes por versión y documentos vecinos", () => {
    const related = withRepo((repo) => repo.related("ibm-730-commands-crtrpgmod-command-7d3ce327", { limit: 8 }));

    expect(related.topic?.title).toContain("CRTRPGMOD");
    expect(related.equivalentVersions.some((doc) => doc.version === "7.4" || doc.version === "7.5" || doc.version === "7.6")).toBe(true);
    expect(related.related.length).toBeGreaterThan(0);
  });

  it("compara un tópico entre versiones IBM i", () => {
    const comparison = withRepo((repo) => repo.compareVersions({ query: "CRTRPGMOD", versions: ["7.3", "7.6"] }));

    expect(comparison.query).toBe("CRTRPGMOD");
    expect(comparison.versions.map((entry) => entry.version)).toEqual(expect.arrayContaining(["7.3", "7.6"]));
    expect(comparison.evidence.length).toBeGreaterThan(0);
  });

  it("devuelve pista de lectura completa porque search solo entrega evidencia resumida", () => {
    const results = withRepo((repo) => repo.search({
      query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      category: "ile-rpg",
      limit: 3,
      includeSections: true
    }));

    expect(results[0]?.title).toBe("SND-MSG (Send a Message to the Joblog)");
    expect(results[0]?.textLength).toBeGreaterThan(results[0]?.snippet.length ?? 0);
    expect(results[0]?.readHint).toContain("ibmi_docs_read");
    expect(results[0]?.taxonomy?.kind).toMatch(/rpg-opcode|rpg-bif|message/);
    expect(results[0]?.sectionsPreview?.length).toBeGreaterThan(0);
  });

  it("soporta auto-read para resultados fuertes sin confundir snippet con contenido completo", () => {
    const results = withRepo((repo) => repo.search({
      query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      category: "ile-rpg",
      limit: 1,
      autoRead: true
    }));

    expect(results[0]?.autoReadApplied).toBe(true);
    expect(results[0]?.fullContent?.length).toBeGreaterThan(1000);
  });

  it("genera respuesta agéntica con citas y evidencia", () => {
    const answer = withRepo((repo) => repo.answer({
      question: "Explica SND-MSG, %MSG y %TARGET",
      language: "RPGLE",
      includeExamples: true,
      limit: 3
    }));

    expect(answer.answer).toContain("Respuesta basada");
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.suggestedTools).toContain("ibmi_docs_read");
  });

  it("explica ranking con FTS, expansión semántica y razones", () => {
    const explanation = withRepo((repo) => repo.explainRanking({
      query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      category: "ile-rpg",
      top: 3
    }));

    expect(explanation.ftsQuery).toContain("snd");
    expect(explanation.semanticQueries.length).toBeGreaterThan(0);
    expect(explanation.results[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("extrae secciones estructurales de tópicos completos", () => {
    const sections = withRepo((repo) => repo.sections("rdi-b314bc2569c3d305"));

    expect(sections.topic?.title).toContain("SND-MSG");
    expect(sections.sections.some((section) => section.kind === "syntax")).toBe(true);
  });

  it("emite reporte de calidad y recetas comunitarias", () => {
    const result = withRepo((repo) => ({ quality: repo.qualityReport(), recipes: repo.recipes() }));

    expect(result.quality.ok).toBe(false);
    expect(result.quality.documents).toBeGreaterThan(1000);
    expect(result.quality.documentKinds.topic).toBeGreaterThan(0);
    expect(result.quality.duplicateCanonicalTopics.length).toBe(0);
    expect(result.quality.recommendations.length).toBeGreaterThan(0);
    expect(result.recipes.length).toBeGreaterThan(3);
  });

  it("genera reportes reproducibles para feedback de ranking", () => {
    const report = withRepo((repo) => repo.reportQuery({
      query: "SND-MSG Send a Message to the Joblog",
      category: "ile-rpg",
      expectedTitle: "SND-MSG",
      limit: 5,
      notes: "Caso de prueba de ranking exacto."
    }));

    expect(report.diagnostics.exactTerms).toContain("snd-msg");
    expect(report.results[0]?.title).toContain("SND-MSG");
    expect(report.issueMarkdown).toContain("Reporte de búsqueda IBM i Docs");
  });

  it("valida código RPGLE/SQLRPGLE contra contexto documental", () => {
    const result = withRepo((repo) => repo.validateCodeContext({
      language: "SQLRPGLE",
      code: "**free\n/copy qrpgleref,mycopy\nexec sql select count(*) into :total from mitabla;\n*inlr = *on;",
      limit: 5
    }));

    expect(result.language).toBe("SQLRPGLE");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("usa fallback canónico version-aware antes que comandos no relacionados", () => {
    const results = withRepo((repo) => repo.search({
      query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      category: "ile-rpg",
      version: "7.5",
      limit: 5,
      includeSections: true
    }));

    expect(results[0]?.title).toContain("SND-MSG");
    expect(results[0]?.requestedVersionFallback).toBe(true);
    expect(results.slice(0, 3).map((hit) => hit.title).join("\n")).not.toMatch(/CRTRPGMOD/i);
    expect(results[0]?.relevanceWarnings?.join(" ")).toMatch(/fallback|No se encontró/i);
  });

  it("no usa evidencia irrelevante al responder consultas exactas", () => {
    const answer = withRepo((repo) => repo.answer({
      question: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      language: "RPGLE",
      version: "7.5",
      limit: 5
    }));

    expect(answer.citations[0]?.title).toContain("SND-MSG");
    expect(answer.citations.map((citation) => citation.title).join("\n")).not.toMatch(/CRTRPGMOD/i);
    expect(answer.warnings.join(" ")).toMatch(/fallback|versión solicitada/i);
  });

  it("resuelve consultas de sintaxis con workflow search-read-sections-answer", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Explica la sintaxis de SND-MSG con %MSG y %TARGET",
      language: "RPGLE",
      version: "7.6",
      limit: 4
    }));

    expect(result.intent).toBe("syntax_lookup");
    expect(result.stages.map((stage) => stage.tool)).toEqual(expect.arrayContaining(["ibmi_docs_search", "ibmi_docs_read", "ibmi_docs_sections", "ibmi_docs_answer"]));
    expect(result.reads.length).toBeGreaterThan(0);
    expect(result.sections.some((topic) => topic.sections.length > 0)).toBe(true);
    expect(result.suggestedTools).toContain("ibmi_docs_read");
  });

  it("resuelve diagnósticos de mensajes con explain_message", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Diagnostica RNF0004 en una compilación RPGLE",
      language: "RPGLE",
      limit: 4
    }));

    expect(result.intent).toBe("message_diagnostic");
    expect(result.messageExplanation?.messageId).toBe("RNF0004");
    expect(result.stages.map((stage) => stage.tool)).toContain("ibmi_docs_explain_message");
  });

  it("no mezcla evidencia genérica cuando un CPF/MCH no tiene entrada documental de mensaje", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Diagnostica CPF0001 en joblog IBM i",
      limit: 4
    }));

    expect(result.intent).toBe("message_diagnostic");
    expect(result.confidence).toBe("baja");
    expect(result.messageExplanation?.messageId).toBe("CPF0001");
    expect(result.messageExplanation?.evidence).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/no se encontró evidencia exacta|No hay evidencia/i);
    expect(JSON.stringify(result)).not.toMatch(/ILE COBOL|IBM Extensions|Simple Insertion Editing/i);
  });

  it("resuelve guía de compilación SQLRPGLE con contexto y compile guidance", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Cómo compilo un programa SQLRPGLE con EXEC SQL y /COPY",
      language: "SQLRPGLE",
      includeCompileCommands: true,
      limit: 5
    }));

    expect(result.intent).toBe("compile_guidance");
    expect(result.context?.compileCommands).toContain("CRTSQLRPGI");
    expect(result.compileGuidance?.recommendedCommands).toContain("CRTSQLRPGI");
    expect(result.stages.map((stage) => stage.tool)).toEqual(expect.arrayContaining(["ibmi_docs_context", "ibmi_docs_compile_guidance"]));
  });

  it("resuelve comparación de versiones con compare_versions", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Compara CRTRPGMOD entre IBM i 7.3 y 7.6",
      limit: 4
    }));

    expect(result.intent).toBe("version_question");
    expect(result.versionComparison?.versions.map((entry) => entry.version)).toEqual(expect.arrayContaining(["7.3", "7.6"]));
    expect(result.stages.map((stage) => stage.tool)).toContain("ibmi_docs_compare_versions");
  });

  it("search recomienda siguiente tool y auto-lee comandos exactos fuertes", () => {
    const results = withRepo((repo) => repo.search({
      query: "CRTRPGMOD command",
      version: "7.6",
      limit: 2,
      includeSections: true
    }));

    expect(results[0]?.title).toContain("CRTRPGMOD");
    expect(results[0]?.nextRecommendedTool).toBe("ibmi_docs_read");
    expect(results[0]?.nextRecommendedArguments).toMatchObject({ id: results[0]?.id });
    expect(results[0]?.autoReadApplied).toBe(true);
    expect(results[0]?.fullContent?.length).toBeGreaterThan(1000);
  });

  it("detecta comandos CL comunes sin recomendar lenguajes inválidos", () => {
    const results = withRepo((repo) => repo.search({
      query: "SBMJOB command",
      limit: 5
    }));

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((hit) => `${hit.title} ${hit.snippet}`.includes("SBMJOB"))).toBe(true);
    const serializedArgs = JSON.stringify(results.map((hit) => hit.nextRecommendedArguments ?? {}));
    expect(serializedArgs).not.toContain("SBMJOB COMMAND");
    expect(serializedArgs).toMatch(/CLLE|ibmi_docs_sections|id/);
  });

  it("registra trazas opcionales y calcula tasas de uso", () => {
    const traceFile = path.resolve("data", "test-trace.ndjson");
    const previousTrace = process.env.IBMI_DOCS_TRACE;
    const previousTraceFile = process.env.IBMI_DOCS_TRACE_FILE;
    if (fs.existsSync(traceFile)) fs.unlinkSync(traceFile);
    process.env.IBMI_DOCS_TRACE = "1";
    process.env.IBMI_DOCS_TRACE_FILE = traceFile;
    try {
      const report = withRepo((repo) => {
        const hits = repo.search({ query: "SND-MSG", version: "7.6", limit: 1 });
        if (hits[0]) repo.read(hits[0].id);
        repo.answer({ question: "Explica SND-MSG", language: "RPGLE", limit: 2 });
        repo.resolve({ question: "Explica RNF0004", language: "RPGLE", limit: 2 });
        return repo.traceReport(20);
      });

      expect(report.enabled).toBe(true);
      expect(report.events).toBeGreaterThanOrEqual(4);
      expect(report.byTool.ibmi_docs_search).toBeGreaterThan(0);
      expect(report.byTool.ibmi_docs_answer).toBeGreaterThan(0);
      expect(report.byTool.ibmi_docs_resolve).toBeGreaterThan(0);
      expect(report.searchThenReadRate).toBeGreaterThanOrEqual(0);
    } finally {
      if (previousTrace === undefined) delete process.env.IBMI_DOCS_TRACE;
      else process.env.IBMI_DOCS_TRACE = previousTrace;
      if (previousTraceFile === undefined) delete process.env.IBMI_DOCS_TRACE_FILE;
      else process.env.IBMI_DOCS_TRACE_FILE = previousTraceFile;
      if (fs.existsSync(traceFile)) fs.unlinkSync(traceFile);
    }
  });
});

describe("curación y distribución del data pack", () => {
  it("normaliza versiones anómalas fuera del conjunto soportado", () => {
    const diagnostics = withRepo((repo) => repo.diagnostics()) as { coverage: { byVersion: Record<string, number> } };
    expect(Object.keys(diagnostics.coverage.byVersion)).not.toContain("9");
  });

  it("separa el data pack del paquete npm para publicarlo como release asset", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
    expect(packageJson.files).not.toContain("data/pack");
  });
});
