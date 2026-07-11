import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  evaluationEligible?: boolean;
  evaluationExclusionReason?: string;
}

interface CaseResult {
  id: string;
  source: string;
  passed: boolean;
  score: number;
  answerMatched: string[];
  evidenceMatched: string[];
  forbiddenMatched: string[];
  contractViolations: string[];
  responsePreview: string;
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
  randomSample: boolean;
  randomSeed?: number;
  includeNonEvaluable: boolean;
  rotateStateFile: string;
  noRotate: boolean;
  serverCommand: string;
  serverArgs: string[];
}

const GLOBAL_FIXTURE = path.resolve("tests", "fixtures", "dev-question-bank.global.json");
const EXTENDED_FIXTURE = path.resolve("tests", "fixtures", "dev-question-bank.extended.json");
const LEGACY_FIXTURE = path.resolve("tests", "fixtures", "dev-question-bank.sample.json");
const DEFAULT_PACK = path.resolve("data", "pack");
const DEFAULT_ROTATE_STATE = path.resolve(".tmp", "question-bank-eval-state.json");
const CASE_PASS_THRESHOLD = 0.85;
const DEFAULT_MIN_PASS_RATE = 0.95;

function parseArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {
    fixture: resolveDefaultFixture(),
    pack: process.env.IBMI_DOCS_PACK_DIR || DEFAULT_PACK,
    minPassRate: DEFAULT_MIN_PASS_RATE,
    sampleSize: 300,
    randomSample: false,
    includeNonEvaluable: false,
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
    } else if (arg === "--random-sample") {
      options.randomSample = true;
      options.noRotate = true;
    } else if (arg === "--random-seed" && next) {
      options.randomSeed = Number(next);
      options.randomSample = true;
      options.noRotate = true;
      index += 1;
    } else if (arg === "--include-non-evaluable") {
      options.includeNonEvaluable = true;
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

function resolveDefaultFixture(): string {
  if (fs.existsSync(GLOBAL_FIXTURE)) return GLOBAL_FIXTURE;
  if (fs.existsSync(EXTENDED_FIXTURE)) return EXTENDED_FIXTURE;
  return LEGACY_FIXTURE;
}

function splitServerArgs(value: string): string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function loadCases(fixturePath: string, options: EvalOptions): {
  all: QuestionBankCase[];
  selectedPool: QuestionBankCase[];
  eligibleBeforeDeduplication: number;
} {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as QuestionBankCase[];
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`Fixture sin casos evaluables: ${fixturePath}`);
  }
  const hasEligibilityMetadata = parsed.some((item) => Object.prototype.hasOwnProperty.call(item, "evaluationEligible"));
  const eligible = !options.includeNonEvaluable && hasEligibilityMetadata
    ? parsed.filter((item) => item.evaluationEligible !== false)
    : parsed;
  const selectedPool = deduplicateEvaluationCases(eligible);
  if (!selectedPool.length) throw new Error(`Fixture sin casos elegibles para evaluar: ${fixturePath}`);
  return { all: parsed, selectedPool, eligibleBeforeDeduplication: eligible.length };
}

function deduplicateEvaluationCases(cases: QuestionBankCase[]): QuestionBankCase[] {
  const uniqueCases = new Map<string, QuestionBankCase>();
  for (const item of cases) {
    // El banco contiene páginas repetidas del mismo PDF. El gate debe medir 300
    // preguntas diferentes, no aprobar dos veces por contestar el mismo texto.
    const key = `${fold(item.question).replace(/\s+/g, " ").trim()}\n${fold(item.expectedAnswerSummary).replace(/\s+/g, " ").trim()}`;
    if (!uniqueCases.has(key)) uniqueCases.set(key, item);
  }
  return [...uniqueCases.values()];
}

function selectRotatingSample(cases: QuestionBankCase[], options: EvalOptions): { selected: QuestionBankCase[]; start: number; nextStart: number; strategy: string; randomSeed?: number } {
  const sampleSize = clampInt(options.sampleSize, Math.min(100, cases.length), 1, cases.length);
  if (options.randomSample) {
    const seed = Number.isFinite(options.randomSeed) ? Math.trunc(options.randomSeed as number) : Date.now();
    const shuffled = seededShuffle(cases, seed);
    return {
      selected: shuffled.slice(0, sampleSize),
      start: 0,
      nextStart: 0,
      strategy: "random",
      randomSeed: seed
    };
  }
  const start = options.sampleSeed !== undefined
    ? positiveModulo(options.sampleSeed, cases.length)
    : options.noRotate
      ? 0
      : readRotationStart(options.rotateStateFile, cases.length);
  const selected = Array.from({ length: sampleSize }, (_, index) => cases[(start + index) % cases.length]);
  const nextStart = (start + sampleSize) % cases.length;
  if (!options.noRotate && options.sampleSeed === undefined) writeRotationStart(options.rotateStateFile, nextStart);
  return { selected, start, nextStart, strategy: options.noRotate || options.sampleSeed !== undefined ? "fixed" : "stateful" };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const shuffled = [...items];
  let state = positiveModulo(seed, 2_147_483_647);
  if (state <= 0) state += 2_147_483_646;
  const nextRandom = (): number => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] as T, shuffled[index] as T];
  }
  return shuffled;
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

function evaluatePublicAnswer(
  item: QuestionBankCase,
  answer: string,
  contractViolations: string[],
  durationMs: number
): CaseResult {
  const answerMatched = containsAny(answer, item.answerMustContainAny);
  const evidenceMatched = containsAny(answer, item.evidenceMustContainAny);
  const forbiddenMatched = containsAny(answer, item.forbiddenAny ?? []);
  const answerUsable = Boolean(answer.trim())
    && !fold(answer).includes(fold("No encontré evidencia documental suficientemente relacionada"));
  const score =
    (answerMatched.length ? 0.45 : 0)
    + (evidenceMatched.length ? 0.35 : 0)
    + (!forbiddenMatched.length ? 0.15 : 0)
    + (answerUsable && !contractViolations.length ? 0.05 : 0);
  const passed = score >= CASE_PASS_THRESHOLD
    && !forbiddenMatched.length
    && !contractViolations.length
    && answerUsable;
  const failureReasons = [
    ...(!answerMatched.length ? [`La respuesta no contiene ninguno de: ${item.answerMustContainAny.join(", ")}`] : []),
    ...(!evidenceMatched.length ? [`La respuesta pública no contiene evidencia suficiente de: ${item.evidenceMustContainAny.join(", ")}`] : []),
    ...(forbiddenMatched.length ? [`Se encontraron términos prohibidos/tangenciales: ${forbiddenMatched.join(", ")}`] : []),
    ...(!answerUsable ? ["La tool pública declaró evidencia insuficiente o devolvió una respuesta vacía."] : []),
    ...contractViolations
  ];

  return {
    id: item.id,
    source: item.source,
    // Un término tangencial prohibido o una violación del contrato público no
    // puede aprobar por redondeo de pesos aunque el score llegue exactamente
    // al umbral. El gate mide calidad y contrato, no una suma indulgente.
    passed,
    score: Math.round(score * 1000) / 1000,
    answerMatched,
    evidenceMatched,
    forbiddenMatched,
    contractViolations,
    responsePreview: answer.slice(0, 600),
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
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const item = cases[caseIndex];
      const started = Date.now();
      const response = await client.callTool({
        name: "ibmi_docs_assist",
        arguments: {
          question: item.question,
          language: item.language,
          version: item.version
        }
      }, undefined, { timeout: 180_000 });
      const textBlocks = Array.isArray(response.content)
        ? response.content.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
        : [];
      const contractViolations = [
        ...(response.structuredContent !== undefined ? ["La tool pública expuso structuredContent."] : []),
        ...(textBlocks.length !== 1 ? [`Se esperaban exactamente 1 bloque de texto y llegaron ${textBlocks.length}.`] : [])
      ];
      const answer = textBlocks.map((block) => block.text).join("\n").trim();
      const internalLabels = ["retrievalPlan", "taskPlan", "semanticScore", "Resumen estructurado", "chunk_vectors"];
      for (const label of internalLabels) {
        if (answer.includes(label)) contractViolations.push(`La respuesta expuso el detalle interno ${label}.`);
      }
      results.push(evaluatePublicAnswer(item, answer, contractViolations, Date.now() - started));
      if ((caseIndex + 1) % 10 === 0 || caseIndex + 1 === cases.length) {
        const passed = results.filter((result) => result.passed).length;
        console.error(`[ibmi-docs eval] ${caseIndex + 1}/${cases.length}; aprobadas=${passed}; tasa=${((passed / results.length) * 100).toFixed(2)}%`);
      }
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
  const loaded = loadCases(options.fixture, options);
  const sample = selectRotatingSample(loaded.selectedPool, options);
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
      totalCasesInFixture: loaded.all.length,
      totalCasesInEvaluationPool: loaded.selectedPool.length,
      eligibleBeforeDeduplication: loaded.eligibleBeforeDeduplication,
      duplicateCasesRemoved: loaded.eligibleBeforeDeduplication - loaded.selectedPool.length,
      includeNonEvaluable: options.includeNonEvaluable,
      sampleSize: sample.selected.length,
      sampleStart: sample.start,
      nextSampleStart: sample.nextStart,
      rotation: sample.strategy,
      randomSeed: sample.randomSeed
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
