import { CorpusRepository } from "../src/repository/CorpusRepository.js";

const queries = ["CRTRPGMOD", "RNF5393", "CLLE", "DDS PF", "SQLRPGLE"];

async function main(): Promise<void> {
  const repo = new CorpusRepository(process.env.IBMI_DOCS_PACK_DIR ?? "data/pack");
  try {
    console.log("Diagnóstico:", JSON.stringify(repo.diagnostics(), null, 2));
    const pack = repo.packDiagnostics();
    console.log("Pack diagnostics:", JSON.stringify(pack, null, 2));
    if (!pack.ok || !pack.vectorCoverage?.ok) process.exitCode = 1;

    for (const query of queries) {
      const results = await repo.search({ query, limit: 5 });
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

    const sqlRpgle = await repo.assist({
      question: "Crear programa SQLRPGLE con embedded SQL e includes; necesito comando, parámetros y validación.",
      language: "SQLRPGLE",
      depth: "deep",
      limit: 6
    });
    console.log("\nAssist SQLRPGLE:", JSON.stringify({
      confidence: sqlRpgle.confidence,
      evidence: sqlRpgle.coverage.evidenceCount,
      reads: sqlRpgle.coverage.readCount,
      sections: sqlRpgle.coverage.sectionCount
    }, null, 2));
    if (sqlRpgle.coverage.status === "thin" || !/CRTSQLRPGI|SQLRPGLE|embedded SQL|\/COPY|\/INCLUDE/i.test(JSON.stringify(sqlRpgle))) {
      process.exitCode = 1;
    }

    const assisted = await repo.assist({
      question: "Corregir CLLE con RTVJOBA y MONMSG; necesito pasos y validación",
      language: "CLLE",
      version: "7.5",
      depth: "deep",
      limit: 4
    });
    console.log("Assist CLLE:", JSON.stringify({
      confidence: assisted.confidence,
      coverage: assisted.coverage.status,
      evidence: assisted.coverage.evidenceCount,
      reads: assisted.coverage.readCount,
      sections: assisted.coverage.sectionCount
    }, null, 2));
    if (
      assisted.coverage.status === "thin"
      || !assisted.answer.trim()
      || /No encontré evidencia documental suficientemente relacionada/i.test(assisted.answer)
      || /llama ibmi_docs_read|usa ibmi_docs_sections|Siguiente paso recomendado|Para obtener la ayuda completa/i.test(JSON.stringify(assisted))
    ) {
      process.exitCode = 1;
    }

    const resolvedSyntax = await repo.assist({
      question: "Explica la sintaxis de SND-MSG con %MSG y %TARGET",
      language: "RPGLE",
      version: "7.6",
      limit: 5
    });
    console.log("Assist SND-MSG:", JSON.stringify({
      confidence: resolvedSyntax.confidence,
      reads: resolvedSyntax.reads.length,
      sections: resolvedSyntax.sections.length,
      citations: resolvedSyntax.citations.length
    }, null, 2));
    if (
      resolvedSyntax.confidence === "baja"
      || resolvedSyntax.reads.length === 0
      || resolvedSyntax.sections.length === 0
      || !/SND-MSG|%MSG|%TARGET/i.test(JSON.stringify(resolvedSyntax))
    ) {
      process.exitCode = 1;
    }

    const commandAutoRead = await repo.search({ query: "CRTRPGMOD command", version: "7.6", limit: 1, autoRead: true });
    console.log("Command auto-read:", JSON.stringify({
      title: commandAutoRead[0]?.title,
      autoReadApplied: commandAutoRead[0]?.autoReadApplied,
      hasContent: Boolean(commandAutoRead[0]?.fullContent)
    }, null, 2));
    if (!commandAutoRead[0]?.autoReadApplied || !commandAutoRead[0]?.fullContent) process.exitCode = 1;

    const related = repo.related("ibm-730-commands-crtrpgmod-command-7d3ce327", { limit: 5 });
    console.log("Related CRTRPGMOD:", JSON.stringify({ equivalents: related.equivalentVersions.length, related: related.related.length }, null, 2));
    if (!related.topic || related.equivalentVersions.length === 0) process.exitCode = 1;

    const traceReport = repo.traceReport(10);
    console.log("Trace report:", JSON.stringify({
      events: traceReport.events,
      searchOnlyRate: traceReport.searchOnlyRate,
      searchThenReadRate: traceReport.searchThenReadRate,
      assistUsageRate: traceReport.assistUsageRate
    }, null, 2));
    if (
      typeof traceReport.searchOnlyRate !== "number"
      || typeof traceReport.searchThenReadRate !== "number"
      || typeof traceReport.assistUsageRate !== "number"
    ) {
      process.exitCode = 1;
    }

    const quality = repo.qualityReport();
    console.log("Quality report:", JSON.stringify({
      ok: quality.ok,
      docs: quality.documents,
      chunks: quality.chunks,
      vectorsOk: quality.vectorCoverage?.ok,
      short: quality.shortDocuments.length
    }, null, 2));
    if (!quality.documents || !quality.recommendations.length || !quality.vectorCoverage?.ok) process.exitCode = 1;
  } finally {
    repo.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
