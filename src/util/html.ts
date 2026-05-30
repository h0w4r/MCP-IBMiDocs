import { load } from "cheerio";

export interface ExtractedDocumentContent {
  title: string;
  breadcrumbs: string[];
  product: string;
  version: string;
  language: string;
  text: string;
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[\t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function extractDocumentContent(html: string): ExtractedDocumentContent {
  const $ = load(html);

  // Elimina scripts/estilos/navegación para que el modelo reciba contenido documental, no UI de Eclipse Help.
  $("script, style, noscript, iframe, frame, nav").remove();

  const title = firstNonBlank(
    $('meta[name="DC.title"]').attr("content"),
    $('meta[name="dcterms.title"]').attr("content"),
    $("h1").first().text(),
    $("h2").first().text(),
    $("title").first().text()
  );
  const product = firstNonBlank($('meta[name="prodname"]').attr("content"), $('meta[name="DC.subject"]').attr("content"));
  const version = firstNonBlank($('meta[name="version"]').attr("content"), $('meta[name="DC.version"]').attr("content"));
  const language = firstNonBlank($('meta[name="DC.language"]').attr("content"), $("html").attr("lang"), "en-us");
  const breadcrumbs = $(".help_breadcrumbs a, .breadcrumb a, .familylinks a")
    .map((_, el) => collapseWhitespace($(el).text()))
    .get()
    .filter(Boolean)
    .slice(0, 12);

  const bodyText = normalizeBodyText($);
  const text = collapseWhitespace([title, breadcrumbs.join(" > "), bodyText].filter(Boolean).join("\n\n"));

  return { title, breadcrumbs, product, version, language, text };
}

function normalizeBodyText($: ReturnType<typeof load>): string {
  const root = ($("body").length ? $("body") : $("html")) as any;

  // Mantener estructura semántica antes de pedir texto plano a Cheerio. IBM Docs
  // usa tablas y bloques pre/code para sintaxis de comandos, parámetros y
  // ejemplos; si los aplastamos a un párrafo, FTS y los agentes pierden contexto.
  root.find("br").replaceWith("\n");
  root.find("h1,h2,h3,h4,h5,h6").each((_: number, el: any) => {
    const text = collapseWhitespace($(el).text());
    if (text) $(el).replaceWith(`\n\n${text}\n\n`);
  });
  root.find("li").each((_: number, el: any) => {
    const text = collapseWhitespace($(el).text());
    if (text) $(el).replaceWith(`\n- ${text}\n`);
  });
  root.find("pre").each((_: number, el: any) => {
    const text = $(el).text().replace(/\r/g, "\n").trimEnd();
    if (text) $(el).replaceWith(`\n\n${text}\n\n`);
  });
  root.find("code").each((_: number, el: any) => {
    const text = $(el).text().trim();
    if (text) $(el).replaceWith(` ${text} `);
  });
  root.find("table").each((_: number, table: any) => {
    const rows = $(table).find("tr").map((__, tr) => {
      const cells = $(tr).find("th,td").map((___, cell) => collapseWhitespace($(cell).text())).get().filter(Boolean);
      return cells.length ? cells.join(" | ") : "";
    }).get().filter(Boolean);
    if (rows.length) $(table).replaceWith(`\n\n${rows.join("\n")}\n\n`);
  });

  return collapseWhitespace(root.text() || $.root().text());
}

export function inferCategory(input: { title: string; path?: string[]; url?: string; text?: string }): string {
  const haystack = foldForSearch([input.title, ...(input.path ?? []), input.url ?? "", (input.text ?? "").slice(0, 3000)].join(" "));
  if (/\brnf\d{4}\b|\brnf\b|rpg.*compiler.*message|compiler.*message.*rpg/.test(haystack)) return "mensajes-rnf";
  if (/\b(sqlrpgle|embedded sql|sql reference|db2|structured query language|\bsql\b)/.test(haystack)) return "sql-db2-for-i";
  if (/\b(clle|control language|\bcl\b command|comandos cl)/.test(haystack)) return "cl-clle";
  if (/\bdds\b|physical file|logical file|display file|printer file/.test(haystack)) return "dds";
  if (/\bcobol\b/.test(haystack)) return "ile-cobol";
  if (/\bc\/c\+\+\b|ile c|ile c\+\+/.test(haystack)) return "ile-c-cpp";
  if (/\brpg\b|rpgle|ile rpg|rpg iv|crtrpgmod|crtbndrpg/.test(haystack)) return "ile-rpg";
  if (/command|comando|crtpgm|crtsrvpgm|crtmod/.test(haystack)) return "comandos-ibmi";
  return "ibm-i-general";
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    const clean = collapseWhitespace(String(value ?? ""));
    if (clean) return clean;
  }
  return "";
}

