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
  mustHaveResults?: boolean;
  required?: boolean;
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

  it("context auto-orquesta lectura y secciones sin delegar siguientes llamadas al agente", () => {
    const context = withRepo((repo) => repo.context({
      task: "Corregir un programa CLLE que usa RTVJOBA y MONMSG para recuperar atributos del trabajo y manejar errores CPF/MCH. Necesito sintaxis, parámetros relevantes y pasos concretos para modificar el código.",
      language: "CLLE",
      version: "7.5",
      limit: 5
    })) as any;

    expect(context.intent.language).toBe("CLLE");
    expect(context.appliedWorkflow.map((stage: { tool: string }) => stage.tool)).toEqual(expect.arrayContaining([
      "ibmi_docs_search",
      "ibmi_docs_read",
      "ibmi_docs_sections"
    ]));
    expect(context.reads.length).toBeGreaterThan(0);
    expect(context.sections.some((topic: { sections: unknown[] }) => topic.sections.length > 0)).toBe(true);
    expect(context.answer).toMatch(/RTVJOBA|MONMSG|CLLE|par[aá]metros|sintaxis/i);

    const materializedTitles = [
      ...context.recommendedDocs.map((doc: { title: string }) => doc.title),
      ...context.reads.map((read: { title: string }) => read.title),
      ...context.sections.map((topic: { title: string }) => topic.title)
    ].join("\n");
    expect(materializedTitles).toMatch(/RTVJOBA/i);
    expect(materializedTitles).toMatch(/MONMSG|Monitor Message/i);
    expect(materializedTitles).not.toMatch(/MONITOR command/i);
    expect(context.intent.queries.join("\n")).not.toMatch(/RELEVANTES command|MONITOR command/i);

    const serializedContext = JSON.stringify(context);
    expect(serializedContext).not.toContain("nextRecommendedTool");
    expect(serializedContext).not.toContain("nextRecommendedArguments");
    expect(serializedContext).not.toContain("readHint");
    expect(serializedContext).not.toMatch(/Para obtener la ayuda completa llama|Si necesitas sintaxis|Siguiente paso recomendado/i);
  });

  it("assist entrega una respuesta final específica y no delega llamadas adicionales al agente", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Corregir un programa CLLE que usa RTVJOBA para recuperar atributos del trabajo y MONMSG para manejar CPF/MCH. Necesito sintaxis, parámetros relevantes, pasos de cambio y validación.",
      language: "CLLE",
      version: "7.5",
      depth: "deep",
      audience: "agent",
      includeExamples: true,
      includeCompileCommands: true,
      limit: 6
    }));

    expect(assist.intent).toMatch(/compile_guidance|code_review|multi_intent|syntax_lookup|explain_topic/);
    expect(assist.answer).toMatch(/Resumen directo/i);
    expect(assist.answer).toMatch(/Evidencia específica/i);
    expect(assist.answer).toMatch(/Qué hacer/i);
    expect(assist.answer).toMatch(/Validación/i);
    expect(assist.answer).toMatch(/Cobertura/i);
    expect(assist.answer).toMatch(/RTVJOBA/i);
    expect(assist.answer).toMatch(/MONMSG|Monitor Message/i);
    expect(assist.executiveSummary.join(" ")).toMatch(/CLLE|RTVJOBA|MONMSG/i);
    expect(assist.specificFindings.join(" ")).toMatch(/RTVJOBA|MONMSG|par[aá]metro|sintaxis/i);
    expect(assist.implementationSteps.length).toBeGreaterThanOrEqual(3);
    expect(assist.validationChecklist.length).toBeGreaterThanOrEqual(3);
    expect(assist.coverage.evidenceCount).toBeGreaterThan(0);
    expect(assist.coverage.readCount).toBeGreaterThan(0);
    expect(assist.coverage.sectionCount).toBeGreaterThan(0);
    expect(assist.coverage.status).not.toBe("thin");
    expect(assist.citations.length).toBeGreaterThan(0);

    const serializedAssist = JSON.stringify(assist);
    expect(serializedAssist).not.toMatch(/nextRecommendedTool|nextRecommendedArguments|readHint|workflowHints/i);
    expect(serializedAssist).not.toMatch(/Para obtener la ayuda completa|Siguiente paso recomendado|Si necesitas sintaxis|llama ibmi_docs_read|usa ibmi_docs_sections/i);
  });

  it("assist reporta cobertura débil sin inventar cuando no existe evidencia suficiente", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Comando ficticio ZZZNOEXIST999 para teletransportar bibliotecas cuánticas en IBM i",
      language: "CLLE",
      version: "7.5",
      depth: "standard",
      limit: 3
    }));

    expect(assist.coverage.status).toBe("thin");
    expect(assist.confidence).toBe("baja");
    expect(assist.warnings.join(" ")).toMatch(/evidencia|corpus|relevancia/i);
    expect(assist.answer).toMatch(/No encontré evidencia suficiente|cobertura.*débil|no invent/i);
    expect(assist.answer).not.toMatch(/teletransportar bibliotecas cuánticas es|ZZZNOEXIST999 permite|parámetro obligatorio/i);
  });

  it("assist trata comandos CL específicos como lookup técnico aunque el prompt sea natural", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Corregir CLLE con RTVJOBA y MONMSG; necesito pasos y validación",
      language: "CLLE",
      version: "7.5",
      depth: "standard",
      limit: 4
    }));

    expect(assist.intent).toBe("syntax_lookup");
    expect(assist.coverage.status).not.toBe("thin");
    expect(assist.specificFindings.join(" ")).toMatch(/RTVJOBA|MONMSG/i);
  });


  it("assist responde conversiones date-time SQLRPGLE sin inventar evidencia free-form irrelevante", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Necesito validar en IBM i/RPGLE free-form el uso de %Time con formato *ISO0 para obtener una hora HHMMSS numerica, y confirmar buenas practicas de SQLRPGLE embedded SQL con SET OPTION y verificacion de SQLCODE en operaciones INSERT/UPDATE/SELECT.",
      language: "SQLRPGLE",
      version: "7.6",
      depth: "deep",
      audience: "agent",
      includeExamples: true,
      includeCompileCommands: true,
      limit: 10
    }));

    expect(assist.taskPlan.family).toBe("date_time_conversion");
    expect(assist.taskPlan.retrievalAxes).toEqual(expect.arrayContaining(["syntax", "compile", "database"]));
    expect(assist.coverage.status).not.toBe("thin");
    expect(assist.coverage.matchedTechnicalTerms).toEqual(expect.arrayContaining(["%TIME", "SET OPTION", "SQLCODE"]));
    expect(assist.answer).toMatch(/%TIME|Time Data Type|time-format|TIMFMT/i);
    expect(assist.answer).toMatch(/%DEC|Packed Decimal|Date, time or timestamp expression|HHMMSS/i);
    expect(assist.answer).toMatch(/SET OPTION|SQLCODE|SQLSTATE|embedded SQL|SQLRPGLE/i);
    expect(assist.answer).not.toMatch(/Free-Form Named Constant Definition|Free-Form Enumeration Definition|Free-Form Parameter Definition/i);
    expect(assist.specificFindings.join(" ")).not.toMatch(/Free-Form Named Constant Definition|Free-Form Enumeration Definition|Free-Form Parameter Definition/i);
    expect(assist.retrievalPlan.hops.some((hop) => /%TIME|Time Data Type|%DEC|SET OPTION|SQLCODE/i.test(hop.query))).toBe(true);
  });

  it("assist normaliza aliases de agentes como query e ibmiVersion sin explotar ni responder tangentes", () => {
    const assist = withRepo((repo) => repo.assist({
      query: "En SQLRPGLE necesito validar si un campo packed decimal 5,3 puede almacenar 1.50 y convertir una hora HHMMSS sin separadores usando %TIME, %DEC o SET OPTION; si falla SQL, revisar SQLCODE SQLSTATE.",
      language: "SQLRPGLE",
      ibmiVersion: "7.6",
      depth: "deep",
      audience: "agent",
      includeExamples: true,
      includeCompileCommands: true,
      limit: 10
    } as any));

    expect(assist.question).toMatch(/packed decimal 5,3/i);
    expect(assist.coverage.status).not.toBe("thin");
    expect(assist.coverage.matchedTechnicalTerms).toEqual(expect.arrayContaining(["%TIME", "%DEC", "SET OPTION", "SQLCODE", "SQLSTATE"]));
    expect(assist.answer).toMatch(/%TIME|Time Data Type|TIMFMT/i);
    expect(assist.answer).toMatch(/%DEC|Packed Decimal|HHMMSS/i);
    expect(assist.answer).toMatch(/SET OPTION|SQLCODE|SQLSTATE/i);
    expect(assist.answer).not.toMatch(/Free-Form Named Constant Definition|Free-Form Enumeration Definition|Free-Form Parameter Definition/i);
  });

  it("assist responde conceptualmente preguntas de banco sobre library list inicial", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Which library gets loaded first when we login to IBM i?",
      language: "CLLE",
      depth: "deep",
      audience: "agent",
      limit: 10
    }));

    const answer = assist.answer + "\n" + assist.specificFindings.join("\n");
    expect(answer).toMatch(/library list|initial library list|Displaying a library list/i);
    expect(answer).toMatch(/QSYS|system library|current library|user portion|job description|QGPL|QTEMP/i);
    expect(answer).not.toMatch(/CRTRPGMOD Command|teletransport/i);
  });

  it("assist responde conceptualmente preguntas de banco sobre miembros de archivo", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "How to check all members of a file in IBM i?",
      language: "CLLE",
      depth: "deep",
      audience: "agent",
      limit: 10
    }));

    const answer = assist.answer + "\n" + assist.specificFindings.join("\n");
    expect(answer).toMatch(/WRKMBRPDM|Work with Members/i);
    expect(answer).toMatch(/DSPFD|Display File Description|member/i);
    expect(answer).not.toMatch(/%TIME|SND-MSG/i);
  });

  it("assist responde conceptualmente preguntas de banco sobre depuración de batch jobs", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "How do you debug a batch job in IBM i?",
      language: "CLLE",
      depth: "deep",
      audience: "agent",
      limit: 10
    }));

    const answer = assist.answer + "\n" + assist.specificFindings.join("\n") + "\n" + assist.implementationSteps.join("\n");
    expect(answer).toMatch(/HOLD\(\*YES\)|hold/i);
    expect(answer).toMatch(/WRKSBMJOB|Work with Submitted Jobs/i);
    expect(answer).toMatch(/STRSRVJOB|Start Service Job/i);
    expect(answer).toMatch(/STRDBG|Start Debug/i);
    expect(answer).toMatch(/ENDDBG|ENDSRVJOB|End Debug|End Servicing Job/i);
    expect(answer).not.toMatch(/%DEC|DDS UNIQUE/i);
  });

  it("assist responde conceptualmente preguntas de banco sobre record locks RPGLE", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "How to check if a record is locked in RPGLE?",
      language: "RPGLE",
      depth: "deep",
      audience: "agent",
      limit: 10
    }));

    const answer = assist.answer + "\n" + assist.specificFindings.join("\n") + "\n" + assist.validationChecklist.join("\n");
    expect(answer).toMatch(/record-lock|record lock|locked record/i);
    expect(answer).toMatch(/1218|%STATUS|%ERROR|CHAIN|READ/i);
    expect(answer).not.toMatch(/SFLDSP|QSYS/i);
  });

  it("assist responde conceptualmente preguntas de banco sobre comandos de línea SEU", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "What are common SEU line commands for copying, deleting, inserting and moving source lines?",
      language: "CLLE",
      depth: "deep",
      audience: "agent",
      limit: 10
    }));

    const answer = assist.answer + "\n" + assist.specificFindings.join("\n");
    expect(answer).toMatch(/SEU|Source Entry Utility/i);
    expect(answer).toMatch(/line command|copy|delete|insert|move/i);
    expect(answer).toMatch(/\bC\b|CC|Cn|D\b|DD|I\b|M\b|MM/i);
    expect(answer).not.toMatch(/SQLCODE|RTVJOBA command/i);
  });

  it("search recupera documentación RPG de ISO0 y HHMMSS desde tipos date-time y %DEC", () => {
    const iso0 = withRepo((repo) => repo.search({
      query: "ISO0 time format RPG Time Data Type",
      category: "ile-rpg",
      limit: 8,
      includeSections: true
    }));
    const hhmmss = withRepo((repo) => repo.search({
      query: "HHMMSS numeric time RPG %DEC packed decimal",
      category: "ile-rpg",
      limit: 8,
      includeSections: true
    }));

    expect(iso0.map((hit) => hit.title).join(" ")).toMatch(/Time Data Type|TIME\{\(format|External Format|%TIME|%TIMESTAMP|TEST|MOVE/i);
    expect(hhmmss.map((hit) => hit.title).join(" ")).toMatch(/%DEC|Date, time or timestamp expression|Time Data Type/i);
  });

  it("assist planifica y ejecuta recuperación multi-hop para una petición compleja SQLRPGLE/RNF", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Necesito corregir SQLRPGLE con EXEC SQL y /COPY que falla RNF0004; además quiero validar opciones de compilación como RPGPPOPT y el comando CRTSQLRPGI en IBM i 7.6.",
      language: "SQLRPGLE",
      version: "7.6",
      depth: "deep",
      audience: "agent",
      includeCompileCommands: true,
      includeExamples: true,
      limit: 8
    })) as any;

    expect(assist.retrievalPlan).toBeDefined();
    expect(assist.retrievalPlan.strategy).toBe("multi-hop");
    expect(assist.retrievalPlan.axes).toEqual(expect.arrayContaining(["primary", "compile", "message", "syntax"]));
    expect(assist.retrievalPlan.hops.length).toBeGreaterThanOrEqual(4);
    expect(assist.retrievalPlan.hops.map((hop: { status: string }) => hop.status)).not.toContain("planned");
    expect(assist.retrievalPlan.hops.some((hop: { query: string }) => /RNF0004/i.test(hop.query))).toBe(true);
    expect(assist.retrievalPlan.hops.some((hop: { query: string }) => /CRTSQLRPGI/i.test(hop.query))).toBe(true);
    expect(assist.retrievalPlan.hops.some((hop: { query: string }) => /RPGPPOPT|COPY|INCLUDE/i.test(hop.query))).toBe(true);
    expect(assist.workflow.map((stage: { tool: string }) => stage.tool)).toEqual(expect.arrayContaining([
      "ibmi_docs_agentic_plan",
      "ibmi_docs_search",
      "ibmi_docs_read",
      "ibmi_docs_sections",
      "ibmi_docs_compile_guidance",
      "ibmi_docs_explain_message"
    ]));
    expect(assist.answer).toMatch(/RNF0004|CRTSQLRPGI|RPGPPOPT|\/COPY|\/INCLUDE|EXEC SQL/i);
    expect(assist.coverage.evidenceCount).toBeGreaterThan(0);
    expect(assist.coverage.readCount).toBeGreaterThan(0);
    expect(assist.coverage.sectionCount).toBeGreaterThan(0);
    expect(assist.coverage.status).not.toBe("thin");

    const serializedAssist = JSON.stringify(assist);
    expect(serializedAssist).not.toMatch(/nextRecommendedTool|nextRecommendedArguments|readHint|workflowHints/i);
    expect(serializedAssist).not.toMatch(/Para obtener la ayuda completa|Siguiente acción recomendada|Si necesitas sintaxis|llama ibmi_docs_read|usa ibmi_docs_sections/i);
  });

  it("assist ejecuta follow-ups por gaps y separa términos cubiertos de términos inexistentes", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Explica MONMSG y ZZZNOEXIST999 en CLLE; necesito saber qué sí está documentado y qué no debo inventar.",
      language: "CLLE",
      version: "7.5",
      depth: "deep",
      audience: "agent",
      limit: 6
    })) as any;

    expect(assist.retrievalPlan).toBeDefined();
    expect(assist.retrievalPlan.strategy).toBe("multi-hop");
    expect(assist.retrievalPlan.axes).toContain("gap-followup");
    expect(assist.retrievalPlan.followUpQueries.some((query: string) => /ZZZNOEXIST999/i.test(query))).toBe(true);
    expect(assist.retrievalPlan.coverageGaps.join(" ")).toMatch(/ZZZNOEXIST999/i);
    expect(assist.coverage.matchedTechnicalTerms.join(" ")).toMatch(/MONMSG/i);
    expect(assist.coverage.missingTechnicalTerms.join(" ")).toMatch(/ZZZNOEXIST999/i);
    expect(assist.answer).toMatch(/MONMSG|Monitor Message/i);
    expect(assist.answer).toMatch(/ZZZNOEXIST999/i);
    expect(assist.answer).not.toMatch(/ZZZNOEXIST999 permite|ZZZNOEXIST999 sirve para|parámetro obligatorio de ZZZNOEXIST999/i);
  });

  it("assist usa un planner explícito para creación de RPGLE y devuelve plantilla de implementación", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Créame un programa RPGLE free-form que lea un archivo físico, valide errores y dime cómo compilarlo como módulo ILE.",
      language: "RPGLE",
      version: "7.5",
      depth: "deep",
      audience: "agent",
      includeCompileCommands: true,
      includeExamples: true,
      limit: 8
    }));

    expect(assist.taskPlan.family).toBe("create_program");
    expect(assist.taskPlan.primaryLanguage).toBe("RPGLE");
    expect(assist.taskPlan.retrievalAxes).toEqual(expect.arrayContaining(["syntax", "compile"]));
    expect(assist.taskPlan.requiredEvidence.join(" ")).toMatch(/RPGLE|compil|CRTRPGMOD|CRTBNDRPG/i);
    expect(assist.answer).toMatch(/Plan de implementación|RPGLE|CRTRPGMOD|CRTBNDRPG|Validación/i);
    expect(assist.implementationSteps.join(" ")).toMatch(/fuente|compil|m[oó]dulo|valid/i);
    expect(assist.coverage.status).not.toBe("thin");
  });

  it("assist usa plantilla DDS cuando el agente debe diseñar archivo físico o reporte", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Diseña un PF DDS con clave única y dame validaciones antes de compilarlo.",
      language: "DDS",
      version: "7.5",
      depth: "deep",
      audience: "agent",
      includeExamples: true,
      includeCompileCommands: true,
      limit: 8
    }));

    expect(assist.taskPlan.family).toBe("design_dds_file");
    expect(assist.taskPlan.primaryLanguage).toBe("DDS");
    expect(assist.taskPlan.retrievalAxes).toEqual(expect.arrayContaining(["syntax", "compile"]));
    expect(assist.answer).toMatch(/Plan DDS|DDS|PF|CRTPF|UNIQUE|clave/i);
    expect(assist.validationChecklist.join(" ")).toMatch(/DDS|CRTPF|clave|unique|joblog/i);
    expect(assist.coverage.status).not.toBe("thin");
  });

  it("assist madura consultas administrativas IBM i sin perder WRKACTJOB ni locks en índices genéricos", () => {
    const assist = withRepo((repo) => repo.assist({
      question: "Cómo reviso trabajos activos y bloqueos de un objeto o miembro en IBM i? Usa WRKACTJOB, WRKOBJLCK, DSPJOB y WRKJOB si aplican.",
      language: "IBM i administration",
      version: "7.5",
      depth: "deep",
      audience: "agent",
      includeExamples: true,
      limit: 10
    }));

    expect(assist.taskPlan.family).toBe("work_management");
    expect(assist.taskPlan.retrievalAxes).toEqual(expect.arrayContaining(["administration", "syntax"]));
    expect(assist.coverage.status).not.toBe("thin");
    expect(assist.coverage.matchedTechnicalTerms).toEqual(expect.arrayContaining(["WRKACTJOB", "WRKOBJLCK", "DSPJOB", "WRKJOB"]));
    expect(assist.coverage.missingTechnicalTerms).not.toContain("WRKACTJOB");
    expect(assist.specificFindings.join(" ")).toMatch(/WRKACTJOB|Work with Active Jobs/i);
    expect(assist.specificFindings.join(" ")).toMatch(/WRKOBJLCK|Work with Object Locks|lock/i);
    expect(assist.answer).toMatch(/Trabajos y locks|WRKACTJOB|WRKOBJLCK|DSPJOB|WRKJOB|Validación/i);
    expect(assist.answer).not.toMatch(/Listing of SQL messages|XPath expression|CUSTOMER FILE ADD\/UPDATE|DDS information/i);
    expect(assist.implementationSteps.join(" ")).not.toMatch(/XPath|QINSTAPP|CUSTOMER FILE|DDS/i);
    expect(assist.citations.map((citation) => `${citation.title} ${citation.section ?? ""}`).join(" ")).not.toMatch(/Listing of SQL messages|DDS|XPath/i);
    expect(assist.retrievalPlan.hops.length).toBeGreaterThanOrEqual(6);
    expect(assist.retrievalPlan.hops.some((hop) => /Work with Active Jobs|WRKACTJOB/i.test(hop.query))).toBe(true);
  });

  it("search promueve secciones y chunks administrativos cuando no hay página canónica de comando", () => {
    const activeJobs = withRepo((repo) => repo.search({
      query: "WRKACTJOB Work with Active Jobs command",
      category: "cl-clle",
      limit: 5,
      includeSections: true
    }));
    const objectLocks = withRepo((repo) => repo.search({
      query: "WRKOBJLCK Work with Object Locks command",
      category: "cl-clle",
      limit: 5,
      includeSections: true
    }));

    expect(activeJobs.length).toBeGreaterThan(0);
    expect(objectLocks.length).toBeGreaterThan(0);
    expect(activeJobs[0].title).toMatch(/WRKACTJOB|Work with Active Jobs|Debugging a job that is running/i);
    expect(`${activeJobs[0].title} ${activeJobs[0].snippet}`).toMatch(/WRKACTJOB|Work with Active Jobs/i);
    expect(objectLocks[0].title).toMatch(/WRKOBJLCK|Work with Object Locks|Displaying the lock states/i);
    expect(`${objectLocks[0].title} ${objectLocks[0].snippet}`).toMatch(/WRKOBJLCK|Work with Object Locks|Lock/i);
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
    expect(results[0]?.taxonomy?.kind).toBe("rpg-opcode");
    expect(results[0]?.taxonomy?.relatedKinds).toContain("rpg-bif");
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
    expect(answer.suggestedTools).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(/nextRecommendedTool|readHint|Para obtener la ayuda completa|Siguiente paso recomendado|Si necesitas sintaxis/i);
  });

  it("explica recuperación semántica vectorial con conceptos y razones", () => {
    const explanation = withRepo((repo) => repo.explainRanking({
      query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      category: "ile-rpg",
      top: 3
    }));

    expect(explanation.semanticProfile.concepts.length + explanation.semanticProfile.intentHints.length).toBeGreaterThan(0);
    expect(explanation.semanticQueries.length).toBeGreaterThan(0);
    expect(explanation.results[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("extrae secciones estructurales de tópicos completos", () => {
    const sections = withRepo((repo) => repo.sections("rdi-b314bc2569c3d305"));

    expect(sections.topic?.title).toContain("SND-MSG");
    expect(sections.sections.some((section) => section.kind === "syntax")).toBe(true);
  });

  it("extrae sintaxis, parámetros y notas desde comandos IBM i compactados", () => {
    const sections = withRepo((repo) => {
      const hit = repo.search({ query: "CRTRPGMOD", limit: 1 })[0];
      return repo.sections(hit.id);
    });

    const kinds = sections.sections.map((section) => section.kind);
    expect(sections.topic?.title).toContain("CRTRPGMOD");
    expect(kinds).toEqual(expect.arrayContaining(["description", "syntax", "parameters", "notes"]));
    expect(sections.sections.find((section) => section.kind === "syntax")?.title).toMatch(/Sintaxis de CRTRPGMOD/i);
    expect(sections.sections.find((section) => section.kind === "parameters")?.content).toMatch(/SRCFILE|SRCMBR|MODULE/i);
    expect(sections.sections.find((section) => section.kind === "notes")?.content).toMatch(/parameters preceding this point/i);
  });

  it("emite reporte de calidad y recetas comunitarias", () => {
    const result = withRepo((repo) => ({ quality: repo.qualityReport(), recipes: repo.recipes() }));

    expect(result.quality.ok).toBe(true);
    expect(result.quality.documents).toBeGreaterThan(1000);
    expect(result.quality.documentKinds.topic).toBeGreaterThan(0);
    expect(result.quality.duplicateCanonicalTopics.length).toBe(0);
    expect(result.quality.duplicateTitlesSameVersion).toBeDefined();
    expect(result.quality.recommendations.length).toBeGreaterThan(0);
    expect(result.recipes.length).toBeGreaterThan(3);
  });

  it("genera reportes reproducibles para feedback de ranking", () => {
    const report = withRepo((repo) => repo.reportQuery({
      query: "SND-MSG Send a Message to the Joblog",
      category: "ile-rpg",
      expectedTitle: "SND-MSG",
      limit: 5,
      notes: "Caso de prueba de recuperación semántica."
    }));

    expect(report.diagnostics.semanticConcepts.length + report.diagnostics.semanticIntentHints.length).toBeGreaterThan(0);
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

  it("usa ampliación de alcance version-aware antes que comandos no relacionados", () => {
    const results = withRepo((repo) => repo.search({
      query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      category: "ile-rpg",
      version: "7.5",
      limit: 5,
      includeSections: true
    }));

    expect(results[0]?.title).toContain("SND-MSG");
    expect(results[0]?.requestedVersionScopeExpansion).toBe(true);
    expect(results.slice(0, 3).map((hit) => hit.title).join("\n")).not.toMatch(/CRTRPGMOD/i);
    expect(results[0]?.relevanceWarnings?.join(" ")).toMatch(/No se encontró|versión solicitada/i);
  });

  it("no usa evidencia irrelevante al responder consultas específicas", () => {
    const answer = withRepo((repo) => repo.answer({
      question: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET",
      language: "RPGLE",
      version: "7.5",
      limit: 5
    }));

    expect(answer.citations[0]?.title).toContain("SND-MSG");
    expect(answer.citations.map((citation) => citation.title).join("\n")).not.toMatch(/CRTRPGMOD/i);
    expect(answer.warnings.join(" ")).toMatch(/ampliación de alcance|versión solicitada/i);
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
    expect(result.suggestedTools).toEqual([]);
    expect(result.answer).not.toMatch(/Siguiente acción recomendada|usa ibmi_docs_read|ibmi_docs_sections para/i);
    expect(JSON.stringify(result)).not.toMatch(/nextRecommendedTool|readHint|nextRecommendedArguments|workflowHints|Para obtener la ayuda completa llama|Si necesitas sintaxis|Siguiente paso recomendado/i);
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
    expect(result.confidence).toBe("media");
    expect(result.messageExplanation?.messageId).toBe("CPF0001");
    expect(result.messageExplanation?.coverageStatus).toBe("family");
    expect(result.messageExplanation?.specificMatch).toBe(false);
    expect(result.messageExplanation?.evidence.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/familia|entrada específica/i);
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

  it("search recomienda siguiente tool y auto-lee comandos específicos fuertes", () => {
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
    expect(results[0]?.title).toContain("SBMJOB command");
    expect(results[0]?.synthetic).toBe(true);
    expect(results.some((hit) => `${hit.title} ${hit.snippet}`.includes("SBMJOB"))).toBe(true);
    const serializedArgs = JSON.stringify(results.map((hit) => hit.nextRecommendedArguments ?? {}));
    expect(serializedArgs).not.toContain("SBMJOB COMMAND");
    expect(serializedArgs).toMatch(/CLLE|ibmi_docs_sections|id/);
  });

  it("genera entrada sintética para comandos CL mencionados por descripción larga", () => {
    const results = withRepo((repo) => repo.search({
      query: "RTVJOBA command",
      category: "cl-clle",
      limit: 5
    }));

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toContain("RTVJOBA command");
    expect(results[0]?.synthetic).toBe(true);
    expect(results[0]?.taxonomy?.kind).toBe("command");
    expect(`${results[0]?.title} ${results[0]?.snippet}`).toMatch(/RTVJOBA|Retrieve Job Attributes|Job Attributes/i);
  });

  it("prioriza evidencia de compilación SQLRPGLE sobre catálogos Db2 genéricos", () => {
    const results = withRepo((repo) => repo.search({
      query: "SQLRPGLE",
      category: "sql-db2-for-i",
      limit: 5
    }));

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toMatch(/CRTSQLRPGI|embedded SQL|SQL RPG|precompiler|RPGPPOPT/i);
    expect(results[0]?.title).not.toMatch(/SYSINDEXSTAT/i);
  });

  it("permite categoría estricta sin ampliación de alcance fuera de la categoría solicitada", () => {
    const loose = withRepo((repo) => repo.search({ query: "DSPFD command", category: "dds", limit: 3 }));
    const strict = withRepo((repo) => repo.search({ query: "DSPFD command", category: "dds", strictCategory: true, limit: 3 }));

    expect(loose.some((hit) => hit.requestedCategoryScopeExpansion)).toBe(true);
    expect(strict.every((hit) => hit.category === "dds")).toBe(true);
  });

  it("detecta señales CLLE de jobs y mensajes programáticos", () => {
    const result = withRepo((repo) => repo.validateCodeContext({
      language: "CLLE",
      code: "PGM\nSBMJOB CMD(CALL PGM(MYLIB/MYPGM)) JOB(TESTJOB)\nMONMSG MSGID(CPF0000) EXEC(DO)\nSNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('Falló')\nENDDO\nENDPGM",
      limit: 5
    }));

    expect(result.detectedSignals).toEqual(expect.arrayContaining(["CLLE", "MONMSG", "SBMJOB", "SNDPGMMSG", "CPF message"]));
    expect(result.findings.map((finding) => finding.title)).toEqual(expect.arrayContaining(["MONMSG detectado en CL", "SBMJOB detectado", "SNDPGMMSG detectado"]));
    expect(result.findings.some((finding) => finding.severity === "warning")).toBe(true);
  });

  it("clasifica consultas mixtas como multi_intent con advertencias por eje", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Para auditar comandos CL como DSPFD y SBMJOB y mensajes CPF MCH RNF, qué evidencia debe priorizar",
      limit: 4
    }));

    expect(result.intent).toBe("multi_intent");
    expect(result.confidence).not.toBe("alta");
    expect(result.warnings.join(" ")).toMatch(/Consulta mixta|familias de mensajes/i);
  });

  it("resuelve intención mixta de mensaje RNF y compilación SQLRPGLE", () => {
    const result = withRepo((repo) => repo.resolve({
      question: "Diagnostica RNF0004 y revisa CRTSQLRPGI para SQLRPGLE",
      language: "SQLRPGLE",
      limit: 4
    }));

    expect(result.intent).toBe("multi_intent");
    expect(result.messageExplanation?.messageId).toBe("RNF0004");
    expect(result.compileGuidance?.recommendedCommands).toContain("CRTSQLRPGI");
    expect(result.stages.map((stage) => stage.tool)).toEqual(expect.arrayContaining([
      "ibmi_docs_explain_message",
      "ibmi_docs_compile_guidance"
    ]));
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
        repo.search({ query: "DSPFD command", category: "dds", limit: 3 });
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
      expect(report.scopeExpansionCount).toBeGreaterThan(0);
      expect(report.scopeExpansionByKind.category).toBeGreaterThan(0);
      expect(report.scopeExpansionFeedback.some((item) => item.kind === "category" && item.requestedScope === "dds" && item.usedScope === "cl-clle")).toBe(true);
      expect(report.scopeExpansionFeedback.map((item) => item.improvementHint).join(" ")).toMatch(/mapearse directamente|falta una entrada|alias/i);
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
