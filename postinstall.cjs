#!/usr/bin/env node
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

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

async function main() {
  await assembleBundledSqliteAtomically();
  if (process.env.IBMI_DOCS_SKIP_MODEL_INSTALL === "1") {
    console.log("[ibmi-docs] IBMI_DOCS_SKIP_MODEL_INSTALL=1; se omite instalación de modelos neuronales.");
    return;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const explicitModel = process.env.IBMI_DOCS_EMBEDDING_MODEL?.trim();
  const localModelDir = explicitModel ? path.resolve(explicitModel) : path.join(CACHE_DIR, MODEL_DIRECTORY);
  console.log(`[ibmi-docs] Preparando modelo semántico afinado ${MODEL_ID}`);
  console.log(`[ibmi-docs] Cache del modelo: ${CACHE_DIR}`);

  if (!explicitModel) {
    await installBundledModelAtomically(BUNDLED_MODEL_DIR, localModelDir, MODEL_SHA256, "bi-encoder");
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
    pipeline
  } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  env.allowRemoteModels = false;

  const extractor = await pipeline("feature-extraction", localModelDir, { dtype: MODEL_DTYPE });
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

  // El reranker afinado también viaja fragmentado en npm. Se reconstruye de
  // forma local para eliminar red tanto en instalación como en runtime.
  console.log(`[ibmi-docs] Preparando reranker neuronal local ${RERANKER_MODEL_ID} (${RERANKER_DTYPE})`);
  const explicitReranker = process.env.IBMI_DOCS_RERANKER_MODEL?.trim();
  const localRerankerDir = explicitReranker ? path.resolve(explicitReranker) : path.join(CACHE_DIR, RERANKER_DIRECTORY);
  if (!explicitReranker) {
    await installBundledModelAtomically(BUNDLED_RERANKER_DIR, localRerankerDir, RERANKER_SHA256, "reranker");
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

  // La cabeza query->corpus se instala como componente obligatorio. Sus pesos
  // pequeños se validan por SHA y viajan dentro del paquete, sin descarga ni
  // ruta alternativa basada en coincidencias textuales.
  const localQueryHeadDir = path.join(CACHE_DIR, QUERY_HEAD_DIRECTORY);
  const queryHeadManifest = JSON.parse(
    await fs.readFile(path.join(BUNDLED_QUERY_HEAD_DIR, "model-manifest.json"), "utf8")
  );
  if (queryHeadManifest.weightsSha256 !== QUERY_HEAD_SHA256) {
    throw new Error("El manifest de la cabeza neuronal no coincide con el release esperado.");
  }
  await installQueryHeadAtomically(BUNDLED_QUERY_HEAD_DIR, localQueryHeadDir, QUERY_HEAD_SHA256);
  const queryHeadSha256 = await sha256File(path.join(localQueryHeadDir, "neural-query-head.f32"));
  await fs.writeFile(QUERY_HEAD_MARKER_FILE, JSON.stringify({
    modelId: QUERY_HEAD_MODEL_ID,
    localPath: localQueryHeadDir,
    weightsSha256: queryHeadSha256,
    installedAt: new Date().toISOString(),
    runtimePolicy: "required-neural-query-to-corpus-only"
  }, null, 2), "utf8");
  console.log("[ibmi-docs] Cabeza neuronal query->corpus instalada y verificada.");
}

async function assembleBundledSqliteAtomically() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(SQLITE_PARTS_MANIFEST, "utf8"));
  } catch {
    // Compatibilidad con packs antiguos que aún distribuían SQLite completo.
    await fs.access(path.join(BUNDLED_PACK_DIR, "ibmi-docs.sqlite"));
    return;
  }
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error("El data pack npm no declara fragmentos SQLite.");
  }
  const destination = path.join(BUNDLED_PACK_DIR, manifest.fileName || "ibmi-docs.sqlite");
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
      const partPath = path.join(BUNDLED_PACK_DIR, part.name);
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

async function installBundledModelAtomically(source, destination, expectedSha256, label) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, "model-manifest.json"), "utf8"));
  if (manifest.onnxSha256 !== expectedSha256) throw new Error(`El manifest ${label} de npm no coincide con el release esperado.`);
  const parts = Array.isArray(manifest.onnxParts) ? manifest.onnxParts : [];
  if (!parts.length) throw new Error("El modelo npm no declara sus fragmentos ONNX.");
  for (const part of parts) {
    const actualHash = await sha256File(path.join(source, "onnx", part.name));
    if (actualHash !== part.sha256) throw new Error(`Fragmento ONNX alterado: ${part.name}.`);
  }
  try {
    if (await sha256File(path.join(destination, "onnx", "model_quantized.onnx")) === expectedSha256) {
      // Un release puede corregir tokenizer/config sin cambiar los pesos ONNX.
      // Sincronizar estos archivos evita conservar metadatos obsoletos al actualizar.
      await syncBundledModelMetadata(source, destination);
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

async function syncBundledModelMetadata(source, destination) {
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
  console.error("[ibmi-docs] Si necesitas instalar sin red temporalmente usa IBMI_DOCS_SKIP_MODEL_INSTALL=1, pero el MCP reportará modelo no disponible.");
  process.exit(1);
});
