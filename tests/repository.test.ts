import { describe, expect, it } from "vitest";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";
import { MAX_CODE_CHARS, MAX_QUESTION_CHARS } from "../src/util/inputLimits.js";

const PACK_DIR = "data/pack";

async function withRepo<T>(callback: (repo: CorpusRepository) => Promise<T>): Promise<T> {
  const repo = new CorpusRepository(PACK_DIR);
  try {
    return await callback(repo);
  } finally {
    repo.close();
  }
}

describe("CorpusRepository neural-only", () => {
  it("rechaza entradas desproporcionadas antes de invocar Transformers", async () => {
    await withRepo(async (repo) => {
      await expect(repo.search({ query: "x".repeat(MAX_QUESTION_CHARS + 1) }))
        .rejects.toThrow(/máximo permitido/i);
      await expect(repo.assist({ question: "consulta válida", code: "x".repeat(MAX_CODE_CHARS + 1) }))
        .rejects.toThrow(/máximo permitido/i);
    });
  });

  it("search usa recuperación neuronal multi-perspectiva y recupera el comando para invocar RLU", async () => {
    const results = await withRepo((repo) => repo.search({
      query: "What is the command used to invoke RLU?",
      limit: 10
    }));

    const corpus = results.map((hit) => `${hit.title}\n${hit.snippet}`).join("\n\n");
    expect(corpus).toMatch(/STRRLU|Start Report Layout Utility/i);
    expect(results[0]?.matchReasons?.join(" ")).toContain("Transformers.js");
  });

  it("assist sintetiza la respuesta RLU desde evidencia documental materializada", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "What is the command used to invoke RLU?",
      language: "CL",
      depth: "deep",
      limit: 8
    }));

    const answerCorpus = [
      assist.answer,
      assist.specificFindings.join("\n"),
      assist.evidence.map((hit) => `${hit.title} ${hit.snippet}`).join("\n"),
      assist.reads.map((read) => `${read.title} ${read.excerpt}`).join("\n")
    ].join("\n");

    expect(answerCorpus).toMatch(/STRRLU|Start Report Layout Utility/i);
    expect(assist.confidence).not.toBe("baja");
    expect(assist.workflow.map((stage) => stage.tool)).toEqual(expect.arrayContaining([
      "ibmi_docs_neural_retrieval",
      "ibmi_docs_read",
      "ibmi_docs_sections"
    ]));
  });

  it("diagnostics reporta cobertura vectorial completa del corpus indexado", async () => {
    await withRepo(async (repo) => {
      const diagnostics = repo.diagnostics() as {
        vectorCoverage?: {
          ok: boolean;
          documents: number;
          chunks: number;
          vectors: number;
          documentVectors: number;
          documentsWithoutChunks: number;
          documentsWithoutVectors: number;
          chunksWithoutVectors: number;
        };
      };

      expect(diagnostics.vectorCoverage?.ok).toBe(true);
      expect(diagnostics.vectorCoverage?.documents).toBeGreaterThan(0);
      expect(diagnostics.vectorCoverage?.chunks).toBeGreaterThanOrEqual(diagnostics.vectorCoverage?.documents ?? 0);
      expect(diagnostics.vectorCoverage?.vectors).toBe(diagnostics.vectorCoverage?.chunks);
      expect(diagnostics.vectorCoverage?.documentVectors).toBe(diagnostics.vectorCoverage?.documents);
      expect(diagnostics.vectorCoverage?.documentsWithoutChunks).toBe(0);
      expect(diagnostics.vectorCoverage?.documentsWithoutVectors).toBe(0);
      expect(diagnostics.vectorCoverage?.chunksWithoutVectors).toBe(0);
    });
  });

  it("qualityReport calcula duplicados, categorías escasas e integridad real", async () => {
    await withRepo(async (repo) => {
      const report = repo.qualityReport();
      expect(report.ok).toBe(true);
      expect(report.vectorCoverage?.ok).toBe(true);
      expect(report.duplicateTitles.length).toBeGreaterThan(0);
      expect(report.duplicateTitlesCrossVersionExpected?.length).toBeGreaterThan(0);
      expect(report.sparseCategories.some((item) => item.category === "ibm-i-general")).toBe(true);
      expect(report.qualityPolicy.ok).toBe(true);
      expect(report.qualityPolicy.failedChecks).toEqual([]);
      expect(report.qualityPolicy.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
        "integridad-vectorial-y-fisica",
        "duplicados-exactos-misma-version",
        "categorias-coherentes-con-manifest",
        "categorias-con-cobertura-sustancial",
        "tasa-maxima-stubs",
        "cobertura-ibm-i-7.6"
      ]));
    });
  });

  it("search recupera comandos y tópicos técnicos con embeddings Transformers", async () => {
    const results = await withRepo((repo) => repo.search({ query: "CRTRPGMOD", limit: 5 }));

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toContain("CRTRPGMOD");
    expect(results[0]?.matchReasons?.join(" ")).toContain("Transformers.js");
  });

  it("search encuentra documentación SQLRPGLE de /COPY con SQL embebido", async () => {
    const results = await withRepo((repo) => repo.search({ query: "Using /COPY embedded SQL", limit: 5 }));

    expect(results.some((hit) => hit.title.includes("/COPY") && hit.category === "sql-db2-for-i")).toBe(true);
    expect(results.every((hit) => typeof hit.score === "number" && hit.score > 0)).toBe(true);
  });

  it("search amplía versión cuando el scope solicitado tiene evidencia vectorial más débil", async () => {
    const results = await withRepo((repo) => repo.search({
      query: "job scheduler entries work management scheduled jobs",
      version: "7.5",
      limit: 5
    }));

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((hit) => hit.requestedVersionScopeExpansion)).toBe(true);
    expect(results.map((hit) => hit.title).join("\n")).toMatch(/job|scheduler|work management/i);
  });

  it("assist materializa evidencia, lecturas, secciones, citas y workflow sin pedir sub-tools", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "Cómo compilo SQLRPGLE con EXEC SQL y copybooks?",
      language: "SQLRPGLE",
      version: "7.5",
      depth: "standard",
      limit: 5
    }));

    expect(assist.taskPlan.family).toBe("neural_retrieval");
    expect(assist.retrievalPlan.strategy).toBe("single-pass");
    expect(assist.retrievalPlan.axes).toContain("semantic-variant");
    expect(assist.evidence.length).toBeGreaterThan(0);
    expect(assist.reads.length).toBeGreaterThan(0);
    expect(assist.citations.length).toBeGreaterThan(0);
    expect(assist.workflow.map((stage) => stage.tool)).toEqual(expect.arrayContaining([
      "ibmi_docs_neural_retrieval",
      "ibmi_docs_neural_reranker",
      "ibmi_docs_read",
      "ibmi_docs_sections"
    ]));
    expect(assist.relevance.supported).toBe(true);
    expect(assist.retrievalPlan.initialQueries.join("\n")).toContain("Language or environment hint: SQLRPGLE");
    expect(assist.answer).not.toMatch(/Citas|Score:|ID:|retrievalPlan|taskPlan/i);
  });

  it("assist responde consultas de tipo hora con evidencia Db2 for i relacionada", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "Qué tipo de dato conviene para almacenar horas en una tabla Db2 for i?",
      language: "SQL",
      version: "7.5",
      limit: 5
    }));

    const evidenceText = assist.evidence.map((hit) => `${hit.title} ${hit.category}`).join("\n");
    expect(evidenceText).toMatch(/Time|Data types|Datetime|sql-db2-for-i/i);
    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/\bTIME(?:STAMP)?\b/i);
    expect(assist.answer).not.toMatch(/Estimated time/i);
  });

  it("assist resuelve la equivalencia CL de EXFMT desde la ayuda completa del comando", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "In CL which command is equivalent to EXFMT?",
      language: "CLLE"
    }));

    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/SNDRCVF|Send\/Receive File/i);
    expect(assist.answer).not.toMatch(/EXPORTFS|Performance Explorer/i);
  });

  it("assist conserva varias evidencias cuando la consulta contiene dos conceptos", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "Explain WRKOBJPDM and DSPOBJD",
      language: "CLLE",
      depth: "deep"
    }));

    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/WRKOBJPDM/i);
    expect(assist.answer).toMatch(/DSPOBJD/i);
  });

  it("assist distingue copiar registros de duplicar un objeto", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "How do I copy records from an existing IBM i file into another file?",
      language: "CLLE"
    }));

    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/CPYF|Copy File/i);
    expect(assist.answer).not.toMatch(/CRTDUPOBJ.*only|only.*CRTDUPOBJ/i);
  });

  it("rechaza semánticamente una consulta ajena al corpus sin inventar una respuesta IBM i", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "Evalúa si una herramienta MCP debe devolver JSON o solo respuesta final",
      depth: "concise"
    }));

    expect(assist.relevance.supported).toBe(false);
    expect(assist.confidence).toBe("baja");
    expect(assist.answer).toMatch(/No encontré evidencia documental suficientemente relacionada/i);
    expect(assist.answer).not.toMatch(/DDS8196|Workstation I\/O|SQL messages/i);
  });

  it("acepta evidencia fuerte del mismo tópico aunque el consenso elija otro pasaje", async () => {
    const assist = await withRepo((repo) => repo.assist({
      question: "What are the different types of locks that can be held? What is meant by locking and concurrency?",
      depth: "concise"
    }));

    expect(assist.relevance.supported).toBe(true);
    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/Locking|locks|commit|rollback/i);
  });

  it("la API pública usa un único núcleo asíncrono neuronal", async () => {
    await withRepo(async (repo) => {
      const search = await repo.search({ query: "CRTRPGMOD", limit: 1 });
      const assist = await repo.assist({ question: "CRTRPGMOD", depth: "concise" });
      expect(search[0]?.title).toContain("CRTRPGMOD");
      expect(assist.taskPlan.family).toBe("neural_retrieval");
      expect(assist.relevance.supported).toBe(true);
    });
  });

  it("diagnostics, categories, read y sections siguen operativos sin RDi runtime", async () => {
    await withRepo(async (repo) => {
      const diagnostics = repo.diagnostics();
      const categories = repo.categories();
      const search = await repo.search({ query: "CRTRPGMOD", limit: 1 });
      const read = repo.read(search[0].id);
      const sections = repo.sections(search[0].id);

      expect(diagnostics.runtimeDependency).toContain("Sin RDi");
      expect(categories.categories.length).toBeGreaterThan(0);
      expect(read?.content.length).toBeGreaterThan(0);
      expect(sections.sections.length).toBeGreaterThan(0);
    });
  });
});
