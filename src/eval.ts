import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { GeminiExtractor, geminiModel, sleep } from "./gemini.js";
import { validateBatch } from "./validate.js";
import type { ExtractedDoc, InvoiceData } from "./types.js";

const SAMPLES_DIR = "samples";
const EXPECTED_DIR = path.join(SAMPLES_DIR, "expected");
const OUT_MD = path.join("eval", "results.md");
const REPEATS = 3;

function fieldScore(expected: unknown, actual: unknown): boolean {
  return JSON.stringify(expected ?? null) === JSON.stringify(actual ?? null);
}

const FIELDS: (keyof InvoiceData)[] = [
  "docType",
  "issuer",
  "registrationNumber",
  "issueDate",
  "dueDate",
  "documentNumber",
  "subtotal",
  "total",
  "currency",
];

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.log("GEMINI_API_KEY が未設定です");
    return;
  }
  const minInterval = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4000);
  const extractor = new GeminiExtractor();
  const files = (await readdir(SAMPLES_DIR)).filter((f) =>
    /\.(pdf|png|jpg|jpeg|webp)$/i.test(f),
  ).sort();
  const fieldHits: Record<string, { ok: number; n: number }> = Object.fromEntries(
    FIELDS.map((f) => [f, { ok: 0, n: 0 }]),
  );
  const perDoc: {
    file: string;
    runs: { okFields: number; needsReview: boolean; unstable: string[] }[];
    expectedNeedsReview: boolean;
    gotNeedsReview: boolean;
  }[] = [];
  // 重複検出は単体ではなく一覧(バッチ)で判定するため、1回目の結果を集めておく
  const batchFirst: ExtractedDoc[] = [];

  for (const file of files) {
    const buf = await readFile(path.join(SAMPLES_DIR, file));
    const mime = file.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : file.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg";
    let expected: InvoiceData | null = null;
    let expectedNeedsReview = false;
    try {
      const expRaw = await readFile(
        path.join(EXPECTED_DIR, file.replace(/\.[^.]+$/, ".json")),
        "utf-8",
      );
      const expJson = JSON.parse(expRaw) as { data?: InvoiceData; needsReview?: boolean };
      expected = (expJson.data ?? expJson) as InvoiceData;
      expectedNeedsReview = expJson.needsReview === true;
    } catch {
      expected = null;
    }
    const runs: { okFields: number; needsReview: boolean; unstable: string[] }[] = [];
    const seenValues: Record<string, Set<string>> = Object.fromEntries(
      FIELDS.map((f) => [f, new Set<string>()]),
    );
    let lastNeedsReview = false;
    const allData: InvoiceData[] = [];
    for (let r = 0; r < REPEATS; r++) {
      const data = await extractor.extract(buf, mime, file);
      allData.push(data);
      // 単体チェック(重複検出は全件読み取り後にバッチで再判定する)
      const checked = validateBatch([{ file, data } as ExtractedDoc]);
      lastNeedsReview = checked[0].validation.needsReview;
      let okFields = 0;
      if (expected) {
        for (const f of FIELDS) {
          fieldHits[f].n++;
          if (fieldScore((expected as unknown as Record<string, unknown>)[f], (data as unknown as Record<string, unknown>)[f])) {
            fieldHits[f].ok++;
            okFields++;
          }
        }
      }
      for (const f of FIELDS) {
        seenValues[f].add(JSON.stringify((data as unknown as Record<string, unknown>)[f] ?? null));
      }
      runs.push({ okFields, needsReview: lastNeedsReview, unstable: [] });
      if (r < REPEATS - 1 && Number.isFinite(minInterval) && minInterval > 0) {
        await sleep(minInterval);
      }
    }
    const unstable = FIELDS.filter((f) => seenValues[f].size > 1);
    for (const run of runs) run.unstable = unstable;
    batchFirst.push({ file, data: allData[0] });
    perDoc.push({
      file,
      runs,
      expectedNeedsReview,
      gotNeedsReview: runs.some((r) => r.needsReview),
    });
  }
  // バッチ(一覧)としての重複チェックを反映する
  {
    const batchChecked = validateBatch(batchFirst);
    const flagByFile = new Map(batchChecked.map((d) => [d.file, d.validation.needsReview]));
    for (const d of perDoc) {
      if (flagByFile.get(d.file)) d.gotNeedsReview = true;
    }
  }

  const lines: string[] = [];
  lines.push(`# 評価結果`);
  lines.push(``);
  lines.push(`- 日時: ${new Date().toISOString()}`);
  lines.push(`- モデル: ${geminiModel()}`);
  lines.push(`- 各書類を${REPEATS}回ずつ読み取り`);
  lines.push(``);
  lines.push(`## 項目別正答率`);
  lines.push(`| 項目 | 正答率 | 正解数/試行数 |`);
  lines.push(`|---|---|---|`);
  for (const f of FIELDS) {
    const h = fieldHits[f];
    const rate = h.n ? ((h.ok / h.n) * 100).toFixed(1) : "-";
    lines.push(`| ${f} | ${rate}% | ${h.ok}/${h.n} |`);
  }
  lines.push(``);
  lines.push(`## 書類別`);
  lines.push(`| ファイル | 期待:要確認 | 実際:要確認(いずれか) | 回ごとの正解項目数 | ぶれ(回で変わった項目) |`);
  lines.push(`|---|---|---|---|---|`);
  for (const d of perDoc) {
    lines.push(
      `| ${d.file} | ${d.expectedNeedsReview ? "要確認" : "OK"} | ${d.gotNeedsReview ? "要確認" : "OK"} | ${d.runs.map((r) => `${r.okFields}/${FIELDS.length}`).join(", ")} | ${d.runs[0].unstable.join(", ") || "-"} |`,
    );
  }
  const flagOk = perDoc.filter((d) => d.expectedNeedsReview === d.gotNeedsReview).length;
  lines.push(``);
  lines.push(`要確認の振り分け一致: ${flagOk}/${perDoc.length}`);
  lines.push(``);
  await mkdir(path.dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_MD, lines.join("\n") + "\n", "utf-8");
  console.log(`保存: ${OUT_MD} (${perDoc.length}件×${REPEATS}回)`);
}

await main();
