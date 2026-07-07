import fs from "node:fs";
import path from "node:path";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";

interface QuestionBankCase {
  id: string;
  source: string;
  licenseNote?: string;
  question: string;
  language?: string;
  version?: string;
  expectedAnswerSummary: string;
  answerMustContainAny: string[];
  evidenceMustContainAny: string[];
  forbiddenAny?: string[];
}

interface CaseResult {
  id: string;
  source: string;
  passed: boolean;
  score: number;
  answerMatched: string[];
  evidenceMatched: string[];
  forbiddenMatched: string[];
  coverageStatus: string;
  confidence: string;
  topCitations: string[];
  failureReasons: string[];
}

interface EvalOptions {
  fixture: string;
  pack: string;
  minPassRate: number;
  out?: string;
}

const DEFAULT_FIXTURE = path.resolve("tests", "fixtures", "dev-question-bank.sample.json");
const DEFAULT_PACK = path.resolve("data", "pack");

function parseArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {
    fixture: DEFAULT_FIXTURE,
    pack: process.env.IBMI_DOCS_PACK_DIR || DEFAULT_PACK,
    minPassRate: 0.6
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--fixture" && next) {
      options.fixture = path.resolve(next);
      index += 1;
    } else if (arg === "--pack" && next) {
      options.pack = path.resolve(next);
      index += 1;
    } else if (arg === "--min-pass-rate" && next) {
      options.minPassRate = Number(next);
      index += 1;
    } else if (arg === "--out" && next) {
      options.out = path.resolve(next);
      index += 1;
    }
  }
  return options;
}

function loadCases(fixturePath: string): QuestionBankCase[] {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as QuestionBankCase[];
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`Fixture sin casos evaluables: ${fixturePath}`);
  }
  return parsed;
}

function containsAny(haystack: string, needles: string[]): string[] {
  const normalizedHaystack = fold(haystack);
  return needles.filter((needle) => normalizedHaystack.includes(fold(needle)));
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function evaluateCase(repo: CorpusRepository, item: QuestionBankCase): CaseResult {
  const assist = repo.assist({
    question: item.question,
    language: item.language,
    version: item.version,
    depth: "deep",
    audience: "agent",
    includeExamples: true,
    includeCompileCommands: true,
    limit: 8
  });

  // El objetivo del harness no es comparar texto literal del banco:
  // valida que el MCP recupere evidencia alineada y no fabrique una respuesta fuera de dominio.
  const answerCorpus = [
    assist.answer,
    assist.executiveSummary.join(" "),
    assist.implementationSteps.join(" "),
    assist.validationChecklist.join(" "),
    assist.coverage.matchedTechnicalTerms.join(" "),
    assist.specificFindings.join(" ")
  ].join("\n");
  const evidenceCorpus = [
    ...assist.citations.map((citation) => `${citation.title} ${citation.section ?? ""} ${citation.id}`),
    ...assist.evidence.map((hit) => `${hit.title} ${hit.snippet}`)
  ].join("\n");
  const fullCorpus = `${answerCorpus}\n${evidenceCorpus}`;
  const answerMatched = containsAny(answerCorpus, item.answerMustContainAny);
  const evidenceMatched = containsAny(evidenceCorpus, item.evidenceMustContainAny);
  const forbiddenMatched = containsAny(fullCorpus, item.forbiddenAny ?? []);
  const coverageHealthy = assist.coverage.status !== "thin" && assist.confidence !== "baja";
  const score =
    (answerMatched.length ? 0.4 : 0)
    + (evidenceMatched.length ? 0.35 : 0)
    + (!forbiddenMatched.length ? 0.15 : 0)
    + (coverageHealthy ? 0.1 : 0);
  const failureReasons = [
    ...(!answerMatched.length ? [`La respuesta no contiene ninguno de: ${item.answerMustContainAny.join(", ")}`] : []),
    ...(!evidenceMatched.length ? [`La evidencia no contiene ninguno de: ${item.evidenceMustContainAny.join(", ")}`] : []),
    ...(forbiddenMatched.length ? [`Se encontraron términos prohibidos/tangenciales: ${forbiddenMatched.join(", ")}`] : []),
    ...(!coverageHealthy ? [`Cobertura/confianza insuficiente: ${assist.coverage.status}/${assist.confidence}`] : [])
  ];

  return {
    id: item.id,
    source: item.source,
    passed: score >= 0.75,
    score: Math.round(score * 1000) / 1000,
    answerMatched,
    evidenceMatched,
    forbiddenMatched,
    coverageStatus: assist.coverage.status,
    confidence: assist.confidence,
    topCitations: assist.citations.slice(0, 5).map((citation) => citation.title),
    failureReasons
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const cases = loadCases(options.fixture);
  const repo = new CorpusRepository(options.pack);
  const started = Date.now();
  try {
    const results = cases.map((item) => evaluateCase(repo, item));
    const passed = results.filter((result) => result.passed).length;
    const passRate = cases.length ? passed / cases.length : 0;
    const report = {
      generatedAt: new Date().toISOString(),
      fixture: options.fixture,
      pack: options.pack,
      runtimeOnly: false,
      note: "Harness de desarrollo: no forma parte de las tools MCP ni del runtime instalado por usuarios finales.",
      total: cases.length,
      passed,
      failed: cases.length - passed,
      passRate: Math.round(passRate * 10000) / 100,
      durationMs: Date.now() - started,
      results
    };

    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (options.out) {
      fs.mkdirSync(path.dirname(options.out), { recursive: true });
      fs.writeFileSync(options.out, `${json}\n`, "utf8");
    }
    if (passRate < options.minPassRate) {
      console.error(`Evaluación question-bank bajo umbral: ${report.passRate}% < ${options.minPassRate * 100}%`);
      process.exitCode = 1;
    }
  } finally {
    repo.close();
  }
}

main();
