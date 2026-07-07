import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("CLI ibmi-docs", () => {
  it("mantiene --version para la versión del programa", () => {
    const result = runCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("usa --ibmi-version para filtrar release IBM i sin chocar con Commander", () => {
    const result = runCli(["search", "CRTRPGMOD", "--category", "ile-rpg", "--ibmi-version", "7.5", "--limit", "1"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{ title: string; version: string }>;
    expect(parsed[0]?.title).toContain("CRTRPGMOD");
    expect(parsed[0]?.version).toBe("7.5");
  });

  it("genera report-query reproducible para feedback comunitario", () => {
    const result = runCli(["report-query", "SND-MSG", "--category", "ile-rpg", "--expected-title", "SND-MSG", "--limit", "3"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { diagnostics: { semanticConcepts: string[]; semanticIntentHints: string[] }; issueMarkdown: string };
    expect(parsed.diagnostics.semanticConcepts.length + parsed.diagnostics.semanticIntentHints.length).toBeGreaterThan(0);
    expect(parsed.issueMarkdown).toContain("Reporte de búsqueda IBM i Docs");
  });

  it("expone comandos CLI equivalentes a tools MCP públicas", () => {
    const help = runCli(["--help"]);

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("assist");
    expect(help.stdout).toContain("context");
    expect(help.stdout).toContain("compile-guidance");
    expect(help.stdout).toContain("explain-message");
    expect(help.stdout).toContain("related");
    expect(help.stdout).toContain("compare-versions");
    expect(help.stdout).toContain("validate-code-context");
  });

  it("ejecuta comandos CLI nuevos con salida JSON reproducible", () => {
    const context = runCli(["context", "Crear programa SQLRPGLE con EXEC SQL", "--language", "SQLRPGLE", "--limit", "2"]);
    expect(context.status).toBe(0);
    expect(JSON.parse(context.stdout).intent.language).toBe("SQLRPGLE");

    const message = runCli(["explain-message", "CPF0001", "--limit", "2"]);
    expect(message.status).toBe(0);
    expect(JSON.parse(message.stdout).messageId).toBe("CPF0001");

    const comparison = runCli(["compare-versions", "CRTRPGMOD", "--versions", "7.3,7.6", "--limit", "1"]);
    expect(comparison.status).toBe(0);
    expect(JSON.parse(comparison.stdout).versions.map((entry: { version: string }) => entry.version)).toEqual(expect.arrayContaining(["7.3", "7.6"]));

    const validation = runCli(["validate-code-context", "--language", "SQLRPGLE", "--code", "exec sql select 1 from sysibm.sysdummy1;", "--limit", "2"]);
    expect(validation.status).toBe(0);
    expect(JSON.parse(validation.stdout).findings.length).toBeGreaterThan(0);
  });

  it("assist entrega salida JSON final para agentes sin pedir sub-tools manuales", () => {
    const result = runCli([
      "assist",
      "Corregir CLLE con RTVJOBA y MONMSG; necesito sintaxis, parámetros y validación",
      "--language",
      "CLLE",
      "--ibmi-version",
      "7.5",
      "--depth",
      "deep",
      "--compile",
      "--examples",
      "--limit",
      "4"
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      answer: string;
      coverage: { status: string; evidenceCount: number; readCount: number; sectionCount: number };
      implementationSteps: string[];
      validationChecklist: string[];
    };
    expect(parsed.answer).toMatch(/Resumen directo|Qué hacer|Validación/i);
    expect(parsed.answer).toMatch(/RTVJOBA|MONMSG/i);
    expect(parsed.coverage.status).not.toBe("thin");
    expect(parsed.coverage.evidenceCount).toBeGreaterThan(0);
    expect(parsed.coverage.readCount).toBeGreaterThan(0);
    expect(parsed.coverage.sectionCount).toBeGreaterThan(0);
    expect(parsed.implementationSteps.length).toBeGreaterThanOrEqual(3);
    expect(parsed.validationChecklist.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(parsed)).not.toMatch(/llama ibmi_docs_read|usa ibmi_docs_sections|Siguiente paso recomendado|Para obtener la ayuda completa/i);
  });
});
