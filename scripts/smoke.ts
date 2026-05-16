import { CorpusRepository } from "../src/repository/CorpusRepository.js";

const queries = ["CRTRPGMOD", "RNF0004", "CLLE", "DDS PF", "SQLRPGLE"];
const repo = new CorpusRepository(process.env.IBMI_DOCS_PACK_DIR ?? "data/pack");
try {
  console.log("Diagnóstico:", JSON.stringify(repo.diagnostics(), null, 2));
  for (const query of queries) {
    const results = repo.search({ query, limit: 5 });
    console.log(`\n[${query}] resultados=${results.length}`);
    for (const result of results.slice(0, 3)) {
      console.log(`- ${result.id} | ${result.title} | ${result.version} | ${result.category}`);
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
} finally {
  repo.close();
}
