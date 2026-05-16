import { createHash } from "node:crypto";
import path from "node:path";
import sanitize from "sanitize-filename";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function ensureSafeFileName(value: string, fallback = "document"): string {
  const clean = sanitize(value).replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return clean.length > 0 ? clean.slice(0, 180) : fallback;
}

export function projectRoot(): string {
  return process.cwd();
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
