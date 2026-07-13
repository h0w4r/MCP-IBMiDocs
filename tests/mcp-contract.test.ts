import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_CODE_CHARS, MAX_QUESTION_CHARS } from "../src/util/inputLimits.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(ROOT_DIR, "dist", "src", "server.js");
const PACK_DIR = path.join(ROOT_DIR, "data", "pack");

describe("contrato MCP público agent-first", () => {
  let client: Client;

  beforeAll(async () => {
    // La prueba usa stdio real para validar exactamente lo que recibe un agente
    // externo; no invoca handlers privados ni clases del repositorio.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        IBMI_DOCS_PACK_DIR: PACK_DIR,
        IBMI_DOCS_TOOL_PROFILE: "agent",
        NO_COLOR: "1"
      } as Record<string, string>,
      stderr: "pipe"
    });
    client = new Client({ name: "ibmi-docs-contract-test", version: "1" }, { capabilities: {} });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  it("expone una sola tool con un esquema de entrada compacto", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["ibmi_docs_assist"]);
    const schema = listed.tools[0].inputSchema as {
      properties?: Record<string, { maxLength?: number }>;
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["code", "language", "question", "version"]);
    expect(schema.properties?.question?.maxLength).toBe(MAX_QUESTION_CHARS);
    expect(schema.properties?.code?.maxLength).toBe(MAX_CODE_CHARS);
  });

  it("no publica recursos ni prompts de diagnóstico en el perfil de usuario", async () => {
    // Al no anunciar esas capacidades, el protocolo responde Method not found:
    // no existe una lista vacía decorativa que el cliente pueda intentar usar.
    await expect(client.listResources()).rejects.toThrow(/Method not found/i);
    await expect(client.listPrompts()).rejects.toThrow(/Method not found/i);
  });

  it("devuelve un único texto final sin structuredContent ni telemetría interna", async () => {
    const result = await client.callTool({
      name: "ibmi_docs_assist",
      arguments: { question: "What is the command used to invoke RLU?" }
    }, undefined, { timeout: 180_000 });

    expect(result.structuredContent).toBeUndefined();
    const content = (result as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    const block = content[0] as { type: string; text?: string };
    expect(block.type).toBe("text");
    expect(block.text).toMatch(/STRRLU|Start Report Layout Utility/i);
    expect(block.text).not.toMatch(/retrievalPlan|taskPlan|semanticScore|Resumen estructurado|Score:|ID:/i);
  }, 180_000);

  it("declara falta de soporte en vez de responder con documentación tangencial", async () => {
    const result = await client.callTool({
      name: "ibmi_docs_assist",
      arguments: { question: "Evalúa si una herramienta MCP debe devolver JSON o solo una respuesta final" }
    }, undefined, { timeout: 180_000 });
    const content = (result as { content: unknown[] }).content;
    const block = content[0] as { type: string; text?: string };

    expect(result.structuredContent).toBeUndefined();
    expect(block.text).toMatch(/No encontré evidencia documental suficientemente relacionada/i);
    expect(block.text).not.toMatch(/DDS8196|Workstation I\/O|SQL messages/i);
  }, 180_000);
});
