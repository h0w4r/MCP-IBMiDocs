#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { Command } from "commander";
import { exportRdiHelp } from "./ingest/rdiExporter.js";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";
import { CorpusRepository } from "./repository/CorpusRepository.js";
import { archiveDataPack, installDataPack, installLatestDataPack, lintContribution, listCandidatePacks, verifyDataPack } from "./pack/dataPack.js";
import { defaultUserPackDir, resolvePackDir } from "./util/paths.js";

const program = new Command();
program
  .name("ibmi-docs")
  .description("CLI de construcción, validación y consulta del corpus local para MCP IBM i Docs.")
  .version("0.5.0");

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
  .option("--max-pages-per-version <n>", "Límite de páginas por versión", "500")
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
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--limit <n>", "Límite", "8")
  .option("--mode <mode>", "fts|hybrid", "hybrid")
  .option("--auto-read", "Adjunta contenido completo para resultados fuertes")
  .option("--sections", "Incluye vista previa de secciones")
  .action((query, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.search({
    query,
    category: opts.category,
    version: getIbmVersion(opts),
    limit: Number(opts.limit),
    mode: opts.mode,
    autoRead: Boolean(opts.autoRead),
    includeSections: Boolean(opts.sections)
  }))));

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
  .command("sections")
  .description("Extrae secciones estructurales de un tópico.")
  .argument("<id>", "ID de documento")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((id, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.sections(id))));

program
  .command("answer")
  .description("Genera una respuesta extractiva con citas desde el corpus local.")
  .argument("<question>", "Pregunta técnica")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--language <language>", "Lenguaje/tecnología")
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--category <category>", "Categoría")
  .option("--examples", "Incluye ejemplos si existen")
  .option("--compile", "Incluye comandos/opciones de compilación")
  .option("--limit <n>", "Límite", "5")
  .action((question, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.answer({
    question,
    language: opts.language,
    version: getIbmVersion(opts),
    category: opts.category,
    includeExamples: Boolean(opts.examples),
    includeCompileCommands: Boolean(opts.compile),
    limit: Number(opts.limit)
  }))));

program
  .command("resolve")
  .description("Resuelve una consulta con workflow agéntico: search -> read -> sections -> answer/context/diagnóstico según intención.")
  .argument("<question>", "Pregunta técnica")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--language <language>", "Lenguaje/tecnología")
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--category <category>", "Categoría")
  .option("--code <code>", "Código a validar documentalmente")
  .option("--examples", "Incluye ejemplos si existen")
  .option("--compile", "Incluye comandos/opciones de compilación")
  .option("--limit <n>", "Límite", "6")
  .action((question, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.resolve({
    question,
    language: opts.language,
    version: getIbmVersion(opts),
    category: opts.category,
    code: opts.code,
    includeExamples: Boolean(opts.examples),
    includeCompileCommands: Boolean(opts.compile),
    limit: Number(opts.limit)
  }))));

program
  .command("explain-ranking")
  .description("Explica por qué ganó cada resultado de búsqueda.")
  .argument("<query>", "Consulta técnica")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--category <category>", "Categoría")
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--top <n>", "Cantidad de resultados", "5")
  .action((query, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.explainRanking({
    query,
    category: opts.category,
    version: getIbmVersion(opts),
    top: Number(opts.top)
  }))));

program
  .command("report-query")
  .description("Genera un reporte reproducible para depurar búsquedas/ranking y abrir issues de contribución.")
  .argument("<query>", "Consulta técnica que dio mal resultado")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--category <category>", "Categoría")
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--expected-title <title>", "Título esperado o fragmento")
  .option("--expected-id <id>", "ID esperado")
  .option("--notes <text>", "Notas del reportante")
  .option("--limit <n>", "Límite", "8")
  .option("--out <file>", "Escribe el issue Markdown en un archivo")
  .action(async (query, opts) => {
    const report = withRepo(String(opts.pack ?? ""), (repo) => repo.reportQuery({
      query,
      category: opts.category,
      version: getIbmVersion(opts),
      expectedTitle: opts.expectedTitle,
      expectedId: opts.expectedId,
      notes: opts.notes,
      limit: Number(opts.limit)
    }));
    if (opts.out) {
      const outFile = path.resolve(String(opts.out));
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, report.issueMarkdown, "utf8");
    }
    printJson(report);
  });

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
  .command("quality-report")
  .description("Reporte de calidad del corpus: tópicos cortos, duplicados, cobertura y recomendaciones.")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.qualityReport())));

program
  .command("recipes")
  .description("Muestra recetas/prompts útiles para agentes y contribuidores.")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.recipes())));

program
  .command("trace-report")
  .description("Resume trazas opcionales de uso activadas con IBMI_DOCS_TRACE=1.")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--limit <n>", "Eventos recientes", "30")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.traceReport(Number(opts.limit)))));

program
  .command("setup")
  .description("Wizard no interactivo: valida instalación, pack, smoke queries y genera config Codex opcional.")
  .option("--pack <dir>", "Ruta del data pack", defaultUserPackDir())
  .option("--print-codex", "Incluye bloque TOML para Codex")
  .action(async (opts) => {
    const packDir = String(opts.pack);
    const verified = await verifyDataPack(packDir);
    const checks = [
      { name: "node", ok: Boolean(process.version), detail: process.version },
      { name: "data-pack", ok: verified.ok, detail: verified.issues.join("; ") || `${verified.corpusVersion} (${verified.documents} docs)` }
    ];
    if (verified.ok) {
      withRepo(packDir, (repo) => {
        for (const query of ["CRTRPGMOD", "RNF0004", "SND-MSG", "SQLRPGLE"]) {
          const hits = repo.search({ query, limit: 1 });
          checks.push({ name: `smoke:${query}`, ok: hits.length > 0, detail: hits[0]?.title ?? "sin resultado" });
        }
      });
    }
    const ok = checks.every((check) => check.ok);
    printJson({
      ok,
      packDir: path.resolve(packDir),
      checks,
      codexConfig: opts.printCodex ? renderCodexConfig({ command: process.execPath, server: path.resolve("dist", "src", "server.js"), cwd: process.cwd(), pack: path.resolve(packDir) }) : undefined
    });
    if (!ok) process.exitCode = 1;
  });

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
  .command("verify")
  .description("Verifica manifest, SQLite y política anti-endpoint local de un data pack.")
  .option("--pack <dir>", "Ruta del pack", defaultUserPackDir())
  .action(async (opts) => {
    const result = await verifyDataPack(String(opts.pack));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  });

pack
  .command("list")
  .description("Lista data packs candidatos bajo un directorio raíz.")
  .option("--root <dir>", "Directorio raíz", path.dirname(defaultUserPackDir()))
  .action(async (opts) => printJson(await listCandidatePacks(String(opts.root))));

pack
  .command("install")
  .description("Instala un data pack desde directorio local, .tar/.tgz o URL de release asset.")
  .option("--from <source>", "Directorio, .tgz/.tar o URL")
  .option("--latest", "Instala el data pack del release público más reciente")
  .option("--out <dir>", "Destino", defaultUserPackDir())
  .action(async (opts) => {
    if (!opts.from && !opts.latest) throw new Error("Indica --from <source> o --latest.");
    const result = opts.latest
      ? await installLatestDataPack({ outDir: String(opts.out) })
      : await installDataPack({ from: String(opts.from), outDir: String(opts.out) });
    printJson(result);
  });

pack
  .command("update")
  .description("Actualiza el data pack local desde el release público más reciente o desde IBMI_DOCS_PACK_LATEST_URL.")
  .option("--out <dir>", "Destino", defaultUserPackDir())
  .action(async (opts) => {
    const result = await installLatestDataPack({ outDir: String(opts.out) });
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

pack
  .command("lint-contribution")
  .description("Valida una contribución de corpus antes de abrir PR o construir pack.")
  .requiredOption("--input <dir>", "Directorio con manifest.json, raw/ y normalized/")
  .action(async (opts) => {
    const result = await lintContribution(String(opts.input));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
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

function getIbmVersion(opts: Record<string, unknown>): string | undefined {
  return (opts.ibmiVersion ?? opts.release) ? String(opts.ibmiVersion ?? opts.release) : undefined;
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
