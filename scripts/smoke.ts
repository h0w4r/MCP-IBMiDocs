import { CorpusRepository } from "../src/repository/CorpusRepository.js";

const queries = ["CRTRPGMOD", "RNF0004", "CLLE", "DDS PF", "SQLRPGLE"];
const repo = new CorpusRepository(process.env.IBMI_DOCS_PACK_DIR ?? "data/pack");
try {
  console.log("Diagnóstico:", JSON.stringify(repo.diagnostics(), null, 2));
  const pack = repo.packDiagnostics();
  console.log("Pack diagnostics:", JSON.stringify(pack, null, 2));
  if (!pack.ok) process.exitCode = 1;

  for (const query of queries) {
    const results = repo.search({ query, limit: 5 });
    console.log(`\n[${query}] resultados=${results.length}`);
    for (const result of results.slice(0, 3)) {
      console.log(`- ${result.id} | ${result.title} | ${result.version} | ${result.category} | score=${result.score}`);
    }
    if (results.length === 0) {
      process.exitCode = 1;
      continue;
    }

    const fullTopic = repo.read(results[0].id);
    if (!fullTopic?.content.trim()) {
      console.error(`No se pudo leer tópico completo para ${query}: ${results[0].id}`);
      process.exitCode = 1;
    } else {
      console.log(`  lectura_ok=${fullTopic.content.length} caracteres`);
    }
  }

  const context = repo.context({ task: "Crear programa SQLRPGLE con embedded SQL e includes", language: "SQLRPGLE", limit: 5 });
  console.log("\nContext SQLRPGLE:", JSON.stringify({ compileCommands: context.compileCommands, docs: context.recommendedDocs.length }, null, 2));
  if (!context.compileCommands.includes("CRTSQLRPGI") || context.recommendedDocs.length === 0) process.exitCode = 1;

  const guidance = repo.compileGuidance({ language: "SQLRPGLE", usesEmbeddedSql: true, usesCopybook: true, limit: 5 });
  console.log("Compile guidance:", JSON.stringify({ commands: guidance.recommendedCommands, evidence: guidance.evidence.length }, null, 2));
  if (!guidance.recommendedCommands.includes("CRTSQLRPGI") || guidance.evidence.length === 0) process.exitCode = 1;

  const related = repo.related("ibm-730-commands-crtrpgmod-command-7d3ce327", { limit: 5 });
  console.log("Related CRTRPGMOD:", JSON.stringify({ equivalents: related.equivalentVersions.length, related: related.related.length }, null, 2));
  if (!related.topic || related.equivalentVersions.length === 0) process.exitCode = 1;
} finally {
  repo.close();
}
