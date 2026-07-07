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

  const answer = repo.answer({ question: "Explica SND-MSG, %MSG y %TARGET", language: "RPGLE", includeExamples: true, limit: 3 });
  console.log("Answer SND-MSG:", JSON.stringify({ confidence: answer.confidence, citations: answer.citations.length }, null, 2));
  if (!answer.citations.length || !answer.answer.includes("Respuesta basada")) process.exitCode = 1;

  const assisted = repo.assist({
    question: "Corregir CLLE con RTVJOBA y MONMSG; necesito pasos y validación",
    language: "CLLE",
    version: "7.5",
    depth: "deep",
    includeCompileCommands: true,
    limit: 4
  });
  console.log("Assist CLLE:", JSON.stringify({
    intent: assisted.intent,
    confidence: assisted.confidence,
    coverage: assisted.coverage.status,
    evidence: assisted.coverage.evidenceCount,
    reads: assisted.coverage.readCount,
    sections: assisted.coverage.sectionCount
  }, null, 2));
  if (
    assisted.coverage.status === "thin"
    || assisted.implementationSteps.length < 3
    || assisted.validationChecklist.length < 3
    || /llama ibmi_docs_read|usa ibmi_docs_sections|Siguiente paso recomendado|Para obtener la ayuda completa/i.test(JSON.stringify(assisted))
  ) {
    process.exitCode = 1;
  }

  // Valida el workflow agéntico principal: resolve debe leer evidencia y extraer secciones útiles.
  const resolvedSyntax = repo.resolve({
    question: "Explica la sintaxis de SND-MSG con %MSG y %TARGET",
    language: "RPGLE",
    version: "7.6",
    includeExamples: true,
    limit: 3
  });
  console.log("Resolve SND-MSG:", JSON.stringify({
    intent: resolvedSyntax.intent,
    confidence: resolvedSyntax.confidence,
    reads: resolvedSyntax.reads.length,
    sections: resolvedSyntax.sections.length,
    citations: resolvedSyntax.citations.length
  }, null, 2));
  if (
    resolvedSyntax.intent !== "syntax_lookup"
    || resolvedSyntax.reads.length === 0
    || resolvedSyntax.sections.length === 0
    || !resolvedSyntax.stages.some((stage) => stage.tool === "ibmi_docs_read")
  ) {
    process.exitCode = 1;
  }

  const resolvedMessage = repo.resolve({
    question: "Diagnostica RNF0004 en una compilación RPGLE",
    language: "RPGLE",
    limit: 3
  });
  console.log("Resolve RNF0004:", JSON.stringify({
    intent: resolvedMessage.intent,
    messageId: resolvedMessage.messageExplanation?.messageId,
    reads: resolvedMessage.reads.length
  }, null, 2));
  if (resolvedMessage.intent !== "message_diagnostic" || resolvedMessage.messageExplanation?.messageId !== "RNF0004") {
    process.exitCode = 1;
  }

  // Los comandos IBM i específicos deben activar auto-read para evitar respuestas basadas solo en snippets.
  const commandAutoRead = repo.search({ query: "CRTRPGMOD command", version: "7.6", limit: 1 });
  console.log("Command auto-read:", JSON.stringify({
    title: commandAutoRead[0]?.title,
    autoReadApplied: commandAutoRead[0]?.autoReadApplied,
    hasContent: Boolean(commandAutoRead[0]?.fullContent)
  }, null, 2));
  if (!commandAutoRead[0]?.autoReadApplied || !commandAutoRead[0]?.fullContent) process.exitCode = 1;

  const ranking = repo.explainRanking({ query: "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET", category: "ile-rpg", top: 3 });
  console.log("Ranking SND-MSG:", JSON.stringify({ semanticQueries: ranking.semanticQueries.length, results: ranking.results.length }, null, 2));
  if (!ranking.semanticQueries.length || !ranking.results.length) process.exitCode = 1;

  // El reporte debe ser seguro aunque las trazas opcionales estén desactivadas.
  const traceReport = repo.traceReport(10);
  console.log("Trace report:", JSON.stringify({
    events: traceReport.events,
    searchOnlyRate: traceReport.searchOnlyRate,
    searchThenReadRate: traceReport.searchThenReadRate,
    answerUsageRate: traceReport.answerUsageRate
  }, null, 2));
  if (
    typeof traceReport.searchOnlyRate !== "number"
    || typeof traceReport.searchThenReadRate !== "number"
    || typeof traceReport.answerUsageRate !== "number"
  ) {
    process.exitCode = 1;
  }

  const quality = repo.qualityReport();
  console.log("Quality report:", JSON.stringify({ ok: quality.ok, docs: quality.documents, short: quality.shortDocuments.length }, null, 2));
  if (!quality.documents || !quality.recommendations.length) process.exitCode = 1;
} finally {
  repo.close();
}
