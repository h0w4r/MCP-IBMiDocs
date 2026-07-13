import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackResolution {
  packDir: string;
  source: "explicit" | "env" | "cwd" | "user" | "bundled" | "default-user";
  checked: string[];
}

export function defaultUserPackDir(): string {
  return path.join(os.homedir(), ".ibmi-docs", "pack");
}

export function hasPack(dir: string): boolean {
  return fs.existsSync(path.join(dir, "ibmi-docs.sqlite")) && fs.existsSync(path.join(dir, "manifest.json"));
}

export function missingPackFiles(dir: string): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(path.join(dir, "manifest.json"))) missing.push("manifest.json");
  if (!fs.existsSync(path.join(dir, "ibmi-docs.sqlite"))) missing.push("ibmi-docs.sqlite");
  return missing;
}

/**
 * Resuelve una ruta declarada por un manifest garantizando que no escape
 * del directorio base. Protege validación, instalación y lecturas del pack.
 */
export function resolveContainedPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolvedPath;
  throw new Error(`Ruta fuera del directorio permitido: ${relativePath}`);
}

/**
 * Resuelve una ruta existente y comprueba también su destino físico. La
 * segunda comprobación impide que un enlace simbólico o junction dentro del
 * pack apunte fuera de su raíz aunque la ruta textual parezca válida.
 */
export function resolveContainedExistingPath(root: string, relativePath: string): string {
  const candidate = resolveContainedPath(root, relativePath);
  if (!fs.existsSync(candidate)) throw new Error(`No existe el archivo declarado: ${relativePath}`);

  const physicalRoot = fs.realpathSync.native(path.resolve(root));
  const physicalCandidate = fs.realpathSync.native(candidate);
  const physicalRelative = path.relative(physicalRoot, physicalCandidate);
  if (physicalRelative === "" || (!physicalRelative.startsWith("..") && !path.isAbsolute(physicalRelative))) {
    const stat = fs.statSync(physicalCandidate);
    if (!stat.isFile()) {
      throw new Error(`La ruta declarada no es un archivo regular: ${relativePath}`);
    }
    return physicalCandidate;
  }
  throw new Error(`La ruta resuelve fuera del directorio permitido: ${relativePath}`);
}

export function resolvePackDir(moduleUrl: string, explicit?: string): PackResolution {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const checked: string[] = [];
  const candidates: Array<{ source: PackResolution["source"]; dir: string; force?: boolean }> = [
    explicit ? { source: "explicit", dir: explicit, force: true } : undefined,
    process.env.IBMI_DOCS_PACK_DIR ? { source: "env", dir: process.env.IBMI_DOCS_PACK_DIR, force: true } : undefined,
    { source: "cwd", dir: path.resolve("data", "pack") },
    { source: "user", dir: defaultUserPackDir() },
    { source: "bundled", dir: path.resolve(moduleDir, "..", "..", "data", "pack") }
  ].filter(Boolean) as Array<{ source: PackResolution["source"]; dir: string; force?: boolean }>;

  for (const candidate of candidates) {
    const dir = path.resolve(candidate.dir);
    checked.push(dir);
    if (hasPack(dir)) return { packDir: dir, source: candidate.source, checked };
    if (candidate.force) {
      const origin = candidate.source === "explicit" ? "ruta explícita --pack" : "variable IBMI_DOCS_PACK_DIR";
      const missing = missingPackFiles(dir);
      throw new Error(`${origin} inválida: ${dir}. Faltan: ${missing.join(", ") || "data pack válido"}. Rutas revisadas: ${checked.join("; ")}`);
    }
  }
  return { packDir: defaultUserPackDir(), source: "default-user", checked };
}
