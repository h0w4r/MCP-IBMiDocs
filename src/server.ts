#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CorpusRepository } from "./repository/CorpusRepository.js";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";
import { loadPackageVersion } from "./util/packageVersion.js";
import { resolvePackDir } from "./util/paths.js";

const moduleFile = fileURLToPath(import.meta.url);
const packResolution = resolvePackDir(import.meta.url);
const packDir = packResolution.packDir;

function createRepository(): CorpusRepository {
  return new CorpusRepository(packDir);
}

function withRepository<T>(callback: (repo: CorpusRepository) => T): T {
  const repo = createRepository();
  try {
    return callback(repo);
  } finally {
    repo.close();
  }
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "ibmi-docs-mcp", version: loadPackageVersion(import.meta.url) },
    {
      instructions:
        [
          "Usa estas herramientas para contrastar respuestas sobre IBM i/AS400, RPGLE, SQLRPGLE, CLLE, DDS, Db2 for i y mensajes RNF contra documentación local oficial.",
          "Si el cliente o agente no sabe qué herramienta elegir, usa primero ibmi_docs_assist: es la tool one-shot y devuelve respuesta final, pasos, validación, cobertura y citas sin delegar sub-tools.",
          "Para flujos especializados usa ibmi_docs_resolve, ibmi_docs_answer o ibmi_docs_context: estas tools auto-orquestan búsqueda, lectura, secciones y síntesis dentro del MCP, y devuelven evidencia ya materializada.",
          "ibmi_docs_search, ibmi_docs_read e ibmi_docs_sections son herramientas de bajo nivel para auditoría manual o depuración; no son requisito posterior cuando una tool de alto nivel ya respondió.",
          "Las tools de alto nivel no deben delegar trabajo adicional al agente: si la consulta requiere sintaxis, parámetros, ejemplos, mensajes, compilación o comparación por versión, la tool debe incorporar ese flujo en su propia salida.",
          "Si un ranking parece incorrecto, usa ibmi_docs_report_query para generar evidencia reproducible lista para issue.",
          "El runtime no depende de RDi ni Eclipse Help y nunca consulta el endpoint local de bootstrap."
        ].join(" ")
    }
  );

  server.registerTool(
    "ibmi_docs_assist",
    {
      title: "Asistente IBM i one-shot",
      description: "Herramienta principal para agentes y usuarios: recibe la tarea completa y ejecuta internamente un motor multi-hop de intención -> búsqueda -> lectura -> secciones -> follow-ups por gaps -> síntesis. Devuelve respuesta final autocontenida con evidencia, lecturas, secciones, pasos, validación, cobertura, citas y retrievalPlan; no pide llamadas adicionales.",
      inputSchema: z.object({
        question: z.string().min(1).describe("Pregunta o tarea completa del usuario sobre IBM i/AS400."),
        language: z.string().optional().describe("Lenguaje o tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL."),
        version: z.string().optional().describe("Versión IBM i preferida, por ejemplo 7.5 o 7.6."),
        category: z.string().optional().describe("Categoría opcional del corpus."),
        code: z.string().optional().describe("Código opcional para validación documental."),
        depth: z.enum(["concise", "standard", "deep"]).optional().describe("Nivel de detalle de la respuesta."),
        audience: z.enum(["agent", "developer", "maintainer"]).optional().describe("Audiencia principal de la salida."),
        includeExamples: z.boolean().optional().describe("Incluir ejemplos/secciones de ejemplo cuando existan."),
        includeCompileCommands: z.boolean().optional().describe("Incluir guía de compilación cuando aplique."),
        limit: z.number().int().min(1).max(12).optional()
      })
    },
    async (input) => {
      const assisted = withRepository((repo) => repo.assist(input));
      return { content: [{ type: "text" as const, text: renderAssist(assisted) }], structuredContent: structured(assisted) };
    }
  );

  server.registerTool(
    "ibmi_docs_resolve",
    {
      title: "Resolver consulta IBM i con workflow agéntico",
      description: "Herramienta principal para agentes: clasifica la intención y auto-orquesta búsqueda, lectura, secciones, respuesta, contexto, compilación, mensajes, versiones o ranking según corresponda. Devuelve una respuesta autocontenida; no pide llamadas adicionales.",
      inputSchema: z.object({
        question: z.string().min(1).describe("Consulta completa del usuario sobre IBM i/AS400."),
        language: z.string().optional().describe("Lenguaje o tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL."),
        version: z.string().optional().describe("Versión IBM i preferida, por ejemplo 7.5 o 7.6."),
        category: z.string().optional().describe("Categoría opcional del corpus."),
        code: z.string().optional().describe("Código a validar documentalmente si la consulta es revisión/corrección."),
        includeExamples: z.boolean().optional(),
        includeCompileCommands: z.boolean().optional(),
        limit: z.number().int().min(1).max(12).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const resolved = withRepository((repo) => repo.resolve(input));
      return { content: [{ type: "text" as const, text: renderResolve(resolved) }], structuredContent: structured(resolved) };
    }
  );

  server.registerTool(
    "ibmi_docs_search",
    {
      title: "Buscar documentación IBM i",
      description: "Descubrimiento de documentos candidatos con SQLite FTS5, ranking heurístico y evidencia trazable. Es bajo nivel; para una respuesta final usa ibmi_docs_assist, ibmi_docs_resolve, ibmi_docs_answer o ibmi_docs_context.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Consulta técnica: CRTRPGMOD, RNF0004, CLLE, DDS PF, SQLRPGLE, etc."),
        version: z.string().optional().describe("Versión IBM i opcional, por ejemplo 7.4, 7.5 o 7.6."),
        category: z.string().optional().describe("Categoría opcional: ile-rpg, cl-clle, dds, sql-db2-for-i, mensajes-rnf."),
        limit: z.number().int().min(1).max(50).optional(),
        mode: z.enum(["fts", "hybrid"]).optional().describe("Modo fts puro o híbrido con expansión semántica local."),
        autoRead: z.boolean().optional().describe("Si true, adjunta contenido completo cuando el resultado es fuerte."),
        includeSections: z.boolean().optional().describe("Si true, agrega vista previa de secciones detectadas."),
        strictCategory: z.boolean().optional().describe("Si true, no permite fallback fuera de la categoría solicitada.")
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, version, category, limit, mode, autoRead, includeSections, strictCategory }) => {
      const results = withRepository((repo) => repo.search({ query, version, category, limit, mode, autoRead, includeSections, strictCategory }));
      return { content: [{ type: "text" as const, text: renderSearchResults(query, results) }], structuredContent: structured({ query, results: results.map(sanitizeAgentHit) }) };
    }
  );

  server.registerTool(
    "ibmi_docs_read",
    {
      title: "Leer tópico IBM i",
      description: "Lee el contenido completo normalizado de un tópico por ID. Útil para auditoría manual; las tools de alto nivel ya realizan esta lectura internamente cuando la necesitan.",
      inputSchema: z.object({ id: z.string().min(1).describe("ID de documento devuelto por ibmi_docs_search.") }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      const result = withRepository((repo) => repo.read(id));
      if (!result) return { content: [{ type: "text" as const, text: `No se encontró el tópico ${id}.` }], isError: true };
      return { content: [{ type: "text" as const, text: renderReadResult(result) }], structuredContent: structured({ result }) };
    }
  );

  server.registerTool(
    "ibmi_docs_sections",
    {
      title: "Secciones de tópico IBM i",
      description: "Extrae secciones estructurales del tópico: sintaxis, parámetros, ejemplos, notas, mensajes y referencias.",
      inputSchema: z.object({ id: z.string().min(1).describe("ID de documento devuelto por ibmi_docs_search.") }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      const result = withRepository((repo) => repo.sections(id));
      if (!result.topic) return { content: [{ type: "text" as const, text: `No se encontró el tópico ${id}.` }], isError: true };
      return { content: [{ type: "text" as const, text: renderSections(result) }], structuredContent: structured(result) };
    }
  );

  server.registerTool(
    "ibmi_docs_answer",
    {
      title: "Responder con evidencia IBM i",
      description: "Respuesta recomendada para preguntas directas: auto-orquesta búsqueda híbrida, lectura de tópicos, selección de secciones, citas y comandos cuando aplica. Devuelve una respuesta autocontenida.",
      inputSchema: z.object({
        question: z.string().min(1),
        language: z.string().optional(),
        version: z.string().optional(),
        category: z.string().optional(),
        includeExamples: z.boolean().optional(),
        includeCompileCommands: z.boolean().optional(),
        limit: z.number().int().min(1).max(10).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const answer = withRepository((repo) => repo.answer(input));
      return { content: [{ type: "text" as const, text: renderAnswer(answer) }], structuredContent: structured(answer) };
    }
  );

  server.registerTool(
    "ibmi_docs_context",
    {
      title: "Resolver contexto IBM i",
      description: "Genera un paquete contextual agéntico autocontenido: intención, respuesta, lecturas, secciones enfocadas, comandos, riesgos, notas de versión, acciones y evidencia ya materializada.",
      inputSchema: z.object({
        task: z.string().min(1).describe("Tarea del usuario: crear programa RPG, corregir RNFxxxx, escribir CLLE, etc."),
        language: z.string().optional().describe("Lenguaje o tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL."),
        version: z.string().optional().describe("Versión IBM i preferida."),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ task, language, version, limit }) => {
      const context = withRepository((repo) => repo.context({ task, language, version, limit }));
      return { content: [{ type: "text" as const, text: renderContext(context) }], structuredContent: structured(context) };
    }
  );

  server.registerTool(
    "ibmi_docs_compile_guidance",
    {
      title: "Guía de compilación IBM i",
      description: "Recomienda comandos y opciones de compilación para RPGLE, SQLRPGLE, CLLE, DDS y COBOL con evidencia documental.",
      inputSchema: z.object({
        language: z.string().min(1),
        target: z.string().optional(),
        usesEmbeddedSql: z.boolean().optional(),
        usesCopybook: z.boolean().optional(),
        version: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const guidance = withRepository((repo) => repo.compileGuidance(input));
      return { content: [{ type: "text" as const, text: renderCompileGuidance(guidance) }], structuredContent: structured(guidance) };
    }
  );

  server.registerTool(
    "ibmi_docs_explain_message",
    {
      title: "Explicar mensaje IBM i",
      description: "Busca y resume mensajes RNF/SQL/IBM i con recovery checklist y evidencia trazable.",
      inputSchema: z.object({ messageId: z.string().min(3), limit: z.number().int().min(1).max(20).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ messageId, limit }) => {
      const explanation = withRepository((repo) => repo.explainMessage({ messageId, limit }));
      return { content: [{ type: "text" as const, text: renderMessageExplanation(explanation) }], structuredContent: structured(explanation) };
    }
  );

  server.registerTool(
    "ibmi_docs_related",
    {
      title: "Documentos relacionados IBM i",
      description: "Devuelve equivalentes por versión y documentos vecinos de un tópico localizado.",
      inputSchema: z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id, limit }) => {
      const related = withRepository((repo) => repo.related(id, { limit }));
      return { content: [{ type: "text" as const, text: renderRelated(related) }], structuredContent: structured(related) };
    }
  );

  server.registerTool(
    "ibmi_docs_compare_versions",
    {
      title: "Comparar versiones IBM i",
      description: "Compara la disponibilidad de un tópico entre IBM i 7.3, 7.4, 7.5 y 7.6.",
      inputSchema: z.object({
        query: z.string().min(1),
        versions: z.array(z.string()).min(1),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const comparison = withRepository((repo) => repo.compareVersions(input));
      return { content: [{ type: "text" as const, text: renderVersionComparison(comparison) }], structuredContent: structured(comparison) };
    }
  );

  server.registerTool(
    "ibmi_docs_explain_ranking",
    {
      title: "Explicar ranking IBM i Docs",
      description: "Explica FTS, expansión semántica local, términos exactos, taxonomía y razones de ranking para depurar búsquedas.",
      inputSchema: z.object({
        query: z.string().min(1),
        version: z.string().optional(),
        category: z.string().optional(),
        top: z.number().int().min(1).max(20).optional(),
        mode: z.enum(["fts", "hybrid"]).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const explanation = withRepository((repo) => repo.explainRanking(input));
      return { content: [{ type: "text" as const, text: renderRankingExplanation(explanation) }], structuredContent: structured(explanation) };
    }
  );

  server.registerTool(
    "ibmi_docs_validate_code_context",
    {
      title: "Validar código contra docs IBM i",
      description: "Detecta señales en código RPGLE/SQLRPGLE/CLLE/DDS y devuelve hallazgos con evidencia documental.",
      inputSchema: z.object({
        language: z.string().min(1),
        code: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const validation = withRepository((repo) => repo.validateCodeContext(input));
      return { content: [{ type: "text" as const, text: renderCodeValidation(validation) }], structuredContent: structured(validation) };
    }
  );

  server.registerTool(
    "ibmi_docs_categories",
    {
      title: "Categorías IBM i Docs",
      description: "Lista categorías, versiones y fuentes disponibles en el data pack.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const categories = withRepository((repo) => repo.categories());
      return { content: [{ type: "text" as const, text: JSON.stringify(categories, null, 2) }], structuredContent: structured(categories) };
    }
  );

  server.registerTool(
    "ibmi_docs_pack_diagnostics",
    {
      title: "Diagnóstico de integridad del data pack",
      description: "Valida integridad del data pack: archivos faltantes, rutas largas, versiones anómalas y conteos.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const diagnostics = withRepository((repo) => repo.packDiagnostics());
      return { content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }], structuredContent: structured(diagnostics) };
    }
  );

  server.registerTool(
    "ibmi_docs_quality_report",
    {
      title: "Reporte de calidad del corpus IBM i",
      description: "Reporta tópicos cortos, duplicados, cobertura, categorías escasas y recomendaciones para contribuir al corpus.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const report = withRepository((repo) => repo.qualityReport());
      return { content: [{ type: "text" as const, text: renderQualityReport(report) }], structuredContent: structured(report) };
    }
  );

  server.registerTool(
    "ibmi_docs_report_query",
    {
      title: "Reportar búsqueda/ranking IBM i Docs",
      description: "Genera un reporte reproducible para depurar una búsqueda mala: ranking, warnings, términos exactos y Markdown listo para issue.",
      inputSchema: z.object({
        query: z.string().min(1),
        version: z.string().optional(),
        category: z.string().optional(),
        expectedTitle: z.string().optional(),
        expectedId: z.string().optional(),
        notes: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const report = withRepository((repo) => repo.reportQuery(input));
      return { content: [{ type: "text" as const, text: report.issueMarkdown }], structuredContent: structured(report) };
    }
  );

  server.registerTool(
    "ibmi_docs_recipes",
    {
      title: "Recetas de uso IBM i Docs",
      description: "Devuelve prompts y flujos listos para usar con agentes, útiles para onboarding y contribución comunitaria.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const recipes = withRepository((repo) => repo.recipes());
      return { content: [{ type: "text" as const, text: renderRecipes(recipes) }], structuredContent: structured({ recipes }) };
    }
  );

  server.registerTool(
    "ibmi_docs_diagnostics",
    {
      title: "Diagnóstico del corpus IBM i",
      description: "Muestra versión, cobertura, fuentes, ruta resuelta del pack y conteos del repositorio local.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const diagnostics = withRepository((repo) => ({ ...repo.diagnostics(), packResolution }));
      return { content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }], structuredContent: structured(diagnostics) };
    }
  );

  server.registerTool(
    "ibmi_docs_trace_report",
    {
      title: "Reporte de trazas de uso IBM i Docs",
      description: "Resume trazas locales opcionales activadas con IBMI_DOCS_TRACE=1: search-only rate, search->read, uso de answer/resolve y eventos recientes.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ limit }) => {
      const report = withRepository((repo) => repo.traceReport(limit));
      return { content: [{ type: "text" as const, text: renderTraceReport(report) }], structuredContent: structured(report) };
    }
  );

  if (process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC === "1") {
    server.registerTool(
      "ibmi_docs_sync",
      {
        title: "Sincronizar IBM Docs público",
        description: "Tool de mantenimiento: refresca el data pack solo desde IBM Docs público. No se registra en runtime de usuario salvo que IBMI_DOCS_ALLOW_NETWORK_SYNC=1. Nunca usa RDi local ni Eclipse Help.",
        inputSchema: z.object({
          maxPagesPerVersion: z.number().int().min(1).max(2000).optional(),
          versions: z.array(z.string()).optional()
        })
      },
      async ({ maxPagesPerVersion, versions }) => {
        const cacheDir = path.resolve("data", "ibm-docs-cache");
        await syncIbmDocs({ outDir: cacheDir, versions, maxPagesPerVersion: maxPagesPerVersion ?? 500 });
        const manifest = await buildDataPack({ inputDir: path.resolve("data"), outDir: packDir });
        return {
          content: [{ type: "text" as const, text: `Sync IBM Docs completado. Documentos: ${manifest.documents.length}. Fuente: IBM Docs público; RDi local no usado.` }],
          structuredContent: structured({ enabled: true, documents: manifest.documents.length, sourcePolicy: "ibm-docs-only", maintenanceTool: true })
        };
      }
    );
  }

  server.registerResource("ibmi-docs-manifest", "ibmi-docs://manifest", { title: "Manifest del corpus IBM i", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(withRepository((repo) => repo.manifest()), null, 2) }]
  }));

  server.registerResource(
    "ibmi-docs-topic",
    new ResourceTemplate("ibmi-docs://topic/{id}", { list: undefined }),
    { title: "Tópico IBM i", mimeType: "text/plain" },
    async (uri, variables) => {
      const idValue = variables.id;
      const id = Array.isArray(idValue) ? idValue[0] : idValue;
      const result = withRepository((repo) => repo.read(String(id)));
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: result?.content ?? `No se encontró ${String(id)}` }] };
    }
  );

  server.registerResource("ibmi-docs-coverage", "ibmi-docs://coverage", { title: "Cobertura IBM i Docs", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(withRepository((repo) => repo.diagnostics()), null, 2) }]
  }));

  server.registerPrompt("consultar-documentacion-ibmi", {
    title: "Consultar documentación IBM i",
    description: "Prompt para resolver una consulta IBM i con workflow agéntico y evidencia antes de responder.",
    argsSchema: { consulta: z.string().min(1) }
  }, ({ consulta }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_assist para: ${consulta}. La respuesta debe salir autocontenida con evidencia, citas, lecturas, secciones relevantes, pasos y validación ya materializados por el MCP.` } }] }));

  server.registerPrompt("revisar-codigo-rpgle-con-docs", {
    title: "Revisar RPGLE con documentación",
    description: "Prompt para revisar código RPGLE con ayuda IBM i.",
    argsSchema: { codigo: z.string().min(1) }
  }, ({ codigo }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_assist con language=RPGLE y code para revisar este código contra documentación oficial. La tool debe orquestar internamente validación documental y guía de compilación cuando detecte SQL embebido o /COPY:\n\n${codigo}` } }] }));

  server.registerPrompt("diagnosticar-error-rnf", {
    title: "Diagnosticar RNF",
    description: "Prompt para diagnosticar mensajes RNF con causa y recovery.",
    argsSchema: { mensaje: z.string().min(1) }
  }, ({ mensaje }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_assist para diagnosticar ${mensaje}; la salida debe incluir diagnóstico, evidencia principal, recovery y acciones de validación sin delegar llamadas posteriores al agente.` } }] }));

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("IBM i Docs MCP listo por stdio; runtime sin dependencia de RDi/Eclipse Help.");
}

function renderSearchResults(query: string, results: Array<any>): string {
  if (!results.length) return `Sin resultados para: ${query}`;
  return [`Resultados IBM i Docs para: ${query}`, "", ...results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    `   ID: ${result.id}`,
    `   Score: ${result.score}`,
    `   Versión/Categoría: ${result.version} / ${result.category}`,
    `   Tipo documental: ${result.documentKind ?? "n/a"} · Clave: ${result.canonicalTopicKey ?? "n/a"}`,
    `   Fuente: ${result.sourceKind} · ${result.canonicalUrl}`,
    result.requestedVersionFallback ? "   Aviso: fallback exacto fuera de la versión solicitada." : "",
    result.relevanceWarnings?.length ? `   Guardrails: ${result.relevanceWarnings.join(" | ")}` : "",
    `   Texto completo auto-adjunto: ${result.autoReadApplied ? `sí (${String(result.fullContent ?? "").length} caracteres)` : "no"}${result.textLength ? ` · tópico=${result.textLength} caracteres` : ""}`,
    result.sectionsPreview?.length ? `   Secciones previas: ${result.sectionsPreview.map((section: any) => section.kind).join(", ")}` : "",
    `   Evidencia: ${result.snippet}`
  ].filter(Boolean).join("\n"))].join("\n");
}

function renderEvidenceList(label: string, results: Array<any>): string {
  if (!results.length) return `Sin evidencia para: ${label}`;
  return [`Evidencia IBM i Docs para: ${label}`, "", ...results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    `   ID: ${result.id}`,
    `   Score: ${result.score}`,
    `   Versión/Categoría: ${result.version} / ${result.category}`,
    `   Fuente: ${result.sourceKind} · ${result.canonicalUrl}`,
    result.requestedVersionFallback ? "   Aviso: fallback exacto fuera de la versión solicitada." : "",
    result.relevanceWarnings?.length ? `   Guardrails: ${result.relevanceWarnings.join(" | ")}` : "",
    `   Evidencia: ${result.snippet}`
  ].filter(Boolean).join("\n"))].join("\n");
}

function renderAssist(assist: any): string {
  return [
    assist.answer,
    "",
    "Resumen estructurado:",
    `- Intención: ${assist.intent}`,
    `- Confianza: ${assist.confidence}`,
    `- Plan agéntico: ${assist.retrievalPlan?.strategy ?? "n/a"}; ejes=${assist.retrievalPlan?.axes?.join(", ") ?? "n/a"}; hops=${assist.retrievalPlan?.hops?.length ?? 0}; follow-ups=${assist.retrievalPlan?.followUpQueries?.length ?? 0}`,
    `- Cobertura: ${assist.coverage?.status ?? "n/a"} (${assist.coverage?.evidenceCount ?? 0} evidencias, ${assist.coverage?.readCount ?? 0} lecturas, ${assist.coverage?.sectionCount ?? 0} secciones)`,
    assist.warnings?.length ? `- Advertencias: ${assist.warnings.slice(0, 4).join(" | ")}` : "- Advertencias: n/a"
  ].join("\n");
}

function renderResolve(resolved: any): string {
  return [
    `Consulta: ${resolved.question}`,
    `Intención: ${resolved.intent}`,
    `Confianza: ${resolved.confidence}`,
    `Política: ${resolved.policy?.description ?? "n/a"}`,
    "",
    resolved.answer,
    "",
    "Workflow ejecutado:",
    ...(resolved.stages as Array<any>).map((stage) => `- [${stage.status}] ${stage.tool}: ${stage.reason}${stage.outputSummary ? ` (${stage.outputSummary})` : ""}`),
    "",
    "Citas:",
    bullet((resolved.citations as Array<any>).map((citation) => `${citation.title} (${citation.id}, ${citation.version}, ${citation.sourceKind})`)),
    "",
    "Advertencias:",
    bullet(resolved.warnings)
  ].join("\n");
}

function renderReadResult(result: any): string {
  return [`Título: ${result.title}`, `ID: ${result.id}`, `Versión/Categoría: ${result.version} / ${result.category}`, `Taxonomía: ${result.taxonomy?.kind ?? "n/a"} · ${result.taxonomy?.label ?? "n/a"}`, `Fuente: ${result.sourceKind} · ${result.canonicalUrl}`, `SHA-256: ${result.sha256}`, "", String(result.content ?? "")].join("\n");
}

function renderSections(result: any): string {
  const topic = result.topic;
  const sections = result.sections as Array<{ kind: string; title: string; content: string; startLine: number; endLine: number }>;
  return [`Secciones para: ${topic.title} (${topic.id})`, "", ...sections.map((section, index) => [
    `${index + 1}. [${section.kind}] ${section.title} · líneas ${section.startLine}-${section.endLine}`,
    section.content.slice(0, 700)
  ].join("\n"))].join("\n\n");
}

function renderAnswer(answer: any): string {
  return [
    `Pregunta: ${answer.question}`,
    `Confianza: ${answer.confidence}`,
    "",
    answer.answer,
    "",
    "Citas:",
    bullet((answer.citations as Array<any>).map((citation) => `${citation.title} (${citation.id}, ${citation.version}, ${citation.sourceKind})`)),
    "",
    "Advertencias:",
    bullet(answer.warnings)
  ].join("\n");
}

function renderContext(context: any): string {
  return [
    `Contexto IBM i para: ${context.task}`,
    "",
    context.answer,
    "",
    "Intención:",
    JSON.stringify(context.intent, null, 2),
    "",
    "Workflow interno ejecutado:",
    bullet((context.appliedWorkflow as Array<any>).map((stage) => `[${stage.status}] ${stage.reason}${stage.outputSummary ? ` (${stage.outputSummary})` : ""}`)),
    "",
    "Acciones técnicas sugeridas:",
    bullet(context.actionItems),
    "",
    "Comandos sugeridos:",
    bullet(context.compileCommands),
    "",
    "Opciones a revisar:",
    bullet(context.optionsToReview),
    "",
    "Lecturas materializadas:",
    bullet((context.reads as Array<any>).map((read) => `${read.title} (${read.id}, ${read.version}, ${read.textLength} caracteres)`)),
    "",
    "Secciones enfocadas:",
    bullet((context.sections as Array<any>).flatMap((topic) => (topic.sections as Array<any>).map((section) => `${topic.title} > ${section.title} [${section.kind}]`))),
    "",
    "Riesgos/pitfalls:",
    bullet(context.pitfalls),
    "",
    renderEvidenceList("evidencia contextual", context.evidence as Array<any>),
    "",
    "Advertencias:",
    bullet(context.warnings)
  ].join("\n");
}

function renderCompileGuidance(guidance: any): string {
  return [`Guía de compilación ${guidance.language} -> ${guidance.target}`, "", "Comandos recomendados:", bullet(guidance.recommendedCommands), "", "Comandos relacionados:", bullet(guidance.relatedCommands), "", "Opciones a revisar:", bullet(guidance.optionsToReview), "", "Pitfalls:", bullet(guidance.pitfalls), "", renderEvidenceList("evidencia de compilación", guidance.evidence as Array<any>)].join("\n");
}

function renderMessageExplanation(explanation: any): string {
  return [
    `Mensaje: ${explanation.messageId}`,
    `Familia/Categoría: ${explanation.family} / ${explanation.category}`,
    `Cobertura: ${explanation.coverageStatus ?? "n/a"}${explanation.exactMatch === false ? " (sin entrada exacta)" : ""}`,
    `Resumen: ${explanation.summary}`,
    ...(explanation.warnings?.length ? ["", "Advertencias:", bullet(explanation.warnings)] : []),
    "",
    "Recovery checklist:",
    bullet(explanation.recoveryChecklist),
    "",
    renderEvidenceList(String(explanation.messageId), explanation.evidence as Array<any>)
  ].join("\n");
}

function renderRelated(related: any): string {
  const topic = related.topic as { title?: string; id?: string } | null;
  return [`Tópico base: ${topic?.title ?? "no encontrado"} (${topic?.id ?? "sin id"})`, "", "Equivalentes por versión:", renderEvidenceList("equivalentes", related.equivalentVersions as Array<any>), "", "Relacionados:", renderEvidenceList("relacionados", related.related as Array<any>)].join("\n");
}

function renderVersionComparison(comparison: any): string {
  const entries = comparison.versions as Array<{ version: string; found: boolean; result?: { title: string; id: string }; notes: string[] }>;
  return [`Comparación de versiones para: ${comparison.query}`, "", ...entries.map((entry) => [
    `- ${entry.version}: ${entry.found ? `${entry.result?.title} (${entry.result?.id})` : "sin resultado"}`,
    ...entry.notes.map((note) => `  - ${note}`)
  ].join("\n")), "", renderEvidenceList("evidencia comparativa", comparison.evidence as Array<any>)].join("\n");
}

function renderRankingExplanation(explanation: any): string {
  return [
    `Ranking para: ${explanation.query}`,
    `FTS: ${explanation.ftsQuery}`,
    `Expansiones: ${(explanation.semanticQueries as string[]).join(" | ") || "n/a"}`,
    `Términos exactos: ${(explanation.exactTerms as string[]).join(", ") || "n/a"}`,
    "",
    ...(explanation.results as Array<any>).map((item, index) => [
      `${index + 1}. ${item.hit.title} · score=${item.hit.score} · ${item.taxonomy.kind} · ${item.documentKind ?? item.hit.documentKind ?? "n/a"}`,
      ...item.reasons.map((reason: string) => `   - ${reason}`),
      ...((item.relevanceWarnings as string[] | undefined) ?? item.hit.relevanceWarnings ?? []).map((warning: string) => `   - guardrail: ${warning}`)
    ].join("\n"))
  ].join("\n");
}

function renderQualityReport(report: any): string {
  return [
    `Calidad del corpus: ${report.ok ? "OK" : "REVISAR"}`,
    `Corpus: ${report.corpusVersion}`,
    `Documentos/chunks: ${report.documents}/${report.chunks}`,
    "",
    "Categorías:",
    JSON.stringify(report.coverage.byCategory, null, 2),
    "",
    "Tipos documentales:",
    JSON.stringify(report.documentKinds, null, 2),
    "",
    "Tópicos cortos destacados:",
    bullet((report.shortDocuments as Array<any>).slice(0, 10).map((doc) => `${doc.title} (${doc.id}) · ${doc.textLength} chars`)),
    "",
    "Duplicados canónicos destacados:",
    bullet((report.duplicateCanonicalTopics as Array<any>).slice(0, 10).map((item) => `${item.canonicalTopicKey} · ${item.count} docs · ${item.versions.join(", ")}`)),
    "",
    "Recomendaciones:",
    bullet(report.recommendations)
  ].join("\n");
}

function renderRecipes(recipes: Array<any>): string {
  return ["Recetas IBM i Docs:", "", ...recipes.map((recipe) => [
    `- ${recipe.title} (${recipe.id})`,
    `  Prompt: ${recipe.prompt}`,
    `  Tools: ${(recipe.tools as string[]).join(", ")}`,
    `  Resultado: ${recipe.expectedOutcome}`
  ].join("\n"))].join("\n\n");
}

function renderCodeValidation(validation: any): string {
  const findings = validation.findings as Array<{ severity: string; title: string; detail: string }>;
  return [`Validación documental para ${validation.language}`, `Señales: ${(validation.detectedSignals as string[]).join(", ") || "sin señales"}`, "", "Hallazgos:", ...findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.detail}`), "", renderEvidenceList("evidencia de validación", validation.evidence as Array<any>)].join("\n");
}

function renderTraceReport(report: any): string {
  return [
    `Trace IBM i Docs: ${report.enabled ? "activo" : "inactivo"}`,
    `Archivo: ${report.traceFile}`,
    `Eventos: ${report.events}`,
    `Search events: ${report.searchEvents}`,
    `Search-only rate: ${report.searchOnlyRate}%`,
    `Search->read rate: ${report.searchThenReadRate}%`,
    `Answer usage rate: ${report.answerUsageRate}%`,
    `Resolve usage rate: ${report.resolveUsageRate}%`,
    "",
    "Por tool:",
    JSON.stringify(report.byTool, null, 2),
    "",
    "Recientes:",
    ...((report.recent as Array<any>) ?? []).slice(-10).map((event) => `- ${event.timestamp} ${event.tool} ${event.query ?? event.id ?? ""} (${event.durationMs} ms)`)
  ].join("\n");
}

function sanitizeAgentHit(hit: any): any {
  if (!hit || typeof hit !== "object") return hit;
  const {
    readHint: _readHint,
    nextRecommendedTool: _nextRecommendedTool,
    nextRecommendedReason: _nextRecommendedReason,
    nextRecommendedArguments: _nextRecommendedArguments,
    workflowHints: _workflowHints,
    ...safeHit
  } = hit;
  return safeHit;
}

function structured(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function bullet(value: unknown): string {
  const items = Array.isArray(value) ? value : [];
  return items.length ? items.map((item) => `- ${String(item)}`).join("\n") : "- n/a";
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
