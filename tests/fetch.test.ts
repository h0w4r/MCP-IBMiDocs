import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadFileWithTimeout } from "../src/util/fetch.js";

const temporaryRoots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function serve(body: Buffer, declareLength = true): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/gzip");
    if (declareLength) response.setHeader("content-length", body.length);
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se obtuvo puerto HTTP de prueba.");
  return `http://127.0.0.1:${address.port}/pack.tgz`;
}

async function destination(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ibmi-docs-download-"));
  temporaryRoots.push(root);
  return path.join(root, "pack.tgz");
}

describe("descarga streaming", () => {
  it("materializa el archivo sin acumular el asset completo en memoria", async () => {
    const body = Buffer.alloc(256 * 1024, 0x5a);
    const url = await serve(body);
    const file = await destination();

    const result = await downloadFileWithTimeout(url, file, { maxBytes: body.length + 1 });
    expect(result.bytes).toBe(body.length);
    expect(await fs.readFile(file)).toEqual(body);
  });

  it("corta una respuesta chunked que supera el límite y elimina parciales", async () => {
    const body = Buffer.alloc(64 * 1024, 0x41);
    const url = await serve(body, false);
    const file = await destination();

    await expect(downloadFileWithTimeout(url, file, { maxBytes: 1024 })).rejects.toThrow(/máximo permitido/i);
    const entries = await fs.readdir(path.dirname(file));
    expect(entries).toEqual([]);
  });

  it("rechaza límites inválidos antes de iniciar una descarga", async () => {
    const file = await destination();
    await expect(downloadFileWithTimeout("http://127.0.0.1:1/no-fetch", file, { maxBytes: Number.NaN }))
      .rejects.toThrow(/maxBytes debe ser/i);
  });

  it("aborta por timeout y elimina el archivo parcial", async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/gzip");
      setTimeout(() => response.end(Buffer.alloc(1024)), 250);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No se obtuvo puerto HTTP de prueba.");
    const file = await destination();

    await expect(downloadFileWithTimeout(`http://127.0.0.1:${address.port}/slow`, file, { timeoutMs: 20 }))
      .rejects.toThrow(/Timeout descargando/i);
    expect(await fs.readdir(path.dirname(file))).toEqual([]);
  });
});
