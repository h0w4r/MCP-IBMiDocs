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
import {
  MAX_CODE_CHARS,
  MAX_DOCUMENT_ID_CHARS,
  MAX_LABEL_CHARS,
  MAX_NOTES_CHARS,
  MAX_QUESTION_CHARS,
  MAX_VERSION_ITEMS
} from "./util/inputLimits.js";

const moduleFile = fileURLToPath(import.meta.url);
const packResolution = resolvePackDir(import.meta.url);
const packDir = packResolution.packDir;

// Los mismos límites se publican en JSON Schema y se vuelven a validar en el
// repositorio. Así protegen tanto clientes MCP como consumidores TypeScript.
const questionSchema = z.string().trim().min(1).max(MAX_QUESTION_CHARS);
const optionalCodeSchema = z.string().max(MAX_CODE_CHARS).optional();
const codeSchema = z.string().min(1).max(MAX_CODE_CHARS);
const labelSchema = z.string().trim().min(1).max(MAX_LABEL_CHARS);
const optionalLabelSchema = z.string().trim().max(MAX_LABEL_CHARS).optional();
const documentIdSchema = z.string().trim().min(1).max(MAX_DOCUMENT_ID_CHARS);

type McpToolProfile = "agent" | "standard" | "full" | "maintainer";

const AGENT_PROFILE_TOOLS = new Set([
  "ibmi_docs_assist"
]);

const STANDARD_PROFILE_TOOLS = new Set([
  ...AGENT_PROFILE_TOOLS,
  "ibmi_docs_resolve",
  "ibmi_docs_answer",
  "ibmi_docs_context",
  "ibmi_docs_compile_guidance",
  "ibmi_docs_explain_message",
  "ibmi_docs_compare_versions",
  "ibmi_docs_validate_code_context"
]);

function resolveMcpToolProfile(): McpToolProfile {
  const rawProfile = String(process.env.IBMI_DOCS_TOOL_PROFILE ?? "agent").trim().toLowerCase();
  if (rawProfile === "standard" || rawProfile === "full" || rawProfile === "maintainer") {
    return rawProfile;
  }
  return "agent";
}

function shouldRegisterMcpTool(name: string, profile: McpToolProfile): boolean {
  // Sync es mantenimiento explícito: ni el perfil agent ni una variable de red aislada
  // deben exponerlo al agente usuario. Evita que el agente se bloquee llamando tools
  // operativas cuando solo necesitaba documentación.
  if (name === "ibmi_docs_sync") {
    return process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC === "1" && (profile === "full" || profile === "maintainer");
  }

  if (profile === "agent") return AGENT_PROFILE_TOOLS.has(name);
  if (profile === "standard") return STANDARD_PROFILE_TOOLS.has(name);
  return true;
}

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

async function withRepositoryAsync<T>(callback: (repo: CorpusRepository) => Promise<T>): Promise<T> {
  const repo = createRepository();
  try {
    return await callback(repo);
  } finally {
    repo.close();
  }
}

export function createServer(): McpServer {
  const toolProfile = resolveMcpToolProfile();
  const isAgentProfile = toolProfile === "agent";
  const server = new McpServer(
    { name: "ibmi-docs-mcp", version: loadPackageVersion(import.meta.url) },
    {
      instructions:
        (isAgentProfile
          ? [
              "Usa ibmi_docs_assist para cualquier consulta o tarea sobre IBM i/AS400, RPGLE, SQLRPGLE, CLLE, DDS, COBOL, Db2 for i, comandos y mensajes.",
              "Pasa la petición completa y, si existen, el código, el lenguaje y la versión.",
              "La tool realiza toda la recuperación internamente y devuelve únicamente la respuesta final; no solicites índices, scores, planes, IDs ni sub-tools."
            ]
          : [
              "Usa ibmi_docs_assist como entrada principal para consultas IBM i.",
              `Perfil MCP activo: ${toolProfile}. Las tools adicionales son para auditoría o mantenimiento explícito.`,
              "Las tools de alto nivel devuelven una respuesta final limpia; la telemetría se consulta únicamente mediante tools diagnósticas.",
              "El runtime no depende de RDi ni Eclipse Help y nunca consulta el endpoint local de bootstrap."
            ]).join(" ")
    }
  );

  const registerTool = ((name: string, config: any, handler: any) => {
    if (shouldRegisterMcpTool(name, toolProfile)) server.registerTool(name, config, handler);
  }) as McpServer["registerTool"];

  registerTool(
    "ibmi_docs_assist",
    {
      title: "Asistente IBM i one-shot",
      description: "Responde la tarea completa usando documentación IBM i local. Devuelve únicamente la respuesta final; toda búsqueda, lectura y validación ocurre internamente.",
      inputSchema: isAgentProfile
        ? z.object({
            question: questionSchema.describe("Pregunta o tarea completa sobre IBM i/AS400."),
            code: optionalCodeSchema.describe("Código relacionado, si existe."),
            language: optionalLabelSchema.describe("Lenguaje o tecnología, si se conoce."),
            version: optionalLabelSchema.describe("Versión IBM i preferida, si aplica.")
          })
        : z.object({
            question: questionSchema.describe("Pregunta o tarea completa del usuario sobre IBM i/AS400."),
            language: optionalLabelSchema.describe("Lenguaje o tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL."),
            version: optionalLabelSchema.describe("Versión IBM i preferida, por ejemplo 7.5 o 7.6."),
            category: optionalLabelSchema.describe("Categoría opcional del corpus."),
            code: optionalCodeSchema.describe("Código opcional para validación documental."),
            depth: z.enum(["concise", "standard", "deep"]).optional().describe("Nivel de detalle de la respuesta."),
            limit: z.number().int().min(1).max(12).optional()
          }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      return executeAssistTool(input);
    }
  );

  registerTool(
    "ibmi_docs_resolve",
    {
      title: "Resolver consulta IBM i con workflow agéntico",
      description: "Compatibilidad para agentes: enruta la consulta completa al orquestador neuronal de ibmi_docs_assist. Devuelve una respuesta autocontenida; no pide llamadas adicionales.",
      inputSchema: z.object({
        question: questionSchema.describe("Consulta completa del usuario sobre IBM i/AS400."),
        language: optionalLabelSchema.describe("Lenguaje o tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL."),
        version: optionalLabelSchema.describe("Versión IBM i preferida, por ejemplo 7.5 o 7.6."),
        category: optionalLabelSchema.describe("Categoría opcional del corpus."),
        code: optionalCodeSchema.describe("Código a validar documentalmente si la consulta es revisión/corrección."),
        limit: z.number().int().min(1).max(12).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      return executeAssistTool(input);
    }
  );

  registerTool(
    "ibmi_docs_search",
    {
      title: "Buscar documentación IBM i",
      description: "Descubrimiento de documentos candidatos con recuperación semántica vectorial local y evidencia trazable. Es bajo nivel; para una respuesta final usa ibmi_docs_assist, ibmi_docs_resolve, ibmi_docs_answer o ibmi_docs_context.",
      inputSchema: z.object({
        query: questionSchema.describe("Consulta técnica: CRTRPGMOD, RNF5393, CLLE, DDS PF, SQLRPGLE, etc."),
        version: optionalLabelSchema.describe("Versión IBM i opcional, por ejemplo 7.4, 7.5 o 7.6."),
        category: optionalLabelSchema.describe("Categoría opcional: ile-rpg, cl-clle, dds, sql-db2-for-i, mensajes-rnf."),
        limit: z.number().int().min(1).max(50).optional(),
        autoRead: z.boolean().optional().describe("Si true, adjunta contenido completo cuando el resultado es fuerte."),
        includeSections: z.boolean().optional().describe("Si true, agrega vista previa de secciones detectadas.")
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, version, category, limit, autoRead, includeSections }) => {
      const results = await withRepositoryAsync((repo) => repo.search({ query, version, category, limit, autoRead, includeSections }));
      return { content: [{ type: "text" as const, text: renderSearchResults(query, results) }], structuredContent: structured({ query, results }) };
    }
  );

  registerTool(
    "ibmi_docs_read",
    {
      title: "Leer tópico IBM i",
      description: "Lee el contenido completo normalizado de un tópico por ID. Útil para auditoría manual; las tools de alto nivel ya realizan esta lectura internamente cuando la necesitan.",
      inputSchema: z.object({ id: documentIdSchema.describe("ID de documento devuelto por ibmi_docs_search.") }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      const result = withRepository((repo) => repo.read(id));
      if (!result) return { content: [{ type: "text" as const, text: `No se encontró el tópico ${id}.` }], isError: true };
      return { content: [{ type: "text" as const, text: renderReadResult(result) }], structuredContent: structured({ result }) };
    }
  );

  registerTool(
    "ibmi_docs_sections",
    {
      title: "Secciones de tópico IBM i",
      description: "Extrae secciones estructurales del tópico: sintaxis, parámetros, ejemplos, notas, mensajes y referencias.",
      inputSchema: z.object({ id: documentIdSchema.describe("ID de documento devuelto por ibmi_docs_search.") }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      const result = withRepository((repo) => repo.sections(id));
      if (!result.topic) return { content: [{ type: "text" as const, text: `No se encontró el tópico ${id}.` }], isError: true };
      return { content: [{ type: "text" as const, text: renderSections(result) }], structuredContent: structured(result) };
    }
  );

  registerTool(
    "ibmi_docs_answer",
    {
      title: "Responder consulta IBM i",
      description: "Alias avanzado de ibmi_docs_assist: devuelve únicamente la respuesta técnica final.",
      inputSchema: z.object({
        question: questionSchema,
        language: optionalLabelSchema,
        version: optionalLabelSchema,
        category: optionalLabelSchema,
        limit: z.number().int().min(1).max(10).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      return executeAssistTool(input);
    }
  );

  registerTool(
    "ibmi_docs_context",
    {
      title: "Resolver contexto IBM i",
      description: "Alias avanzado de ibmi_docs_assist: procesa la tarea completa y devuelve únicamente la respuesta técnica final.",
      inputSchema: z.object({
        task: questionSchema.describe("Tarea del usuario: crear programa RPG, corregir RNFxxxx, escribir CLLE, etc."),
        language: optionalLabelSchema.describe("Lenguaje o tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL."),
        version: optionalLabelSchema.describe("Versión IBM i preferida."),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ task, language, version, limit }) => {
      return executeAssistTool({ question: task, language, version, limit });
    }
  );

  registerTool(
    "ibmi_docs_compile_guidance",
    {
      title: "Guía de compilación IBM i",
      description: "Recomienda comandos y opciones de compilación para RPGLE, SQLRPGLE, CLLE, DDS y COBOL con evidencia documental.",
      inputSchema: z.object({
        language: labelSchema,
        target: optionalLabelSchema,
        usesEmbeddedSql: z.boolean().optional(),
        usesCopybook: z.boolean().optional(),
        version: optionalLabelSchema,
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      return executeAssistTool({
        question: [
          `Necesito guía de compilación IBM i para ${input.language}.`,
          input.target ? `Target: ${input.target}.` : "",
          input.usesEmbeddedSql ? "Usa SQL embebido." : "",
          input.usesCopybook ? "Usa copybooks o /COPY /INCLUDE." : ""
        ].filter(Boolean).join(" "),
        language: input.language,
        version: input.version,
        limit: input.limit
      });
    }
  );

  registerTool(
    "ibmi_docs_explain_message",
    {
      title: "Explicar mensaje IBM i",
      description: "Busca y resume mensajes RNF/SQL/IBM i con recovery checklist y evidencia trazable.",
      inputSchema: z.object({ messageId: z.string().trim().min(3).max(MAX_LABEL_CHARS), limit: z.number().int().min(1).max(20).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ messageId, limit }) => {
      return executeAssistTool({
        question: `Diagnostica el mensaje IBM i ${messageId} con evidencia documental específica.`,
        limit
      });
    }
  );

  registerTool(
    "ibmi_docs_related",
    {
      title: "Documentos relacionados IBM i",
      description: "Devuelve equivalentes por versión y documentos vecinos de un tópico localizado.",
      inputSchema: z.object({ id: documentIdSchema, limit: z.number().int().min(1).max(20).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ id, limit }) => {
      const related = withRepository((repo) => repo.related(id, { limit }));
      return { content: [{ type: "text" as const, text: renderRelated(related) }], structuredContent: structured(related) };
    }
  );

  registerTool(
    "ibmi_docs_compare_versions",
    {
      title: "Comparar versiones IBM i",
      description: "Compara la disponibilidad de un tópico entre IBM i 7.3, 7.4, 7.5 y 7.6.",
      inputSchema: z.object({
        query: questionSchema,
        versions: z.array(labelSchema).min(1).max(MAX_VERSION_ITEMS),
        category: optionalLabelSchema,
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      return executeAssistTool({
        question: `Compara documentación IBM i para '${input.query}' en las versiones ${input.versions.join(", ")}.`,
        version: input.versions[input.versions.length - 1],
        category: input.category,
        limit: input.limit
      });
    }
  );

  registerTool(
    "ibmi_docs_explain_ranking",
    {
      title: "Explicar ranking IBM i Docs",
      description: "Explica la recuperación neuronal disponible para depurar búsquedas. En el perfil de agente se recomienda ibmi_docs_assist como entrada canónica.",
      inputSchema: z.object({
        query: questionSchema,
        version: optionalLabelSchema,
        category: optionalLabelSchema,
        top: z.number().int().min(1).max(20).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const explanation = await withRepositoryAsync((repo) => repo.explainRanking(input));
      return { content: [{ type: "text" as const, text: renderRankingExplanation(explanation) }], structuredContent: structured(explanation) };
    }
  );

  registerTool(
    "ibmi_docs_validate_code_context",
    {
      title: "Validar código contra docs IBM i",
      description: "Detecta señales en código RPGLE/SQLRPGLE/CLLE/DDS y devuelve hallazgos con evidencia documental.",
      inputSchema: z.object({
        language: labelSchema,
        code: codeSchema,
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      return executeAssistTool({
        question: `Valida este código ${input.language} contra documentación IBM i y reporta hallazgos accionables.`,
        language: input.language,
        code: input.code,
        limit: input.limit
      });
    }
  );

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
    "ibmi_docs_report_query",
    {
      title: "Reportar búsqueda/ranking IBM i Docs",
      description: "Genera un reporte reproducible para depurar una búsqueda mala con evidencia y Markdown listo para issue.",
      inputSchema: z.object({
        query: questionSchema,
        version: optionalLabelSchema,
        category: optionalLabelSchema,
        expectedTitle: optionalLabelSchema,
        expectedId: documentIdSchema.optional(),
        notes: z.string().max(MAX_NOTES_CHARS).optional(),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      const report = await withRepositoryAsync((repo) => repo.reportQuery(input));
      return { content: [{ type: "text" as const, text: report.issueMarkdown }], structuredContent: structured(report) };
    }
  );

  registerTool(
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

  registerTool(
    "ibmi_docs_diagnostics",
    {
      title: "Diagnóstico del corpus IBM i",
      description: "Muestra versión, cobertura, fuentes, ruta resuelta del pack y conteos del repositorio local.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const registeredTools = Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
      const diagnostics = withRepository((repo) => ({
        ...repo.diagnostics(),
        packResolution,
        mcpToolProfile: toolProfile,
        recommendedEntrypoint: "ibmi_docs_assist",
        registeredTools
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }], structuredContent: structured(diagnostics) };
    }
  );

  registerTool(
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
    registerTool(
      "ibmi_docs_sync",
      {
        title: "Sincronizar IBM Docs público",
        description: "Tool de mantenimiento: refresca el data pack solo desde IBM Docs público. No se registra en runtime de usuario salvo que IBMI_DOCS_ALLOW_NETWORK_SYNC=1. Nunca usa RDi local ni Eclipse Help.",
        inputSchema: z.object({
          maxPagesPerVersion: z.number().int().min(1).max(2000).optional(),
          versions: z.array(labelSchema).max(MAX_VERSION_ITEMS).optional()
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

  // Los recursos y prompts revelan detalles de corpus y operación. Se reservan para
  // perfiles avanzados para que el cliente normal solo descubra la respuesta one-shot.
  if (!isAgentProfile) {
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
      description: "Prompt avanzado para resolver una consulta IBM i mediante ibmi_docs_assist.",
      argsSchema: { consulta: questionSchema }
    }, ({ consulta }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_assist para responder esta tarea IBM i completa: ${consulta}` } }] }));

    server.registerPrompt("revisar-codigo-rpgle-con-docs", {
      title: "Revisar RPGLE con documentación",
      description: "Prompt avanzado para revisar código RPGLE con ayuda IBM i.",
      argsSchema: { codigo: codeSchema }
    }, ({ codigo }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_assist con language=RPGLE y code para revisar este código contra documentación IBM i:\n\n${codigo}` } }] }));

    server.registerPrompt("diagnosticar-error-rnf", {
      title: "Diagnosticar RNF",
      description: "Prompt avanzado para diagnosticar mensajes RNF.",
      argsSchema: { mensaje: questionSchema }
    }, ({ mensaje }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_assist para diagnosticar este mensaje IBM i: ${mensaje}` } }] }));
  }

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
      result.requestedVersionScopeExpansion ? "   Aviso: ampliación de alcance semántico fuera de la versión solicitada." : "",
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
      result.requestedVersionScopeExpansion ? "   Aviso: ampliación de alcance semántico fuera de la versión solicitada." : "",
    result.relevanceWarnings?.length ? `   Guardrails: ${result.relevanceWarnings.join(" | ")}` : "",
    `   Evidencia: ${result.snippet}`
  ].filter(Boolean).join("\n"))].join("\n");
}

async function executeAssistTool(input: any): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const assisted = await withRepositoryAsync((repo) => repo.assist(input));
    return publicAssistResult(assisted);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[ibmi-docs] Falló la recuperación neuronal: ${detail}`);
    const installationProblem = /data pack|modelo|transformer|onnx|sqlite|índice local/i.test(detail);
    return {
      content: [{
        type: "text",
        text: installationProblem
          ? "IBM i Docs no pudo consultar el corpus local porque la instalación está incompleta o desincronizada. Ejecuta `npm install -g @ckirsch94/ibmi-docs-mcp@latest` y luego `ibmi-docs doctor`."
          : "IBM i Docs no pudo completar esta consulta. Ejecuta `ibmi-docs doctor`; si el diagnóstico es correcto, reporta el caso sin incluir credenciales ni código privado."
      }],
      isError: true
    };
  }
}

function publicAssistResult(assist: any): { content: Array<{ type: "text"; text: string }> } {
  const answer = String(assist?.answer ?? "").trim();
  return {
    content: [{
      type: "text",
      text: answer || "No encontré evidencia documental suficientemente relacionada en el corpus IBM i para responder con fiabilidad."
    }]
  };
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
    `Cobertura: ${explanation.coverageStatus ?? "n/a"}${explanation.specificMatch === false ? " (sin entrada específica)" : ""}`,
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
    `Consultas neurales: ${(explanation.semanticQueries as string[]).join(" | ") || "n/a"}`,
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
    "Gate de calidad:",
    bullet((report.qualityPolicy?.checks as Array<any> ?? []).map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.actual} (${check.operator} ${check.threshold})`)),
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
    `Assist usage rate: ${report.assistUsageRate}%`,
    `Scope expansions: ${report.scopeExpansionCount ?? 0}`,
    "",
    "Feedback de ampliación de alcance:",
    bullet(((report.scopeExpansionFeedback as Array<any>) ?? []).map((item) => `${item.kind} ${item.requestedScope} -> ${item.usedScope}: ${item.improvementHint}`)),
    "",
    "Por tool:",
    JSON.stringify(report.byTool, null, 2),
    "",
    "Recientes:",
    ...((report.recent as Array<any>) ?? []).slice(-10).map((event) => `- ${event.timestamp} ${event.tool} ${event.queryPreview ?? event.queryFingerprint ?? event.id ?? ""} (${event.durationMs} ms)`)
  ].join("\n");
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
