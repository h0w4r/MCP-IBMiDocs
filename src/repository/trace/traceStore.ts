import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TraceEvent, TraceReport } from "../../types.js";

const DEFAULT_TRACE_MAX_BYTES = Number(process.env.IBMI_DOCS_TRACE_MAX_BYTES ?? 5 * 1024 * 1024);

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

export function appendTraceEvent(file: string, event: TraceEvent): void {
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
  const answerEvents = events.filter((event) => event.tool === "ibmi_docs_answer");
  const resolveEvents = events.filter((event) => event.tool === "ibmi_docs_resolve");
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
    answerUsageRate: roundRate(answerEvents.length / denominator),
    resolveUsageRate: roundRate(resolveEvents.length / denominator),
    recent: events.slice(-limit)
  };
}

function traceMaxBytes(): number {
  return Number.isFinite(DEFAULT_TRACE_MAX_BYTES) && DEFAULT_TRACE_MAX_BYTES > 0
    ? DEFAULT_TRACE_MAX_BYTES
    : 5 * 1024 * 1024;
}

function rotateTraceIfNeeded(file: string, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (stat.size < maxBytes) return;
  const rotated = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.old`;
  fs.renameSync(file, rotated);
}

function redactTraceEvent(event: TraceEvent): TraceEvent {
  return {
    ...event,
    query: event.query ? redactTraceText(event.query) : undefined
  };
}

function redactTraceText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 240 && !/\b(exec\s+sql|pgm|dcl-|dcl\s+var|password|token|secret)\b/i.test(oneLine)) return oneLine;
  return `${oneLine.slice(0, 180)}… [redacted:${oneLine.length}]`;
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
