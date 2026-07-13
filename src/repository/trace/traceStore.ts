import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import type { TraceEvent, TraceReport } from "../../types.js";

const DEFAULT_TRACE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TRACE_MAX_ROTATED_FILES = 5;

interface TraceReadResult {
  events: TraceEvent[];
  totalLines: number;
  omittedEvents: number;
  corruptLines: number;
}

export function defaultTraceFile(): string {
  return process.env.IBMI_DOCS_TRACE_FILE
    ? path.resolve(process.env.IBMI_DOCS_TRACE_FILE)
    : path.join(os.homedir(), ".ibmi-docs", "traces", "ibmi-docs-trace.ndjson");
}

export function isTraceEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.IBMI_DOCS_TRACE ?? "");
}

export function appendTraceEvent(file: string, event: TraceInputEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateTraceIfNeeded(file, traceMaxBytes());
    fs.appendFileSync(file, `${JSON.stringify(redactTraceEvent(event))}\n`, "utf8");
  } catch (error) {
    // La traza es diagnóstica y opcional: nunca debe romper una consulta documental.
    // Si el operador necesita diagnóstico del trace store, puede activar debug explícito.
    if (/^(1|true|yes|on)$/i.test(process.env.IBMI_DOCS_TRACE_DEBUG ?? "")) {
      console.error(`[ibmi-docs trace] No se pudo escribir ${file}:`, error);
    }
  }
}

export function buildTraceReport(file: string, limit: number): TraceReport {
  const { events, omittedEvents, corruptLines } = readTraceEvents(file, Math.max(limit, 500));
  const byTool: Record<string, number> = {};
  for (const event of events) byTool[event.tool] = (byTool[event.tool] ?? 0) + 1;

  const searchEvents = events.filter((event) => event.tool === "ibmi_docs_search");
  const readEvents = events.filter((event) => event.tool === "ibmi_docs_read");
  const readIds = new Set(readEvents.map((event) => event.id ?? event.topResultId).filter(Boolean));
  const searchThenRead = searchEvents.filter((event) => (event.followedReadCandidateIds ?? []).some((id) => readIds.has(id)));
  const assistEvents = events.filter((event) => event.tool === "ibmi_docs_assist");
  const scopeExpansionFeedback = events.flatMap((event) => (event.scopeExpansions ?? []).map((expansion) => ({
    ...expansion,
    queryFingerprint: event.queryFingerprint,
    queryPreview: event.queryPreview,
    timestamp: event.timestamp,
    tool: event.tool
  })));
  const scopeExpansionByKind: Record<string, number> = {};
  const scopeExpansionByRequestedScope: Record<string, number> = {};
  for (const expansion of scopeExpansionFeedback) {
    scopeExpansionByKind[expansion.kind] = (scopeExpansionByKind[expansion.kind] ?? 0) + 1;
    const requestedKey = `${expansion.kind}:${expansion.requestedScope}`;
    scopeExpansionByRequestedScope[requestedKey] = (scopeExpansionByRequestedScope[requestedKey] ?? 0) + 1;
  }
  const denominator = events.length || 1;
  const searchDenominator = searchEvents.length || 1;

  return {
    enabled: isTraceEnabled(),
    traceFile: file,
    traceFileSizeBytes: fileSize(file),
    maxBytes: traceMaxBytes(),
    rotatedFiles: rotatedTraceFiles(file),
    omittedEvents,
    corruptLines,
    events: events.length,
    byTool,
    searchEvents: searchEvents.length,
    searchOnlyRate: roundRate((searchEvents.length - searchThenRead.length) / searchDenominator),
    searchThenReadRate: roundRate(searchThenRead.length / searchDenominator),
    assistUsageRate: roundRate(assistEvents.length / denominator),
    scopeExpansionCount: scopeExpansionFeedback.length,
    scopeExpansionByKind,
    scopeExpansionByRequestedScope,
    scopeExpansionFeedback: scopeExpansionFeedback.slice(-limit),
    recent: events.slice(-limit)
  };
}

export type TraceInputEvent = Omit<TraceEvent, "queryFingerprint" | "queryLength" | "queryPreview" | "semanticQueryCount"> & {
  query?: string;
  semanticQueries?: string[];
};

function traceMaxBytes(): number {
  const configured = Number(process.env.IBMI_DOCS_TRACE_MAX_BYTES ?? DEFAULT_TRACE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TRACE_MAX_BYTES;
}

function traceMaxRotatedFiles(): number {
  const configured = Number(process.env.IBMI_DOCS_TRACE_MAX_ROTATED_FILES ?? DEFAULT_TRACE_MAX_ROTATED_FILES);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_TRACE_MAX_ROTATED_FILES;
}

function rotateTraceIfNeeded(file: string, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (stat.size < maxBytes) return;
  const rotated = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${crypto.randomUUID()}.old`;
  fs.renameSync(file, rotated);
  pruneRotatedTraceFiles(file, traceMaxRotatedFiles());
}

function pruneRotatedTraceFiles(file: string, maxFiles: number): void {
  const files = rotatedTraceFiles(file);
  const excess = Math.max(0, files.length - maxFiles);
  for (const obsolete of files.slice(0, excess)) {
    fs.rmSync(obsolete, { force: true });
  }
}

function redactTraceEvent(event: TraceInputEvent): TraceEvent {
  const { query, semanticQueries, ...safeEvent } = event;
  const cleanQuery = String(query ?? "").trim();
  const includePreview = /^(1|true|yes|on)$/i.test(process.env.IBMI_DOCS_TRACE_INCLUDE_QUERY ?? "");
  return {
    ...safeEvent,
    queryFingerprint: cleanQuery ? crypto.createHash("sha256").update(cleanQuery).digest("hex").slice(0, 16) : undefined,
    queryLength: cleanQuery ? cleanQuery.length : undefined,
    queryPreview: cleanQuery && includePreview ? redactTraceText(cleanQuery) : undefined,
    semanticQueryCount: semanticQueries?.length
  };
}

function redactTraceText(value: string): string {
  const oneLine = value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[CLAVE PRIVADA REDACTADA]")
    .replace(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "Authorization: [REDACTADO]")
    .replace(/(["']?(?:password|passwd|pwd|token|secret|api[_-]?key)["']?\s*:\s*)["'][^"']*["']/gi, "$1\"[REDACTADO]\"")
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTADO]")
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*\(\s*(["'])[^"']*\2\s*\)/gi, "$1([REDACTADO])")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 180)}…`;
}

function readTraceEvents(file: string, limit = 500): TraceReadResult {
  if (!fs.existsSync(file)) return { events: [], totalLines: 0, omittedEvents: 0, corruptLines: 0 };

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const selectedLines = lines.slice(-limit);
  const events: TraceEvent[] = [];
  let corruptLines = 0;

  for (const line of selectedLines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Ignorar líneas corruptas o truncadas; el reporte debe seguir siendo útil.
      corruptLines += 1;
    }
  }

  return {
    events,
    totalLines: lines.length,
    omittedEvents: Math.max(0, lines.length - selectedLines.length),
    corruptLines
  };
}

function rotatedTraceFiles(file: string): string[] {
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) return [];

  const prefix = `${path.basename(file)}.`;
  return fs.readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".old"))
    .sort()
    .map((entry) => path.join(directory, entry));
}

function fileSize(file: string): number {
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

function roundRate(value: number): number {
  return Math.round(value * 10000) / 100;
}
