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

    expect(result.quality.documents).toBeGreaterThan(1000);
    expect(result.quality.recommendations.length).toBeGreaterThan(0);
    expect(result.recipes.length).toBeGreaterThan(3);
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
