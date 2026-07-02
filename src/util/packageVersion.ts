import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@ckirsch94/ibmi-docs-mcp";

export function loadPackageVersion(fromUrl = import.meta.url): string {
  // El CLI y el servidor MCP deben reportar la versión real publicada/instalada.
  // Buscamos hacia arriba para funcionar igual desde src/ con tsx y desde dist/src/ en npm.
  let currentDir = path.dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
        if (packageJson.name === PACKAGE_NAME && typeof packageJson.version === "string") {
          return packageJson.version;
        }
      } catch {
        // Si el package.json encontrado no es legible, continuamos subiendo directorios.
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return "0.0.0-dev";
}
