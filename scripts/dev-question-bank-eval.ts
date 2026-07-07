import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AssistResult } from "../src/types.js";

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
  runtimeMode: "mcp";
  durationMs: number;
}

interface EvalOptions {
  fixture: string;
  pack: string;
  minPassRate: number;
  out?: string;
  sampleSize: number;
  sampleSeed?: number;
  rotateStateFile: string;
  noRotate: boolean;
  serverCommand: string;
  serverArgs: string[];
}

const DEFAULT_FIXTURE = path.resolve("tests", "fixtures", "dev-question-bank.extended.json");
const LEGACY_FIXTURE = path.resolve("tests", "fixtures", "dev-question-bank.sample.json");
const DEFAULT_PACK = path.resolve("data", "pack");
const DEFAULT_ROTATE_STATE = path.resolve(".tmp", "question-bank-eval-state.json");
const CASE_PASS_THRESHOLD = 0.85;
const DEFAULT_MIN_PASS_RATE = 0.9;

function parseArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {
    fixture: fs.existsSync(DEFAULT_FIXTURE) ? DEFAULT_FIXTURE : LEGACY_FIXTURE,
    pack: process.env.IBMI_DOCS_PACK_DIR || DEFAULT_PACK,
    minPassRate: DEFAULT_MIN_PASS_RATE,
    sampleSize: 100,
    rotateStateFile: DEFAULT_ROTATE_STATE,
    noRotate: false,
    serverCommand: process.execPath,
    serverArgs: [path.resolve("dist", "src", "server.js")]
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
    } else if (arg === "--sample-size" && next) {
      options.sampleSize = Number(next);
      index += 1;
    } else if (arg === "--sample-seed" && next) {
      options.sampleSeed = Number(next);
      options.noRotate = true;
      index += 1;
    } else if (arg === "--rotate-state" && next) {
      options.rotateStateFile = path.resolve(next);
      index += 1;
    } else if (arg === "--no-rotate") {
      options.noRotate = true;
    } else if (arg === "--server-command" && next) {
      options.serverCommand = next;
      index += 1;
    } else if (arg === "--server-args" && next) {
      options.serverArgs = splitServerArgs(next);
      index += 1;
    }
  }
  return options;
}

function splitServerArgs(value: string): string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function loadCases(fixturePath: string): QuestionBankCase[] {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as QuestionBankCase[];
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`Fixture sin casos evaluables: ${fixturePath}`);
  }
  return parsed;
}

function selectRotatingSample(cases: QuestionBankCase[], options: EvalOptions): { selected: QuestionBankCase[]; start: number; nextStart: number } {
  const sampleSize = clampInt(options.sampleSize, Math.min(100, cases.length), 1, cases.length);
  const start = options.sampleSeed !== undefined
    ? positiveModulo(options.sampleSeed, cases.length)
    : options.noRotate
      ? 0
      : readRotationStart(options.rotateStateFile, cases.length);
  const selected = Array.from({ length: sampleSize }, (_, index) => cases[(start + index) % cases.length]);
  const nextStart = (start + sampleSize) % cases.length;
  if (!options.noRotate && options.sampleSeed === undefined) writeRotationStart(options.rotateStateFile, nextStart);
  return { selected, start, nextStart };
}

function readRotationStart(stateFile: string, modulo: number): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { nextStart?: number };
    return positiveModulo(Number(parsed.nextStart ?? 0), modulo);
  } catch {
    return 0;
  }
}

function writeRotationStart(stateFile: string, nextStart: number): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ nextStart, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function positiveModulo(value: number, modulo: number): number {
  return ((Math.trunc(value) % modulo) + modulo) % modulo;
}

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
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

function buildEvaluationCorpus(assist: AssistResult): { answerCorpus: string; evidenceCorpus: string; fullCorpus: string } {
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
    ...assist.evidence.map((hit) => `${hit.title} ${hit.snippet}`),
    ...assist.reads.map((read) => `${read.title} ${read.excerpt} ${read.focusedSections.map((section) => `${section.title} ${section.content}`).join(" ")}`)
  ].join("\n");
  return {
    answerCorpus,
    evidenceCorpus,
    fullCorpus: `${answerCorpus}\n${evidenceCorpus}`
  };
}

function evaluateAssist(item: QuestionBankCase, assist: AssistResult, durationMs: number): CaseResult {
  const { answerCorpus, evidenceCorpus, fullCorpus } = buildEvaluationCorpus(assist);
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
    passed: score >= CASE_PASS_THRESHOLD,
    score: Math.round(score * 1000) / 1000,
    answerMatched,
    evidenceMatched,
    forbiddenMatched,
    coverageStatus: assist.coverage.status,
    confidence: assist.confidence,
    topCitations: assist.citations.slice(0, 5).map((citation) => citation.title),
    failureReasons,
    runtimeMode: "mcp",
    durationMs
  };
}

async function evaluateWithMcp(cases: QuestionBankCase[], options: EvalOptions): Promise<CaseResult[]> {
  const serverEntry = options.serverArgs[0];
  if (options.serverCommand === process.execPath && serverEntry && !fs.existsSync(serverEntry)) {
    throw new Error(`No existe ${serverEntry}. Ejecuta npm run build antes del gate MCP.`);
  }

  const env = {
    ...process.env,
    IBMI_DOCS_PACK_DIR: options.pack,
    IBMI_DOCS_TOOL_PROFILE: "agent",
    NO_COLOR: "1"
  } as Record<string, string>;
  const transport = new StdioClientTransport({
    command: options.serverCommand,
    args: options.serverArgs,
    cwd: process.cwd(),
    env,
    stderr: "pipe"
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });
  const client = new Client({ name: "ibmi-docs-question-bank-eval", version: "dev" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listedTools = await client.listTools();
    if (!listedTools.tools.some((tool) => tool.name === "ibmi_docs_assist")) {
      throw new Error(`El servidor MCP no expuso ibmi_docs_assist. Tools: ${listedTools.tools.map((tool) => tool.name).join(", ")}`);
    }
    const results: CaseResult[] = [];
    for (const item of cases) {
      const started = Date.now();
      const response = await client.callTool({
        name: "ibmi_docs_assist",
        arguments: {
          question: item.question,
          language: item.language,
          version: item.version,
          depth: "deep",
          audience: "agent",
          includeExamples: true,
          includeCompileCommands: true,
          limit: 8
        }
      }, undefined, { timeout: 180_000 });
      const structured = response.structuredContent as AssistResult | undefined;
      if (!structured?.coverage || !structured.answer) {
        throw new Error(`Respuesta MCP sin structuredContent AssistResult para ${item.id}`);
      }
      results.push(evaluateAssist(item, structured, Date.now() - started));
    }
    return results;
  } catch (error) {
    if (stderrChunks.length) {
      const stderrFile = path.join(os.tmpdir(), `ibmi-docs-mcp-eval-stderr-${Date.now()}.log`);
      fs.writeFileSync(stderrFile, stderrChunks.join(""), "utf8");
      console.error(`stderr del servidor MCP guardado en ${stderrFile}`);
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = loadCases(options.fixture);
  const sample = selectRotatingSample(cases, options);
  const started = Date.now();
  const results = await evaluateWithMcp(sample.selected, options);
  const passed = results.filter((result) => result.passed).length;
  const passRate = sample.selected.length ? passed / sample.selected.length : 0;
  const report = {
    generatedAt: new Date().toISOString(),
    fixture: options.fixture,
    pack: options.pack,
    runtimeOnly: false,
    mode: "mcp",
    server: { command: options.serverCommand, args: options.serverArgs },
    note: "Harness de desarrollo: levanta el servidor MCP por stdio y llama la tool pública ibmi_docs_assist, igual que un agente usuario. No usa clases internas del repositorio como atajo.",
    thresholds: {
      casePass: CASE_PASS_THRESHOLD,
      minPassRate: options.minPassRate
    },
    corpus: {
      totalCasesInFixture: cases.length,
      sampleSize: sample.selected.length,
      sampleStart: sample.start,
      nextSampleStart: sample.nextStart,
      rotation: options.noRotate || options.sampleSeed !== undefined ? "fixed" : "stateful"
    },
    total: sample.selected.length,
    passed,
    failed: sample.selected.length - passed,
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
