import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTraceEvent, buildTraceReport } from "../src/repository/trace/traceStore.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.IBMI_DOCS_TRACE_INCLUDE_QUERY;
  delete process.env.IBMI_DOCS_TRACE_MAX_BYTES;
  delete process.env.IBMI_DOCS_TRACE_MAX_ROTATED_FILES;
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function traceFile(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-docs-trace-"));
  temporaryRoots.push(root);
  return path.join(root, "trace.ndjson");
}

describe("privacidad de trazas", () => {
  it("guarda fingerprint y longitud sin persistir la consulta por defecto", async () => {
    const file = await traceFile();
    const query = "Consulta interna sobre PROGRAMA_PRIVADO y password=secreto";
    appendTraceEvent(file, {
      timestamp: new Date(0).toISOString(),
      tool: "ibmi_docs_assist",
      durationMs: 10,
      query,
      semanticQueries: [query, "otra perspectiva"]
    });

    const raw = await fs.readFile(file, "utf8");
    const report = buildTraceReport(file, 10);
    expect(raw).not.toContain("PROGRAMA_PRIVADO");
    expect(raw).not.toContain("secreto");
    expect(report.recent[0].queryFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(report.recent[0].queryLength).toBe(query.length);
    expect(report.recent[0].semanticQueryCount).toBe(2);
  });

  it("solo incluye preview con opt-in y redacta secretos", async () => {
    process.env.IBMI_DOCS_TRACE_INCLUDE_QUERY = "1";
    const file = await traceFile();
    appendTraceEvent(file, {
      timestamp: new Date(0).toISOString(),
      tool: "ibmi_docs_assist",
      durationMs: 10,
      query: "Revisar RPGLE token=abc123"
    });

    const report = buildTraceReport(file, 10);
    expect(report.recent[0].queryPreview).toContain("token=[REDACTADO]");
    expect(report.recent[0].queryPreview).not.toContain("abc123");
  });

  it("redacta cabeceras, JSON, funciones de contraseña y claves privadas en preview", async () => {
    process.env.IBMI_DOCS_TRACE_INCLUDE_QUERY = "1";
    const file = await traceFile();
    const query = [
      "Authorization: Bearer bearer-secreto",
      '{"apiKey":"json-secreto","token":"otro-secreto"}',
      "PASSWORD('sql-secreto')",
      "-----BEGIN PRIVATE KEY-----",
      "contenido-privado",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    appendTraceEvent(file, {
      timestamp: new Date(0).toISOString(),
      tool: "ibmi_docs_assist",
      durationMs: 10,
      query
    });

    const preview = buildTraceReport(file, 10).recent[0].queryPreview ?? "";
    expect(preview).toContain("[REDACTADO]");
    expect(preview).not.toMatch(/bearer-secreto|json-secreto|otro-secreto|sql-secreto|contenido-privado/i);
  });

  it("limita la retención de archivos rotados", async () => {
    process.env.IBMI_DOCS_TRACE_MAX_BYTES = "120";
    process.env.IBMI_DOCS_TRACE_MAX_ROTATED_FILES = "2";
    const file = await traceFile();

    for (let index = 0; index < 8; index += 1) {
      appendTraceEvent(file, {
        timestamp: new Date(index).toISOString(),
        tool: "ibmi_docs_assist",
        durationMs: index,
        query: `consulta-${index}-${"x".repeat(180)}`
      });
    }

    const report = buildTraceReport(file, 10);
    expect(report.rotatedFiles.length).toBeLessThanOrEqual(2);
  });
});
