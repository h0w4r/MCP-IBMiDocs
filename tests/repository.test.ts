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
