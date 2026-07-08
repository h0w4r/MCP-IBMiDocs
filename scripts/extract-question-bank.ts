import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import * as cheerio from "cheerio";

interface ExtractedQuestionBankCase {
  id: string;
  source: string;
  sourceId?: string;
  licenseNote: string;
  question: string;
  language: string;
  expectedAnswerSummary: string;
  answerMustContainAny: string[];
  evidenceMustContainAny: string[];
  forbiddenAny: string[];
  evaluationEligible: boolean;
  extraction: {
    sourceKind: string;
    extractionQuality: "answered" | "question-only" | "multiple-choice" | "partial";
    url?: string;
    page?: number;
    ordinal?: string;
    rawAnswer?: string;
  };
}

interface PdfPage {
  page: number;
  text: string;
}

interface ParsedItem {
  ordinal?: string;
  question: string;
  answer: string;
  quality: ExtractedQuestionBankCase["extraction"]["extractionQuality"];
}

interface ExtractOptions {
  site: string;
  pdf: string;
  out: string;
  sources?: string;
  report?: string;
  includeUnverified: boolean;
  skipWeb: boolean;
  skipPdf: boolean;
}

interface QuestionBankSource {
  id: string;
  kind: "web" | "pdf" | "fixture";
  enabled?: boolean;
  sourceKind?: string;
  licenseStatus: "maintainer-confirmed" | "public-domain" | "open-license" | "unknown" | "restricted";
  licenseNote: string;
  redistributable?: boolean;
  devOnly?: boolean;
  discover?: boolean;
  seedUrls?: string[];
  urls?: string[];
  path?: string;
  notes?: string;
}

interface QuestionBankSourceRegistry {
  version: number;
  generatedAt?: string;
  policy?: string;
  sources: QuestionBankSource[];
}

const DEFAULT_SITE = "https://ibmiskills.com/interviewquestions-1";
const DEFAULT_PDF = "C:\\Users\\azast\\Downloads\\kupdf.net_master-question-bank-as400-iseries.pdf";
const DEFAULT_OUT = path.resolve("tests", "fixtures", "dev-question-bank.global.json");
const DEFAULT_SOURCES = path.resolve("tests", "fixtures", "question-bank.sources.json");
const LICENSE_NOTE = "Fuente comunitaria/educativa indicada por el mantenedor; fixture usado solo para validación de desarrollo, no para runtime del MCP.";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_WEB_PAGES = 80;
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const KNOWN_SITE_PATH_HINTS = [
  "/interviewquestions-1",
  "/as400-interview-questions-part-1-1",
  "/as400-interview-questions-part-2-1",
  "/as400-interview-questions-part-3-1",
  "/as400-interview-questions-part-4-1",
  "/as400-interview-questions-part-5-1",
  "/as400-interview-questions-part-6-1",
  "/as400-interview-questions-part-7-1",
  "/as400-interview-questions-part-8-1",
  "/as400-interview-questions-part-9-1",
  "/as400-interview-questions-part-10-1",
  "/as400-interview-questions-part-11-1",
  "/sql-interview-questions-1-1",
  "/ile-rpg-concept-interview-1-1",
  "/except-opcode-in-rpg-1",
  "/update-opcode-questions-1",
  "/interview-1"
];

const STOPWORDS = new Set([
  "about", "after", "again", "also", "and", "answer", "because", "before", "between", "but", "can", "cannot", "command",
  "could", "define", "describe", "difference", "does", "each", "explain", "file", "following", "from", "have", "how", "into",
  "list", "many", "much", "only", "program", "question", "should", "that", "the", "their", "there", "these", "this", "through",
  "used", "using", "what", "when", "where", "which", "with", "within", "without", "would", "your", "para", "una", "uno", "los", "las"
]);

const IMPORTANT_PHRASES = [
  "access path",
  "activation group",
  "batch job",
  "binding directory",
  "commitment control",
  "data area",
  "data queue",
  "display file",
  "externally described file",
  "job queue",
  "journal receiver",
  "library list",
  "logical file",
  "message queue",
  "module object",
  "packed decimal",
  "physical file",
  "record format",
  "record lock",
  "service program",
  "source physical file",
  "subfile control",
  "subfile record",
  "system value"
];

function parseArgs(argv: string[]): ExtractOptions {
  const options: ExtractOptions = {
    site: DEFAULT_SITE,
    pdf: DEFAULT_PDF,
    out: DEFAULT_OUT,
    sources: fs.existsSync(DEFAULT_SOURCES) ? DEFAULT_SOURCES : undefined,
    report: undefined,
    includeUnverified: false,
    skipWeb: false,
    skipPdf: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--site" && next) {
      options.site = next;
      index += 1;
    } else if (arg === "--pdf" && next) {
      options.pdf = path.resolve(next);
      index += 1;
    } else if (arg === "--out" && next) {
      options.out = path.resolve(next);
      index += 1;
    } else if (arg === "--sources" && next) {
      options.sources = path.resolve(next);
      index += 1;
    } else if (arg === "--report" && next) {
      options.report = path.resolve(next);
      index += 1;
    } else if (arg === "--include-unverified") {
      options.includeUnverified = true;
    } else if (arg === "--skip-web") {
      options.skipWeb = true;
    } else if (arg === "--skip-pdf") {
      options.skipPdf = true;
    }
  }
  return options;
}

function loadSourceRegistry(registryPath: string): QuestionBankSourceRegistry {
  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as QuestionBankSourceRegistry;
  if (!Array.isArray(parsed.sources)) throw new Error(`Registry de fuentes inválido: ${registryPath}`);
  return parsed;
}

function isSourceAllowed(source: QuestionBankSource, options: ExtractOptions): boolean {
  if (source.enabled === false) return false;
  if (source.kind === "web" && options.skipWeb) return false;
  if (source.kind === "pdf" && options.skipPdf) return false;
  if (source.licenseStatus === "restricted") return false;
  if (source.redistributable || source.licenseStatus === "maintainer-confirmed" || source.licenseStatus === "open-license" || source.licenseStatus === "public-domain") {
    return true;
  }
  return options.includeUnverified;
}

async function extractRegistryCases(registryPath: string, options: ExtractOptions): Promise<ExtractedQuestionBankCase[]> {
  const registry = loadSourceRegistry(registryPath);
  const cases: ExtractedQuestionBankCase[] = [];
  for (const source of registry.sources.filter((item) => isSourceAllowed(item, options))) {
    if (source.kind === "web") {
      const urls = await resolveWebSourceUrls(source);
      for (const url of urls) {
        try {
          const html = await fetchText(url);
          const pageCases = extractCasesFromHtml(url, html, source);
          cases.push(...pageCases);
          console.error(`web ${pageCases.length.toString().padStart(3, " ")} casos <- ${source.id} ${url}`);
        } catch (error) {
          console.warn(`No se pudo extraer ${source.id} ${url}: ${formatError(error)}`);
        }
      }
    } else if (source.kind === "pdf") {
      const pdfPath = source.path ? path.resolve(source.path) : options.pdf;
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        console.warn(`PDF no disponible para ${source.id}: ${pdfPath || "<sin ruta>"}`);
        continue;
      }
      const pdfCases = extractPdfCases(pdfPath, source);
      cases.push(...pdfCases);
      console.error(`pdf ${pdfCases.length.toString().padStart(3, " ")} casos <- ${source.id} ${pdfPath}`);
    } else if (source.kind === "fixture") {
      const fixturePath = source.path ? path.resolve(source.path) : "";
      if (!fixturePath || !fs.existsSync(fixturePath)) {
        console.warn(`Fixture no disponible para ${source.id}: ${fixturePath || "<sin ruta>"}`);
        continue;
      }
      const fixtureCases = extractFixtureCases(fixturePath, source);
      cases.push(...fixtureCases);
      console.error(`fixture ${fixtureCases.length.toString().padStart(3, " ")} casos <- ${source.id} ${fixturePath}`);
    }
  }
  return cases;
}

function extractFixtureCases(fixturePath: string, source: QuestionBankSource): ExtractedQuestionBankCase[] {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ExtractedQuestionBankCase[];
  if (!Array.isArray(parsed)) throw new Error(`Fixture de preguntas inválido: ${fixturePath}`);
  return parsed
    .filter((item) => item?.question && item?.expectedAnswerSummary)
    .map((item, index) => ({
      ...item,
      id: item.id || `qb-${slugify(source.id)}-${index + 1}`,
      source: item.source || fixturePath,
      sourceId: item.sourceId ?? source.id,
      licenseNote: source.licenseNote || item.licenseNote || LICENSE_NOTE,
      extraction: {
        ...item.extraction,
        sourceKind: item.extraction?.sourceKind || source.sourceKind || "fixture"
      }
    }));
}

async function resolveWebSourceUrls(source: QuestionBankSource): Promise<string[]> {
  const explicit = [...(source.urls ?? [])];
  if (source.discover === false) return uniqueStrings(explicit);
  const seeds = source.seedUrls?.length ? source.seedUrls : explicit;
  const discovered: string[] = [];
  for (const seed of seeds) {
    try {
      discovered.push(...await discoverWebPages(seed));
    } catch (error) {
      console.warn(`No se pudo descubrir enlaces para ${source.id} desde ${seed}: ${formatError(error)}`);
    }
  }
  return uniqueStrings([...explicit, ...discovered]).slice(0, MAX_WEB_PAGES);
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9,es;q=0.8",
          "user-agent": BROWSER_USER_AGENT
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${url}`);
      return await response.text();
    } catch (error) {
      try {
        return fetchTextWithCurl(url, error);
      } catch (curlError) {
        return fetchTextWithPython(url, error, curlError);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

function fetchTextWithCurl(url: string, cause: unknown): string {
  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  const result = spawnSync(executable, [
    "-L",
    "--silent",
    "--show-error",
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    "-H",
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H",
    "Accept-Language: en-US,en;q=0.9,es;q=0.8",
    "-A",
    BROWSER_USER_AGENT,
    url
  ], {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`No se pudo descargar ${url}. fetch=${String(cause)} curl=${result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function fetchTextWithPython(url: string, fetchCause: unknown, curlCause: unknown): string {
  const python = String.raw`
import sys
import urllib.request

url = sys.argv[1]
headers = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
try:
    import requests
    response = requests.get(url, headers=headers, timeout=30)
    response.raise_for_status()
    sys.stdout.buffer.write(response.text.encode("utf-8"))
except Exception as requests_error:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            sys.stdout.buffer.write(response.read().decode(charset, errors="replace").encode("utf-8"))
    except Exception as urllib_error:
        raise RuntimeError(f"requests={requests_error!r}; urllib={urllib_error!r}")
`;
  const result = spawnSync("python", ["-", url], {
    input: python,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`No se pudo descargar ${url}. fetch=${String(fetchCause)} curl=${String(curlCause)} python=${result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

async function discoverWebPages(seedUrl: string): Promise<string[]> {
  const seed = new URL(seedUrl);
  const urls = new Map<string, string>();
  const add = (candidate: string): void => {
    const resolved = new URL(candidate, seedUrl);
    if (resolved.origin !== seed.origin) return;
    if (!isRelevantQuestionBankUrl(resolved)) return;
    resolved.hash = "";
    urls.set(resolved.href, resolved.href);
  };

  add(seedUrl);
  if (/ibmiskills\.com$/i.test(seed.hostname)) {
    for (const hint of KNOWN_SITE_PATH_HINTS) add(new URL(hint, seed.origin).href);
  }

  try {
    const html = await fetchText(seedUrl);
    const $ = cheerio.load(html);
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      const label = cleanInlineText($(element).text());
      if (!href) return;
      if (!/interview|question|opcode|rpg|sql|as400|ile/i.test(`${href} ${label}`)) return;
      add(href);
    });
  } catch (error) {
    console.warn(`No se pudo descubrir enlaces desde ${seedUrl}: ${formatError(error)}`);
  }

  return Array.from(urls.values()).slice(0, MAX_WEB_PAGES);
}

function isRelevantQuestionBankUrl(url: URL): boolean {
  if (/youtube|facebook|twitter|linkedin|instagram|login|register|privacy|terms/i.test(url.href)) return false;
  return /interview|question|opcode|rpg|sql|as400|ile/i.test(url.pathname);
}

async function extractWebCases(siteUrl: string): Promise<ExtractedQuestionBankCase[]> {
  const pages = await discoverWebPages(siteUrl);
  const cases: ExtractedQuestionBankCase[] = [];
  for (const pageUrl of pages) {
    try {
      const html = await fetchText(pageUrl);
      const pageCases = extractCasesFromHtml(pageUrl, html, {
        id: "legacy-site",
        kind: "web",
        sourceKind: "ibmiskills-web",
        licenseStatus: "maintainer-confirmed",
        licenseNote: LICENSE_NOTE,
        redistributable: true
      });
      cases.push(...pageCases);
      console.error(`web ${pageCases.length.toString().padStart(3, " ")} casos <- ${pageUrl}`);
    } catch (error) {
      console.warn(`No se pudo extraer ${pageUrl}: ${formatError(error)}`);
    }
  }
  return cases;
}

function extractCasesFromHtml(url: string, html: string, source: QuestionBankSource): ExtractedQuestionBankCase[] {
  const $ = cheerio.load(html);
  $("form").each((_, element) => {
    $(element).replaceWith($(element).contents());
  });
  $("script,style,svg,nav,footer,noscript").remove();
  const cases: ExtractedQuestionBankCase[] = [];
  let ordinal = 0;

  $("h2,h3,h4").each((_, element) => {
    const heading = $(element);
    const question = normalizeQuestion(heading.text());
    if (!looksLikeQuestion(question)) return;

    const answerParts: string[] = [];
    let sibling = heading.next();
    while (sibling.length) {
      const tag = String(sibling.prop("tagName") ?? "").toLowerCase();
      if (/^h[1-4]$/.test(tag)) {
        const siblingHeading = cleanInlineText(sibling.text());
        if (looksLikeQuestion(siblingHeading)) break;
        if (looksLikeAnswerHeading(siblingHeading)) {
          sibling = sibling.next();
          continue;
        }
        break;
      }
      const text = cleanBlockText(sibling.text());
      if (text && !isBoilerplate(text)) answerParts.push(text);
      sibling = sibling.next();
    }

    const answer = cleanAnswer(answerParts.join("\n"));
    if (!answer && question.length < 8) return;
    ordinal += 1;
    cases.push(makeCase({
      idPrefix: `qb-${slugify(source.id)}-${slugify(new URL(url).pathname)}-${ordinal}`,
      source: url,
      sourceId: source.id,
      sourceKind: source.sourceKind ?? "web",
      licenseNote: source.licenseNote,
      question,
      answer,
      ordinal: String(ordinal)
    }));
  });

  if (cases.length === 0) {
    const text = cleanBlockText($("body").text());
    for (const item of parseLooseNumberedItems(text)) {
      ordinal += 1;
      cases.push(makeCase({
        idPrefix: `qb-${slugify(source.id)}-${slugify(new URL(url).pathname)}-${ordinal}`,
        source: url,
        sourceId: source.id,
        sourceKind: source.sourceKind ?? "web",
        licenseNote: source.licenseNote,
        question: item.question,
        answer: item.answer,
        ordinal: item.ordinal,
        quality: item.quality
      }));
    }
  }

  return cases;
}

function extractPdfPages(pdfPath: string): PdfPage[] {
  if (!fs.existsSync(pdfPath)) throw new Error(`No existe el PDF del banco de preguntas: ${pdfPath}`);
  const python = String.raw`
import json
import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
pages = []
for index, page in enumerate(reader.pages, start=1):
    pages.append({"page": index, "text": page.extract_text() or ""})
print(json.dumps(pages, ensure_ascii=False))
`;
  const result = spawnSync("python", ["-", pdfPath], {
    input: python,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Python/pypdf no pudo extraer el PDF. stderr=${result.stderr || "<vacío>"}`);
  }
  const parsed = JSON.parse(result.stdout) as PdfPage[];
  if (!Array.isArray(parsed)) throw new Error("La extracción PDF no devolvió una lista de páginas.");
  return parsed;
}

function extractPdfCases(pdfPath: string, source?: QuestionBankSource): ExtractedQuestionBankCase[] {
  const pages = extractPdfPages(pdfPath);
  const cases: ExtractedQuestionBankCase[] = [];
  const sourceId = `dev-pdf://${slugify(path.basename(pdfPath, path.extname(pdfPath)))}`;
  const sourceName = source?.id ?? sourceId;
  for (const page of pages) {
    const items = parseLooseNumberedItems(page.text);
    let ordinalInPage = 0;
    for (const item of items) {
      ordinalInPage += 1;
      cases.push(makeCase({
        idPrefix: `qb-${slugify(sourceName)}-p${page.page}-${item.ordinal ?? ordinalInPage}`,
        source: sourceId,
        sourceId: source?.id,
        sourceKind: source?.sourceKind ?? "pdf",
        licenseNote: source?.licenseNote ?? LICENSE_NOTE,
        page: page.page,
        question: item.question,
        answer: item.answer,
        ordinal: item.ordinal,
        quality: item.quality
      }));
    }
  }
  return cases;
}

function parseLooseNumberedItems(text: string): ParsedItem[] {
  const lines = text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => cleanInlineText(line))
    .filter((line) => line && !isBoilerplate(line));

  const items: { ordinal?: string; lines: string[] }[] = [];
  let current: { ordinal?: string; lines: string[] } | undefined;

  const pushCurrent = (): void => {
    if (!current) return;
    const combined = cleanBlockText(current.lines.join("\n"));
    if (combined.length >= 8) items.push(current);
    current = undefined;
  };

  for (const line of lines) {
    const start = parseQuestionStart(line);
    if (start) {
      pushCurrent();
      current = { ordinal: start.ordinal, lines: [start.text] };
      continue;
    }
    if (!current) continue;
    if (line.length <= 2 && /^[A-E]$/i.test(line)) continue;
    current.lines.push(line);
  }
  pushCurrent();

  return items
    .map((item) => splitQuestionAnswer(item.ordinal, item.lines))
    .filter((item) => item.question.length >= 8);
}

function parseQuestionStart(line: string): { ordinal: string; text: string } | undefined {
  const numeric = line.match(/^\s*(?:Q(?:uestion)?\s*)?(\d{1,4})[.):]\s+(.+)$/i);
  if (numeric) {
    const candidate = cleanInlineText(numeric[2] ?? "");
    if (candidate.length >= 4 && !looksLikeOptionLine(candidate)) return { ordinal: numeric[1] ?? "", text: candidate };
  }

  const questionMarker = line.match(/^\s*(?:Q(?:uestion)?)(?:\s*(\d{1,4}))?\s*[:\-]\s+(.+)$/i);
  if (questionMarker) {
    const candidate = cleanInlineText(questionMarker[2] ?? "");
    if (candidate.length >= 4 && !looksLikeOptionLine(candidate)) return { ordinal: questionMarker[1] ?? "", text: candidate };
  }

  const coded = line.match(/^\s*(Q[A-Z0-9]{2,})\s+(.+)$/i);
  if (coded) {
    const candidate = cleanInlineText(coded[2] ?? "");
    if (candidate.length >= 4) return { ordinal: coded[1] ?? "", text: candidate };
  }
  return undefined;
}

function splitQuestionAnswer(ordinal: string | undefined, lines: string[]): ParsedItem {
  const joined = cleanBlockText(lines.join("\n"));
  const answerMatch = joined.match(/\b(?:Ans|Answer)(?:\s*\d{1,4})?\s*[:\-]+/i);
  if (answerMatch?.index !== undefined) {
    const question = normalizeQuestion(joined.slice(0, answerMatch.index));
    const answer = cleanAnswer(joined.slice(answerMatch.index + answerMatch[0].length));
    return {
      ordinal,
      question: question || normalizeQuestion(lines[0] ?? joined),
      answer,
      quality: classifyQuality(answer, joined)
    };
  }

  const first = cleanInlineText(lines[0] ?? "");
  const rest = lines.slice(1).map((line) => cleanInlineText(line)).filter(Boolean);
  if (rest.length && first.includes("?") && rest.some((line) => looksLikeAnswerLine(line))) {
    return {
      ordinal,
      question: normalizeQuestion(first),
      answer: cleanAnswer(rest.join(" ")),
      quality: classifyQuality(rest.join(" "), joined)
    };
  }

  return {
    ordinal,
    question: normalizeQuestion(joined),
    answer: "",
    quality: "question-only"
  };
}

function makeCase(input: {
  idPrefix: string;
  source: string;
  sourceId?: string;
  sourceKind: string;
  licenseNote?: string;
  question: string;
  answer: string;
  ordinal?: string;
  page?: number;
  quality?: ExtractedQuestionBankCase["extraction"]["extractionQuality"];
}): ExtractedQuestionBankCase {
  const question = normalizeQuestion(input.question);
  const answer = cleanAnswer(input.answer);
  const quality = input.quality ?? classifyQuality(answer, `${question}\n${answer}`);
  const expectedAnswerSummary = answer || question;
  const answerTerms = extractEvaluationTerms(answer || question, question, 16);
  const evidenceTerms = uniqueStrings([...extractEvaluationTerms(`${question}\n${answer}`, question, 18), ...answerTerms]).slice(0, 22);
  const id = `${input.idPrefix}-${slugify(question).slice(0, 70)}`.replace(/-+$/g, "");
  return {
    id,
    source: input.source,
    sourceId: input.sourceId,
    licenseNote: input.licenseNote ?? LICENSE_NOTE,
    question,
    language: inferLanguage(`${question}\n${answer}`),
    expectedAnswerSummary,
    answerMustContainAny: answerTerms,
    evidenceMustContainAny: evidenceTerms.length ? evidenceTerms : answerTerms,
    forbiddenAny: [],
    evaluationEligible: isEvaluationEligible({ question, answer, quality, answerTerms }),
    extraction: {
      sourceKind: input.sourceKind,
      extractionQuality: quality,
      url: input.sourceKind !== "pdf" ? input.source : undefined,
      page: input.page,
      ordinal: input.ordinal,
      rawAnswer: answer || undefined
    }
  };
}

function isEvaluationEligible(input: {
  question: string;
  answer: string;
  quality: ExtractedQuestionBankCase["extraction"]["extractionQuality"];
  answerTerms: string[];
}): boolean {
  if (input.quality === "question-only") return false;
  if (!looksLikeQuestion(input.question)) return false;
  if (input.answer.length < 4 && !/%[A-Z]|[A-Z]{3,}|\*[A-Z]/.test(input.answer)) return false;
  const meaningfulTerms = input.answerTerms.filter((term) => !STOPWORDS.has(fold(term)) && term.length >= 3);
  return meaningfulTerms.length > 0;
}

function classifyQuality(answer: string, raw: string): ExtractedQuestionBankCase["extraction"]["extractionQuality"] {
  const cleaned = cleanInlineText(answer);
  if (!cleaned) return "question-only";
  if (/^([A-E](?:\s*,\s*[A-E])*)$/i.test(cleaned) || /\bAnswer\s*:\s*[A-E]\b/i.test(raw)) return "multiple-choice";
  if (cleaned.length < 12) return "partial";
  return "answered";
}

function inferLanguage(text: string): string {
  if (/\bSQLRPGLE\b|embedded\s+sql|sqlcode|sqlstate|\bdb2\b|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b/i.test(text)) return "SQLRPGLE";
  if (/\bDDS\b|subfile|\bSFL[A-Z0-9]*\b|physical\s+file|logical\s+file|display\s+file|printer\s+file|\bPF\b|\bLF\b/i.test(text)) return "DDS";
  if (/\bCLLE\b|\bCLP?\b|MONMSG|SBMJOB|RTVJOBA|DCLF|RCVF|OVRDBF|DLTOVR|\bCMD\b|command/i.test(text)) return "CLLE";
  if (/\bRPGLE\b|\bRPG\b|ILE\s+RPG|opcode|\bCHAIN\b|\bREADE?\b|\bSETLL\b|\bEVAL\b|%[A-Z0-9_-]+/i.test(text)) return "RPGLE";
  return "IBM i";
}

function extractEvaluationTerms(primary: string, question: string, maxTerms: number): string[] {
  const source = `${primary}\n${question}`;
  const terms: string[] = [];

  for (const phrase of IMPORTANT_PHRASES) {
    if (fold(source).includes(phrase)) terms.push(phrase);
  }

  const technicalMatches = source.match(/%[A-Z][A-Z0-9_-]*|\*[A-Z][A-Z0-9_]*|\b[A-Z]{2,}[A-Z0-9_#@$-]{1,}\b|\b(?:CPF|MCH|RNF|SQL)\d{4,5}\b/g) ?? [];
  for (const match of technicalMatches) {
    const normalized = match.replace(/[.,;:)]$/g, "");
    if (normalized.length > 1 && !/^AS400$/i.test(normalized)) terms.push(normalized);
  }

  const words = source
    .replace(/[%*#@$]/g, " ")
    .split(/[^A-Za-z0-9_-]+/g)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word.toLowerCase()) && !/^\d+$/.test(word));
  for (const word of words) terms.push(word);

  const unique = uniqueStrings(terms)
    .filter((term) => term.length >= 3)
    .slice(0, maxTerms);

  if (unique.length) return unique;
  const fallback = cleanInlineText(question).split(" ").slice(0, 8).join(" ");
  return fallback ? [fallback] : ["IBM i"];
}

function looksLikeQuestion(text: string): boolean {
  const normalized = cleanInlineText(text);
  if (normalized.length < 8) return false;
  if (normalized.includes("?")) return true;
  return /^(what|how|why|when|where|which|can|do|does|is|are|will|would|explain|describe|define|list|differentiate|difference)\b/i.test(normalized);
}

function looksLikeAnswerLine(text: string): boolean {
  const cleaned = cleanInlineText(text);
  if (!cleaned || looksLikeOptionLine(cleaned)) return false;
  if (/^(ans|answer)\b/i.test(cleaned)) return true;
  if (/[,.;:]\s*/.test(cleaned) && cleaned.length > 5) return true;
  if (/%[A-Z]|\*[A-Z]|\b[A-Z]{3,}\b/.test(cleaned)) return true;
  return cleaned.split(" ").length >= 3;
}

function looksLikeAnswerHeading(text: string): boolean {
  return /^(?:Ans|Answer)(?:\s*\d{1,4})?\s*[:\-]?$/i.test(cleanInlineText(text));
}

function looksLikeOptionLine(text: string): boolean {
  return /^[A-E][.)]\s+/.test(text) || /^\([A-E]\)\s+/i.test(text);
}

function normalizeQuestion(text: string): string {
  return cleanInlineText(text)
    .replace(/^(?:Q(?:uestion)?\s*)?\d{1,4}[.):]\s*/i, "")
    .replace(/^(?:Q(?:uestion)?)(?:\s*\d{1,4})?\s*[:\-]\s*/i, "")
    .replace(/^Q[A-Z0-9]{2,}[:.)]?\s+/i, "")
    .replace(/\b(?:Ans|Answer)(?:\s*\d{1,4})?\s*[:\-]+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAnswer(text: string): string {
  return cleanBlockText(text)
    .replace(/^(?:Ans|Answer)(?:\s*\d{1,4})?\s*[:\-]+\s*/i, "")
    .replace(/\bPost\s+a\s+Comment\b.*$/i, "")
    .replace(/\bComments?\b\s*$/i, "")
    .trim();
}

function cleanBlockText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .split("\n")
    .map((line) => cleanInlineText(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function cleanInlineText(text: string): string {
  return text
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoilerplate(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return /^(home|sign in|register|comments?|post comments?|older post|newer post|about me|popular posts|follow us|copyright|save|share|menu)$/i.test(cleaned)
    || /ibmiskills\.com|subscribe to|powered by|site map/i.test(cleaned);
}

function slugify(value: string): string {
  return fold(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "item";
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanInlineText(value).replace(/^[-–•]+\s*/, "");
    const key = fold(cleaned);
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return cleanInlineText(message.split(/\r?\n/)[0] ?? message).slice(0, 260);
}

function uniquifyIds(cases: ExtractedQuestionBankCase[]): ExtractedQuestionBankCase[] {
  const seen = new Map<string, number>();
  return cases.map((item) => {
    const count = seen.get(item.id) ?? 0;
    seen.set(item.id, count + 1);
    if (count === 0) return item;
    return { ...item, id: `${item.id}-${count + 1}` };
  });
}

function summarize(cases: ExtractedQuestionBankCase[]): Record<string, unknown> {
  const bySourceKind: Record<string, number> = {};
  const bySourceId: Record<string, number> = {};
  const byQuality: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  let evaluationEligible = 0;
  for (const item of cases) {
    bySourceKind[item.extraction.sourceKind] = (bySourceKind[item.extraction.sourceKind] ?? 0) + 1;
    bySourceId[item.sourceId ?? item.source] = (bySourceId[item.sourceId ?? item.source] ?? 0) + 1;
    byQuality[item.extraction.extractionQuality] = (byQuality[item.extraction.extractionQuality] ?? 0) + 1;
    byLanguage[item.language] = (byLanguage[item.language] ?? 0) + 1;
    if (item.evaluationEligible !== false) evaluationEligible += 1;
  }
  return { total: cases.length, evaluationEligible, bySourceKind, bySourceId, byQuality, byLanguage };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases: ExtractedQuestionBankCase[] = [];

  if (options.sources && fs.existsSync(options.sources)) {
    cases.push(...await extractRegistryCases(options.sources, options));
  } else {
    if (!options.skipWeb) {
      cases.push(...await extractWebCases(options.site));
    }
    if (!options.skipPdf) {
      const pdfCases = extractPdfCases(options.pdf);
      console.error(`pdf ${pdfCases.length.toString().padStart(3, " ")} casos <- ${options.pdf}`);
      cases.push(...pdfCases);
    }
  }

  const finalCases = uniquifyIds(cases)
    .filter((item) => item.question.length >= 8)
    .sort((a, b) => `${a.extraction.sourceKind}:${a.source}:${a.extraction.page ?? 0}:${a.extraction.ordinal ?? ""}`.localeCompare(`${b.extraction.sourceKind}:${b.source}:${b.extraction.page ?? 0}:${b.extraction.ordinal ?? ""}`));

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(finalCases, null, 2)}\n`, "utf8");
  const report = {
    generatedAt: new Date().toISOString(),
    out: options.out,
    sourcesRegistry: options.sources,
    includeUnverified: options.includeUnverified,
    ...summarize(finalCases)
  };
  if (options.report) {
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.error(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
