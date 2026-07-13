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

  it("genera configuración Codex con el servidor compilado real", () => {
    const result = runCli(["codex-config"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[mcp_servers.ibmi-docs]");
    const args = result.stdout.match(/^args = \[(.+)\]$/m);
    expect(args).toBeTruthy();
    expect(JSON.parse(args?.[1] ?? "null")).toMatch(/dist[\\/]src[\\/]server\.js/);
    expect(result.stdout).toContain('IBMI_DOCS_TOOL_PROFILE = "agent"');
  });

  it("escapa rutas con apóstrofes y backslashes como strings TOML básicos", () => {
    const pack = "C:\\Users\\O'Neil\\ibmi pack";
    const result = runCli(["codex-config", "--pack", pack]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`IBMI_DOCS_PACK_DIR = ${JSON.stringify(pack)}`);
    expect(result.stdout).not.toContain("O''Neil");
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
    const parsed = JSON.parse(result.stdout) as { diagnostics: { topResultTitle?: string; pass: boolean }; issueMarkdown: string; results: Array<{ title: string }> };
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.diagnostics.topResultTitle).toBeTruthy();
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
    expect(JSON.parse(context.stdout).taskPlan.family).toBe("neural_retrieval");

    const message = runCli(["explain-message", "CPF0001", "--limit", "2"]);
    expect(message.status).toBe(0);
    expect(JSON.parse(message.stdout).question).toContain("CPF0001");

    const comparison = runCli(["compare-versions", "CRTRPGMOD", "--versions", "7.3,7.6", "--limit", "1"]);
    expect(comparison.status).toBe(0);
    expect(JSON.parse(comparison.stdout).versions.map((entry: { version: string }) => entry.version)).toEqual(expect.arrayContaining(["7.3", "7.6"]));

    const validation = runCli(["validate-code-context", "--language", "SQLRPGLE", "--code", "exec sql select 1 from sysibm.sysdummy1;", "--limit", "2"]);
    expect(validation.status).toBe(0);
    expect(JSON.parse(validation.stdout).evidence.length).toBeGreaterThan(0);
  }, 360_000);

  it("assist entrega solo la respuesta final salvo diagnóstico explícito", () => {
    const result = runCli([
      "assist",
      "What is the command used to invoke RLU?",
      "--depth",
      "concise",
      "--limit",
      "4"
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/STRRLU|Start Report Layout Utility/i);
    expect(result.stdout).not.toMatch(/retrievalPlan|taskPlan|coverage|semanticScore|Resumen estructurado|"answer"/i);
  }, 360_000);
});
