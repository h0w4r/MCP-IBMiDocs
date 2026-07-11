import { describe, expect, it } from "vitest";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";

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
  it("searchSmart usa recuperación neuronal multi-perspectiva y recupera el comando para invocar RLU", async () => {
    const results = await withRepo((repo) => repo.searchSmart({
      query: "What is the command used to invoke RLU?",
      limit: 10
    }));

    const corpus = results.map((hit) => `${hit.title}\n${hit.snippet}`).join("\n\n");
    expect(corpus).toMatch(/STRRLU|Start Report Layout Utility/i);
    expect(results[0]?.matchReasons?.join(" ")).toContain("Transformers.js");
  });

  it("assistSmart sintetiza la respuesta RLU desde evidencia documental materializada", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
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

  it("searchSmart recupera comandos y tópicos técnicos con embeddings Transformers", async () => {
    const results = await withRepo((repo) => repo.searchSmart({ query: "CRTRPGMOD", limit: 5 }));

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toContain("CRTRPGMOD");
    expect(results[0]?.matchReasons?.join(" ")).toContain("Transformers.js");
  });

  it("searchSmart encuentra documentación SQLRPGLE de /COPY con SQL embebido", async () => {
    const results = await withRepo((repo) => repo.searchSmart({ query: "Using /COPY embedded SQL", limit: 5 }));

    expect(results.some((hit) => hit.title.includes("/COPY") && hit.category === "sql-db2-for-i")).toBe(true);
    expect(results.every((hit) => typeof hit.score === "number" && hit.score > 0)).toBe(true);
  });

  it("searchSmart amplía versión cuando el scope solicitado tiene evidencia vectorial más débil", async () => {
    const results = await withRepo((repo) => repo.searchSmart({
      query: "job scheduler entries work management scheduled jobs",
      version: "7.5",
      limit: 5
    }));

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((hit) => hit.requestedVersionScopeExpansion)).toBe(true);
    expect(results.map((hit) => hit.title).join("\n")).toMatch(/job|scheduler|work management/i);
  });

  it("assistSmart materializa evidencia, lecturas, secciones, citas y workflow sin pedir sub-tools", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
      question: "Cómo compilo SQLRPGLE con EXEC SQL y copybooks?",
      language: "SQLRPGLE",
      version: "7.5",
      depth: "standard",
      limit: 5
    }));

    expect(assist.taskPlan.family).toBe("neural_retrieval");
    expect(assist.retrievalPlan.strategy).toBe("multi-hop");
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
    expect(assist.answer).not.toMatch(/Citas|Score:|ID:|retrievalPlan|taskPlan/i);
  });

  it("assistSmart responde consultas de tipo hora con evidencia Db2 for i relacionada", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
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

  it("assistSmart resuelve la equivalencia CL de EXFMT desde la ayuda completa del comando", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
      question: "In CL which command is equivalent to EXFMT?",
      language: "CLLE"
    }));

    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/SNDRCVF|Send\/Receive File/i);
    expect(assist.answer).not.toMatch(/EXPORTFS|Performance Explorer/i);
  });

  it("assistSmart conserva varias evidencias cuando la consulta contiene dos conceptos", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
      question: "Explain WRKOBJPDM and DSPOBJD",
      language: "CLLE",
      depth: "deep"
    }));

    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/WRKOBJPDM/i);
    expect(assist.answer).toMatch(/DSPOBJD/i);
  });

  it("assistSmart distingue copiar registros de duplicar un objeto", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
      question: "How do I copy records from an existing IBM i file into another file?",
      language: "CLLE"
    }));

    expect(assist.confidence).not.toBe("baja");
    expect(assist.answer).toMatch(/CPYF|Copy File/i);
    expect(assist.answer).not.toMatch(/CRTDUPOBJ.*only|only.*CRTDUPOBJ/i);
  });

  it("rechaza semánticamente una consulta ajena al corpus sin inventar una respuesta IBM i", async () => {
    const assist = await withRepo((repo) => repo.assistSmart({
      question: "Evalúa si una herramienta MCP debe devolver JSON o solo respuesta final",
      depth: "concise"
    }));

    expect(assist.relevance.supported).toBe(false);
    expect(assist.confidence).toBe("baja");
    expect(assist.answer).toMatch(/No encontré evidencia documental suficientemente relacionada/i);
    expect(assist.answer).not.toMatch(/DDS8196|Workstation I\/O|SQL messages/i);
  });

  it("las APIs síncronas antiguas no ejecutan búsqueda no neuronal", async () => {
    await withRepo(async (repo) => {
      expect(() => repo.search({ query: "CRTRPGMOD" })).toThrow(/searchSmart/);
      const assist = repo.assist({ question: "CRTRPGMOD" });
      expect(assist.taskPlan.family).toBe("neural_retrieval");
      expect(assist.answer).toMatch(/assistSmart|ibmi_docs_assist/);
    });
  });

  it("diagnostics, categories, read y sections siguen operativos sin RDi runtime", async () => {
    await withRepo(async (repo) => {
      const diagnostics = repo.diagnostics();
      const categories = repo.categories();
      const search = await repo.searchSmart({ query: "CRTRPGMOD", limit: 1 });
      const read = repo.read(search[0].id);
      const sections = repo.sections(search[0].id);

      expect(diagnostics.runtimeDependency).toContain("Sin RDi");
      expect(categories.categories.length).toBeGreaterThan(0);
      expect(read?.content.length).toBeGreaterThan(0);
      expect(sections.sections.length).toBeGreaterThan(0);
    });
  });
});
