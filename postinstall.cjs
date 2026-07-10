#!/usr/bin/env node
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MODEL_ID = process.env.IBMI_DOCS_EMBEDDING_MODEL || "Xenova/multilingual-e5-small";
const RERANKER_MODEL_ID = process.env.IBMI_DOCS_RERANKER_MODEL || "onnx-community/bge-reranker-v2-m3-ONNX";
const RERANKER_DTYPE = process.env.IBMI_DOCS_RERANKER_DTYPE || "q4";
const CACHE_DIR = process.env.IBMI_DOCS_MODEL_CACHE || path.join(os.homedir(), ".ibmi-docs-mcp", "models");
const MARKER_FILE = path.join(CACHE_DIR, "ibmi-docs-embedding-model.json");
const RERANKER_MARKER_FILE = path.join(CACHE_DIR, "ibmi-docs-reranker-model.json");
const QUERY_ADAPTER_MANIFEST = path.join(__dirname, "models", "semantic-query-adapter.json");
const QUERY_ADAPTER_WEIGHTS = path.join(__dirname, "models", "semantic-query-adapter.f32");

async function main() {
  if (process.env.IBMI_DOCS_SKIP_MODEL_INSTALL === "1") {
    console.log("[ibmi-docs] IBMI_DOCS_SKIP_MODEL_INSTALL=1; se omite descarga del modelo semántico.");
    return;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  console.log(`[ibmi-docs] Preparando modelo semántico local ${MODEL_ID}`);
  console.log(`[ibmi-docs] Cache del modelo: ${CACHE_DIR}`);

  const {
    AutoModelForSequenceClassification,
    AutoTokenizer,
    env,
    pipeline
  } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  env.allowRemoteModels = true;

  const extractor = await pipeline("feature-extraction", MODEL_ID);
  const prefixes = /\be5\b/i.test(MODEL_ID)
    ? { queryPrefix: "query: ", passagePrefix: "passage: " }
    : { queryPrefix: "", passagePrefix: "" };
  const output = await extractor(`${prefixes.queryPrefix}IBM i Docs semantic model installation check`, { pooling: "mean", normalize: true });
  const list = output.tolist();
  const vector = Array.isArray(list[0]) ? list[0] : list;
  if (!Array.isArray(vector) || vector.length < 128) {
    throw new Error(`El modelo ${MODEL_ID} devolvió ${Array.isArray(vector) ? vector.length : "n/a"} dimensiones; se esperaba un embedding válido.`);
  }

  await fs.writeFile(MARKER_FILE, JSON.stringify({
    modelId: MODEL_ID,
    dimensions: vector.length,
    cacheDir: CACHE_DIR,
    installedAt: new Date().toISOString(),
    runtimePolicy: "download-at-install-update; runtime-local-only",
    queryPrefix: prefixes.queryPrefix,
    passagePrefix: prefixes.passagePrefix
  }, null, 2), "utf8");
  console.log("[ibmi-docs] Modelo de embeddings listo para uso local-only en runtime.");

  // El reranker lee pregunta y pasaje conjuntamente. Se descarga al instalar
  // para que ninguna consulta de usuario dependa de red durante el runtime.
  console.log(`[ibmi-docs] Preparando reranker neuronal local ${RERANKER_MODEL_ID} (${RERANKER_DTYPE})`);
  const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL_ID);
  const reranker = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_ID, {
    dtype: RERANKER_DTYPE
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
    dtype: RERANKER_DTYPE,
    cacheDir: CACHE_DIR,
    installedAt: new Date().toISOString(),
    runtimePolicy: "download-at-install-update; runtime-local-only"
  }, null, 2), "utf8");
  console.log("[ibmi-docs] Reranker neuronal listo para uso local-only en runtime.");

  // El adaptador viaja dentro del paquete: el usuario no descarga el dataset
  // de desarrollo ni ejecuta entrenamiento durante la instalación.
  const adapterManifest = JSON.parse(await fs.readFile(QUERY_ADAPTER_MANIFEST, "utf8"));
  const adapterWeights = await fs.stat(QUERY_ADAPTER_WEIGHTS);
  const expectedFloats = adapterManifest.dimensions * adapterManifest.hiddenDimensions
    + adapterManifest.hiddenDimensions
    + adapterManifest.hiddenDimensions * adapterManifest.dimensions
    + adapterManifest.dimensions;
  if (adapterManifest.schemaVersion !== 2 || adapterManifest.kind !== "residual-mlp-gelu"
    || adapterWeights.size !== expectedFloats * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("El adaptador neuronal IBM i incluido en el paquete no es compatible o está incompleto.");
  }
  console.log(`[ibmi-docs] Adaptador neuronal IBM i listo (${adapterManifest.trainCount} pares; ${adapterManifest.testCount} casos de prueba retenidos).`);

}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[ibmi-docs] No se pudo preparar el modelo semántico: ${message}`);
  console.error("[ibmi-docs] Si necesitas instalar sin red temporalmente usa IBMI_DOCS_SKIP_MODEL_INSTALL=1, pero el MCP reportará modelo no disponible.");
  process.exit(1);
});
