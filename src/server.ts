#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CorpusRepository } from "./repository/CorpusRepository.js";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";
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
    { name: "ibmi-docs-mcp", version: "0.2.0" },
    {
      instructions:
        "Usa estas herramientas para contrastar respuestas sobre IBM i/AS400, RPGLE, SQLRPGLE, CLLE, DDS, Db2 for i y mensajes RNF contra documentación local oficial. El runtime no depende de RDi ni Eclipse Help."
    }
  );

  server.registerTool(
    "ibmi_docs_search",
    {
      title: "Buscar documentación IBM i",
      description: "Busca en el corpus local IBM i/AS400 con SQLite FTS5, ranking heurístico y evidencia trazable.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Consulta técnica: CRTRPGMOD, RNF0004, CLLE, DDS PF, SQLRPGLE, etc."),
        version: z.string().optional().describe("Versión IBM i opcional, por ejemplo 7.4, 7.5 o 7.6."),
        category: z.string().optional().describe("Categoría opcional: ile-rpg, cl-clle, dds, sql-db2-for-i, mensajes-rnf."),
        limit: z.number().int().min(1).max(50).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, version, category, limit }) => {
      const results = withRepository((repo) => repo.search({ query, version, category, limit }));
      return { content: [{ type: "text" as const, text: renderSearchResults(query, results) }], structuredContent: structured({ query, results }) };
    }
  );

  server.registerTool(
    "ibmi_docs_read",
    {
      title: "Leer tópico IBM i",
      description: "Lee el contenido completo normalizado de un tópico previamente localizado por ibmi_docs_search.",
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
    "ibmi_docs_context",
    {
      title: "Resolver contexto IBM i",
      description: "Genera un paquete contextual agéntico con intención, docs, comandos, riesgos, notas de versión y evidencia.",
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
    "ibmi_docs_sync",
    {
      title: "Sincronizar IBM Docs público",
      description: "Refresca el data pack solo desde IBM Docs público. Nunca usa RDi local ni Eclipse Help.",
      inputSchema: z.object({
        maxPagesPerVersion: z.number().int().min(1).max(2000).optional(),
        versions: z.array(z.string()).optional()
      })
    },
    async ({ maxPagesPerVersion, versions }) => {
      if (process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC !== "1") {
        return {
          content: [{ type: "text" as const, text: "Sync público deshabilitado por defecto. Define IBMI_DOCS_ALLOW_NETWORK_SYNC=1 para permitir descarga desde IBM Docs. No se usará RDi local." }],
          structuredContent: structured({ enabled: false, sourcePolicy: "ibm-docs-only" })
        };
      }
      const cacheDir = path.resolve("data", "ibm-docs-cache");
      await syncIbmDocs({ outDir: cacheDir, versions, maxPagesPerVersion: maxPagesPerVersion ?? 160 });
      const manifest = await buildDataPack({ inputDir: path.resolve("data"), outDir: packDir });
      return {
        content: [{ type: "text" as const, text: `Sync IBM Docs completado. Documentos: ${manifest.documents.length}. Fuente: IBM Docs público; RDi local no usado.` }],
        structuredContent: structured({ enabled: true, documents: manifest.documents.length, sourcePolicy: "ibm-docs-only" })
      };
    }
  );

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
    description: "Prompt para obligar al agente a contrastar con el MCP antes de responder sobre IBM i.",
    argsSchema: { consulta: z.string().min(1) }
  }, ({ consulta }) => ({ messages: [{ role: "user", content: { type: "text", text: `Busca en ibmi_docs_search evidencia para: ${consulta}. Después responde citando título, versión y fuente.` } }] }));

  server.registerPrompt("revisar-codigo-rpgle-con-docs", {
    title: "Revisar RPGLE con documentación",
    description: "Prompt para revisar código RPGLE con ayuda IBM i.",
    argsSchema: { codigo: z.string().min(1) }
  }, ({ codigo }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_validate_code_context con lenguaje RPGLE y revisa este código contra documentación oficial:\n\n${codigo}` } }] }));

  server.registerPrompt("diagnosticar-error-rnf", {
    title: "Diagnosticar RNF",
    description: "Prompt para diagnosticar mensajes RNF con causa y recovery.",
    argsSchema: { mensaje: z.string().min(1) }
  }, ({ mensaje }) => ({ messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_explain_message para ${mensaje} y resume causa, recovery y acciones de validación.` } }] }));

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
    `   Fuente: ${result.sourceKind} · ${result.canonicalUrl}`,
    // La búsqueda entrega evidencia resumida; esta pista evita que el agente confunda el snippet con el tópico completo.
    `   Lectura completa: usa ibmi_docs_read con id="${result.id}"${result.textLength ? ` (${result.textLength} caracteres)` : ""}`,
    `   Evidencia: ${result.snippet}`
  ].join("\n"))].join("\n");
}

function renderReadResult(result: any): string {
  return [`Título: ${result.title}`, `ID: ${result.id}`, `Versión/Categoría: ${result.version} / ${result.category}`, `Fuente: ${result.sourceKind} · ${result.canonicalUrl}`, `SHA-256: ${result.sha256}`, "", String(result.content ?? "")].join("\n");
}

function renderContext(context: any): string {
  return [`Contexto IBM i para: ${context.task}`, "", "Intención:", JSON.stringify(context.intent, null, 2), "", "Comandos sugeridos:", bullet(context.compileCommands), "", "Opciones a revisar:", bullet(context.optionsToReview), "", "Riesgos/pitfalls:", bullet(context.pitfalls), "", renderSearchResults("evidencia contextual", context.evidence as Array<any>)].join("\n");
}

function renderCompileGuidance(guidance: any): string {
  return [`Guía de compilación ${guidance.language} -> ${guidance.target}`, "", "Comandos recomendados:", bullet(guidance.recommendedCommands), "", "Comandos relacionados:", bullet(guidance.relatedCommands), "", "Opciones a revisar:", bullet(guidance.optionsToReview), "", "Pitfalls:", bullet(guidance.pitfalls), "", renderSearchResults("evidencia de compilación", guidance.evidence as Array<any>)].join("\n");
}

function renderMessageExplanation(explanation: any): string {
  return [`Mensaje: ${explanation.messageId}`, `Familia/Categoría: ${explanation.family} / ${explanation.category}`, `Resumen: ${explanation.summary}`, "", "Recovery checklist:", bullet(explanation.recoveryChecklist), "", renderSearchResults(String(explanation.messageId), explanation.evidence as Array<any>)].join("\n");
}

function renderRelated(related: any): string {
  const topic = related.topic as { title?: string; id?: string } | null;
  return [`Tópico base: ${topic?.title ?? "no encontrado"} (${topic?.id ?? "sin id"})`, "", "Equivalentes por versión:", renderSearchResults("equivalentes", related.equivalentVersions as Array<any>), "", "Relacionados:", renderSearchResults("relacionados", related.related as Array<any>)].join("\n");
}

function renderVersionComparison(comparison: any): string {
  const entries = comparison.versions as Array<{ version: string; found: boolean; result?: { title: string; id: string } }>;
  return [`Comparación de versiones para: ${comparison.query}`, "", ...entries.map((entry) => `- ${entry.version}: ${entry.found ? `${entry.result?.title} (${entry.result?.id})` : "sin resultado"}`), "", renderSearchResults("evidencia comparativa", comparison.evidence as Array<any>)].join("\n");
}

function renderCodeValidation(validation: any): string {
  const findings = validation.findings as Array<{ severity: string; title: string; detail: string }>;
  return [`Validación documental para ${validation.language}`, `Señales: ${(validation.detectedSignals as string[]).join(", ") || "sin señales"}`, "", "Hallazgos:", ...findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.detail}`), "", renderSearchResults("evidencia de validación", validation.evidence as Array<any>)].join("\n");
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
