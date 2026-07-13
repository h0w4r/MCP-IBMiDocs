import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface InstallLock {
  owner: string;
  heartbeat: NodeJS.Timeout;
  file: string;
}

interface PostinstallExports {
  acquireInstallLock: (file?: string, options?: { waitMs?: number; staleMs?: number; heartbeatMs?: number }) => Promise<InstallLock>;
  releaseInstallLock: (lock?: InstallLock) => Promise<void>;
  sha256NormalizedTree: (packDir: string, documents: Array<{ normalizedTextPath: string }>) => Promise<string>;
  validatePackIntegrity: (packDir: string, corpusVersion: string, sqliteSha256: string, normalizedTreeSha256: string) => Promise<void>;
}

const require = createRequire(import.meta.url);
const installer = require("../postinstall.cjs") as PostinstallExports;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe("postinstall robusto", () => {
  it("mantiene vivo el lock y no permite que otra instalación lo robe por antigüedad", async () => {
    const root = await tempDir("ibmi-install-lock-");
    const file = path.join(root, "install.lock");
    const first = await installer.acquireInstallLock(file, { waitMs: 50, staleMs: 40, heartbeatMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(installer.acquireInstallLock(file, { waitMs: 40, staleMs: 40, heartbeatMs: 5 }))
      .rejects.toThrow(/otra instalación/i);
    await installer.releaseInstallLock(first);

    const second = await installer.acquireInstallLock(file, { waitMs: 50, staleMs: 40, heartbeatMs: 5 });
    await installer.releaseInstallLock(second);
  });

  it("no elimina un lock cuyo propietario cambió", async () => {
    const root = await tempDir("ibmi-install-owner-");
    const file = path.join(root, "install.lock");
    const lock = await installer.acquireInstallLock(file, { waitMs: 50, staleMs: 1_000, heartbeatMs: 50 });
    await fs.writeFile(file, JSON.stringify({ owner: "otro-proceso" }), "utf8");

    await installer.releaseInstallLock(lock);
    expect(JSON.parse(await fs.readFile(file, "utf8")).owner).toBe("otro-proceso");
  });

  it("detecta cualquier texto normalizado ausente o alterado", async () => {
    const root = await tempDir("ibmi-install-pack-");
    await fs.mkdir(path.join(root, "normalized"), { recursive: true });
    await fs.writeFile(path.join(root, "normalized", "doc.txt"), "contenido íntegro", "utf8");
    await fs.writeFile(path.join(root, "ibmi-docs.sqlite"), "sqlite-de-prueba", "utf8");
    const manifest = {
      corpusVersion: "test-pack",
      documents: [{ normalizedTextPath: "normalized/doc.txt" }]
    };
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), "utf8");
    const sqliteSha256 = crypto.createHash("sha256").update("sqlite-de-prueba").digest("hex");
    const normalizedTreeSha256 = await installer.sha256NormalizedTree(root, manifest.documents);

    await expect(installer.validatePackIntegrity(root, "test-pack", sqliteSha256, normalizedTreeSha256)).resolves.toBeUndefined();
    await fs.writeFile(path.join(root, "normalized", "doc.txt"), "contenido alterado", "utf8");
    await expect(installer.validatePackIntegrity(root, "test-pack", sqliteSha256, normalizedTreeSha256))
      .rejects.toThrow(/textos normalizados/i);
  });
});
