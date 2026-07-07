import fs from "node:fs";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";

interface BenchmarkQuery {
  name: string;
  query: string;
  category?: string;
  version?: string;
  mustBeFirstTitle?: string;
  mustContainTitle?: string;
  mustContainTitlePattern?: string;
  mustHaveResults?: boolean;
  required?: boolean;
}

const coreFixture = new URL("../tests/fixtures/golden-queries.json", import.meta.url);
const extendedFixture = new URL("../tests/fixtures/extended-golden-queries.json", import.meta.url);
const queries = [
  ...(JSON.parse(fs.readFileSync(coreFixture, "utf8")) as BenchmarkQuery[]),
  ...(JSON.parse(fs.readFileSync(extendedFixture, "utf8")) as BenchmarkQuery[])
];
const repo = new CorpusRepository(process.env.IBMI_DOCS_PACK_DIR ?? "data/pack");
const failures: Array<{ name: string; query: string; category?: string; reason: string; topTitles: string[] }> = [];
const started = Date.now();

try {
  for (const item of queries) {
    const results = repo.search({ query: item.query, category: item.category, version: item.version, limit: 5 });
    const topTitles = results.slice(0, 5).map((hit) => hit.title);
    if (!results.length) {
      failures.push({ ...item, reason: "sin resultados", topTitles });
      continue;
    }
    if (item.mustBeFirstTitle && results[0]?.title !== item.mustBeFirstTitle) {
      failures.push({ ...item, reason: `top esperado: ${item.mustBeFirstTitle}; top real: ${results[0]?.title}`, topTitles });
      continue;
    }
    if (item.mustContainTitle && !topTitles.slice(0, 3).some((title) => title.includes(item.mustContainTitle!))) {
      failures.push({ ...item, reason: `no contiene título esperado en top 3: ${item.mustContainTitle}`, topTitles });
      continue;
    }
    if (item.mustContainTitlePattern && !new RegExp(item.mustContainTitlePattern, "i").test(topTitles.slice(0, 3).join("\n"))) {
      failures.push({ ...item, reason: `no cumple patrón en top 3: ${item.mustContainTitlePattern}`, topTitles });
    }
  }
} finally {
  repo.close();
}

const passed = queries.length - failures.length;
const passRate = queries.length ? passed / queries.length : 0;
const report = {
  total: queries.length,
  passed,
  failed: failures.length,
  passRate: Math.round(passRate * 10000) / 100,
  durationMs: Date.now() - started,
  failures
};
console.log(JSON.stringify(report, null, 2));

const requiredFailures = failures.filter((failure) => queries.some((query) => query.name === failure.name && (query.required || query.mustHaveResults)));

if (requiredFailures.length) {
  console.error(`Benchmark golden falló en ${requiredFailures.length} query(s) obligatoria(s).`);
  process.exit(1);
}

if (passRate < 0.95) {
  console.error(`Benchmark golden bajo umbral: ${report.passRate}% < 95%`);
  process.exit(1);
}

if (failures.some((failure) => /top esperado|título esperado|patrón/.test(failure.reason))) {
  console.error("Benchmark golden falló en una expectativa explícita de precisión.");
  process.exit(1);
}
