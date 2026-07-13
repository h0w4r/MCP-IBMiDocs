/**
 * Límites defensivos del contrato público. Evitan que una invocación MCP
 * accidentalmente masiva multiplique el texto en varias perspectivas y agote
 * la memoria antes de que el tokenizer aplique su truncamiento por tokens.
 */
export const MAX_QUESTION_CHARS = 16_000;
export const MAX_CODE_CHARS = 100_000;
export const MAX_LABEL_CHARS = 256;
export const MAX_DOCUMENT_ID_CHARS = 512;
export const MAX_NOTES_CHARS = 4_000;
export const MAX_VERSION_ITEMS = 16;

export function assertInputLength(value: unknown, label: string, maxChars: number): void {
  if (value === undefined || value === null) return;
  const length = String(value).length;
  if (length > maxChars) {
    throw new Error(`${label} excede el máximo permitido de ${maxChars} caracteres (recibidos: ${length}).`);
  }
}
