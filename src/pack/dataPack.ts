import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { hasPack } from "../util/paths.js";

export interface InstallDataPackOptions {
  from: string;
  outDir: string;
}

export interface ArchiveDataPackOptions {
  packDir: string;
  outFile: string;
}

export async function installDataPack(options: InstallDataPackOptions): Promise<{ outDir: string; source: string }> {
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const source = await materializeSource(options.from);

  // Si la fuente ya es un directorio de pack, copiamos tal cual; si es tgz/tar, extraemos en el destino.
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    if (!hasPack(source)) throw new Error(`El directorio fuente no parece un data pack válido: ${source}`);
    await fs.cp(source, outDir, { recursive: true, force: true });
  } else {
    await tar.x({ file: source, cwd: outDir, gzip: source.endsWith(".tgz") || source.endsWith(".gz") });
  }

  if (!hasPack(outDir)) throw new Error(`La instalación terminó, pero ${outDir} no contiene manifest.json e ibmi-docs.sqlite.`);
  return { outDir, source };
}

export async function archiveDataPack(options: ArchiveDataPackOptions): Promise<{ outFile: string }> {
  const packDir = path.resolve(options.packDir);
  if (!hasPack(packDir)) throw new Error(`No se puede archivar un pack inválido: ${packDir}`);
  const outFile = path.resolve(options.outFile);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await tar.c({ gzip: true, cwd: packDir, file: outFile }, ["."]);
  return { outFile };
}

async function materializeSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`No se pudo descargar ${source}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-docs-pack-")), path.basename(new URL(source).pathname) || "pack.tgz");
    await fs.writeFile(file, buffer);
    return file;
  }
  const local = path.resolve(source);
  if (!fsSync.existsSync(local)) throw new Error(`No existe la fuente de data pack: ${local}`);
  return local;
}
