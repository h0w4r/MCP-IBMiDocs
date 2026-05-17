import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackResolution {
  packDir: string;
  source: "env" | "cwd" | "user" | "bundled" | "default-user";
  checked: string[];
}

export function defaultUserPackDir(): string {
  return path.join(os.homedir(), ".ibmi-docs", "pack");
}

export function hasPack(dir: string): boolean {
  return fs.existsSync(path.join(dir, "ibmi-docs.sqlite")) && fs.existsSync(path.join(dir, "manifest.json"));
}

export function resolvePackDir(moduleUrl: string, explicit?: string): PackResolution {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const checked: string[] = [];
  const candidates: Array<{ source: PackResolution["source"]; dir: string; force?: boolean }> = [
    explicit ? { source: "env", dir: explicit, force: true } : undefined,
    process.env.IBMI_DOCS_PACK_DIR ? { source: "env", dir: process.env.IBMI_DOCS_PACK_DIR, force: true } : undefined,
    { source: "cwd", dir: path.resolve("data", "pack") },
    { source: "user", dir: defaultUserPackDir() },
    { source: "bundled", dir: path.resolve(moduleDir, "..", "..", "data", "pack") }
  ].filter(Boolean) as Array<{ source: PackResolution["source"]; dir: string; force?: boolean }>;

  for (const candidate of candidates) {
    const dir = path.resolve(candidate.dir);
    checked.push(dir);
    if (candidate.force || hasPack(dir)) return { packDir: dir, source: candidate.source, checked };
  }
  return { packDir: defaultUserPackDir(), source: "default-user", checked };
}
