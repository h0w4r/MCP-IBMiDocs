import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Algunas pruebas agénticas recorren el corpus SQLite/FTS completo; en CI Windows pueden pasar de 5s.
    testTimeout: 20000
  }
});
