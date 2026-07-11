import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export const SQLITE_PARTS_MANIFEST = "ibmi-docs.sqlite.parts.json";
export const DEFAULT_SQLITE_PART_SIZE = 64 * 1024 * 1024;

export interface SqlitePartRecord {
  name: string;
  size: number;
  sha256: string;
}

export interface SqlitePartsManifest {
  schemaVersion: 1;
  fileName: "ibmi-docs.sqlite";
  size: number;
  sha256: string;
  partSize: number;
  generatedAt: string;
  parts: SqlitePartRecord[];
}

/**
 * Divide SQLite sin alterar el original. Los fragmentos permiten versionar un
 * pack grande en GitHub y npm; cada instalación reconstruye y verifica el
 * archivo antes de abrirlo.
 */
export async function splitSqliteForDistribution(
  sqlitePath: string,
  partSize = DEFAULT_SQLITE_PART_SIZE
): Promise<SqlitePartsManifest> {
  const absolute = path.resolve(sqlitePath);
  const directory = path.dirname(absolute);
  const fileName = path.basename(absolute);
  const normalizedPartSize = Math.max(1024 * 1024, Math.trunc(partSize));
  await removeExistingParts(directory, fileName);

  const source = await fs.open(absolute, "r");
  const wholeDigest = crypto.createHash("sha256");
  const parts: SqlitePartRecord[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, normalizedPartSize));
  let totalSize = 0;
  let partIndex = 0;
  let output: FileHandle | undefined;
  let partDigest = crypto.createHash("sha256");
  let partBytes = 0;
  let partName = partFileName(fileName, partIndex);

  try {
    output = await fs.open(path.join(directory, partName), "w");
    while (true) {
      const remaining = normalizedPartSize - partBytes;
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      await output.write(chunk);
      wholeDigest.update(chunk);
      partDigest.update(chunk);
      totalSize += bytesRead;
      partBytes += bytesRead;

      if (partBytes === normalizedPartSize) {
        await output.close();
        output = undefined;
        parts.push({ name: partName, size: partBytes, sha256: partDigest.digest("hex") });
        partIndex += 1;
        partName = partFileName(fileName, partIndex);
        partBytes = 0;
        partDigest = crypto.createHash("sha256");
        output = await fs.open(path.join(directory, partName), "w");
      }
    }
    if (output) {
      await output.close();
      output = undefined;
    }
    if (partBytes > 0) {
      parts.push({ name: partName, size: partBytes, sha256: partDigest.digest("hex") });
    } else {
      await fs.rm(path.join(directory, partName), { force: true });
    }
  } finally {
    await output?.close().catch(() => undefined);
    await source.close();
  }

  const manifest: SqlitePartsManifest = {
    schemaVersion: 1,
    fileName: "ibmi-docs.sqlite",
    size: totalSize,
    sha256: wholeDigest.digest("hex"),
    partSize: normalizedPartSize,
    generatedAt: new Date().toISOString(),
    parts
  };
  await fs.writeFile(path.join(directory, SQLITE_PARTS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/** Reconstruye SQLite en un temporal, valida hashes y reemplaza el destino. */
export async function assembleSqliteFromParts(packDir: string): Promise<SqlitePartsManifest> {
  const directory = path.resolve(packDir);
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, SQLITE_PARTS_MANIFEST), "utf8")
  ) as SqlitePartsManifest;
  if (!manifest.parts.length) throw new Error("El manifest SQLite no declara fragmentos.");
  const destination = path.join(directory, manifest.fileName);
  const temporary = `${destination}.assemble-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { force: true });
  try {
    for (const part of manifest.parts) {
      const partPath = path.join(directory, part.name);
      const stat = await fs.stat(partPath);
      if (stat.size !== part.size || await sha256File(partPath) !== part.sha256) {
        throw new Error(`Fragmento SQLite inválido: ${part.name}`);
      }
      await appendFile(partPath, temporary);
    }
    if (await sha256File(temporary) !== manifest.sha256) {
      throw new Error("El SQLite reconstruido no coincide con el SHA-256 publicado.");
    }
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
    return manifest;
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function removeExistingParts(directory: string, fileName: string): Promise<void> {
  const entries = await fs.readdir(directory);
  await Promise.all(entries
    .filter((entry) => entry.startsWith(`${fileName}.part-`))
    .map((entry) => fs.rm(path.join(directory, entry), { force: true })));
}

function partFileName(fileName: string, index: number): string {
  return `${fileName}.part-${String(index).padStart(3, "0")}`;
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function appendFile(source: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = fsSync.createReadStream(source);
    const output = fsSync.createWriteStream(destination, { flags: "a" });
    input.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    input.pipe(output);
  });
}
