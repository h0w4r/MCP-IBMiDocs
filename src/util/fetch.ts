export interface FetchWithTimeoutOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Descarga contenido binario con timeout y límite de tamaño.
 * Evita que sync/install queden colgados o consuman memoria sin control.
 */
export async function fetchBufferWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<{ buffer: Buffer; contentType: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
    const reader = response.body.getReader();
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
    } finally {
      reader.releaseLock();
    }

    return {
      buffer: Buffer.concat(chunks),
      contentType: response.headers.get("content-type") ?? ""
    };
  } catch (error) {
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
