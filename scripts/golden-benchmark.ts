import fs from "node:fs";
import { CorpusRepository } from "../src/repository/CorpusRepository.js";

interface BenchmarkQuery {
  name: string;
  query: string;
  category?: string;
}

const fixture = new URL("../tests/fixtures/extended-golden-queries.json", import.meta.url);
const queries = JSON.parse(fs.readFileSync(fixture, "utf8")) as BenchmarkQuery[];
const repo = new CorpusRepository(process.env.IBMI_DOCS_PACK_DIR ?? "data/pack");
const failures: Array<{ name: string; query: string; category?: string }> = [];
const started = Date.now();

try {
  for (const item of queries) {
    const results = repo.search({ query: item.query, category: item.category, limit: 3, mode: "hybrid" });
    if (!results.length) failures.push(item);
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

if (passRate < 0.95) {
  console.error(`Benchmark golden bajo umbral: ${report.passRate}% < 95%`);
  process.exit(1);
}
