import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import * as cheerio from "cheerio";

interface ExtractedQuestionBankCase {
  id: string;
  source: string;
  licenseNote: string;
  question: string;
  language: string;
  expectedAnswerSummary: string;
  answerMustContainAny: string[];
  evidenceMustContainAny: string[];
  forbiddenAny: string[];
  evaluationEligible: boolean;
  extraction: {
    sourceKind: "ibmiskills-web" | "pdf";
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
  skipWeb: boolean;
  skipPdf: boolean;
}

const DEFAULT_SITE = "https://ibmiskills.com/interviewquestions-1";
const DEFAULT_PDF = "C:\\Users\\azast\\Downloads\\kupdf.net_master-question-bank-as400-iseries.pdf";
const DEFAULT_OUT = path.resolve("tests", "fixtures", "dev-question-bank.global.json");
const LICENSE_NOTE = "Fuente comunitaria/educativa indicada por el mantenedor; fixture usado solo para validación de desarrollo, no para runtime del MCP.";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_WEB_PAGES = 80;

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
    } else if (arg === "--skip-web") {
      options.skipWeb = true;
    } else if (arg === "--skip-pdf") {
      options.skipPdf = true;
    }
  }
  return options;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "MCP-IBMiDocs-dev-question-bank-extractor/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
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
  for (const hint of KNOWN_SITE_PATH_HINTS) add(new URL(hint, seed.origin).href);

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
    console.warn(`No se pudo descubrir enlaces desde ${seedUrl}: ${String(error)}`);
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
      const pageCases = extractCasesFromHtml(pageUrl, html);
      cases.push(...pageCases);
      console.error(`web ${pageCases.length.toString().padStart(3, " ")} casos <- ${pageUrl}`);
    } catch (error) {
      console.warn(`No se pudo extraer ${pageUrl}: ${String(error)}`);
    }
  }
  return cases;
}

function extractCasesFromHtml(url: string, html: string): ExtractedQuestionBankCase[] {
  const $ = cheerio.load(html);
  $("script,style,svg,nav,footer,form,noscript").remove();
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
      if (/^h[1-4]$/.test(tag)) break;
      const text = cleanBlockText(sibling.text());
      if (text && !isBoilerplate(text)) answerParts.push(text);
      sibling = sibling.next();
    }

    const answer = cleanAnswer(answerParts.join("\n"));
    if (!answer && question.length < 8) return;
    ordinal += 1;
    cases.push(makeCase({
      idPrefix: `qb-web-${slugify(new URL(url).pathname)}-${ordinal}`,
      source: url,
      sourceKind: "ibmiskills-web",
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
        idPrefix: `qb-web-${slugify(new URL(url).pathname)}-${ordinal}`,
        source: url,
        sourceKind: "ibmiskills-web",
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

function extractPdfCases(pdfPath: string): ExtractedQuestionBankCase[] {
  const pages = extractPdfPages(pdfPath);
  const cases: ExtractedQuestionBankCase[] = [];
  const sourceId = `dev-pdf://${slugify(path.basename(pdfPath, path.extname(pdfPath)))}`;
  for (const page of pages) {
    const items = parseLooseNumberedItems(page.text);
    let ordinalInPage = 0;
    for (const item of items) {
      ordinalInPage += 1;
      cases.push(makeCase({
        idPrefix: `qb-pdf-p${page.page}-${item.ordinal ?? ordinalInPage}`,
        source: sourceId,
        sourceKind: "pdf",
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
  const numeric = line.match(/^\s*(?:Q(?:uestion)?\s*)?(\d{1,4})[.)]\s+(.+)$/i);
  if (numeric) {
    const candidate = cleanInlineText(numeric[2] ?? "");
    if (candidate.length >= 4 && !looksLikeOptionLine(candidate)) return { ordinal: numeric[1] ?? "", text: candidate };
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
  const answerMatch = joined.match(/\b(?:Ans|Answer)\s*[:\-]+/i);
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
  sourceKind: "ibmiskills-web" | "pdf";
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
    licenseNote: LICENSE_NOTE,
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
      url: input.sourceKind === "ibmiskills-web" ? input.source : undefined,
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

function looksLikeOptionLine(text: string): boolean {
  return /^[A-E][.)]\s+/.test(text) || /^\([A-E]\)\s+/i.test(text);
}

function normalizeQuestion(text: string): string {
  return cleanInlineText(text)
    .replace(/^(?:Question\s*)?\d{1,4}[.)]\s*/i, "")
    .replace(/^Q[A-Z0-9]{2,}\s+/i, "")
    .replace(/\b(?:Ans|Answer)\s*[:\-]+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAnswer(text: string): string {
  return cleanBlockText(text)
    .replace(/^(?:Ans|Answer)\s*[:\-]+\s*/i, "")
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
  const byQuality: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const item of cases) {
    bySourceKind[item.extraction.sourceKind] = (bySourceKind[item.extraction.sourceKind] ?? 0) + 1;
    byQuality[item.extraction.extractionQuality] = (byQuality[item.extraction.extractionQuality] ?? 0) + 1;
    byLanguage[item.language] = (byLanguage[item.language] ?? 0) + 1;
  }
  return { total: cases.length, bySourceKind, byQuality, byLanguage };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases: ExtractedQuestionBankCase[] = [];

  if (!options.skipWeb) {
    cases.push(...await extractWebCases(options.site));
  }
  if (!options.skipPdf) {
    const pdfCases = extractPdfCases(options.pdf);
    console.error(`pdf ${pdfCases.length.toString().padStart(3, " ")} casos <- ${options.pdf}`);
    cases.push(...pdfCases);
  }

  const finalCases = uniquifyIds(cases)
    .filter((item) => item.question.length >= 8)
    .sort((a, b) => `${a.extraction.sourceKind}:${a.source}:${a.extraction.page ?? 0}:${a.extraction.ordinal ?? ""}`.localeCompare(`${b.extraction.sourceKind}:${b.source}:${b.extraction.page ?? 0}:${b.extraction.ordinal ?? ""}`));

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(finalCases, null, 2)}\n`, "utf8");
  console.error(JSON.stringify({ out: options.out, ...summarize(finalCases) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
