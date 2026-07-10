import { describe, expect, it } from "vitest";
import { extractDocumentContent, inferCategory } from "../src/util/html.js";
import { createServer } from "../src/server.js";
import { loadPackageVersion } from "../src/util/packageVersion.js";
import { buildEmbeddingChunkBodies } from "../src/ingest/packBuilder.js";
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

  it("crea chunks atómicos para entradas de índices documentales", () => {
    const text = [
      "CL command finder",
      "",
      "STRQRY (Start Query) command",
      "",
      "STRRLU (Start Report Layout Utility) command",
      "",
      "STRSEU (Start Source Entry Utility) command",
      "",
      "Abbreviations",
      "",
      "RLU",
      "report layout utility"
    ].join("\n");

    const chunks = buildEmbeddingChunkBodies(text, 3200);

    expect(chunks).toContain("STRRLU (Start Report Layout Utility) command");
    expect(chunks).toContain("RLU report layout utility");
  });
});

describe("anti dependencia runtime RDi", () => {
  it("el servidor runtime no contiene endpoint local temporal", () => {
    const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(server).not.toContain("52070");
    expect(server).not.toContain("export-rdi");
  });

  it("el runtime documental no reintroduce clasificadores, presets ni rescates no neuronales", () => {
    const runtimeSource = [
      fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("../src/repository/CorpusRepository.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("../src/repository/neuralEmbeddings.ts", import.meta.url), "utf8")
    ].join("\n");

    expect(fs.existsSync(new URL("../src/repository/semanticVector.ts", import.meta.url))).toBe(false);
    expect(runtimeSource).not.toMatch(/\b(fallback|legacy|FTS)\b/i);
    expect(runtimeSource).not.toMatch(/classifyAssistIntentNeural|NeuralAssistIntentProfile|neuralIntentClassifier|PROTOTYPES|SEMANTIC_EXPANSIONS|CONCEPT_RULES|CATEGORY_CONCEPTS|IBM_I_COMMAND_ALIASES|semanticQueryExpansions|LANGUAGE_PRESETS|resolvePreset|buildAssistIntentProfile|extractSemanticEntityAnchors|inferAssistAxisForQuery|classifyResolveIntent|semanticVector/);
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
    const previousToolProfile = process.env.IBMI_DOCS_TOOL_PROFILE;
    delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
    delete process.env.IBMI_DOCS_TOOL_PROFILE;
    try {
      const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
      const tools = Object.keys(server._registeredTools);

      expect(tools).toContain("ibmi_docs_assist");
      expect(tools).not.toContain("ibmi_docs_diagnostics");
      expect(tools).not.toContain("ibmi_docs_categories");
      expect(tools).not.toContain("ibmi_docs_context");
      expect(tools).not.toContain("ibmi_docs_search");
      expect(tools).not.toContain("ibmi_docs_read");
      expect(tools).not.toContain("ibmi_docs_sync");
      expect(tools).toEqual(["ibmi_docs_assist"]);
    } finally {
      if (previousAllowNetworkSync === undefined) delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
      else process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = previousAllowNetworkSync;
      if (previousToolProfile === undefined) delete process.env.IBMI_DOCS_TOOL_PROFILE;
      else process.env.IBMI_DOCS_TOOL_PROFILE = previousToolProfile;
    }
  });

  it("expone tools avanzadas cuando el operador usa perfil full", () => {
    const previousToolProfile = process.env.IBMI_DOCS_TOOL_PROFILE;
    process.env.IBMI_DOCS_TOOL_PROFILE = "full";
    try {
      const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
      const tools = Object.keys(server._registeredTools);

      expect(tools).toContain("ibmi_docs_assist");
      expect(tools).toContain("ibmi_docs_context");
      expect(tools).toContain("ibmi_docs_resolve");
      expect(tools).toContain("ibmi_docs_search");
      expect(tools).toContain("ibmi_docs_read");
      expect(tools).toContain("ibmi_docs_sections");
      expect(tools).not.toContain("ibmi_docs_sync");
    } finally {
      if (previousToolProfile === undefined) delete process.env.IBMI_DOCS_TOOL_PROFILE;
      else process.env.IBMI_DOCS_TOOL_PROFILE = previousToolProfile;
    }
  });

  it("expone ibmi_docs_sync solo cuando el operador habilita perfil full y sincronización de red", () => {
    const previousAllowNetworkSync = process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
    const previousToolProfile = process.env.IBMI_DOCS_TOOL_PROFILE;
    process.env.IBMI_DOCS_TOOL_PROFILE = "full";
    process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = "1";
    try {
      const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
      expect(Object.keys(server._registeredTools)).toContain("ibmi_docs_sync");
    } finally {
      if (previousAllowNetworkSync === undefined) delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
      else process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = previousAllowNetworkSync;
      if (previousToolProfile === undefined) delete process.env.IBMI_DOCS_TOOL_PROFILE;
      else process.env.IBMI_DOCS_TOOL_PROFILE = previousToolProfile;
    }
  });

  it("no expone sync aunque haya red habilitada si el perfil sigue siendo agent", () => {
    const previousAllowNetworkSync = process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
    const previousToolProfile = process.env.IBMI_DOCS_TOOL_PROFILE;
    process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = "1";
    delete process.env.IBMI_DOCS_TOOL_PROFILE;
    try {
      const server = createServer() as unknown as { _registeredTools: Record<string, unknown> };
      expect(Object.keys(server._registeredTools)).not.toContain("ibmi_docs_sync");
    } finally {
      if (previousAllowNetworkSync === undefined) delete process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC;
      else process.env.IBMI_DOCS_ALLOW_NETWORK_SYNC = previousAllowNetworkSync;
      if (previousToolProfile === undefined) delete process.env.IBMI_DOCS_TOOL_PROFILE;
      else process.env.IBMI_DOCS_TOOL_PROFILE = previousToolProfile;
    }
  });
});

describe("dataset de preguntas de desarrollo", () => {
  it("mantiene un registry auditable y seguro para fuentes Q&A", () => {
    const registry = JSON.parse(fs.readFileSync(new URL("./fixtures/question-bank.sources.json", import.meta.url), "utf8")) as {
      sources: Array<{
        id?: string;
        kind?: string;
        licenseStatus?: string;
        licenseNote?: string;
        redistributable?: boolean;
        devOnly?: boolean;
        urls?: string[];
        path?: string;
        site?: string;
        tags?: string[];
        searchQueries?: string[];
      }>;
    };

    expect(Array.isArray(registry.sources)).toBe(true);
    expect(registry.sources.length).toBeGreaterThanOrEqual(10);
    for (const source of registry.sources) {
      expect(source.id).toBeTruthy();
      expect(["web", "pdf", "fixture", "stackexchange", "allinterview"]).toContain(source.kind);
      expect(source.licenseStatus).toBeTruthy();
      expect(source.licenseNote).toBeTruthy();
      if (source.kind === "stackexchange") {
        expect(source.site).toBeTruthy();
        expect((source.tags?.length ?? 0) + (source.searchQueries?.length ?? 0)).toBeGreaterThan(0);
      } else {
        expect(source.urls?.length || source.path).toBeTruthy();
      }
      if (source.licenseStatus === "unknown") {
        expect(source.devOnly).toBe(true);
        expect(source.redistributable).not.toBe(true);
      }
    }
  });

  it("conserva el cache curado de IBMiSkills como fixture reproducible", () => {
    const cache = JSON.parse(fs.readFileSync(new URL("./fixtures/dev-question-bank.ibmiskills-cache.json", import.meta.url), "utf8")) as Array<{
      question?: string;
      expectedAnswerSummary?: string;
      extraction?: { sourceKind?: string };
    }>;

    expect(cache.length).toBeGreaterThanOrEqual(250);
    expect(cache.every((item) => item.question && item.expectedAnswerSummary)).toBe(true);
    expect(cache.every((item) => item.extraction?.sourceKind === "ibmiskills-web")).toBe(true);
  });
});
