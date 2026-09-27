#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { GeminiExtractor, type Extractor } from "./gemini.js";
import { validateBatch } from "./validate.js";
import { toCsv, toExcelBuffer } from "./export.js";
import type { ExtractedDoc } from "./types.js";

/**
 * CLI: npm run extract -- samples/*.pdf --out out/result.xlsx
 * --out の拡張子で形式を判定 (.xlsx / .csv / .json)。
 */

function mimeOf(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export async function runCli(
  argv: string[],
  extractorFactory?: () => Extractor,
): Promise<void> {
  const args = argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const inputs = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out" && !a.startsWith("--"));
  if (inputs.length === 0 || !out) {
    console.log("使い方: npm run extract -- <入力PDF/画像...> --out out/result.xlsx");
    console.log("例: npm run extract -- samples/inv-01.pdf samples/rcp-01.pdf --out out/result.xlsx");
    process.exitCode = 2;
    return;
  }
  if (!extractorFactory && !process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY が未設定です(.envに設定してください)");
    process.exitCode = 1;
    return;
  }
  const extractor = extractorFactory ? extractorFactory() : new GeminiExtractor();
  const extracted: ExtractedDoc[] = [];
  for (const file of inputs) {
    const buf = await readFile(file);
    const data = await extractor.extract(buf, mimeOf(file), path.basename(file));
    extracted.push({ file: path.basename(file), data });
  }
  const checked = validateBatch(extracted);
  const needs = checked.filter((d) => d.validation.needsReview).length;
  console.log(`${checked.length}件読み取り: OK=${checked.length - needs} 要確認=${needs}`);
  for (const d of checked) {
    if (d.validation.needsReview) console.log(`- [要確認] ${d.file}: ${d.validation.reasons.join(" / ")}`);
  }
  await mkdir(path.dirname(out), { recursive: true });
  const lower = out.toLowerCase();
  if (lower.endsWith(".csv")) {
    await writeFile(out, toCsv(checked), "utf-8");
  } else if (lower.endsWith(".json")) {
    await writeFile(out, JSON.stringify(checked, null, 2), "utf-8");
  } else {
    const buf = await toExcelBuffer(checked);
    await writeFile(out, buf);
  }
  console.log(`保存: ${out}`);
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
  await runCli(process.argv);
}
