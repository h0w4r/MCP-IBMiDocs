import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Las pruebas end-to-end cargan embeddings y reranker local, y algunas
    // validan varios procesos CLI/MCP consecutivos. En CPU pueden superar un
    // minuto sin indicar bloqueo real.
    testTimeout: 180000,
    // Cada worker puede cargar E5 y BGE en memoria. Serializar archivos evita
    // falsos fallos por presión de RAM cuando las suites CLI y MCP coinciden.
    fileParallelism: false,
    maxWorkers: 1
  }
});
