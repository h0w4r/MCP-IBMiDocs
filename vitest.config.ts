import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Las pruebas agénticas deep ejecutan recuperación semántica local + multi-hop sobre el corpus.
    // En Windows/CI pueden superar 20s sin indicar bloqueo real.
    testTimeout: 60000
  }
});
