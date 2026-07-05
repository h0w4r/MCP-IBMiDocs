import { describe, expect, it } from "vitest";
import { extractDocumentContent, inferCategory } from "../src/util/html.js";
import { toFtsQuery } from "../src/repository/CorpusRepository.js";
import { createServer } from "../src/server.js";
import { loadPackageVersion } from "../src/util/packageVersion.js";
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

  it("preserva estructura útil de tablas, listas y bloques de código", () => {
    const html = `
      <html><head><meta name="DC.title" content="CRTRPGMOD Command"></head>
      <body>
        <h1>CRTRPGMOD Command</h1>
        <p>Creates an RPG module.</p>
        <table><tr><th>Parameter</th><th>Description</th></tr><tr><td>SRCFILE</td><td>Source file</td></tr></table>
        <ul><li>Use DBGVIEW for debugging.</li></ul>
        <pre>CRTRPGMOD MODULE(MYLIB/HELLO) SRCFILE(MYLIB/QRPGLESRC)</pre>
      </body></html>`;
    const doc = extractDocumentContent(html);

    expect(doc.text).toContain("Parameter | Description");
    expect(doc.text).toContain("SRCFILE | Source file");
    expect(doc.text).toContain("- Use DBGVIEW for debugging.");
    expect(doc.text).toContain("CRTRPGMOD MODULE(MYLIB/HELLO)");
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
    expect(packageJson.bin["ibmi-docs-mcp"].replace(/^\.\//, "")).toBe("dist/src/server.js");
    expect(packageJson.bin["ibmi-docs"].replace(/^\.\//, "")).toBe("dist/src/cli.js");
  });

  it("el runtime reporta la versión real del paquete y no un literal obsoleto", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(loadPackageVersion()).toBe(packageJson.version);

    const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(server).not.toContain('version: "0.6.0"');
  });

  it("no expone tools de mantenimiento o sincronización en runtime de usuario", () => {
    const previousAllowNetworkSync = process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
    delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
    try {
      const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
      const tools = Object.keys(server._registeredTools);

      expect(tools).toContain("ibmi_docs_assist");
      expect(tools).toContain("ibmi_docs_context");
      expect(tools).not.toContain("ibmi_docs_sync");
    } finally {
      if (previousAllowNetworkSync === undefined) delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
      else process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = previousAllowNetworkSync;
    }
  });

  it("expone ibmi_docs_sync solo cuando el operador habilita sincronización de red explícitamente", () => {
    const previousAllowNetworkSync = process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
    process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = "1";
    try {
      const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
      expect(Object.keys(server._registeredTools)).toContain("ibmi_docs_sync");
    } finally {
      if (previousAllowNetworkSync === undefined) delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
      else process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = previousAllowNetworkSync;
    }
  });
});
