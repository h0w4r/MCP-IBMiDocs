import fs from "node:fs";
import path from "node:path";
import {
  embedTexts,
  semanticPassageText,
  semanticQueryText,
  vectorToBuffer
} from "../src/repository/neuralEmbeddings.js";

interface CaseRecord {
  id: string;
  question: string;
  expectedAnswerSummary: string;
  evaluationEligible?: boolean;
}

const fullPath = path.resolve("data/eval/question-bank/dev-question-bank.full-local.json");
const holdoutPath = path.resolve("tests/fixtures/dev-question-bank.global.json");
const outputDir = path.resolve(".tmp/query-adapter-training");
const full = JSON.parse(fs.readFileSync(fullPath, "utf8")) as CaseRecord[];
const holdout = (JSON.parse(fs.readFileSync(holdoutPath, "utf8")) as CaseRecord[])
  .filter(isUsableCase);

// La exclusión por firma evita que una pregunta duplicada con otro ID filtre
// información del benchmark hacia el entrenamiento.
const holdoutIds = new Set(holdout.map((item) => item.id));
const holdoutSignatures = new Set(holdout.map(caseSignature));
const train = full
  .filter(isUsableCase)
  .filter((item) => !holdoutIds.has(item.id) && !holdoutSignatures.has(caseSignature(item)))
  .slice(0, 8_000);

fs.mkdirSync(outputDir, { recursive: true });
await embedSplit("train", train);
await embedSplit("holdout", holdout);
fs.writeFileSync(path.join(outputDir, "metadata.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  trainCount: train.length,
  holdoutCount: holdout.length,
  dimensions: 384,
  fullSource: fullPath,
  holdoutSource: holdoutPath,
  holdoutPolicy: "IDs y firmas excluidos completamente del entrenamiento"
}, null, 2)}\n`);
console.error(`Listo: train=${train.length}; holdout=${holdout.length}`);

async function embedSplit(name: string, cases: CaseRecord[]): Promise<void> {
  const queryStream = fs.createWriteStream(path.join(outputDir, `${name}-queries.f32`));
  const answerStream = fs.createWriteStream(path.join(outputDir, `${name}-answers.f32`));
  const batchSize = 48;
  for (let start = 0; start < cases.length; start += batchSize) {
    const batch = cases.slice(start, start + batchSize);
    const inputs = [
      ...batch.map((item) => semanticQueryText(item.question)),
      ...batch.map((item) => semanticPassageText({ body: item.expectedAnswerSummary }))
    ];
    // Se desactiva explícitamente cualquier adaptador previo: el entrenamiento
    // siempre parte de los embeddings base y es reproducible.
    const vectors = await embedTexts(inputs, { localOnly: true });
    const queryVectors = vectors.slice(0, batch.length);
    const answerVectors = vectors.slice(batch.length);
    for (const vector of queryVectors) queryStream.write(vectorToBuffer(vector));
    for (const vector of answerVectors) answerStream.write(vectorToBuffer(vector));
    if (start % (batchSize * 10) === 0) {
      console.error(`${name}: ${Math.min(start + batch.length, cases.length)}/${cases.length}`);
    }
  }
  await Promise.all([closeStream(queryStream), closeStream(answerStream)]);
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function isUsableCase(item: CaseRecord): boolean {
  return item.evaluationEligible !== false
    && String(item.question ?? "").trim().length >= 8
    && String(item.expectedAnswerSummary ?? "").trim().length >= 16;
}

function caseSignature(item: CaseRecord): string {
  return `${fold(item.question)}\n${fold(item.expectedAnswerSummary)}`;
}

function fold(value: string): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
