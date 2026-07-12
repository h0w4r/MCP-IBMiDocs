#!/usr/bin/env node
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const tar = require("tar");

const MODEL_ID = "ibmi-docs/multilingual-e5-base-ibmi-v1";
const MODEL_DIRECTORY = "ibmi-e5-base-finetuned-v1";
const MODEL_DTYPE = "q8";
const MODEL_SHA256 = "fdb18cfc1799759960636d59432d680cbf25a048df10b430b40347f171bad1ba";
const BUNDLED_MODEL_DIR = path.join(__dirname, "models", MODEL_DIRECTORY);
const RERANKER_MODEL_ID = "ibmi-docs/mmarco-minilm-ibmi-reranker-v1";
const RERANKER_DIRECTORY = "ibmi-reranker-finetuned-v1";
const RERANKER_DTYPE = "q8";
const RERANKER_SHA256 = "9ff4941522f54a7ea348f0fe6543d646409c5870bbede92ee8275dbc680a9953";
const BUNDLED_RERANKER_DIR = path.join(__dirname, "models", RERANKER_DIRECTORY);
const QUERY_HEAD_MODEL_ID = "ibmi-docs/e5-query-to-corpus-head-v1";
const QUERY_HEAD_DIRECTORY = "ibmi-neural-query-head-v1";
const QUERY_HEAD_SHA256 = "5763055a6cb9b7daffcbbf305d92335ea61ec113431cf19f880f7fb516db81bf";
const BUNDLED_QUERY_HEAD_DIR = path.join(__dirname, "models", QUERY_HEAD_DIRECTORY);
const BUNDLED_PACK_DIR = path.join(__dirname, "data", "pack");
const SQLITE_PARTS_MANIFEST = path.join(BUNDLED_PACK_DIR, "ibmi-docs.sqlite.parts.json");
const CACHE_DIR = process.env.IBMI_DOCS_MODEL_CACHE || path.join(os.homedir(), ".ibmi-docs-mcp", "models");
const MARKER_FILE = path.join(CACHE_DIR, "ibmi-docs-embedding-model.json");
const RERANKER_MARKER_FILE = path.join(CACHE_DIR, "ibmi-docs-reranker-model.json");
const QUERY_HEAD_MARKER_FILE = path.join(CACHE_DIR, "ibmi-docs-query-head.json");
const RUNTIME_ASSETS_FILE = path.join(__dirname, "runtime-assets.json");
const DOWNLOAD_CACHE_DIR = process.env.IBMI_DOCS_DOWNLOAD_CACHE
  || path.join(os.homedir(), ".ibmi-docs-mcp", "downloads");
const USER_PACK_DIR = path.join(os.homedir(), ".ibmi-docs", "pack");

async function main() {
  const skipModels = process.env.IBMI_DOCS_SKIP_MODEL_INSTALL === "1";
  const sources = await resolveInstallationSources(!skipModels);
  try {
    if (sources.packKind === "bundled") {
      await assembleBundledSqliteAtomically(sources.packDir);
    } else {
      await installDownloadedPackAtomically(
        sources.packDir,
        sources.runtimeManifest.corpusVersion,
        sources.runtimeManifest.checks.sqliteSha256
      );
    }
    if (skipModels) {
      console.log("[ibmi-docs] IBMI_DOCS_SKIP_MODEL_INSTALL=1; se omite instalación de modelos neuronales.");
      return;
    }

    await fs.mkdir(CACHE_DIR, { recursive: true });
    const explicitModel = process.env.IBMI_DOCS_EMBEDDING_MODEL?.trim();
    const localModelDir = explicitModel ? path.resolve(explicitModel) : path.join(CACHE_DIR, MODEL_DIRECTORY);
    console.log(`[ibmi-docs] Preparando modelo semántico afinado ${MODEL_ID}`);
    console.log(`[ibmi-docs] Cache del modelo: ${CACHE_DIR}`);

    if (!explicitModel) {
      await installModelAtomically(
        path.join(sources.modelsDir, MODEL_DIRECTORY),
        localModelDir,
        MODEL_SHA256,
        "bi-encoder"
      );
    }
    const modelFile = path.join(localModelDir, "onnx", "model_quantized.onnx");
    const modelSha256 = await sha256File(modelFile);
    if (!explicitModel && modelSha256 !== MODEL_SHA256) {
      throw new Error(`Hash inválido para el modelo IBM i afinado: ${modelSha256}.`);
    }

    const {
      AutoModelForSequenceClassification,
      AutoTokenizer,
      env,
      pipeline: transformerPipeline
    } = await import("@huggingface/transformers");
    env.cacheDir = CACHE_DIR;
    env.allowRemoteModels = false;

    const extractor = await transformerPipeline("feature-extraction", localModelDir, { dtype: MODEL_DTYPE });
  const prefixes = { queryPrefix: "query: ", passagePrefix: "passage: " };
  const output = await extractor(`${prefixes.queryPrefix}IBM i Docs semantic model installation check`, { pooling: "mean", normalize: true });
  const list = output.tolist();
  const vector = Array.isArray(list[0]) ? list[0] : list;
  if (!Array.isArray(vector) || vector.length < 128) {
    throw new Error(`El modelo ${MODEL_ID} devolvió ${Array.isArray(vector) ? vector.length : "n/a"} dimensiones; se esperaba un embedding válido.`);
  }

  await fs.writeFile(MARKER_FILE, JSON.stringify({
    modelId: MODEL_ID,
    localPath: localModelDir,
    dtype: MODEL_DTYPE,
    modelSha256,
    dimensions: vector.length,
    cacheDir: CACHE_DIR,
    installedAt: new Date().toISOString(),
    runtimePolicy: "download-at-install-update; runtime-local-only",
    queryPrefix: prefixes.queryPrefix,
    passagePrefix: prefixes.passagePrefix
  }, null, 2), "utf8");
  console.log("[ibmi-docs] Transformer IBM i afinado listo para uso local-only en runtime.");

  // El reranker afinado viaja fragmentado dentro del asset de modelos. Se
  // reconstruye localmente y no vuelve a usar red durante las consultas.
  console.log(`[ibmi-docs] Preparando reranker neuronal local ${RERANKER_MODEL_ID} (${RERANKER_DTYPE})`);
  const explicitReranker = process.env.IBMI_DOCS_RERANKER_MODEL?.trim();
  const localRerankerDir = explicitReranker ? path.resolve(explicitReranker) : path.join(CACHE_DIR, RERANKER_DIRECTORY);
    if (!explicitReranker) {
      await installModelAtomically(
        path.join(sources.modelsDir, RERANKER_DIRECTORY),
        localRerankerDir,
        RERANKER_SHA256,
        "reranker"
      );
    }
  const rerankerFile = path.join(localRerankerDir, "onnx", "model_quantized.onnx");
  const rerankerSha256 = await sha256File(rerankerFile);
  if (!explicitReranker && rerankerSha256 !== RERANKER_SHA256) {
    throw new Error(`Hash inválido para el reranker IBM i afinado: ${rerankerSha256}.`);
  }
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(localRerankerDir, { local_files_only: true });
  const reranker = await AutoModelForSequenceClassification.from_pretrained(localRerankerDir, {
    dtype: RERANKER_DTYPE,
    local_files_only: true
  });
  const rerankerInputs = tokenizer(
    ["What command invokes RLU?"],
    {
      text_pair: ["Start Report Layout Utility (STRRLU) command"],
      padding: true,
      truncation: true,
      max_length: 128
    }
  );
  const rerankerOutput = await reranker(rerankerInputs);
  const rerankerLogits = rerankerOutput.logits.tolist();
  const rerankerLogit = Array.isArray(rerankerLogits[0]) ? rerankerLogits[0][0] : rerankerLogits[0];
  if (!Number.isFinite(Number(rerankerLogit))) {
    throw new Error(`El reranker ${RERANKER_MODEL_ID} no devolvió un logit válido.`);
  }
  await fs.writeFile(RERANKER_MARKER_FILE, JSON.stringify({
    modelId: RERANKER_MODEL_ID,
    localPath: localRerankerDir,
    dtype: RERANKER_DTYPE,
    modelSha256: rerankerSha256,
    cacheDir: CACHE_DIR,
    installedAt: new Date().toISOString(),
    runtimePolicy: "download-at-install-update; runtime-local-only"
  }, null, 2), "utf8");
  console.log("[ibmi-docs] Reranker neuronal listo para uso local-only en runtime.");

  // La cabeza query->corpus se instala como componente obligatorio desde el
  // mismo asset firmado, sin ruta alternativa por coincidencias textuales.
    const queryHeadSourceDir = path.join(sources.modelsDir, QUERY_HEAD_DIRECTORY);
    const localQueryHeadDir = path.join(CACHE_DIR, QUERY_HEAD_DIRECTORY);
  const queryHeadManifest = JSON.parse(
      await fs.readFile(path.join(queryHeadSourceDir, "model-manifest.json"), "utf8")
  );
  if (queryHeadManifest.weightsSha256 !== QUERY_HEAD_SHA256) {
    throw new Error("El manifest de la cabeza neuronal no coincide con el release esperado.");
  }
    await installQueryHeadAtomically(queryHeadSourceDir, localQueryHeadDir, QUERY_HEAD_SHA256);
  const queryHeadSha256 = await sha256File(path.join(localQueryHeadDir, "neural-query-head.f32"));
  await fs.writeFile(QUERY_HEAD_MARKER_FILE, JSON.stringify({
    modelId: QUERY_HEAD_MODEL_ID,
    localPath: localQueryHeadDir,
    weightsSha256: queryHeadSha256,
    installedAt: new Date().toISOString(),
    runtimePolicy: "required-neural-query-to-corpus-only"
  }, null, 2), "utf8");
    console.log("[ibmi-docs] Cabeza neuronal query->corpus instalada y verificada.");
  } finally {
    for (const temporary of sources.cleanupDirs) {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

async function resolveInstallationSources(includeModels) {
  const bundledPackReady = await pathExists(path.join(BUNDLED_PACK_DIR, "manifest.json"))
    && (await pathExists(path.join(BUNDLED_PACK_DIR, "ibmi-docs.sqlite"))
      || await pathExists(SQLITE_PARTS_MANIFEST));
  const bundledModelsReady = await pathExists(path.join(BUNDLED_MODEL_DIR, "model-manifest.json"))
    && await pathExists(path.join(BUNDLED_RERANKER_DIR, "model-manifest.json"))
    && await pathExists(path.join(BUNDLED_QUERY_HEAD_DIR, "model-manifest.json"));

  if (bundledPackReady && (!includeModels || bundledModelsReady)) {
    return {
      packKind: "bundled",
      packDir: BUNDLED_PACK_DIR,
      modelsDir: path.join(__dirname, "models"),
      runtimeManifest: null,
      cleanupDirs: []
    };
  }

  const runtimeManifest = await readRuntimeAssetsManifest();
  const cleanupDirs = [];
  let packDir = BUNDLED_PACK_DIR;
  let packKind = "bundled";
  let modelsDir = path.join(__dirname, "models");

  if (!bundledPackReady) {
    const extractedPack = await downloadAndExtractAsset(runtimeManifest.assets.pack);
    packDir = extractedPack.rootDir;
    packKind = "downloaded";
    cleanupDirs.push(extractedPack.temporaryDir);
  }
  if (includeModels && !bundledModelsReady) {
    const extractedModels = await downloadAndExtractAsset(runtimeManifest.assets.models);
    modelsDir = extractedModels.rootDir;
    cleanupDirs.push(extractedModels.temporaryDir);
  }

  return { packKind, packDir, modelsDir, runtimeManifest, cleanupDirs };
}

async function readRuntimeAssetsManifest() {
  const manifest = JSON.parse(await fs.readFile(RUNTIME_ASSETS_FILE, "utf8"));
  if (manifest.schemaVersion !== 1 || !manifest.assets?.pack || !manifest.assets?.models) {
    throw new Error("runtime-assets.json no cumple el esquema de distribución esperado.");
  }
  if (!manifest.corpusVersion || !manifest.checks?.sqliteSha256) {
    throw new Error("runtime-assets.json no declara versión y hash del data pack.");
  }
  for (const [name, asset] of Object.entries(manifest.assets)) {
    if (!asset.fileName || !asset.url || !asset.sha256 || !asset.root || !Number.isFinite(asset.bytes)) {
      throw new Error(`Asset runtime incompleto: ${name}.`);
    }
  }
  return manifest;
}

async function downloadAndExtractAsset(asset) {
  await fs.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
  const cachedFile = path.join(DOWNLOAD_CACHE_DIR, asset.fileName);
  let cacheValid = false;
  try {
    const stat = await fs.stat(cachedFile);
    cacheValid = stat.size === asset.bytes && await sha256File(cachedFile) === asset.sha256;
  } catch {
    cacheValid = false;
  }

  if (!cacheValid) {
    const temporaryDownload = `${cachedFile}.download-${process.pid}-${Date.now()}`;
    const sourceUrl = resolveAssetUrl(asset);
    console.log(`[ibmi-docs] Descargando activo de instalación: ${sourceUrl}`);
    let installed = false;
    let lastError;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await fs.rm(temporaryDownload, { force: true });
        try {
          await downloadHttpAsset(sourceUrl, temporaryDownload);
          const stat = await fs.stat(temporaryDownload);
          const hash = await sha256File(temporaryDownload);
          if (stat.size !== asset.bytes || hash !== asset.sha256) {
            throw new Error(`Integridad inválida para ${asset.fileName}: bytes=${stat.size}, sha256=${hash}.`);
          }
          installed = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            console.warn(`[ibmi-docs] Reintento ${attempt + 1}/3 para ${asset.fileName}.`);
            await delay(1_000 * attempt);
          }
        }
      }
      if (!installed) throw lastError || new Error(`No se pudo descargar ${asset.fileName}.`);
      await fs.rm(cachedFile, { force: true });
      await fs.rename(temporaryDownload, cachedFile);
    } catch (error) {
      await fs.rm(temporaryDownload, { force: true });
      throw error;
    }
  } else {
    console.log(`[ibmi-docs] Activo de instalación reutilizado desde caché: ${asset.fileName}`);
  }

  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-docs-asset-"));
  try {
    await tar.x({
      cwd: temporaryDir,
      file: cachedFile,
      preservePaths: false,
      strict: true
    });
    const rootDir = path.resolve(temporaryDir, asset.root);
    if (!rootDir.startsWith(`${path.resolve(temporaryDir)}${path.sep}`)) {
      throw new Error(`Raíz insegura declarada por el asset: ${asset.root}.`);
    }
    await fs.access(rootDir);
    await assertNoSymbolicLinks(rootDir);
    return { rootDir, temporaryDir };
  } catch (error) {
    await fs.rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadHttpAsset(sourceUrl, destination, redirectsRemaining = 8) {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Protocolo de asset no permitido: ${parsed.protocol}`);
  }
  const client = parsed.protocol === "https:" ? https : http;
  await new Promise((resolve, reject) => {
    const request = client.get(parsed, {
      headers: {
        "User-Agent": "MCP-IBMiDocs-postinstall",
        Accept: "application/octet-stream"
      }
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Demasiadas redirecciones al descargar ${sourceUrl}.`));
          return;
        }
        const redirected = new URL(response.headers.location, parsed).toString();
        downloadHttpAsset(redirected, destination, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status} al descargar ${sourceUrl}.`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolve, reject);
    });
    request.setTimeout(120_000, () => request.destroy(new Error(`Timeout al descargar ${sourceUrl}.`)));
    request.on("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveAssetUrl(asset) {
  const override = process.env.IBMI_DOCS_RUNTIME_ASSET_BASE_URL?.trim();
  if (!override) return asset.url;
  const normalizedBase = override.endsWith("/") ? override : `${override}/`;
  return new URL(asset.fileName, normalizedBase).toString();
}

async function installDownloadedPackAtomically(source, expectedCorpusVersion, expectedSqliteSha256) {
  const sourceManifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  if (sourceManifest.corpusVersion !== expectedCorpusVersion) {
    throw new Error(`Versión inesperada del data pack: ${sourceManifest.corpusVersion}.`);
  }
  const sourceSqlite = path.join(source, "ibmi-docs.sqlite");
  if (await sha256File(sourceSqlite) !== expectedSqliteSha256) {
    throw new Error("El SQLite descargado no coincide con el SHA-256 publicado.");
  }
  await fs.access(path.join(source, "normalized"));

  await fs.mkdir(path.dirname(USER_PACK_DIR), { recursive: true });
  const temporary = `${USER_PACK_DIR}.install-${process.pid}-${Date.now()}`;
  const backup = `${USER_PACK_DIR}.backup-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(backup, { recursive: true, force: true });
  await fs.cp(source, temporary, { recursive: true, force: true });
  if (await sha256File(path.join(temporary, "ibmi-docs.sqlite")) !== expectedSqliteSha256) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw new Error("La copia local del SQLite no superó SHA-256.");
  }

  let previousMoved = false;
  try {
    if (await pathExists(USER_PACK_DIR)) {
      await fs.rename(USER_PACK_DIR, backup);
      previousMoved = true;
    }
    await fs.rename(temporary, USER_PACK_DIR);
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    if (previousMoved && !await pathExists(USER_PACK_DIR)) {
      await fs.rename(backup, USER_PACK_DIR);
    }
    throw error;
  }
  console.log(`[ibmi-docs] Data pack ${expectedCorpusVersion} instalado en ${USER_PACK_DIR}.`);
}

async function assertNoSymbolicLinks(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`El asset contiene un enlace simbólico no permitido: ${entryPath}.`);
    if (entry.isDirectory()) await assertNoSymbolicLinks(entryPath);
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function assembleBundledSqliteAtomically(packDir) {
  const partsManifest = path.join(packDir, "ibmi-docs.sqlite.parts.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(partsManifest, "utf8"));
  } catch {
    // Los assets de release ya distribuyen el SQLite completo.
    await fs.access(path.join(packDir, "ibmi-docs.sqlite"));
    return;
  }
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error("El data pack local no declara fragmentos SQLite.");
  }
  const destination = path.join(packDir, manifest.fileName || "ibmi-docs.sqlite");
  try {
    if (await sha256File(destination) === manifest.sha256) {
      console.log("[ibmi-docs] Data pack SQLite ya estaba reconstruido y verificado.");
      return;
    }
  } catch {
    // El archivo no existe o está incompleto; se reconstruye a continuación.
  }
  const temporary = `${destination}.assemble-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { force: true });
  try {
    for (const part of manifest.parts) {
      const partPath = path.join(packDir, part.name);
      const stat = await fs.stat(partPath);
      const hash = await sha256File(partPath);
      if (stat.size !== part.size || hash !== part.sha256) {
        throw new Error(`Fragmento SQLite alterado: ${part.name}.`);
      }
      await appendFile(partPath, temporary);
    }
    const assembledHash = await sha256File(temporary);
    if (assembledHash !== manifest.sha256) {
      throw new Error(`El SQLite reconstruido no superó SHA-256: ${assembledHash}.`);
    }
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
    console.log("[ibmi-docs] Data pack SQLite reconstruido y verificado desde fragmentos locales.");
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function installModelAtomically(source, destination, expectedSha256, label) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, "model-manifest.json"), "utf8"));
  if (manifest.onnxSha256 !== expectedSha256) throw new Error(`El manifest ${label} no coincide con el release esperado.`);
  const parts = Array.isArray(manifest.onnxParts) ? manifest.onnxParts : [];
  if (!parts.length) throw new Error("El modelo distribuido no declara sus fragmentos ONNX.");
  for (const part of parts) {
    const actualHash = await sha256File(path.join(source, "onnx", part.name));
    if (actualHash !== part.sha256) throw new Error(`Fragmento ONNX alterado: ${part.name}.`);
  }
  try {
    if (await sha256File(path.join(destination, "onnx", "model_quantized.onnx")) === expectedSha256) {
      // Un release puede corregir tokenizer/config sin cambiar los pesos ONNX.
      // Sincronizar estos archivos evita conservar metadatos obsoletos al actualizar.
      await syncModelMetadata(source, destination);
      return;
    }
  } catch {
    // La instalación no existe o está incompleta; se reemplaza a continuación.
  }
  const temporary = `${destination}.install-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { recursive: true, force: true });
  try {
    await fs.cp(source, temporary, { recursive: true, force: true });
    const assembledModel = path.join(temporary, "onnx", "model_quantized.onnx");
    await fs.rm(assembledModel, { force: true });
    for (const part of parts) {
      await appendFile(path.join(temporary, "onnx", part.name), assembledModel);
    }
    const assembledHash = await sha256File(assembledModel);
    if (assembledHash !== expectedSha256) {
      throw new Error(`El modelo ONNX ${label} reconstruido no superó SHA-256: ${assembledHash}.`);
    }
    for (const part of parts) await fs.rm(path.join(temporary, "onnx", part.name), { force: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function syncModelMetadata(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

async function installQueryHeadAtomically(source, destination, expectedSha256) {
  try {
    if (await sha256File(path.join(destination, "neural-query-head.f32")) === expectedSha256) {
      await fs.copyFile(
        path.join(source, "model-manifest.json"),
        path.join(destination, "model-manifest.json")
      );
      return;
    }
  } catch {
    // No existe o está incompleta; se reemplaza de forma atómica.
  }
  const temporary = `${destination}.install-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { recursive: true, force: true });
  try {
    await fs.cp(source, temporary, { recursive: true, force: true });
    const actualSha = await sha256File(path.join(temporary, "neural-query-head.f32"));
    if (actualSha !== expectedSha256) {
      throw new Error(`La cabeza neuronal no superó SHA-256: ${actualSha}.`);
    }
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function appendFile(source, destination) {
  return new Promise((resolve, reject) => {
    const input = createReadStream(source);
    const output = createWriteStream(destination, { flags: "a" });
    input.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    input.pipe(output);
  });
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[ibmi-docs] No se pudo preparar la instalación local: ${message}`);
  console.error("[ibmi-docs] Verifica acceso al release o configura IBMI_DOCS_RUNTIME_ASSET_BASE_URL hacia un mirror autorizado.");
  console.error("[ibmi-docs] IBMI_DOCS_SKIP_MODEL_INSTALL=1 omite solo los modelos; no sustituye el data pack obligatorio.");
  process.exit(1);
});
