#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { exportRdiHelp } from "./ingest/rdiExporter.js";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";
import { CorpusRepository } from "./repository/CorpusRepository.js";
import { archiveDataPack, installDataPack } from "./pack/dataPack.js";
import { defaultUserPackDir, resolvePackDir } from "./util/paths.js";

const program = new Command();
program
  .name("ibmi-docs")
  .description("CLI de construcción, validación y consulta del corpus local para MCP IBM i Docs.")
  .version("0.2.0");

program
  .command("export-rdi")
  .description("Exporta contenido completo desde un endpoint Eclipse/RDi Help temporal. Uso interno de construcción, no runtime.")
  .requiredOption("--base-url <url>", "Base URL temporal de Eclipse/RDi Help, por ejemplo http://<host>:<puerto>/help")
  .option("--out <dir>", "Directorio de salida", "data/rdi-export")
  .option("--max-topics <n>", "Máximo de nodos/tópicos de TOC a recorrer", "30000")
  .option("--concurrency <n>", "Descargas paralelas", "8")
  .action(async (opts) => {
    const manifest = await exportRdiHelp({
      baseUrl: String(opts.baseUrl),
      outDir: String(opts.out),
      maxTopics: Number(opts.maxTopics),
      concurrency: Number(opts.concurrency)
    });
    console.error(`Exportación RDi completada: ${manifest.documents.length} documentos en ${opts.out}`);
  });

program
  .command("sync-ibm")
  .description("Sincroniza documentación pública IBM Docs. No usa RDi ni endpoints locales.")
  .option("--out <dir>", "Directorio de salida", "data/ibm-docs-cache")
  .option("--versions <list>", "Versiones IBM i separadas por coma", "7.3.0,7.4.0,7.5.0,7.6.0")
  .option("--max-pages-per-version <n>", "Límite de páginas por versión", "160")
  .option("--concurrency <n>", "Descargas paralelas", "5")
  .action(async (opts) => {
    const versions = String(opts.versions).split(",").map((value) => value.trim()).filter(Boolean);
    const manifest = await syncIbmDocs({
      outDir: String(opts.out),
      versions,
      maxPagesPerVersion: Number(opts.maxPagesPerVersion),
      concurrency: Number(opts.concurrency)
    });
    console.error(`Sync IBM Docs completado: ${manifest.documents.length} documentos en ${opts.out}`);
  });

program
  .command("build-pack")
  .description("Construye data/pack con HTML, texto normalizado, manifest y SQLite FTS5.")
  .option("--input <dir>", "Directorio base con rdi-export e ibm-docs-cache", "data")
  .option("--out <dir>", "Directorio final del data pack", "data/pack")
  .action(async (opts) => {
    const manifest = await buildDataPack({ inputDir: String(opts.input), outDir: String(opts.out) });
    console.error(`Data pack construido: ${manifest.documents.length} documentos en ${opts.out}`);
  });

program
  .command("diagnostics")
  .description("Muestra diagnóstico del corpus local resuelto.")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo, resolution) => printJson({ ...repo.diagnostics(), packResolution: resolution })));

program
  .command("search")
  .description("Busca documentación desde la CLI.")
  .argument("<query>", "Consulta técnica")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--category <category>", "Categoría")
  .option("--version <version>", "Versión IBM i")
  .option("--limit <n>", "Límite", "8")
  .action((query, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.search({ query, category: opts.category, version: opts.version, limit: Number(opts.limit) }))));

program
  .command("read")
  .description("Lee un tópico por ID.")
  .argument("<id>", "ID de documento")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((id, opts) => withRepo(String(opts.pack ?? ""), (repo) => {
    const result = repo.read(id);
    if (!result) throw new Error(`No se encontró ${id}`);
    console.log(result.content);
  }));

program
  .command("validate-pack")
  .description("Valida integridad del data pack local.")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo) => {
    const diagnostics = repo.packDiagnostics();
    printJson(diagnostics);
    if (!diagnostics.ok) process.exitCode = 1;
  }));

program
  .command("doctor")
  .description("Diagnóstico rápido de instalación CLI/MCP: ruta de pack, integridad y política anti-RDi runtime.")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo, resolution) => {
    const pack = repo.packDiagnostics();
    printJson({ ok: pack.ok, packResolution: resolution, pack, runtimePolicy: "Sin RDi, sin Eclipse Help, sin endpoint local de RDi" });
    if (!pack.ok) process.exitCode = 1;
  }));

program
  .command("codex-config")
  .description("Genera bloque TOML para instalar este MCP en Codex.")
  .option("--pack <dir>", "Ruta del data pack", defaultUserPackDir())
  .option("--command <path>", "Ruta de node", process.execPath)
  .option("--server <path>", "Ruta del server compilado", path.resolve("dist", "src", "server.js"))
  .option("--cwd <dir>", "Directorio de trabajo", process.cwd())
  .action((opts) => {
    console.log(renderCodexConfig({ command: opts.command, server: opts.server, cwd: opts.cwd, pack: opts.pack }));
  });

const pack = program.command("pack").description("Gestión de data packs externos/release assets.");
pack
  .command("install")
  .description("Instala un data pack desde directorio local, .tar/.tgz o URL de release asset.")
  .requiredOption("--from <source>", "Directorio, .tgz/.tar o URL")
  .option("--out <dir>", "Destino", defaultUserPackDir())
  .action(async (opts) => {
    const result = await installDataPack({ from: String(opts.from), outDir: String(opts.out) });
    printJson(result);
  });

pack
  .command("archive")
  .description("Crea un release asset .tgz desde un data pack local.")
  .option("--pack <dir>", "Ruta del pack", "data/pack")
  .option("--out <file>", "Archivo .tgz", "dist/ibmi-docs-pack.tgz")
  .action(async (opts) => {
    const result = await archiveDataPack({ packDir: String(opts.pack), outFile: String(opts.out) });
    printJson(result);
  });

function withRepo<T>(explicitPack: string, callback: (repo: CorpusRepository, resolution: ReturnType<typeof resolvePackDir>) => T): T {
  const resolution = resolvePackDir(import.meta.url, explicitPack || undefined);
  const repo = new CorpusRepository(resolution.packDir);
  try {
    return callback(repo, resolution);
  } finally {
    repo.close();
  }
}

function renderCodexConfig(input: { command: string; server: string; cwd: string; pack: string }): string {
  // TOML intencionalmente simple para que el usuario pueda copiar y pegar sin depender de herramientas externas.
  return [
    "[mcp_servers.ibmi-docs]",
    `command = '${input.command}'`,
    `args = ['${input.server}']`,
    `cwd = '${input.cwd}'`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 120.0",
    "",
    "[mcp_servers.ibmi-docs.env]",
    `IBMI_DOCS_PACK_DIR = '${input.pack}'`
  ].join("\n");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
