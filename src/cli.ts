#!/usr/bin/env node
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { syncIbmDocs } from "./ingest/ibmDocsCrawler.js";
import { buildDataPack } from "./ingest/packBuilder.js";
import { CorpusRepository } from "./repository/CorpusRepository.js";
import { archiveDataPack, installDataPack, installLatestDataPack, lintContribution, listCandidatePacks, verifyDataPack } from "./pack/dataPack.js";
import { defaultUserPackDir, resolvePackDir } from "./util/paths.js";

const program = new Command();
program
  .name("ibmi-docs")
  .description("CLI de construcción, validación y consulta del corpus local para MCP IBM i Docs.")
  .version(loadPackageVersion());

program
  .command("export-rdi", { hidden: process.env.IBMI_DOCS_ENABLE_INTERNAL !== "1" })
  .description("Exporta contenido completo desde un endpoint Eclipse/RDi Help temporal. Uso interno de construcción, no runtime.")
  .requiredOption("--base-url <url>", "Base URL temporal de Eclipse/RDi Help, por ejemplo http://<host>:<puerto>/help")
  .option("--out <dir>", "Directorio de salida", "data/rdi-export")
  .option("--max-topics <n>", "Máximo de nodos/tópicos de TOC a recorrer", "30000")
  .option("--concurrency <n>", "Descargas paralelas", "8")
  .action(async (opts) => {
    const manifest = await exportRdiInternal({
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
  .option("--strict-category", "No permite fallback fuera de --category")
  .action((query, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.search({
    query,
    category: opts.category,
    version: getIbmVersion(opts),
    limit: Number(opts.limit),
    mode: opts.mode,
    autoRead: Boolean(opts.autoRead),
    includeSections: Boolean(opts.sections),
    strictCategory: Boolean(opts.strictCategory)
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
  .command("context")
  .description("Genera un paquete contextual agéntico equivalente a ibmi_docs_context.")
  .argument("<task>", "Tarea IBM i a resolver")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--language <language>", "Lenguaje/tecnología")
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--limit <n>", "Límite", "8")
  .action((task, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.context({
    task,
    language: opts.language,
    version: getIbmVersion(opts),
    limit: Number(opts.limit)
  }))));

program
  .command("compile-guidance")
  .description("Recomienda comandos/opciones de compilación equivalente a ibmi_docs_compile_guidance.")
  .requiredOption("--language <language>", "Lenguaje/tecnología: RPGLE, SQLRPGLE, CLLE, DDS, COBOL")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--target <target>", "Objetivo: module, program, service-program, file")
  .option("--embedded-sql", "Indica uso de SQL embebido")
  .option("--uses-copybook", "Indica uso de /COPY, /INCLUDE o copybooks")
  .option("--ibmi-version <version>", "Versión IBM i")
  .option("--release <version>", "Alias de --ibmi-version")
  .option("--limit <n>", "Límite", "8")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.compileGuidance({
    language: String(opts.language),
    target: opts.target,
    usesEmbeddedSql: Boolean(opts.embeddedSql),
    usesCopybook: Boolean(opts.usesCopybook),
    version: getIbmVersion(opts),
    limit: Number(opts.limit)
  }))));

program
  .command("explain-message")
  .description("Explica RNF/SQL/CPF/MCH equivalente a ibmi_docs_explain_message.")
  .argument("<messageId>", "ID de mensaje, por ejemplo RNF0004, CPF9898, MCH3601")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--limit <n>", "Límite", "6")
  .action((messageId, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.explainMessage({
    messageId,
    limit: Number(opts.limit)
  }))));

program
  .command("related")
  .description("Busca equivalentes por versión y documentos vecinos equivalente a ibmi_docs_related.")
  .argument("<id>", "ID de documento")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--limit <n>", "Límite", "8")
  .action((id, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.related(id, { limit: Number(opts.limit) }))));

program
  .command("compare-versions")
  .description("Compara un tópico entre releases equivalente a ibmi_docs_compare_versions.")
  .argument("<query>", "Consulta técnica")
  .requiredOption("--versions <list>", "Versiones separadas por coma, por ejemplo 7.3,7.4,7.5,7.6")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--category <category>", "Categoría")
  .option("--limit <n>", "Límite", "5")
  .action((query, opts) => withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.compareVersions({
    query,
    versions: parseList(String(opts.versions)),
    category: opts.category,
    limit: Number(opts.limit)
  }))));

program
  .command("validate-code-context")
  .description("Valida código IBM i contra el corpus equivalente a ibmi_docs_validate_code_context.")
  .requiredOption("--language <language>", "Lenguaje/tecnología")
  .option("--code <code>", "Código inline a validar")
  .option("--code-file <file>", "Archivo de código a validar")
  .option("--pack <dir>", "Ruta explícita del data pack")
  .option("--limit <n>", "Límite", "8")
  .action(async (opts) => {
    const code = await readCodeInput(opts);
    withRepo(String(opts.pack ?? ""), (repo) => printJson(repo.validateCodeContext({
      language: String(opts.language),
      code,
      limit: Number(opts.limit)
    })));
  });

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
  .option("--fail-on-not-ok", "Termina con exit code 1 si qualityReport.ok=false")
  .action((opts) => withRepo(String(opts.pack ?? ""), (repo) => {
    const report = repo.qualityReport();
    printJson(report);
    if (opts.failOnNotOk && !report.ok) process.exitCode = 1;
  }));

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
  .option("--quality-gate <mode>", "Control de quality-report: off|warn|fail", "warn")
  .action(async (opts) => {
    const packDir = String(opts.pack);
    const verified = await verifyDataPack(packDir);
    const checks = [
      { name: "node", ok: Boolean(process.version), detail: process.version },
      { name: "data-pack", ok: verified.ok, detail: verified.issues.join("; ") || `${verified.corpusVersion} (${verified.documents} docs)` }
    ];
    if (verified.ok) {
      withRepo(packDir, (repo) => {
        for (const smoke of smokeCases()) {
          const hits = repo.search({ query: smoke.query, category: smoke.category, limit: 3 });
          const top = hits[0];
          const ok = Boolean(top) && smoke.ok(hits);
          checks.push({ name: `smoke:${smoke.query}`, ok, detail: top ? `${top.title} (${top.category}/${top.version})` : "sin resultado" });
        }
        const quality = repo.qualityReport();
        const qualityMode = String(opts.qualityGate ?? "warn").toLowerCase();
        if (qualityMode !== "off") {
          checks.push({
            name: "quality-report",
            ok: quality.ok || qualityMode === "warn",
            detail: quality.ok ? "ok" : `warning: quality-report ok=false; stubs=${quality.documentKinds.stub}; sparse=${quality.sparseCategories.map((item) => item.category).join(",") || "n/a"}`
          });
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
    try {
      const result = opts.latest
        ? await installLatestDataPack({ outDir: String(opts.out) })
        : await installDataPack({ from: String(opts.from), outDir: String(opts.out) });
      printJson(result);
    } catch (error) {
      throw new Error(formatPackInstallError(error));
    }
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

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function loadPackageVersion(): string {
  // El CLI debe reportar la versión real del paquete publicado/instalado.
  // Se busca hacia arriba para funcionar igual desde src/ con tsx y desde dist/src/ en npm.
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
        if (packageJson.name === "@ckirsch94/ibmi-docs-mcp" && typeof packageJson.version === "string") {
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

async function exportRdiInternal(options: { baseUrl: string; outDir: string; maxTopics: number; concurrency: number }) {
  if (process.env.IBMI_DOCS_ENABLE_INTERNAL !== "1") {
    throw new Error("export-rdi es una herramienta interna de bootstrap. Define IBMI_DOCS_ENABLE_INTERNAL=1 si estás construyendo el corpus del proyecto.");
  }
  const { exportRdiHelp } = await import("./ingest/rdiExporter.js");
  return exportRdiHelp(options);
}

function smokeCases(): Array<{ query: string; category?: string; ok: (hits: Array<{ title: string; snippet?: string; category: string }>) => boolean }> {
  return [
    { query: "CRTRPGMOD", category: "ile-rpg", ok: (hits) => /CRTRPGMOD/i.test(hits[0]?.title ?? "") && hits[0]?.category === "ile-rpg" },
    { query: "RNF0004", category: "mensajes-rnf", ok: (hits) => hits.some((hit) => hit.category === "mensajes-rnf" && /RPG Messages/i.test(hit.title)) },
    { query: "SND-MSG", category: "ile-rpg", ok: (hits) => /SND-MSG/i.test(hits[0]?.title ?? "") && hits[0]?.category === "ile-rpg" },
    {
      query: "SQLRPGLE",
      category: "sql-db2-for-i",
      ok: (hits) => {
        const top = hits[0];
        if (!top || top.category !== "sql-db2-for-i") return false;
        // Guardrail semántico: un tópico de catálogo como SYSINDEXSTAT no debe validar el setup.
        if (/SYSINDEXSTAT/i.test(`${top.title} ${top.snippet ?? ""}`)) return false;
        return /CRTSQLRPGI|embedded SQL|SQL RPG|precompiler|RPGPPOPT|\/COPY|\/INCLUDE/i.test(`${top.title} ${top.snippet ?? ""}`);
      }
    }
  ];
}

function formatPackInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 404|Not Found/i.test(message)) {
    return [
      message,
      "No se encontró el release asset público ibmi-docs-pack.tgz.",
      "Alternativas: publica el asset con el workflow de release, usa --from <directorio|tgz>, o define IBMI_DOCS_PACK_LATEST_URL con una URL válida."
    ].join("\n");
  }
  return message;
}

async function readCodeInput(opts: Record<string, unknown>): Promise<string> {
  if (opts.codeFile) return fs.readFile(path.resolve(String(opts.codeFile)), "utf8");
  if (opts.code) return String(opts.code);
  throw new Error("Indica --code <texto> o --code-file <archivo>.");
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
