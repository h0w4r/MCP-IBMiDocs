import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

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
    expect(result.stdout.trim()).toBe("0.5.0");
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
    const parsed = JSON.parse(result.stdout) as { diagnostics: { exactTerms: string[] }; issueMarkdown: string };
    expect(parsed.diagnostics.exactTerms).toContain("snd-msg");
    expect(parsed.issueMarkdown).toContain("Reporte de búsqueda IBM i Docs");
  });
});
