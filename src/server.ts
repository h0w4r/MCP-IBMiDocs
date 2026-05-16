#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CorpusRepository } from "./repository/CorpusRepository.js";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";

const moduleFile = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(moduleFile);
const cwdPackDir = path.resolve("data", "pack");
const bundledPackDir = path.resolve(moduleDir, "..", "..", "data", "pack");
const packDir = process.env.IBMI_DOCS_PACK_DIR
  ? path.resolve(process.env.IBMI_DOCS_PACK_DIR)
  : fs.existsSync(path.join(cwdPackDir, "ibmi-docs.sqlite"))
    ? cwdPackDir
    : bundledPackDir;

function createRepository(): CorpusRepository {
  return new CorpusRepository(packDir);
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "ibmi-docs-mcp", version: "0.1.0" },
    {
      instructions:
        "Usa estas herramientas para contrastar respuestas sobre IBM i/AS400, RPGLE, CLLE, DDS, SQL/Db2 for i y mensajes RNF contra documentación local oficial. El runtime no depende de RDi ni Eclipse Help."
    }
  );

  server.registerTool(
    "ibmi_docs_search",
    {
      title: "Buscar documentación IBM i",
      description: "Busca en el corpus local IBM i/AS400 con SQLite FTS5 y devuelve evidencia trazable.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Consulta técnica: CRTRPGMOD, RNF0004, CLLE, DDS PF, SQLRPGLE, etc."),
        version: z.string().optional().describe("Versión IBM i opcional, por ejemplo 7.4, 7.5 o 7.6."),
        category: z.string().optional().describe("Categoría opcional: ile-rpg, cl-clle, dds, sql-db2-for-i, mensajes-rnf."),
        limit: z.number().int().min(1).max(50).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, version, category, limit }) => {
      const repo = createRepository();
      try {
        const results = repo.search({ query, version, category, limit });
        return {
          content: [{ type: "text", text: renderSearchResults(query, results as unknown as Array<{ [key: string]: unknown }>) }],
          structuredContent: { query, results }
        };
      } finally {
        repo.close();
      }
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
      const repo = createRepository();
      try {
        const result = repo.read(id);
        if (!result) return { content: [{ type: "text", text: `No se encontró el tópico ${id}.` }], isError: true };
        return {
          content: [{ type: "text", text: renderReadResult(result as unknown as { [key: string]: unknown }) }],
          structuredContent: { result }
        };
      } finally {
        repo.close();
      }
    }
  );

  server.registerTool(
    "ibmi_docs_context",
    {
      title: "Resolver contexto IBM i",
      description: "Genera una guía contextual para desarrollo/corrección IBM i usando búsquedas documentales automáticas.",
      inputSchema: z.object({
        task: z.string().min(1).describe("Tarea del usuario: crear programa RPG, corregir RNFxxxx, escribir CLLE, etc."),
        language: z.string().optional().describe("Lenguaje o tecnología: RPGLE, CLLE, DDS, SQLRPGLE, COBOL."),
        limit: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ task, language, limit }) => {
      const repo = createRepository();
      try {
        const query = [task, language].filter(Boolean).join(" ");
        const results = repo.search({ query, limit: limit ?? 8 });
        const text = [
          `Contexto documental IBM i para: ${task}`,
          language ? `Lenguaje/tecnología: ${language}` : "",
          "",
          renderSearchResults(query, results as unknown as Array<{ [key: string]: unknown }>),
          "",
          "Instrucción para el agente: antes de proponer código o corrección, usa los tópicos citados como evidencia y menciona versión/fuente cuando aplique."
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }], structuredContent: { query, results } };
      } finally {
        repo.close();
      }
    }
  );

  server.registerTool(
    "ibmi_docs_diagnostics",
    {
      title: "Diagnóstico del corpus IBM i",
      description: "Muestra versión, cobertura, fuentes y conteos del repositorio local.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      const repo = createRepository();
      try {
        const diagnostics = repo.diagnostics();
        return { content: [{ type: "text", text: JSON.stringify(diagnostics, null, 2) }], structuredContent: diagnostics };
      } finally {
        repo.close();
      }
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
          content: [{ type: "text", text: "Sync público deshabilitado por defecto. Define IBMI_DOCS_ALLOW_NETWORK_SYNC=1 para permitir descarga desde IBM Docs. No se usará RDi local." }],
          structuredContent: { enabled: false, sourcePolicy: "ibm-docs-only" }
        };
      }
      const cacheDir = path.resolve("data", "ibm-docs-cache");
      await syncIbmDocs({ outDir: cacheDir, versions, maxPagesPerVersion: maxPagesPerVersion ?? 160 });
      const manifest = await buildDataPack({ inputDir: path.resolve("data"), outDir: packDir });
      return {
        content: [{ type: "text", text: `Sync IBM Docs completado. Documentos: ${manifest.documents.length}. Fuente: IBM Docs público; RDi local no usado.` }],
        structuredContent: { enabled: true, documents: manifest.documents.length, sourcePolicy: "ibm-docs-only" }
      };
    }
  );

  server.registerResource(
    "ibmi-docs-manifest",
    "ibmi-docs://manifest",
    { title: "Manifest del corpus IBM i", mimeType: "application/json" },
    async (uri) => {
      const repo = createRepository();
      try {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(repo.manifest(), null, 2) }] };
      } finally {
        repo.close();
      }
    }
  );

  server.registerResource(
    "ibmi-docs-topic",
    new ResourceTemplate("ibmi-docs://topic/{id}", { list: undefined }),
    { title: "Tópico IBM i", mimeType: "text/plain" },
    async (uri, variables) => {
      const repo = createRepository();
      try {
        const idValue = variables.id;
        const id = Array.isArray(idValue) ? idValue[0] : idValue;
        const result = repo.read(String(id));
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: result?.content ?? `No se encontró ${String(id)}` }] };
      } finally {
        repo.close();
      }
    }
  );

  server.registerResource(
    "ibmi-docs-coverage",
    "ibmi-docs://coverage",
    { title: "Cobertura IBM i Docs", mimeType: "application/json" },
    async (uri) => {
      const repo = createRepository();
      try {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(repo.diagnostics(), null, 2) }] };
      } finally {
        repo.close();
      }
    }
  );

  server.registerPrompt(
    "consultar-documentacion-ibmi",
    {
      title: "Consultar documentación IBM i",
      description: "Prompt para obligar al agente a contrastar con el MCP antes de responder sobre IBM i.",
      argsSchema: { consulta: z.string().min(1) }
    },
    ({ consulta }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Busca en ibmi_docs_search evidencia para: ${consulta}. Después responde citando título, versión y fuente.` } }]
    })
  );

  server.registerPrompt(
    "revisar-codigo-rpgle-con-docs",
    {
      title: "Revisar RPGLE con documentación",
      description: "Prompt para revisar código RPGLE con ayuda IBM i.",
      argsSchema: { codigo: z.string().min(1) }
    },
    ({ codigo }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Usa ibmi_docs_context con lenguaje RPGLE y revisa este código contra documentación oficial:\n\n${codigo}` } }]
    })
  );

  server.registerPrompt(
    "diagnosticar-error-rnf",
    {
      title: "Diagnosticar RNF",
      description: "Prompt para diagnosticar mensajes RNF con causa y recovery.",
      argsSchema: { mensaje: z.string().min(1) }
    },
    ({ mensaje }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Busca ${mensaje} con ibmi_docs_search y resume causa, recovery y acciones de validación.` } }]
    })
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("IBM i Docs MCP listo por stdio; runtime sin dependencia de RDi/Eclipse Help.");
}

function renderSearchResults(query: string, results: Array<{ [key: string]: unknown }>): string {
  if (!results.length) return `Sin resultados para: ${query}`;
  return [
    `Resultados IBM i Docs para: ${query}`,
    "",
    ...results.map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        `   ID: ${result.id}`,
        `   Versión/Categoría: ${result.version} / ${result.category}`,
        `   Fuente: ${result.sourceKind} · ${result.canonicalUrl}`,
        `   Evidencia: ${result.snippet}`
      ].join("\n")
    )
  ].join("\n");
}

function renderReadResult(result: { [key: string]: unknown }): string {
  return [
    `Título: ${result.title}`,
    `ID: ${result.id}`,
    `Versión/Categoría: ${result.version} / ${result.category}`,
    `Fuente: ${result.sourceKind} · ${result.canonicalUrl}`,
    `SHA-256: ${result.sha256}`,
    "",
    String(result.content ?? "")
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

