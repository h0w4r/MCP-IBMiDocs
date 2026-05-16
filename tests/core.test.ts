import { describe, expect, it } from "vitest";
import { extractDocumentContent, inferCategory } from "../src/util/html.js";
import { toFtsQuery } from "../src/repository/CorpusRepository.js";
import fs from "node:fs";

// Regresión: el HTML de ayuda trae scripts/frames de Eclipse, pero el corpus debe quedarse con texto útil.
describe("normalización documental", () => {
  it("extrae título, versión y limpia scripts", () => {
    const html = `<html lang="en-us"><head><meta name="DC.title" content="ILE RPG Reference"><meta name="version" content="7.6"></head><body><script>alert(1)</script><h1>ILE RPG Reference</h1><p>CRTRPGMOD creates modules.</p></body></html>`;
    const doc = extractDocumentContent(html);
    expect(doc.title).toBe("ILE RPG Reference");
    expect(doc.version).toBe("7.6");
    expect(doc.text).toContain("CRTRPGMOD creates modules");
    expect(doc.text).not.toContain("alert");
  });

  it("clasifica documentos IBM i por categoría técnica", () => {
    expect(inferCategory({ title: "RNF0004", text: "Compiler not able to access file" })).toBe("mensajes-rnf");
    expect(inferCategory({ title: "Control language", text: "CLLE command" })).toBe("cl-clle");
    expect(inferCategory({ title: "DDS physical file", text: "PF LF" })).toBe("dds");
  });
});

describe("seguridad de búsqueda FTS", () => {
  it("parametriza por tokens y expande sinónimos IBM i", () => {
    const query = toFtsQuery("CRTRPGMOD '; DROP TABLE documents; --");
    expect(query).toContain('"crtrpgmod"');
    expect(query).toContain('"rpgle"');
    expect(query).not.toContain("DROP TABLE");
  });
});

describe("anti dependencia runtime RDi", () => {
  it("el servidor runtime no contiene endpoint local temporal", () => {
    const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(server).not.toContain("52070");
    expect(server).not.toContain("export-rdi");
  });

  it("el data pack distribuible no publica URLs loopback de bootstrap", () => {
    const manifestUrl = new URL("../data/pack/manifest.json", import.meta.url);
    if (!fs.existsSync(manifestUrl)) return;
    const manifest = fs.readFileSync(manifestUrl, "utf8");
    expect(manifest).not.toMatch(/127\.0\.0\.1|localhost|52070/i);
    expect(manifest).toContain("rdi-help-bootstrap://local-export");
  });

  it("los bins npm apuntan a la salida real de TypeScript", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(packageJson.bin["ibmi-docs-mcp"]).toBe("./dist/src/server.js");
    expect(packageJson.bin["ibmi-docs"]).toBe("./dist/src/cli.js");
  });
});
