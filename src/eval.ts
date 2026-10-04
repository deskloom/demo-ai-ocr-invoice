import { readFile, readdir, mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import {
  GeminiExtractor,
  geminiModel,
  sleep,
  isDailyQuotaError,
  parseQuotaValue,
  parseRetryDelayMs,
  isQuotaRateError,
  type Extractor,
} from "./gemini.js";
import { validateBatch } from "./validate.js";
import type { ExtractedDoc, InvoiceData } from "./types.js";

const SAMPLES_DIR = "samples";
const EXPECTED_DIR = path.join(SAMPLES_DIR, "expected");
const OUT_MD = path.join("eval", "results.md");
const RUNS_DIR = path.join("eval", "runs");
const DEFAULT_REPEATS = 3;

function fieldScore(expected: unknown, actual: unknown): boolean {
  return JSON.stringify(expected ?? null) === JSON.stringify(actual ?? null);
}

// lineItems（件数と各行の品目名・数量・単価・金額）と taxBreakdown を比較項目に加える
export const FIELDS: (keyof InvoiceData)[] = [
  "docType",
  "issuer",
  "registrationNumber",
  "issueDate",
  "dueDate",
  "documentNumber",
  "lineItems",
  "subtotal",
  "taxBreakdown",
  "total",
  "currency",
];

export function sanitizeModelName(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function parseEvalArgs(argv: string[]): { model?: string; repeats?: number } {
  const out: { model?: string; repeats?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) {
      out.model = argv[++i];
    } else if (a.startsWith("--model=")) {
      out.model = a.slice("--model=".length);
    } else if (a === "--repeats" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) out.repeats = Math.max(1, Math.floor(n));
    } else if (a.startsWith("--repeats=")) {
      const n = Number(a.slice("--repeats=".length));
      if (Number.isFinite(n)) out.repeats = Math.max(1, Math.floor(n));
    }
  }
  return out;
}

export interface RunRecord {
  model: string;
  file: string;
  repeat: number;
  ok: boolean;
  data?: InvoiceData;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface EvalOptions {
  model?: string;
  repeats?: number;
  samplesDir?: string;
  expectedDir?: string;
  outMd?: string;
  runsDir?: string;
  extractor?: Extractor;
  minIntervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface EvalSummary {
  model: string;
  completed: number;
  total: number;
  dailyQuotaHit: boolean;
  quotaValue: number | null;
}

function mimeForFile(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function loadRecords(runsFile: string): Promise<Map<string, RunRecord>> {
  const map = new Map<string, RunRecord>();
  try {
    const raw = await readFile(runsFile, "utf-8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as RunRecord;
        if (typeof rec.file === "string" && typeof rec.repeat === "number") {
          map.set(`${rec.file}::${rec.repeat}`, rec);
        }
      } catch {
        // 壊れた行は無視
      }
    }
  } catch {
    // ファイル無しは空扱い
  }
  return map;
}

export async function runEval(opts: EvalOptions = {}): Promise<EvalSummary> {
  const model = opts.model ?? geminiModel();
  const repeats = opts.repeats ?? DEFAULT_REPEATS;
  const samplesDir = opts.samplesDir ?? SAMPLES_DIR;
  const expectedDir = opts.expectedDir ?? EXPECTED_DIR;
  const outMd = opts.outMd ?? OUT_MD;
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const sleepFn = opts.sleepFn ?? sleep;
  const minInterval = opts.minIntervalMs ?? Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4000);

  const files = (await readdir(samplesDir)).filter((f) =>
    /\.(pdf|png|jpg|jpeg|webp)$/i.test(f),
  ).sort();
  const total = files.length * repeats;
  const runsFile = path.join(runsDir, `${sanitizeModelName(model)}.jsonl`);
  await mkdir(runsDir, { recursive: true });

  let extractor = opts.extractor;
  if (!extractor && !process.env.GEMINI_API_KEY) {
    console.log("GEMINI_API_KEY が未設定です");
    return { model, completed: 0, total, dailyQuotaHit: false, quotaValue: null };
  }
  if (!extractor) extractor = new GeminiExtractor({ model });

  const saved = await loadRecords(runsFile);
  const fieldHits: Record<string, { ok: number; n: number }> = Object.fromEntries(
    FIELDS.map((f) => [f, { ok: 0, n: 0 }]),
  );
  const perDoc: {
    file: string;
    runs: { okFields: number; needsReview: boolean; unstable: string[]; error?: boolean }[];
    expectedNeedsReview: boolean;
    gotNeedsReview: boolean;
  }[] = [];
  const batchFirst: ExtractedDoc[] = [];
  let completed = 0;
  let dailyQuotaHit = false;
  let quotaValue: number | null = null;
  let errorCount = 0;

  for (const file of files) {
    if (dailyQuotaHit) break;
    const buf = await readFile(path.join(samplesDir, file));
    const mime = mimeForFile(file);
    let expected: InvoiceData | null = null;
    let expectedNeedsReview = false;
    try {
      const expRaw = await readFile(
        path.join(expectedDir, file.replace(/\.[^.]+$/, ".json")),
        "utf-8",
      );
      const expJson = JSON.parse(expRaw) as { data?: InvoiceData; needsReview?: boolean };
      expected = (expJson.data ?? expJson) as InvoiceData;
      expectedNeedsReview = expJson.needsReview === true;
    } catch {
      expected = null;
    }
    const runs: { okFields: number; needsReview: boolean; unstable: string[]; error?: boolean }[] = [];
    const seenValues: Record<string, Set<string>> = Object.fromEntries(
      FIELDS.map((f) => [f, new Set<string>()]),
    );
    let lastNeedsReview = false;
    const allData: InvoiceData[] = [];

    const scoreData = (data: InvoiceData): number => {
      let okFields = 0;
      if (expected) {
        for (const f of FIELDS) {
          fieldHits[f].n++;
          if (
            fieldScore(
              (expected as unknown as Record<string, unknown>)[f],
              (data as unknown as Record<string, unknown>)[f],
            )
          ) {
            fieldHits[f].ok++;
            okFields++;
          }
        }
      }
      for (const f of FIELDS) {
        seenValues[f].add(
          JSON.stringify((data as unknown as Record<string, unknown>)[f] ?? null),
        );
      }
      return okFields;
    };

    for (let r = 0; r < repeats; r++) {
      if (dailyQuotaHit) break;
      const key = `${file}::${r}`;
      const prior = saved.get(key);
      if (prior) {
        // 保存済みは飛ばして続きから（再実行時は呼ばない）
        completed++;
        if (prior.ok && prior.data) {
          const okFields = scoreData(prior.data);
          const checked = validateBatch([{ file, data: prior.data } as ExtractedDoc]);
          lastNeedsReview = checked[0].validation.needsReview;
          if (r === 0) allData.push(prior.data);
          else if (allData.length === 0) allData.push(prior.data);
          runs.push({ okFields, needsReview: lastNeedsReview, unstable: [] });
        } else {
          errorCount++;
          runs.push({ okFields: 0, needsReview: false, unstable: [], error: true });
        }
        continue;
      }

      // 新規に読み取る（429のうち1日上限以外は retryDelay 待って最大3回再試行）
      let data: InvoiceData | null = null;
      let lastErr: unknown = null;
      let stoppedByDaily = false;
      const started = Date.now();
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          data = await extractor.extract(buf, mime, file);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (isDailyQuotaError(err)) {
            quotaValue = parseQuotaValue(err);
            dailyQuotaHit = true;
            stoppedByDaily = true;
            break;
          }
          if (attempt < 3 && isQuotaRateError(err)) {
            const wait = parseRetryDelayMs(err) ?? 2000 * (attempt + 1);
            if (Number.isFinite(minInterval) && minInterval > 0 && attempt === 0) {
              // 初回前の間隔調整は extractor 側で行うためここでは retryDelay のみ待つ
            }
            await sleepFn(wait);
            continue;
          }
          break;
        }
      }
      if (stoppedByDaily) {
        // 当日の失敗分は保存せず、続きから再開できるようにする
        break;
      }
      const durationMs = Date.now() - started;
      if (data) {
        const rec: RunRecord = {
          model,
          file,
          repeat: r,
          ok: true,
          data,
          durationMs,
          timestamp: new Date().toISOString(),
        };
        await mkdir(runsDir, { recursive: true });
        await appendFile(runsFile, JSON.stringify(rec) + "\n", "utf-8");
        saved.set(key, rec);
        completed++;
        allData.push(data);
        const checked = validateBatch([{ file, data } as ExtractedDoc]);
        lastNeedsReview = checked[0].validation.needsReview;
        const okFields = scoreData(data);
        runs.push({ okFields, needsReview: lastNeedsReview, unstable: [] });
      } else {
        // 429以外（400/403等）は記録して次へ進む
        const rec: RunRecord = {
          model,
          file,
          repeat: r,
          ok: false,
          error: String((lastErr as Error)?.message ?? lastErr ?? "unknown error"),
          durationMs,
          timestamp: new Date().toISOString(),
        };
        await mkdir(runsDir, { recursive: true });
        await appendFile(runsFile, JSON.stringify(rec) + "\n", "utf-8");
        saved.set(key, rec);
        completed++;
        errorCount++;
        runs.push({ okFields: 0, needsReview: false, unstable: [], error: true });
      }
      if (r < repeats - 1 && !dailyQuotaHit && Number.isFinite(minInterval) && minInterval > 0) {
        await sleepFn(minInterval);
      }
    }
    const unstable = FIELDS.filter((f) => seenValues[f].size > 1);
    for (const run of runs) run.unstable = unstable;
    if (allData.length > 0) batchFirst.push({ file, data: allData[0] });
    // エラーしか無い書類も行は出す（回ごとの記録なしの場合は空行扱いにしない）
    if (runs.length > 0) {
      perDoc.push({
        file,
        runs,
        expectedNeedsReview,
        gotNeedsReview: runs.some((r) => r.needsReview),
      });
    }
    if (dailyQuotaHit) break;
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
  lines.push(`- モデル: ${model}`);
  lines.push(`- 完了: ${completed}/${total}回`);
  if (dailyQuotaHit) {
    lines.push(
      `- 1日の無料枠到達のため中断（続きから再開できます）`,
    );
  }
  if (errorCount > 0) {
    lines.push(`- エラー記録: ${errorCount}件（429以外は記録して続行）`);
  }
  lines.push(`- 各書類を${repeats}回ずつ読み取り`);
  lines.push(`- 金額（数量・単価・金額・小計・税額・合計）は完全一致で比較`);
  lines.push(`- lineItems は件数と各行の品目名・数量・単価・金額の完全一致、taxBreakdown は税率別の対象額と税額の完全一致で比較`);
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
      `| ${d.file} | ${d.expectedNeedsReview ? "要確認" : "OK"} | ${d.gotNeedsReview ? "要確認" : "OK"} | ${d.runs.map((r) => (r.error ? "エラー" : `${r.okFields}/${FIELDS.length}`)).join(", ")} | ${d.runs[0]?.unstable.join(", ") || "-"} |`,
    );
  }
  const flagOk = perDoc.filter((d) => d.expectedNeedsReview === d.gotNeedsReview).length;
  lines.push(``);
  lines.push(`要確認の振り分け一致: ${flagOk}/${perDoc.length}`);
  lines.push(``);
  await mkdir(path.dirname(outMd), { recursive: true });
  await writeFile(outMd, lines.join("\n") + "\n", "utf-8");
  if (dailyQuotaHit) {
    const quotaStr = quotaValue !== null ? `1日${quotaValue}回` : `1日上限`;
    console.log(
      `本日の無料枠（${model}・${quotaStr}）を使い切りました。明日以降に同じコマンドで続きから再開できます`,
    );
  }
  console.log(`保存: ${outMd} (${perDoc.length}件・完了${completed}/${total}回)`);
  return { model, completed, total, dailyQuotaHit, quotaValue };
}

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));
  if (!args.model && !process.env.GEMINI_API_KEY && !process.env.GEMINI_MODEL) {
    // 下の runEval がキー未設定メッセージを出す
  }
  await runEval({ model: args.model, repeats: args.repeats });
}

export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
