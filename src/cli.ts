#!/usr/bin/env node
import { Command } from "commander";
import { exportRdiHelp } from "./ingest/rdiExporter.js";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";

const program = new Command();
program
  .name("ibmi-docs")
  .description("CLI de construcción y mantenimiento del corpus local para MCP IBM i Docs.")
  .version("0.1.0");

program
  .command("export-rdi")
  .description("Exporta contenido completo desde un endpoint Eclipse/RDi Help temporal. Uso interno de construcción, no runtime.")
  .requiredOption("--base-url <url>", "Base URL temporal de Eclipse/RDi Help, por ejemplo http://127.0.0.1:52070/help")
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

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
