import fs from "node:fs/promises";
import path from "node:path";

export interface FetchWithTimeoutOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface DownloadFileResult {
  file: string;
  contentType: string;
  bytes: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Descarga contenido binario con timeout y límite de tamaño.
 * Evita que sync/install queden colgados o consuman memoria sin control.
 */
export async function fetchBufferWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<{ buffer: Buffer; contentType: string }> {
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await fetch(url, { headers: options.headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Descarga demasiado grande: ${contentLength} bytes; máximo permitido ${maxBytes}.`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    if (!response.body) throw new Error("La respuesta HTTP no contiene body.");

    // Node expone fetch.body como Web ReadableStream. Usamos reader explícito
    // para mantener compatibilidad de tipos TypeScript y cortar por tamaño.
    reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        total += buffer.length;
        if (total > maxBytes) {
          throw new Error(`Descarga excede el máximo permitido de ${maxBytes} bytes.`);
        }
        chunks.push(buffer);
      }
    } catch (error) {
      controller.abort();
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
      reader = undefined;
    }

    return {
      buffer: Buffer.concat(chunks),
      contentType: response.headers.get("content-type") ?? ""
    };
  } catch (error) {
    controller.abort();
    await reader?.cancel(error).catch(() => undefined);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timeout descargando ${url} tras ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Descarga directamente a disco para que un data pack grande no se duplique
 * completo en RAM. El archivo parcial se elimina ante timeout, error HTTP o
 * exceso del límite configurado.
 */
export async function downloadFileWithTimeout(
  url: string,
  destination: string,
  options: FetchWithTimeoutOptions = {}
): Promise<DownloadFileResult> {
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const resolvedDestination = path.resolve(destination);
  const partialFile = `${resolvedDestination}.partial-${process.pid}-${Date.now()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await fetch(url, { headers: options.headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error("La respuesta HTTP no contiene body.");

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Descarga demasiado grande: ${contentLength} bytes; máximo permitido ${maxBytes}.`);
    }

    await fs.mkdir(path.dirname(resolvedDestination), { recursive: true });
    handle = await fs.open(partialFile, "wx");
    reader = response.body.getReader();
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        total += buffer.length;
        if (total > maxBytes) throw new Error(`Descarga excede el máximo permitido de ${maxBytes} bytes.`);
        await writeCompleteBuffer(handle, buffer);
      }
    } catch (error) {
      controller.abort();
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(partialFile, resolvedDestination);
    return {
      file: resolvedDestination,
      contentType: response.headers.get("content-type") ?? "",
      bytes: total
    };
  } catch (error) {
    controller.abort();
    await reader?.cancel(error).catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await fs.rm(partialFile, { force: true }).catch(() => undefined);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timeout descargando ${url} tras ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Variante textual usada por crawlers. Conserva límite de tamaño para evitar
 * shells HTML gigantes o respuestas anómalas.
 */
export async function fetchTextWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<string> {
  const { buffer } = await fetchBufferWithTimeout(url, options);
  return buffer.toString("utf8");
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} debe ser un número finito mayor que cero.`);
  }
  return resolved;
}

async function writeCompleteBuffer(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error("La escritura de la descarga no avanzó.");
    offset += bytesWritten;
  }
}
