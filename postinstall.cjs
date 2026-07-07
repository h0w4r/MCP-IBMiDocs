#!/usr/bin/env node
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MODEL_ID = process.env.IBMI_DOCS_EMBEDDING_MODEL || "Xenova/multilingual-e5-small";
const CACHE_DIR = process.env.IBMI_DOCS_MODEL_CACHE || path.join(os.homedir(), ".ibmi-docs-mcp", "models");
const MARKER_FILE = path.join(CACHE_DIR, "ibmi-docs-embedding-model.json");

async function main() {
  if (process.env.IBMI_DOCS_SKIP_MODEL_INSTALL === "1") {
    console.log("[ibmi-docs] IBMI_DOCS_SKIP_MODEL_INSTALL=1; se omite descarga del modelo semántico.");
    return;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  console.log(`[ibmi-docs] Preparando modelo semántico local ${MODEL_ID}`);
  console.log(`[ibmi-docs] Cache del modelo: ${CACHE_DIR}`);

  const { env, pipeline } = await import("@huggingface/transformers");
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
  console.log("[ibmi-docs] Modelo semántico listo para uso local-only en runtime.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[ibmi-docs] No se pudo preparar el modelo semántico: ${message}`);
  console.error("[ibmi-docs] Si necesitas instalar sin red temporalmente usa IBMI_DOCS_SKIP_MODEL_INSTALL=1, pero el MCP reportará modelo no disponible.");
  process.exit(1);
});
