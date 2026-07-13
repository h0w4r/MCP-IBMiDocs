import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";

interface RuntimeAsset {
  fileName: string;
  url: string;
  sha256: string;
  bytes: number;
  root: string;
}

interface RuntimeAssetsManifest {
  schemaVersion: 1;
  packageVersion: string;
  releaseTag: string;
  corpusVersion: string;
  generatedAt: string;
  checks: {
    sqliteSha256: string;
    normalizedTreeSha256: string;
  };
  assets: {
    pack: RuntimeAsset;
    models: RuntimeAsset;
  };
}

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_DIR = path.resolve(ROOT, ".tmp", "release-assets");
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const PACK_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "pack", "manifest.json"), "utf8")
) as { corpusVersion: string; documents: Array<{ normalizedTextPath: string }> };
const PACK_PARTS_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "pack", "ibmi-docs.sqlite.parts.json"), "utf8")
) as { sha256: string };

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const releaseTag = `v${PACKAGE_JSON.version}`;
  const releaseBaseUrl = `https://github.com/h0w4r/MCP-IBMiDocs/releases/download/${releaseTag}`;
  const packFileName = `ibmi-docs-pack-${PACKAGE_JSON.version}.tgz`;
  const modelsFileName = `ibmi-docs-neural-models-${PACKAGE_JSON.version}.tgz`;
  const packFile = path.join(OUTPUT_DIR, packFileName);
  const modelsFile = path.join(OUTPUT_DIR, modelsFileName);
  const deterministicMtime = new Date("2000-01-01T00:00:00.000Z");

  // El release distribuye el SQLite completo; los fragmentos solo son una
  // adaptación histórica para límites de Git, no una necesidad del instalador.
  await tar.c({
    cwd: path.join(ROOT, "data"),
    file: packFile,
    gzip: true,
    portable: true,
    mtime: deterministicMtime,
    filter: (entryPath) => !entryPath.includes("ibmi-docs.sqlite.part-")
      && !entryPath.endsWith("ibmi-docs.sqlite.parts.json")
      && !entryPath.includes("/raw/")
  }, ["pack"]);

  // Los ONNX completos están ignorados por Git. El archivo conserva los
  // fragmentos firmados y postinstall los reconstruye de forma verificable.
  await tar.c({
    cwd: ROOT,
    file: modelsFile,
    gzip: true,
    portable: true,
    mtime: deterministicMtime,
    filter: (entryPath) => !entryPath.endsWith("/onnx/model_quantized.onnx")
  }, ["models"]);

  const assets = {
    pack: await describeAsset(packFile, `${releaseBaseUrl}/${packFileName}`, "pack"),
    models: await describeAsset(modelsFile, `${releaseBaseUrl}/${modelsFileName}`, "models")
  };
  const previousManifest = readPreviousManifest();
  const hashesUnchanged = previousManifest?.packageVersion === PACKAGE_JSON.version
    && previousManifest.assets.pack.sha256 === assets.pack.sha256
    && previousManifest.assets.models.sha256 === assets.models.sha256;
  const manifest: RuntimeAssetsManifest = {
    schemaVersion: 1,
    packageVersion: PACKAGE_JSON.version,
    releaseTag,
    corpusVersion: PACK_MANIFEST.corpusVersion,
    generatedAt: hashesUnchanged && previousManifest
      ? previousManifest.generatedAt
      : new Date().toISOString(),
    checks: {
      sqliteSha256: PACK_PARTS_MANIFEST.sha256,
      normalizedTreeSha256: await sha256NormalizedTree(path.join(ROOT, "data", "pack"), PACK_MANIFEST.documents)
    },
    assets
  };

  fs.writeFileSync(
    path.join(ROOT, "runtime-assets.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  console.log(JSON.stringify(manifest, null, 2));
}

function readPreviousManifest(): RuntimeAssetsManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "runtime-assets.json"), "utf8")) as RuntimeAssetsManifest;
  } catch {
    return undefined;
  }
}

async function describeAsset(file: string, url: string, root: string): Promise<RuntimeAsset> {
  return {
    fileName: path.basename(file),
    url,
    sha256: await sha256File(file),
    bytes: fs.statSync(file).size,
    root
  };
}

async function sha256File(file: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

async function sha256NormalizedTree(
  packDir: string,
  documents: Array<{ normalizedTextPath: string }>
): Promise<string> {
  const aggregate = crypto.createHash("sha256");
  const seen = new Set<string>();
  const sorted = [...documents].sort((left, right) =>
    String(left.normalizedTextPath).localeCompare(String(right.normalizedTextPath))
  );

  for (const document of sorted) {
    const relative = String(document.normalizedTextPath ?? "").replace(/\\/g, "/");
    if (!relative || seen.has(relative)) throw new Error(`Ruta normalizada ausente o duplicada: ${relative || "(vacía)"}`);
    seen.add(relative);
    const file = path.resolve(packDir, relative);
    const containment = path.relative(path.resolve(packDir), file);
    if (containment.startsWith("..") || path.isAbsolute(containment)) {
      throw new Error(`Ruta normalizada fuera del pack: ${relative}`);
    }
    if (!fs.lstatSync(file).isFile()) throw new Error(`Ruta normalizada no regular: ${relative}`);
    aggregate.update(relative).update("\0").update(await sha256File(file)).update("\n");
  }
  return aggregate.digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
